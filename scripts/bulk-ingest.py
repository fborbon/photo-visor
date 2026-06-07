#!/usr/bin/env python3
"""
bulk-ingest.py  –  Photo Visor bulk ingest and change-tracking script.

Each photo is identified by its SHA-256 content hash, so moves/renames
are detected on re-runs without re-uploading.  The SQLite state database
(state.db, next to this script) is the source of truth for what is in S3.

Usage:
    python3 bulk-ingest.py                  # full scan + upload
    python3 bulk-ingest.py --dry-run        # scan only, no uploads
    python3 bulk-ingest.py --reindex-only   # rebuild index JSON from DB
    python3 bulk-ingest.py --workers 12     # parallel upload threads
    python3 bulk-ingest.py --root /other/path
"""

import io
import os
import re
import sys
import json
import time
import hashlib
import sqlite3
import argparse
import logging
import subprocess
import tempfile
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

import boto3
import exifread
import requests
from PIL import Image, ImageOps
from tqdm import tqdm

# ── Load stack outputs ────────────────────────────────────────────────────────
_HERE = Path(__file__).parent
_OUTPUTS = json.loads((_HERE.parent / "stack-outputs.json").read_text())

PHOTOS_ROOT   = Path("/media/patito/seagate/Personal/Fotos")
BUCKET        = _OUTPUTS["bucketName"]
REGION        = _OUTPUTS["region"]
DB_PATH       = _HERE / "state.db"
THUMB_WIDTH   = 400
THUMB_QUALITY = 72
UPLOAD_WORKERS = 8
NOMINATIM_URL  = "https://nominatim.openstreetmap.org/search"
NOMINATIM_UA   = "PhotoVisor/1.0 (personal photo archive)"
NOMINATIM_DELAY = 1.1   # seconds between API calls (OSM fair-use policy)

IMAGE_EXTS = {".jpg", ".jpeg", ".jpe", ".png", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".cr2", ".nef", ".arw", ".dng", ".orf", ".rw2"}
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".3gp", ".mpg", ".vob", ".wmv", ".mp3"}
# Video formats that browsers/Android WebView cannot play natively → must transcode to MP4
NON_MP4_VIDEO_EXTS = {".mov", ".avi", ".3gp", ".mpg", ".vob", ".wmv"}
SKIP_EXTS  = {".ds_store", ".ini", ".txt", ".htm", ".html", ".js", ".css", ".pdf",
              ".doc", ".pps", ".zip", ".nomedia", ".thm", ".gif"}

# ── Geographic classification tables ─────────────────────────────────────────

# Top-level folders that are purely geographic (continent buckets)
GEO_CONTINENT_ROOTS = {
    "Africa":        "Africa",
    "Europa":        "Europe",
    "Latinoamerica": "Latin America",
    "Norteamerica":  "North America",
    "Suramerica":    "South America",
    "Asia":          "Asia",
}

# Top-level folders treated as non-geographic → everything goes to general/
NON_GEO_ROOTS = {
    "Apuntes", "Atardeceres", "Automoviles", "Comics-Arts",
    "Comidas y recetas", "Google Earth", "Internet", "Lecturas", "Memes",
    "Ordenar", "Otros", "Películas", "Wallpapers",
}

# Spanish (and other) country names → English for Nominatim
COUNTRY_NORMALIZE = {
    "España": "Spain", "Francia": "France", "Alemania": "Germany",
    "Italia": "Italy", "Belgica": "Belgium", "Holanda": "Netherlands",
    "Dinamarca": "Denmark", "Noruega": "Norway", "Inglaterra": "England",
    "Irlanda": "Ireland", "Grecia": "Greece", "Hungria": "Hungary",
    "Polonia": "Poland", "Israel": "Israel", "Monaco": "Monaco",
    "Andorra": "Andorra", "Suiza": "Switzerland", "Turquia": "Turkey",
    "Portugal": "Portugal", "Yugoslavia": "Croatia",
    "Austria": "Austria", "Eslovaquia": "Slovakia", "Republica Checa": "Czech Republic",
    "Paises Balticos": None,  # sub-folders give actual city
    "Egipto": "Egypt",
    "Colombia": "Colombia", "Cuba": "Cuba", "Guatemala": "Guatemala",
    "Chile": "Chile", "Argentina": "Argentina", "Uruguay": "Uruguay",
    "Peru": "Peru", "Perú": "Peru", "Bolivia": "Bolivia",
    "Costa Rica": "Costa Rica",
    "Canada": "Canada",
    "USA": "USA",
    "Japón": "Japan", "Tailandia": "Thailand",
    "Australia": "Australia", "UAE": "UAE",
    # Added for .Amigos / .Whatsapp new country-first structure
    "Panamá": "Panama", "Salvador": "El Salvador", "El Salvador": "El Salvador", "Indonesia": "Indonesia",
    "Brasil": "Brazil", "México": "Mexico",
}

# Country (English) → continent — used for .Amigos and .Whatsapp geo returns
_COUNTRY_CONTINENT: dict[str, str] = {
    "Spain": "Europe", "France": "Europe", "Germany": "Europe",
    "Netherlands": "Europe", "Portugal": "Europe", "Belgium": "Europe",
    "Denmark": "Europe", "Norway": "Europe", "England": "Europe",
    "Ireland": "Europe", "Greece": "Europe", "Hungary": "Europe",
    "Poland": "Europe", "Switzerland": "Europe", "Turkey": "Europe",
    "Austria": "Europe", "Slovakia": "Europe", "Czech Republic": "Europe",
    "Croatia": "Europe", "Italy": "Europe", "Estonia": "Europe",
    "Finland": "Europe", "Sweden": "Europe", "Monaco": "Europe",
    "Andorra": "Europe", "Israel": "Middle East",
    "Costa Rica": "Central America", "Panama": "Central America",
    "El Salvador": "Central America", "Guatemala": "Central America",
    "Cuba": "Caribbean", "Mexico": "North America",
    "USA": "North America", "Canada": "North America",
    "Brazil": "South America", "Argentina": "South America",
    "Chile": "South America", "Colombia": "South America",
    "Peru": "South America", "Bolivia": "South America", "Uruguay": "South America",
    "Egypt": "Africa",
    "Japan": "Asia", "Thailand": "Asia", "UAE": "Asia", "Indonesia": "Asia",
    "Australia": "Oceania",
}

# Folders whose photos should have NO geographic location (general only)
# Populated at runtime from no_location.txt marker files on disk.
_NO_LOCATION_DIRS: frozenset[str] = frozenset()

# Folders where all subfolders collapse to ONE pin (the folder's own geo level).
# Populated at runtime from unique_pin.txt marker files on disk.
_UNIQUE_PIN_DIRS: frozenset[str] = frozenset()


def _load_marker_files(root: Path) -> None:
    """Scan disk for unique_pin.txt / no_location.txt and populate the module-level sets."""
    global _UNIQUE_PIN_DIRS, _NO_LOCATION_DIRS
    unique_pins: set[str] = set()
    no_locs: set[str] = set()
    for marker in root.rglob("unique_pin.txt"):
        unique_pins.add(str(marker.parent.relative_to(root)))
    for marker in root.rglob("no_location.txt"):
        no_locs.add(str(marker.parent.relative_to(root)))
    _UNIQUE_PIN_DIRS = frozenset(unique_pins)
    _NO_LOCATION_DIRS = frozenset(no_locs)
    log.info(f"Marker files: {len(_UNIQUE_PIN_DIRS)} unique_pin, {len(_NO_LOCATION_DIRS)} no_location")

# Folder names at continent/country level-2 that are NOT countries
_NON_COUNTRY_LEVEL2 = {
    "Inmobiliaria", "Mónica", "Monica",
    # "Andorra - Girona" is geographic – handled by the " - " branch below
    "Semana Santa con Anita - Francia - Holanda - Belgica - Abril 2012",
    "Viaje Europa - Rosibel e Ileana - Julio 2008",
    "Viaje Europa - Rosibel y Pablo - Agosto 2014",
    "Viaje Rosibel Canada - Agosto 2010",
    "Viaje Monica - Julio 2015",
    "USA - Fernando-julio 2003",
    "USA - Providence Rhode Island - Fernando-julio 2003",
    "USA - Providence Rhode Island -  Julio 2004",
    "USA - California - Viaje Monica - Julio 2015",
}

# Words that disqualify the first token of a folder name from being a city
_NON_CITY_WORDS = {
    "Diciembre", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Setiembre", "Octubre", "Noviembre",
    "Imprimir", "Repetidos", "Inmobiliaria", "Celular", "Viaje",
    "Reunion", "Clausura", "Bejiga", "Boda", "Defensa", "Graduacion",
    "Graduación", "DIS",
}

# Spanish months → number
SPANISH_MONTHS = {
    "Enero": 1, "Febrero": 2, "Marzo": 3, "Abril": 4, "Mayo": 5, "Junio": 6,
    "Julio": 7, "Agosto": 8, "Septiembre": 9, "Setiembre": 9,
    "Octubre": 10, "Noviembre": 11, "Diciembre": 12,
}

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
log = logging.getLogger("ingest")

# ── Database ──────────────────────────────────────────────────────────────────
SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
    hash            TEXT PRIMARY KEY,
    s3_key          TEXT,
    thumb_key       TEXT,
    current_path    TEXT NOT NULL,
    filename        TEXT NOT NULL,
    lat             REAL,
    lng             REAL,
    datetime_taken  TEXT,
    year            INTEGER,
    month           INTEGER,
    day             INTEGER,
    continent       TEXT,
    country         TEXT,
    city            TEXT,
    general_folder  TEXT,
    exif_make       TEXT,
    exif_model      TEXT,
    width           INTEGER,
    height          INTEGER,
    size_bytes      INTEGER,
    mtime_ns        INTEGER,
    media_type      TEXT DEFAULT 'photo',
    s3_uploaded     INTEGER DEFAULT 0,
    thumb_uploaded  INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'active',
    created_at      TEXT,
    updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS geo_cache (
    query           TEXT PRIMARY KEY,
    lat             REAL,
    lng             REAL,
    display_name    TEXT,
    success         INTEGER DEFAULT 1,
    cached_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_year_month   ON photos(year, month);
CREATE INDEX IF NOT EXISTS idx_country      ON photos(country);
CREATE INDEX IF NOT EXISTS idx_general      ON photos(general_folder);
CREATE INDEX IF NOT EXISTS idx_status       ON photos(status);
CREATE INDEX IF NOT EXISTS idx_path         ON photos(current_path);
"""


def open_db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    # Migrations: add columns introduced after initial schema creation
    existing = set(row[1] for row in db.execute("PRAGMA table_info(photos)"))
    if "mtime_ns" not in existing:
        db.execute("ALTER TABLE photos ADD COLUMN mtime_ns INTEGER")
    if "video_proxy_key" not in existing:
        db.execute("ALTER TABLE photos ADD COLUMN video_proxy_key TEXT")
    db.commit()
    return db


# ── File scanning & hashing ───────────────────────────────────────────────────

_PARTIAL = 65536  # 64 KB read from start + end of file


def quick_hash(path: Path, size: int) -> str:
    """
    Fast stable fingerprint: SHA256( size_bytes | first 64 KB | last 64 KB ).
    Reads at most 128 KB per file regardless of size.  For real-world photos
    the collision probability is effectively zero.
    """
    h = hashlib.sha256()
    h.update(size.to_bytes(8, "big"))
    with open(path, "rb") as f:
        h.update(f.read(_PARTIAL))
        if size > _PARTIAL * 2:
            f.seek(-_PARTIAL, 2)
            h.update(f.read(_PARTIAL))
    return h.hexdigest()


def scan_local(root: Path, db: sqlite3.Connection) -> dict[str, Path]:
    """
    Walk root and return {hash: path} for every supported media file.

    Skip-cache: if a file's (relative_path, size, mtime_ns) exactly matches
    what is already in the DB, we reuse the stored hash without re-reading
    the file.  This makes re-runs on large collections almost instant.
    """
    # Build path → (size_bytes, mtime_ns, hash) cache from DB.
    # mtime_ns may be stored as an ISO string in older records; skip those so
    # they get re-hashed this run (and their mtime_ns will be repaired below).
    path_cache: dict[str, tuple[int, int, str]] = {}
    mtime_stale: set[str] = set()   # relative paths with ISO-string mtime_ns
    for row in db.execute(
        "SELECT current_path, size_bytes, mtime_ns, hash FROM photos WHERE status='active'"
    ):
        mns = row["mtime_ns"]
        if mns is None:
            continue
        if isinstance(mns, int):
            path_cache[row["current_path"]] = (row["size_bytes"], mns, row["hash"])
        else:
            mtime_stale.add(row["current_path"])   # ISO-string format — needs repair

    all_files = [
        p for p in root.rglob("*")
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS | VIDEO_EXTS
        and not any(
            part.startswith(".") and part not in (".Amigos", ".Whatsapp")
            for part in p.parts
        )
    ]
    log.info(f"Fingerprinting {len(all_files):,} files …")

    result: dict[str, Path] = {}
    cached_count = 0
    mtime_repairs: list[tuple[int, int, str]] = []   # (size, mtime_ns_int, rel_path)
    total = len(all_files)
    bar_fmt = "  Scanning  {n:>7,} / " + f"{total:,}" + "  [{elapsed}<{remaining}  {rate_fmt}]"

    for p in tqdm(all_files, bar_format=bar_fmt, unit="file"):
        try:
            st  = p.stat()
            sz  = st.st_size
            mns = st.st_mtime_ns
            rel = str(p.relative_to(root))

            cached = path_cache.get(rel)
            if cached and cached[0] == sz and cached[1] == mns:
                h = cached[2]   # reuse stored hash – no disk read needed
                cached_count += 1
            else:
                h = quick_hash(p, sz)
                if rel in mtime_stale:
                    mtime_repairs.append((sz, mns, rel))

            if h in result:
                log.debug(f"Duplicate {h[:8]}…: {result[h].name}  vs  {p.name}")
            result[h] = p
        except OSError as e:
            log.warning(f"Cannot read {p}: {e}")

    if cached_count:
        log.info(f"  {cached_count:,} files matched cache (no re-hash needed)")

    # Repair ISO-string mtime_ns → integer for legacy records encountered this run
    if mtime_repairs:
        db.executemany(
            "UPDATE photos SET size_bytes=?, mtime_ns=? WHERE current_path=? AND status='active'",
            mtime_repairs,
        )
        db.commit()
        log.info(f"  Repaired mtime_ns for {len(mtime_repairs):,} records (ISO→int migration)")

    return result


# ── EXIF extraction ───────────────────────────────────────────────────────────

def _gps_to_decimal(values, ref: str) -> Optional[float]:
    try:
        d = float(values[0].num) / float(values[0].den)
        m = float(values[1].num) / float(values[1].den)
        s = float(values[2].num) / float(values[2].den)
        dec = d + m / 60 + s / 3600
        if ref in ("S", "W"):
            dec = -dec
        return round(dec, 6)
    except Exception:
        return None


# Ordered from most-specific (datetime + time) to least (date only).
# Each tuple: (compiled regex, has_time_component)
_FN_DATE_PATTERNS = [
    # Android / Screenshot: YYYYMMDD_HHmmss or YYYYMMDD-HHmmss
    (re.compile(r'(?<!\d)(\d{4})(\d{2})(\d{2})[_\-](\d{2})(\d{2})(\d{2})(?!\d)'), True),
    # ISO datetime: 2019-10-19T14:30:55 or 2019-10-19 14.30.55
    (re.compile(r'(\d{4})-(\d{2})-(\d{2})[T_ ](\d{2})[:\.](\d{2})[:\.](\d{2})'), True),
    # ISO date only: 2019-10-19
    (re.compile(r'(\d{4})-(\d{2})-(\d{2})'), False),
    # WhatsApp / compact date only: 20191019 (not preceded/followed by another digit)
    (re.compile(r'(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)'), False),
]


def parse_filename_date(filename: str) -> tuple:
    """
    Extract (iso_datetime_str, year, month, day) from a filename.
    Returns (None, None, None, None) if no recognisable date found.
    Priority: patterns with time component first, then date-only.
    """
    stem = Path(filename).stem
    for pattern, has_time in _FN_DATE_PATTERNS:
        m = pattern.search(stem)
        if not m:
            continue
        g = m.groups()
        try:
            y, mo, d = int(g[0]), int(g[1]), int(g[2])
            if not (1990 <= y <= 2035 and 1 <= mo <= 12 and 1 <= d <= 31):
                continue
            if has_time:
                h, mi, s = int(g[3]), int(g[4]), int(g[5])
                if not (0 <= h <= 23 and 0 <= mi <= 59 and 0 <= s <= 59):
                    continue
                iso = "%04d-%02d-%02dT%02d:%02d:%02d" % (y, mo, d, h, mi, s)
            else:
                iso = "%04d-%02d-%02d" % (y, mo, d)
            return iso, y, mo, d
        except (ValueError, IndexError):
            continue
    return None, None, None, None


def extract_exif(path: Path) -> dict:
    """Return dict with lat, lng, datetime_taken, make, model, width, height."""
    result: dict = {}
    try:
        with open(path, "rb") as f:
            tags = exifread.process_file(f, stop_tag="GPS GPSImgDirection", details=False)

        # GPS
        lat_tag  = tags.get("GPS GPSLatitude")
        lat_ref  = tags.get("GPS GPSLatitudeRef")
        lng_tag  = tags.get("GPS GPSLongitude")
        lng_ref  = tags.get("GPS GPSLongitudeRef")
        if lat_tag and lat_ref and lng_tag and lng_ref:
            lat = _gps_to_decimal(lat_tag.values, str(lat_ref))
            lng = _gps_to_decimal(lng_tag.values, str(lng_ref))
            # Reject (0, 0) – common placeholder for "no GPS"
            if lat is not None and lng is not None and not (lat == 0.0 and lng == 0.0):
                result["lat"] = lat
                result["lng"] = lng

        # Datetime
        for tag in ("EXIF DateTimeOriginal", "EXIF DateTimeDigitized", "Image DateTime"):
            dt_tag = tags.get(tag)
            if dt_tag:
                try:
                    dt = datetime.strptime(str(dt_tag), "%Y:%m:%d %H:%M:%S")
                    result["datetime_taken"] = dt.isoformat()
                    result["year"]  = dt.year
                    result["month"] = dt.month
                    result["day"]   = dt.day
                    break
                except ValueError:
                    pass

        result["exif_make"]  = str(tags["Image Make"]).strip()  if "Image Make"  in tags else None
        result["exif_model"] = str(tags["Image Model"]).strip() if "Image Model" in tags else None

        # Dimensions
        w_tag = tags.get("EXIF ExifImageWidth")  or tags.get("Image ImageWidth")
        h_tag = tags.get("EXIF ExifImageLength") or tags.get("Image ImageLength")
        if w_tag: result["width"]  = int(str(w_tag))
        if h_tag: result["height"] = int(str(h_tag))

    except Exception as e:
        log.debug(f"EXIF error {path.name}: {e}")

    return result


# ── Folder-path geographic classifier ────────────────────────────────────────

def _extract_city_token(folder_name: str) -> Optional[str]:
    """
    From 'Barcelona - Agosto 2011 - Vacaciones' → 'Barcelona'.
    Returns None if the first token looks like a date/event word.
    """
    # Split on ' - ' first, then on '_'
    token = re.split(r"\s+-\s+|_", folder_name)[0].strip()
    if not token:
        return None
    # Reject pure years (e.g. "2014")
    if re.fullmatch(r"\d{4}", token):
        return None
    # Check the FIRST WORD of the token (catches "Diciembre 2014", "Imprimir molduras…")
    first_word = token.split()[0] if token.split() else token
    if first_word in _NON_CITY_WORDS or first_word in SPANISH_MONTHS:
        return None
    return token


def _date_from_folder(folder_name: str) -> tuple[Optional[int], Optional[int]]:
    """Return (year, month) hinted by folder name, e.g. 'Barcelona - Agosto 2011'."""
    year = month = None
    for part in re.split(r"[\s\-_]+", folder_name):
        if re.fullmatch(r"\d{4}", part):
            year = int(part)
        if part in SPANISH_MONTHS:
            month = SPANISH_MONTHS[part]
        # ISO date fragment like 2018-10-13
        m = re.search(r"(\d{4})-(\d{2})", folder_name)
        if m:
            year, month = int(m.group(1)), int(m.group(2))
    return year, month


_NON_PLACE_SUBFOLDERS = {
    'calibration', 'city', 'instruments', 'met_mast', 'selfies', 'targets',
    'wsv1', 'wsv2', 'nokia camera', 'pastelaria pingo doce',
}

def _system_tag(rel_path: str) -> Optional[str]:
    """
    Derive the system tag from the file path.

    Camera/Europa/España/Navarra/Pamplona/2025/file.jpg    → "España/Navarra/Pamplona/2025"
    .Amigos/España - Pamplona/Eva/Dublin 2016/file.jpg     → "España/Pamplona - Eva"
    .Whatsapp/Familia/file.jpg                             → "Costa Rica/Tibás - Whatsapp"
    Memes/funny.jpg                                        → None
    """
    parts = Path(rel_path).parts
    if not parts:
        return None

    # no_location.txt: any ancestor marked → no system tag (no map pin)
    _fp = parts[:-1]
    for _i in range(len(_fp), 0, -1):
        if str(Path(*_fp[:_i])) in _NO_LOCATION_DIRS:
            return None

    # unique_pin.txt: collapse subfolder path to the pin-folder level so all
    # subfolders share the same system tag → one S3 index file → one map pin.
    # _unique_pin_depth tracks how many levels were in the unique_pin folder so
    # we can truncate Camera/ tags to country/city (2 segments) at the end.
    _unique_pin_depth = 0
    folder_parts = parts[:-1]
    for i in range(len(folder_parts), 0, -1):
        ancestor = str(Path(*folder_parts[:i]))
        if ancestor in _UNIQUE_PIN_DIRS:
            _unique_pin_depth = i
            parts = Path(ancestor).parts + ("dummy.jpg",)
            break

    # .Amigos — new structure (two formats):
    #   Country-first:  .Amigos/{Country}/{City}/...           → {Country}/{City} - Amigos
    #   Person-first:   .Amigos/{Person}/{Country}/{City}/...  → {Country}/{City} - {Person}
    if parts[0] == ".Amigos":
        if len(parts) < 3:
            return None
        level1 = parts[1]
        if COUNTRY_NORMALIZE.get(level1) is not None:
            # Country-first: append " - Amigos" to distinguish from Camera/ pins at the same city
            city = parts[2] if len(parts) > 2 else None
            if not city:
                return None
            return f"{level1}/{city} - Amigos"
        else:
            # Person-first: .Amigos/{Person}/{Country}/{City}[/{Subfolder}]/...
            # Include subfolder as a third tag segment so each sub-album gets
            # its own index file (and TOC entry), while all share the same
            # Country:City location bucket → same map pin.
            if len(parts) < 4:
                return None
            person     = level1
            country_es = parts[2]
            city       = parts[3] if len(parts) > 3 else None
            if not city:
                return f"{country_es}/{person}"
            # Include the next path level so each sub-album gets its own index
            # entry and TOC item.  Exclude "dummy.jpg" (injected by unique_pin
            # collapse) and plain filenames (no extension in a real subfolder).
            raw_sub = parts[4] if len(parts) > 4 else None
            subfolder = (raw_sub
                         if raw_sub and '.' not in raw_sub
                         else None)
            if subfolder:
                return f"{country_es}/{city}/{subfolder} - {person}"
            return f"{country_es}/{city} - {person}"

    # .Whatsapp — geographic hierarchy: .Whatsapp/{Country}/{City}[/{Subfolder}]/...
    # Include subfolder as a third segment so named subfolders (e.g. Colegio
    # María Inmaculada) get their own TOC entry in the city pin.
    if parts[0] == ".Whatsapp":
        if len(parts) >= 3:
            country_es = parts[1]
            city       = parts[2]
            raw_sub    = parts[3] if len(parts) > 3 else None
            subfolder  = raw_sub if raw_sub and '.' not in raw_sub else None
            if subfolder:
                return f"{country_es}/{city}/{subfolder} - Whatsapp"
            return f"{country_es}/{city} - Whatsapp"
        return "Costa Rica/Tibás - Whatsapp"

    if parts[0] != "Camera" or len(parts) < 3:
        return None
    dir_parts = list(parts[1:-1])   # between Camera/ and filename
    if not dir_parts:
        return None
    # Strip the continent level when it's a known continent bucket
    if dir_parts[0] in GEO_CONTINENT_ROOTS:
        tag_parts = dir_parts[1:]
    else:
        tag_parts = dir_parts

    # Camera/Europa/Visitas/{Trip}/{Country}/{City}/...    → {country_es}/{city} - {trip}
    # Camera/Europa/Visitas/{Trip}/{Country} - {City}/... → {country_es}/{city} - {trip}
    # Camera/Europa/Visitas/{Trip}/{PlainCity}/...         → {country_es}/{city} - {trip}
    # Trip suffix distinguishes each Visitas album from the main Camera/{Country}/{City} pin.
    _VISITAS_CITY_COUNTRY = {"Lourdes": "Francia", "Biarritz": "Francia",
                             "Paris": "Francia", "Lyon": "Francia",
                             "Lisboa": "Portugal", "Porto": "Portugal"}
    if len(tag_parts) >= 3 and tag_parts[0] == "Visitas":
        trip     = tag_parts[1]
        subfolder = tag_parts[2]
        if " - " in subfolder:
            country_es, city = subfolder.split(" - ", 1)
            if country_es in COUNTRY_NORMALIZE:
                return f"{country_es}/{city} - {trip}"
        elif subfolder in COUNTRY_NORMALIZE:
            # subfolder is a country name → next level is the city
            country_es = subfolder
            city = tag_parts[3] if len(tag_parts) >= 4 else subfolder
            return f"{country_es}/{city} - {trip}"
        else:
            country_es = _VISITAS_CITY_COUNTRY.get(subfolder, "España")
            return f"{country_es}/{subfolder} - {trip}"

    # Camera/Latinoamerica/Costa Rica/{geo_cat}/{city}[/{subfolder}]/...
    # Paseos en bicicleta: depth-4 subfolder is a cycling route *within* the
    # city → keep as sub-album of the city pin ("Costa Rica/{city}/{route}").
    # All other geo cats (Turismo CR, Paseos en automovil, Voluntariados):
    # depth-4 subfolder is a separate destination → promote to its own city pin.
    _CR_GEO_CATS = {"Turismo CR", "Voluntariados",
                    "Paseos en automovil", "Paseos en bicicleta"}
    if (len(tag_parts) >= 3 and tag_parts[0] == "Costa Rica"
            and tag_parts[1] in _CR_GEO_CATS):
        city = tag_parts[2]
        if len(tag_parts) >= 4:
            if tag_parts[1] == "Paseos en bicicleta":
                return f"Costa Rica/{city}/{tag_parts[3]}"   # route sub-album
            else:
                return f"Costa Rica/{tag_parts[3]}"           # separate town pin
        return f"Costa Rica/{city}"
    # Costa Rica non-geo categories → no sys tag
    if (len(tag_parts) >= 2 and tag_parts[0] == "Costa Rica"
            and tag_parts[1] in {"Familia", "Visitas"}):
        return None

    # "{Country} - {City}/Album..." → group all albums under the country-city label.
    # When a city sub-folder exists (trip-style folders), promote it to the tag so that
    # each city gets its own map pin (e.g. "USA - Boston") instead of a trip-level tag.
    if len(tag_parts) >= 1 and " - " in tag_parts[0]:
        country_cand = tag_parts[0].split(" - ")[0].strip()
        if country_cand in COUNTRY_NORMALIZE:
            if len(tag_parts) >= 2:
                return f"{country_cand} - {tag_parts[1]}"
            return tag_parts[0]

    # España: when tag_parts[1] is a region container (Navarra, Cataluña, …)
    # skip it and keep the city + any deeper album path as independent segments.
    # Non-region cities (Guernika, Bilbao, Sevilla, …) fall through to the
    # general handler so each subfolder becomes its own pin (no truncation).
    _ESPAÑA_REGION_CONTAINERS_TAG = {"Navarra", "Cataluña", "Asturias", "Andalucia"}
    if len(tag_parts) >= 3 and tag_parts[0] == "España":
        if tag_parts[1] in _ESPAÑA_REGION_CONTAINERS_TAG:
            # Skip the region level; preserve city + deeper path for independent pins
            city_and_below = "/".join(tag_parts[2:])
            return f"España/{city_and_below}"
        # else: non-region city → fall through to general handler

    # USA: depth-1 is either the city (Boulder, Boston…), a US state, or a trip.
    # • Trip folder  (Viaje …)      → "USA/{city} - {trip}"  (preserves trip for distinct pin)
    # • State folder (South Carolina) → "USA/{city}"          (state is just a container)
    # • City folder  (Boulder, Boston) → "USA/{city}"
    _US_STATE_FOLDERS = {"South Carolina", "North Carolina", "Rhode Island",
                         "New Mexico", "New York State", "West Virginia"}
    if len(tag_parts) >= 3 and tag_parts[0] == "USA":
        city1 = _extract_city_token(tag_parts[1])
        if city1 is None:
            # Depth-1 is a trip folder → append trip so the album is distinct from
            # photos taken in the same city outside the trip context.
            city = _extract_city_token(tag_parts[2]) or tag_parts[2]
            return f"USA/{city} - {tag_parts[1]}"
        elif city1 in _US_STATE_FOLDERS:
            # Depth-1 is a US state container → city at depth-2, no trip suffix
            city = _extract_city_token(tag_parts[2]) or tag_parts[2]
            return f"USA/{city}"
        else:
            # Depth-1 is the actual city (Boulder, Boston, Chicago…)
            return f"USA/{city1}"

    # Strip person-subfolder level (e.g. "Aryan's pictures") so city pin is correct.
    # Camera/Europa/Italia/Roma/{person's pictures}/ → "Italia/Roma"
    if len(tag_parts) >= 3 and tag_parts[2].lower().endswith(" pictures"):
        return "/".join(tag_parts[:2])

    # Trip-folder level: tag_parts[1] is a trip/visit descriptor and tag_parts[2] is
    # the city/place within it.  Append the trip name so the album is distinct from
    # photos taken in the same city outside this trip context.
    # Two descriptor forms:
    #   "{City} - {Visit description}" (e.g. "Cascais - Visita agosto 2008")
    #   "{Visit word} {date/desc}"     (e.g. "Visita agosto 2008", "Viaje Europa 2008")
    # Organisational sub-folders (Parte N, Calibration…) collapse to the trip tag.
    _TRIP_FIRST_WORDS = {"visita", "viaje", "viagem", "tour", "semana"}
    _is_trip_folder = (
        " - " in tag_parts[1] or
        (len(tag_parts) >= 3 and tag_parts[1].split()[0].lower() in _TRIP_FIRST_WORDS)
    ) if len(tag_parts) >= 3 else False

    if _is_trip_folder:
        sub = tag_parts[2]
        sub_lower = sub.lower()
        if (re.match(r'^(Parte\s*\d+|\d+)$', sub, re.IGNORECASE)
                or '_' in sub
                or sub_lower in _NON_PLACE_SUBFOLDERS
                or sub_lower.startswith('fotos de ')):
            return "/".join(tag_parts[:2])
        return f"{tag_parts[0]}/{sub} - {tag_parts[1]}"

    if tag_parts:
        # Normalize folder-spelling variants to the canonical city name
        _CITY_FOLDER_NORMALIZE = {'Bruges': 'Brugge'}
        normalized = [tag_parts[0]] + [_CITY_FOLDER_NORMALIZE.get(p, p) for p in tag_parts[1:]]
        # unique_pin.txt collapse has already replaced parts with the pin-folder
        # path + "dummy.jpg", so tag_parts/normalized already reflect the correct
        # depth.  No further truncation is needed or correct here.
        return "/".join(normalized)
    return None


def classify_path(rel_path: str) -> dict:
    """
    Classify a relative photo path into geo or general metadata.

    Pre-checks (in order):
      1. no_location.txt in any ancestor → return general (no geo)
      2. unique_pin.txt in any ancestor  → collapse all subfolders to that
         folder's geographic level (one pin per unique_pin folder)
      3. Normal classification via _classify_path_raw

    Always sets "folder" key so general_folder is populated for every photo.
    """
    p_parts = Path(rel_path).parts
    folder_parts = p_parts[:-1]   # directory components only (no filename)

    # 1. no_location.txt check
    for i in range(len(folder_parts), 0, -1):
        ancestor = str(Path(*folder_parts[:i]))
        if ancestor in _NO_LOCATION_DIRS:
            return {"type": "general", "folder": str(Path(*folder_parts)) if folder_parts else ""}

    # 2. unique_pin.txt check — find deepest ancestor with unique_pin.txt
    unique_pin_folder: Optional[str] = None
    for i in range(len(folder_parts), 0, -1):
        ancestor = str(Path(*folder_parts[:i]))
        if ancestor in _UNIQUE_PIN_DIRS:
            unique_pin_folder = ancestor
            break

    if unique_pin_folder:
        # Find geo for the pin folder: try test paths from deepest to shallowest
        pin_parts = Path(unique_pin_folder).parts
        for depth in range(len(pin_parts), 0, -1):
            test = "/".join(pin_parts[:depth]) + "/dummy.jpg"
            result = _classify_path_raw(test)
            if result["type"] == "geo":
                result = dict(result)
                # Use real folder path for general_folder
                if rel_path.startswith("Camera/") and len(p_parts) > 2:
                    result["folder"] = str(Path(*p_parts[1:-1]))
                elif folder_parts:
                    result["folder"] = str(Path(*folder_parts))
                return result

    # 3. Normal classification
    result = _classify_path_raw(rel_path)
    # For Camera/ geo records, derive folder from path so general_folder is set
    if result["type"] == "geo" and rel_path.startswith("Camera/"):
        if len(p_parts) > 2:
            result = dict(result)
            result.setdefault("folder", str(Path(*p_parts[1:-1])))
    return result


def _classify_path_raw(rel_path: str) -> dict:
    """
    Internal implementation of classify_path (without the Camera/ folder injection).
    Returns one of:
      {'type': 'geo',     'continent': ..., 'country': ..., 'city': ...,
                          'folder_hint_year': ..., 'folder_hint_month': ...}
      {'type': 'general', 'folder': <original rel dir, dot-stripped>}
    """
    parts = Path(rel_path).parts   # includes filename as last element
    if len(parts) < 2:
        return {"type": "general", "folder": parts[0] if parts else "unknown"}

    # Strip the Camera/ prefix — the geo/general structure starts beneath it
    if parts[0] == "Camera":
        parts = parts[1:]
        if len(parts) < 2:
            return {"type": "general", "folder": "Camera"}

    root = parts[0]

    # ── .Amigos — new geographic structure ───────────────────────────────────
    # Country-first:  .Amigos/{Country}/{City}/...
    # Person-first:   .Amigos/{Person}/{Country}/{City}/...
    if root == ".Amigos":
        if len(parts) < 3:
            return {"type": "general", "folder": str(Path(*parts[:-1])).lstrip(".")}
        level1 = parts[1]
        country_en = COUNTRY_NORMALIZE.get(level1)
        if country_en is not None:
            # Country-first format
            city_raw = parts[2] if len(parts) > 2 else None
            city     = (_extract_city_token(city_raw) or city_raw) if city_raw else None
            continent = _COUNTRY_CONTINENT.get(country_en)
        else:
            # Person-first format: .Amigos/{Person}/{Country}/{City}/...
            if len(parts) < 4:
                return {"type": "general", "folder": str(Path(*parts[:-1])).lstrip(".")}
            country_en = COUNTRY_NORMALIZE.get(parts[2], parts[2])
            city_raw   = parts[3] if len(parts) > 3 else None
            city       = (_extract_city_token(city_raw) or city_raw) if city_raw else None
            continent  = _COUNTRY_CONTINENT.get(country_en)
        return {"type": "geo", "continent": continent,
                "country": country_en, "city": city,
                "folder_hint_year": None, "folder_hint_month": None}

    # ── .Whatsapp — geographic hierarchy: .Whatsapp/{Country}/{City}/... ──────
    if root == ".Whatsapp":
        if len(parts) >= 3:
            country_en = COUNTRY_NORMALIZE.get(parts[1], parts[1])
            city       = _extract_city_token(parts[2]) or parts[2]
            continent  = _COUNTRY_CONTINENT.get(country_en)
            return {"type": "geo", "continent": continent,
                    "country": country_en, "city": city,
                    "folder_hint_year": None, "folder_hint_month": None}
        return {"type": "geo", "continent": "Central America",
                "country": "Costa Rica", "city": "Tibás",
                "folder_hint_year": None, "folder_hint_month": None}

    # ── Purely non-geographic roots ──────────────────────────────────────────
    if root in NON_GEO_ROOTS:
        folder = str(Path(*parts[:-1])).lstrip(".")
        return {"type": "general", "folder": folder}

    # ── Costa Rica ───────────────────────────────────────────────────────────
    # Sub-folders that carry geographic meaning: Turismo CR, Voluntariados,
    # Paseos en automovil/bicicleta, Visitas.  Everything else → general.
    if root == "Costa Rica":
        geo_sub = {"Turismo CR", "Voluntariados", "Paseos en automovil",
                   "Paseos en bicicleta", "Visitas", "Mastatal", ".Amigos"}
        if len(parts) >= 3 and parts[1] in geo_sub:
            city = _extract_city_token(parts[2]) or parts[2]
            hy, hm = _date_from_folder(parts[2])
            return {"type": "geo", "continent": "Central America",
                    "country": "Costa Rica", "city": city,
                    "folder_hint_year": hy, "folder_hint_month": hm}
        folder = str(Path(*parts[:-1])).lstrip(".")
        return {"type": "general", "folder": folder}

    # ── World Tour 2016 ──────────────────────────────────────────────────────
    if root == "World Tour 2016":
        if len(parts) >= 2:
            city = parts[1]
            return {"type": "geo", "continent": None,
                    "country": None, "city": city,
                    "folder_hint_year": 2016, "folder_hint_month": None}
        return {"type": "general", "folder": str(Path(*parts[:-1]))}

    # ── Continent roots: Africa, Europa, Suramerica, Norteamerica ────────────
    if root in GEO_CONTINENT_ROOTS:
        continent = GEO_CONTINENT_ROOTS[root]

        if len(parts) < 3:
            # Only continent/country depth – country-level geo entry
            country_raw = parts[1] if len(parts) >= 2 else root
            country = COUNTRY_NORMALIZE.get(country_raw, country_raw)
            if country is None:
                return {"type": "general", "folder": str(Path(*parts[:-1]))}
            return {"type": "geo", "continent": continent,
                    "country": country, "city": None,
                    "folder_hint_year": None, "folder_hint_month": None}

        level2 = parts[1]

        # ── Special multi-country / personal folders at level-2 ──────────────
        if level2 in _NON_COUNTRY_LEVEL2:
            # Viaje Europa sub-folders use "Country - City" pattern
            if len(parts) >= 4 and " - " in parts[2]:
                sub = parts[2].split(" - ")
                country_raw = sub[0].strip()
                city_raw    = sub[1].strip() if len(sub) > 1 else None
                country = COUNTRY_NORMALIZE.get(country_raw)
                if country:
                    city = _extract_city_token(city_raw) if city_raw else None
                    hy, hm = _date_from_folder(parts[2])
                    return {"type": "geo", "continent": continent,
                            "country": country, "city": city,
                            "folder_hint_year": hy, "folder_hint_month": hm}
            # Norteamerica/Viaje Monica/Los Angeles pattern
            if root == "Norteamerica" and len(parts) >= 4:
                city = _extract_city_token(parts[2]) or parts[2]
                hy, hm = _date_from_folder(level2)
                return {"type": "geo", "continent": continent,
                        "country": "USA", "city": city,
                        "folder_hint_year": hy, "folder_hint_month": hm}
            folder = str(Path(*parts[:-1])).lstrip(".")
            return {"type": "general", "folder": folder}

        # ── Visitas: Camera/Europa/Visitas/{Trip}/{Country} - {City}/ ────────
        if level2 == "Visitas":
            if len(parts) >= 5 and " - " in parts[3]:
                country_raw, city = parts[3].split(" - ", 1)
                country = COUNTRY_NORMALIZE.get(country_raw)
                if country:
                    return {"type": "geo", "continent": continent,
                            "country": country, "city": city,
                            "folder_hint_year": None, "folder_hint_month": None}
            folder = str(Path(*parts[:-1])).lstrip(".")
            return {"type": "general", "folder": folder}

        # ── "Country - City" style level-2 folder (any continent) ─────────────
        if " - " in level2:
            parts_l2    = level2.split(" - ", 1)
            country_raw = parts_l2[0].strip()
            city_raw    = parts_l2[1].strip() if len(parts_l2) > 1 else None
            country     = COUNTRY_NORMALIZE.get(country_raw)
            if country:
                hy, hm = _date_from_folder(level2)
                return {"type": "geo", "continent": continent,
                        "country": country, "city": city_raw,
                        "folder_hint_year": hy, "folder_hint_month": hm}
            folder = str(Path(*parts[:-1])).lstrip(".")
            return {"type": "general", "folder": folder}

        # ── Standard Continent / Country / City structure ────────────────────
        country = COUNTRY_NORMALIZE.get(level2, level2)

        # ── Costa Rica inside Latinoamerica ──────────────────────────────────
        # Geo categories (activity/theme buckets): city is parts[3]
        _CR_GEO_CATS = {"Turismo CR", "Voluntariados",
                        "Paseos en automovil", "Paseos en bicicleta"}
        # Direct city folders (parts[2] IS the city name)
        _CR_DIRECT_CITIES = {
            "Cartago", "Colima", "Colima de Tibás", "Mastatal", "Moravia",
            "Universidad de Costa Rica",
        }
        if country == "Costa Rica":
            if len(parts) >= 5 and parts[2] in _CR_GEO_CATS:
                city = _extract_city_token(parts[3]) or parts[3]
                hy, hm = _date_from_folder(parts[3])
                _CR_SUBCITY_MAP = {
                    ('Turrialba', 'Juan Viñas'): 'Juan Viñas de Turrialba',
                    ('Turrialba', 'Tuis'):       'Tuis',
                }
                if len(parts) >= 6:
                    mapped = _CR_SUBCITY_MAP.get((city, parts[4]))
                    if mapped:
                        city = mapped
                return {"type": "geo", "continent": continent,
                        "country": "Costa Rica", "city": city,
                        "folder_hint_year": hy, "folder_hint_month": hm}
            # Direct city (Colima, Cartago, Moravia, …): parts[2] is the city
            if len(parts) >= 4 and parts[2] in _CR_DIRECT_CITIES:
                city = parts[2]
                hy, hm = _date_from_folder(parts[2])
                return {"type": "geo", "continent": continent,
                        "country": "Costa Rica", "city": city,
                        "folder_hint_year": hy, "folder_hint_month": hm}

        if country is None:
            # Country entry maps to None (e.g. "Paises Balticos" splits into sub-cities)
            if len(parts) >= 4:
                city = _extract_city_token(parts[2]) or parts[2]
                hy, hm = _date_from_folder(parts[2])
                return {"type": "geo", "continent": continent,
                        "country": level2, "city": city,
                        "folder_hint_year": hy, "folder_hint_month": hm}
            return {"type": "general", "folder": str(Path(*parts[:-1])).lstrip(".")}

        # parts[-1] is the filename; a city sub-folder only exists when len >= 4
        if len(parts) >= 4:
            level3 = parts[2]
            city = _extract_city_token(level3)
            hy, hm = _date_from_folder(level3)
            if city is None:
                # USA/Canada: trip-folder (e.g. "Viaje Fernando-julio 2003") wraps
                # real city names at level-4.  Promote level-4 as city.
                if country in ("USA", "Canada") and len(parts) >= 5:
                    sub_city = _extract_city_token(parts[3]) or parts[3]
                    if sub_city:
                        hy2, hm2 = _date_from_folder(level3)
                        return {"type": "geo", "continent": continent,
                                "country": country, "city": sub_city,
                                "folder_hint_year": hy2, "folder_hint_month": hm2}
                # level-3 name looks non-geographic → general, preserve full path
                folder = str(Path(*parts[:-1])).lstrip(".")
                return {"type": "general", "folder": folder}
        else:
            # File is directly inside the country folder – no city sub-folder
            city = hy = hm = None

        # España region containers: Navarra, Cataluña, Asturias, Andalucia, etc.
        # → level-4 is the actual city/place, not the region
        _ESPAÑA_REGION_CONTAINERS = {"Navarra", "Cataluña", "Asturias", "Andalucia"}
        if country == "Spain" and city in _ESPAÑA_REGION_CONTAINERS and len(parts) >= 5:
            sub_city = _extract_city_token(parts[3])
            if sub_city and sub_city != city:
                hy2, hm2 = _date_from_folder(parts[3])
                city = sub_city
                hy = hy2 or hy
                hm = hm2 or hm

        # Trip/visit-style level-3 folder (e.g. "Visita agosto 2008") → real city is level-4
        if (city and city.lower().startswith(('visita', 'viaje', 'viagem'))
                and len(parts) >= 5):
            sub_city = _extract_city_token(parts[3])
            if sub_city:
                city = sub_city

        return {"type": "geo", "continent": continent,
                "country": country, "city": city,
                "folder_hint_year": hy, "folder_hint_month": hm}

    # ── Unknown root → general ────────────────────────────────────────────────
    folder = str(Path(*parts[:-1])).lstrip(".")
    return {"type": "general", "folder": folder}


# ── Geocoding ─────────────────────────────────────────────────────────────────

_last_geocode_time = 0.0


def geocode(db: sqlite3.Connection, city: Optional[str], country: Optional[str]) -> tuple[Optional[float], Optional[float]]:
    """Return (lat, lng) for city+country. Results are cached in SQLite."""
    global _last_geocode_time

    query = ", ".join(filter(None, [city, country]))
    if not query:
        return None, None

    row = db.execute("SELECT lat, lng, success FROM geo_cache WHERE query=?", (query,)).fetchone()
    if row:
        return (row["lat"], row["lng"]) if row["success"] else (None, None)

    # Rate-limit
    elapsed = time.monotonic() - _last_geocode_time
    if elapsed < NOMINATIM_DELAY:
        time.sleep(NOMINATIM_DELAY - elapsed)
    _last_geocode_time = time.monotonic()

    try:
        resp = requests.get(NOMINATIM_URL, params={"q": query, "format": "json", "limit": 1},
                            headers={"User-Agent": NOMINATIM_UA}, timeout=10)
        resp.raise_for_status()
        results = resp.json()
        if results:
            lat = round(float(results[0]["lat"]), 5)
            lng = round(float(results[0]["lon"]), 5)
            db.execute("INSERT OR REPLACE INTO geo_cache VALUES (?,?,?,?,1,?)",
                       (query, lat, lng, results[0].get("display_name"), datetime.now().isoformat()))
            db.commit()
            return lat, lng
        else:
            db.execute("INSERT OR REPLACE INTO geo_cache VALUES (?,NULL,NULL,NULL,0,?)",
                       (query, datetime.now().isoformat()))
            db.commit()
            return None, None
    except Exception as e:
        log.warning(f"Geocode failed for '{query}': {e}")
        return None, None


# ── Thumbnail generation ──────────────────────────────────────────────────────

def generate_thumbnail(path: Path) -> Optional[bytes]:
    ext = path.suffix.lower()
    if ext in VIDEO_EXTS or ext in {".cr2", ".nef", ".arw", ".dng", ".orf", ".rw2"}:
        return None
    if ext in {".heic", ".heif"}:
        try:
            from pillow_heif import register_heif_opener
            register_heif_opener()
        except ImportError:
            return None
    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            img.thumbnail((THUMB_WIDTH, THUMB_WIDTH * 3), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=THUMB_QUALITY, optimize=True)
            return buf.getvalue()
    except Exception as e:
        log.debug(f"Thumbnail failed {path.name}: {e}")
        return None


# ── S3 upload ─────────────────────────────────────────────────────────────────

def _s3_key(file_hash: str, ext: str) -> str:
    return f"photos/{file_hash[:2]}/{file_hash}{ext.lower()}"


def _thumb_key(file_hash: str) -> str:
    return f"thumbs/{file_hash[:2]}/{file_hash}.jpg"


def upload_photo(s3, path: Path, file_hash: str, dry_run: bool) -> str:
    ext = path.suffix.lower()
    key = _s3_key(file_hash, ext)
    if not dry_run:
        s3.upload_file(
            Filename=str(path),
            Bucket=BUCKET,
            Key=key,
            ExtraArgs={"StorageClass": "GLACIER_IR",
                       "ContentType": "image/jpeg" if ext in {".jpg", ".jpeg", ".jpe"} else "application/octet-stream"},
        )
    return key


def upload_thumbnail(s3, thumb_bytes: bytes, file_hash: str, dry_run: bool) -> str:
    key = _thumb_key(file_hash)
    if not dry_run:
        s3.put_object(Bucket=BUCKET, Key=key, Body=thumb_bytes,
                      ContentType="image/jpeg", CacheControl="max-age=2592000")
    return key


# ── Video transcoding ─────────────────────────────────────────────────────────

def _proxy_key(file_hash: str) -> str:
    return f"proxies/{file_hash[:2]}/{file_hash}.mp4"


def transcode_to_mp4(source: Path) -> Optional[bytes]:
    """Transcode a non-MP4 video to H.264 MP4. Returns bytes or None on failure."""
    if source.suffix.lower() not in NON_MP4_VIDEO_EXTS:
        return None
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        result = subprocess.run([
            "ffmpeg", "-y", "-i", str(source),
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            tmp_path,
        ], capture_output=True, timeout=600)
        if result.returncode != 0:
            log.warning(f"ffmpeg failed for {source.name}: {result.stderr[-300:].decode(errors='replace')}")
            return None
        with open(tmp_path, "rb") as f:
            return f.read()
    except subprocess.TimeoutExpired:
        log.warning(f"ffmpeg timeout for {source.name}")
        return None
    except Exception as e:
        log.warning(f"ffmpeg error for {source.name}: {e}")
        return None
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def upload_video_proxy(s3, proxy_bytes: bytes, file_hash: str, dry_run: bool) -> Optional[str]:
    key = _proxy_key(file_hash)
    if dry_run:
        return key
    try:
        s3.put_object(Bucket=BUCKET, Key=key, Body=proxy_bytes,
                      ContentType="video/mp4", CacheControl="max-age=2592000")
        return key
    except Exception as e:
        log.warning(f"S3 proxy upload failed {key}: {e}")
        return None


# ── Index building ────────────────────────────────────────────────────────────

def build_and_upload_index(db: sqlite3.Connection, s3, dry_run: bool):
    log.info("Building index …")
    active = db.execute(
        "SELECT * FROM photos WHERE status='active' AND s3_uploaded=1"
    ).fetchall()

    # ── index/time/{year}.json ────────────────────────────────────────────────
    by_year: dict[int, list] = {}
    for row in active:
        y = row["year"]
        if y:
            by_year.setdefault(y, []).append({
                "hash":    row["hash"],
                "s3_key":  row["s3_key"],
                "thumb":   row["thumb_key"],
                "dt":      row["datetime_taken"],
                "month":   row["month"],
                "day":     row["day"],
                "lat":     row["lat"],
                "lng":     row["lng"],
                "country": row["country"],
                "city":    row["city"],
                "folder":  row["general_folder"],
                "path":    row["current_path"],
                "w":       row["width"],
                "h":       row["height"],
                "video_proxy": row["video_proxy_key"],
            })

    for year, photos in by_year.items():
        photos.sort(key=lambda p: p["dt"] or "")
        _put_index(s3, f"index/time/{year}.json", photos, dry_run)

    # ── index/geo/{Country}_{City}.json ───────────────────────────────────────
    geo_rows = [r for r in active if r["country"] or r["city"]]
    by_location: dict[str, list] = {}
    for row in geo_rows:
        key = f"{row['country'] or 'Unknown'}_{row['city'] or 'Unknown'}"
        key = re.sub(r"[^\w\-]", "_", key)
        by_location.setdefault(key, []).append({
            "hash":    row["hash"],
            "s3_key":  row["s3_key"],
            "thumb":   row["thumb_key"],
            "dt":      row["datetime_taken"],
            "lat":     row["lat"],
            "lng":     row["lng"],
            "country": row["country"],
            "city":    row["city"],
            "folder":  row["general_folder"],
            "path":    row["current_path"],
            "w":       row["width"],
            "h":       row["height"],
            "video_proxy": row["video_proxy_key"],
        })

    for loc_key, photos in by_location.items():
        _put_index(s3, f"index/geo/{loc_key}.json", photos, dry_run)

    # ── index/general/{folder_path}.json ─────────────────────────────────────
    gen_rows = [r for r in active if r["general_folder"]]
    by_folder: dict[str, list] = {}
    for row in gen_rows:
        folder_key = re.sub(r"[^\w\-/]", "_", row["general_folder"])
        by_folder.setdefault(folder_key, []).append({
            "hash":    row["hash"],
            "s3_key":  row["s3_key"],
            "thumb":   row["thumb_key"],
            "dt":      row["datetime_taken"],
            "lat":     row["lat"],
            "lng":     row["lng"],
            "country": row["country"],
            "city":    row["city"],
            "folder":  row["general_folder"],
            "path":    row["current_path"],
            "w":       row["width"],
            "h":       row["height"],
            "video_proxy": row["video_proxy_key"],
        })

    # Non-Camera photos with gf=NULL (e.g. .Amigos geo records) also need general
    # index files, using their current_path directory as the folder key — same key
    # used by path_tags generation so the app can find the file.
    for row in active:
        cp = str(row["current_path"] or "")
        if row["general_folder"] or not cp or "/" not in cp or cp.startswith("Camera/"):
            continue
        dir_path = str(Path(cp).parent)
        folder_key = re.sub(r"[^\w\-/]", "_", dir_path)
        by_folder.setdefault(folder_key, []).append({
            "hash":    row["hash"],
            "s3_key":  row["s3_key"],
            "thumb":   row["thumb_key"],
            "dt":      row["datetime_taken"],
            "lat":     row["lat"],
            "lng":     row["lng"],
            "country": row["country"],
            "city":    row["city"],
            "folder":  dir_path,
            "path":    row["current_path"],
            "w":       row["width"],
            "h":       row["height"],
            "video_proxy": row["video_proxy_key"],
        })

    for folder_key, photos in by_folder.items():
        photos.sort(key=lambda p: p["dt"] or "")
        # Preserve sub-folder path in the key name
        index_key = f"index/general/{folder_key}.json"
        _put_index(s3, index_key, photos, dry_run)

    # ── index/summary.json ────────────────────────────────────────────────────
    countries = db.execute("""
        SELECT country, city, continent,
               COUNT(*) as count,
               AVG(lat) as avg_lat, AVG(lng) as avg_lng
        FROM photos
        WHERE status='active' AND s3_uploaded=1 AND country IS NOT NULL
        GROUP BY country, city
        ORDER BY country, city
    """).fetchall()

    summary = {
        "generated": datetime.now().isoformat(),
        "total": len(active),
        "locations": [
            {"continent": r["continent"], "country": r["country"],
             "city": r["city"], "count": r["count"],
             "lat": round(r["avg_lat"], 4) if r["avg_lat"] else None,
             "lng": round(r["avg_lng"], 4) if r["avg_lng"] else None}
            for r in countries
        ],
        "years": sorted(by_year.keys()),
        "general_folders": sorted({
            re.sub(r"[^\w\-/]", "_", r["general_folder"])
            for r in gen_rows if r["general_folder"]
        }),
    }
    _put_index(s3, "index/summary.json", summary, dry_run)

    # ── index/recent.json — last 100 added photos (for Latest > Added tab) ────
    recent_rows = db.execute("""
        SELECT hash, s3_key, thumb_key, datetime_taken, year, month, day,
               lat, lng, country, city, general_folder, current_path, width, height, created_at,
               video_proxy_key
        FROM photos
        WHERE status='active' AND s3_uploaded=1
        ORDER BY created_at DESC
        LIMIT 100
    """).fetchall()
    recent_photos = [{
        "hash":    r["hash"],
        "s3_key":  r["s3_key"],
        "thumb":   r["thumb_key"],
        "dt":      r["datetime_taken"],
        "addedAt": r["created_at"],
        "lat":     r["lat"],
        "lng":     r["lng"],
        "country": r["country"],
        "city":    r["city"],
        "folder":  r["general_folder"],
        "path":    r["current_path"],
        "w":       r["width"],
        "h":       r["height"],
        "video_proxy": r["video_proxy_key"],
    } for r in recent_rows]
    _put_index(s3, "index/recent.json", {"updated": datetime.now().isoformat(), "photos": recent_photos}, dry_run)

    # ── index/stats.json — aggregated statistics for the Statistics tab ────────
    stats_rows = db.execute("""
        SELECT strftime('%Y-%m', datetime_taken) AS ym,
               COUNT(*) AS cnt
        FROM   photos
        WHERE  status = 'active'
          AND  s3_uploaded = 1
          AND  datetime_taken IS NOT NULL
          AND  datetime_taken != ''
        GROUP  BY ym
        ORDER  BY ym
    """).fetchall()
    by_month = [{"ym": r["ym"], "count": r["cnt"]} for r in stats_rows if r["ym"]]

    total_active = db.execute(
        "SELECT COUNT(*) FROM photos WHERE status='active' AND s3_uploaded=1"
    ).fetchone()[0]
    no_date = db.execute(
        "SELECT COUNT(*) FROM photos WHERE status='active' AND s3_uploaded=1"
        " AND (datetime_taken IS NULL OR datetime_taken = '')"
    ).fetchone()[0]

    _put_index(s3, "index/stats.json", {
        "generated": datetime.now().isoformat(),
        "total":     total_active,
        "no_date":   no_date,
        "by_month":  by_month,
    }, dry_run)

    # ── index/private.json — hashes of non-Camera photos (owner-only) ──────────
    non_camera = [r for r in active if not str(r["current_path"] or "").startswith("Camera/")]
    private_hashes = [r["hash"] for r in non_camera]
    _put_index(s3, "index/private.json", {"photos": private_hashes, "albums": []}, dry_run)

    # ── index/tags/system.json + index/sys/{slug}.json ────────────────────────
    by_sys_tag: dict[str, list] = {}
    for row in active:
        tag = _system_tag(row["current_path"] or "")
        if not tag:
            continue
        by_sys_tag.setdefault(tag, []).append({
            "hash":    row["hash"],
            "s3_key":  row["s3_key"],
            "thumb":   row["thumb_key"],
            "dt":      row["datetime_taken"],
            "lat":     row["lat"],
            "lng":     row["lng"],
            "country": row["country"],
            "city":    row["city"],
            "folder":  row["general_folder"],
            "path":    row["current_path"],
            "w":       row["width"],
            "h":       row["height"],
            "video_proxy": row["video_proxy_key"],
        })

    sys_tag_index: dict = {"updated": datetime.now().isoformat(), "tags": {}}
    for tag_name, photos in by_sys_tag.items():
        photos.sort(key=lambda p: p["dt"] or "")
        slug = re.sub(r"[^\w\-]", "_", tag_name)
        _put_index(s3, f"index/sys/{slug}.json", photos, dry_run)
        is_public = any(str(p.get("path") or "").startswith("Camera/") for p in photos)
        # Compute average lat/lng from photos that have GPS coordinates.
        # These come from actual EXIF GPS or Nominatim geocoding and are far
        # more accurate than the hardcoded fallback table in sysTags.ts.
        coords = [(p["lat"], p["lng"]) for p in photos
                  if p.get("lat") is not None and p.get("lng") is not None]
        avg_lat = round(sum(c[0] for c in coords) / len(coords), 5) if coords else None
        avg_lng = round(sum(c[1] for c in coords) / len(coords), 5) if coords else None
        sys_tag_index["tags"][tag_name] = {
            "count": len(photos), "slug": slug, "public": is_public,
            "lat": avg_lat, "lng": avg_lng,
        }

    # Special "Videos" system tag — all video files across all folders
    video_rows = [r for r in active if r["media_type"] == "video"]
    if video_rows:
        video_photos = [{
            "hash":    r["hash"],
            "s3_key":  r["s3_key"],
            "thumb":   r["thumb_key"],
            "dt":      r["datetime_taken"],
            "lat":     r["lat"],
            "lng":     r["lng"],
            "country": r["country"],
            "city":    r["city"],
            "folder":  r["general_folder"],
            "path":    r["current_path"],
            "w":       r["width"],
            "h":       r["height"],
            "video_proxy": r["video_proxy_key"],
        } for r in video_rows]
        video_photos.sort(key=lambda p: p["dt"] or "")
        _put_index(s3, "index/sys/Videos.json", video_photos, dry_run)
        sys_tag_index["tags"]["Videos"] = {"count": len(video_photos), "slug": "Videos"}

    _put_index(s3, "index/tags/system.json", sys_tag_index, dry_run)

    # ── index/path_tags.json + index/folder_paths.json ────────────────────────
    # path_tags: [{display, s3}] for every folder that has indexed photos.
    # Camera/ → "Camera/" + general_folder; all others → directory of current_path.
    # Using current_path for non-Camera ensures .Amigos folders with geo-type
    # classification (general_folder=NULL) still appear in the tree.
    # Includes all ancestor paths so the tree can be built without intermediate gaps.
    path_tags_map: dict[str, str] = {}   # display → s3_key
    for row in active:
        cp = str(row["current_path"] or "")
        if not cp or "/" not in cp:
            continue
        is_camera = cp.startswith("Camera/")
        if is_camera:
            gf = row["general_folder"]
            if not gf:
                continue
            parts = gf.split("/")
            for depth in range(1, len(parts) + 1):
                ancestor = "/".join(parts[:depth])
                display = "Camera/" + ancestor
                s3_key = re.sub(r"[^\w\-/]", "_", ancestor)
                path_tags_map.setdefault(display, s3_key)
        else:
            dir_path = str(Path(cp).parent)
            dir_parts = dir_path.split("/")
            for depth in range(1, len(dir_parts) + 1):
                ancestor = "/".join(dir_parts[:depth])
                s3_key = re.sub(r"[^\w\-/]", "_", ancestor)
                path_tags_map.setdefault(ancestor, s3_key)
    path_tags_list = sorted([{"display": k, "s3": v} for k, v in path_tags_map.items()],
                            key=lambda x: x["display"])
    _put_index(s3, "index/path_tags.json", path_tags_list, dry_run)
    _put_index(s3, "index/folder_paths.json", sorted(path_tags_map.keys()), dry_run)

    log.info(f"Index: {len(by_year)} year files, {len(by_location)} location files, "
             f"{len(by_folder)} general files, {len(recent_photos)} recent, "
             f"{len(by_month)} monthly stats, {len(by_sys_tag)} system tags, "
             f"{len(video_rows) if video_rows else 0} videos, "
             f"{len(private_hashes)} private hashes, "
             f"{len(path_tags_list)} path tags")

    if not dry_run:
        try:
            import gen_coordinates_csv
            n = gen_coordinates_csv.generate()
            log.info(f"coordinates.csv updated — {n} rows")
        except Exception as exc:
            log.warning(f"coordinates.csv generation failed: {exc}")


def _put_index(s3, key: str, data, dry_run: bool):
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    if not dry_run:
        # recent.json changes every ingest — never cache it
        # Other index files can be cached for 1 hour
        cache_control = "no-cache, no-store, must-revalidate" if "recent" in key else "max-age=3600"
        s3.put_object(Bucket=BUCKET, Key=key, Body=body,
                      ContentType="application/json",
                      CacheControl=cache_control,
                      ContentEncoding="identity")


# ── Main orchestration ────────────────────────────────────────────────────────

def process_photo(args) -> dict:
    """Worker function for ThreadPoolExecutor: process one new/moved photo."""
    file_hash, path, meta, s3, dry_run = args
    result = {"hash": file_hash, "ok": False, "moved": False, "error": None,
              "video_proxy_key": None}

    try:
        # Thumbnail
        thumb_bytes = generate_thumbnail(path)
        thumb_key = None
        if thumb_bytes:
            thumb_key = upload_thumbnail(s3, thumb_bytes, file_hash, dry_run)

        # Photo upload
        s3_key = upload_photo(s3, path, file_hash, dry_run)

        # Video proxy: transcode non-MP4 formats to H.264 MP4
        video_proxy_key = None
        if path.suffix.lower() in NON_MP4_VIDEO_EXTS:
            proxy_bytes = transcode_to_mp4(path)
            if proxy_bytes:
                video_proxy_key = upload_video_proxy(s3, proxy_bytes, file_hash, dry_run)

        result.update({"ok": True, "s3_key": s3_key, "thumb_key": thumb_key,
                        "video_proxy_key": video_proxy_key})
    except Exception as e:
        result["error"] = str(e)

    return result


def _fix_dates(db: sqlite3.Connection, dry_run: bool):
    """
    Retroactively fill datetime_taken / year / month / day for records that
    have no EXIF date by parsing the stored filename.
    Run with --fix-dates; automatically rebuilds the index afterward.
    """
    rows = db.execute(
        "SELECT hash, filename FROM photos WHERE datetime_taken IS NULL AND status='active'"
    ).fetchall()
    log.info(f"Fixing dates for {len(rows):,} records with no EXIF datetime …")

    updated = 0
    batch = []
    for row in rows:
        iso, y, mo, d = parse_filename_date(row["filename"])
        if y:
            batch.append((iso, y, mo, d, row["hash"]))
            updated += 1

    if batch and not dry_run:
        db.executemany(
            "UPDATE photos SET datetime_taken=?, year=?, month=?, day=? WHERE hash=?",
            batch,
        )
        db.commit()

    log.info(f"  Updated {updated:,} records from filename dates "
             f"({len(rows) - updated:,} still have no date)")


def _fix_geo(db: sqlite3.Connection, dry_run: bool):
    """Re-classify Camera/, .Amigos/, and .Whatsapp/ records without a disk scan."""
    rows = db.execute("""
        SELECT hash, current_path, lat, lng FROM photos
        WHERE (current_path LIKE 'Camera/%'
               OR current_path LIKE '.Amigos/%'
               OR current_path LIKE '.Whatsapp/%')
          AND status = 'active'
    """).fetchall()
    log.info(f"Re-classifying {len(rows):,} Camera/+.Amigos/+.Whatsapp/ records …")
    batch = []
    for row in rows:
        cls = classify_path(row["current_path"])
        lat, lng = row["lat"], row["lng"]
        if lat is None and cls["type"] == "geo":
            lat, lng = geocode(db, cls.get("city"), cls.get("country"))
        batch.append((
            cls.get("continent") if cls["type"] == "geo" else None,
            cls.get("country")   if cls["type"] == "geo" else None,
            cls.get("city")      if cls["type"] == "geo" else None,
            cls.get("folder"),
            lat, lng,
            datetime.now().isoformat(),
            row["hash"],
        ))
    if batch and not dry_run:
        db.executemany(
            """UPDATE photos SET continent=?, country=?, city=?, general_folder=?,
               lat=?, lng=?, updated_at=? WHERE hash=?""",
            batch,
        )
        db.commit()
    log.info(f"  Done — {len(batch):,} records updated")


def run(args):
    db = open_db()
    s3 = boto3.client("s3", region_name=REGION)

    # Load unique_pin.txt / no_location.txt marker files from disk
    _load_marker_files(args.root)

    if args.reindex_only:
        build_and_upload_index(db, s3, args.dry_run)
        return

    if args.fix_dates:
        _fix_dates(db, args.dry_run)
        build_and_upload_index(db, s3, args.dry_run)
        return

    if args.fix_geo:
        _fix_geo(db, args.dry_run)
        build_and_upload_index(db, s3, args.dry_run)
        return

    # ── 1. Scan local files ───────────────────────────────────────────────────
    log.info(f"Scanning {PHOTOS_ROOT} …")
    local: dict[str, Path] = scan_local(args.root, db)
    log.info(f"Found {len(local):,} media files locally")

    # ── 2. Load DB state ──────────────────────────────────────────────────────
    db_rows = {r["hash"]: r for r in db.execute("SELECT * FROM photos").fetchall()}
    db_active = {h: r for h, r in db_rows.items() if r["status"] == "active"}

    new_hashes     = [h for h in local if h not in db_rows]
    moved_hashes   = [h for h in local if h in db_active
                      and str(local[h].relative_to(args.root)) != db_active[h]["current_path"]]
    deleted_hashes = [h for h in db_active if h not in local]

    log.info(f"New: {len(new_hashes):,}  |  Moved: {len(moved_hashes):,}  |  "
             f"Deleted: {len(deleted_hashes):,}  |  Unchanged: "
             f"{len(local) - len(new_hashes) - len(moved_hashes):,}")

    # ── 2b. Resurrect deleted records found back on disk ─────────────────────
    resurrected_hashes = [h for h in local if h in db_rows and db_rows[h]["status"] == "deleted"]
    if resurrected_hashes:
        log.info(f"Resurrecting {len(resurrected_hashes):,} previously-deleted files found on disk …")
        if not args.dry_run:
            now_iso = datetime.now().isoformat()
            batch = []
            for h in resurrected_hashes:
                new_rel = str(local[h].relative_to(args.root))
                cls = classify_path(new_rel)
                batch.append((
                    new_rel, local[h].name,
                    cls.get("continent") if cls["type"] == "geo" else None,
                    cls.get("country")   if cls["type"] == "geo" else None,
                    cls.get("city")      if cls["type"] == "geo" else None,
                    cls.get("folder"),
                    now_iso, h,
                ))
            db.executemany(
                """UPDATE photos SET status='active', current_path=?, filename=?,
                   continent=?, country=?, city=?, general_folder=?,
                   s3_uploaded=0, updated_at=? WHERE hash=?""",
                batch,
            )
            db.commit()
        # Add to new_hashes so they get re-uploaded in step 7
        new_hashes.extend(resurrected_hashes)
        log.info(f"  Resurrected {len(resurrected_hashes):,} files (queued for re-upload to S3)")

    # ── 3. Handle moves (no re-upload needed; re-classify geo when path changes) ─
    for h in moved_hashes:
        new_rel  = str(local[h].relative_to(args.root))
        old_path = db_active[h]["current_path"]
        log.info(f"Moved {h[:8]}…  {old_path}  →  {new_rel}")
        if not args.dry_run:
            cls = classify_path(new_rel)
            lat = db_active[h]["lat"]
            lng = db_active[h]["lng"]
            if lat is None and cls["type"] == "geo":
                lat, lng = geocode(db, cls.get("city"), cls.get("country"))
            db.execute(
                """UPDATE photos SET current_path=?, filename=?,
                   continent=?, country=?, city=?, general_folder=?,
                   lat=?, lng=?, updated_at=? WHERE hash=?""",
                (new_rel, local[h].name,
                 cls.get("continent") if cls["type"] == "geo" else None,
                 cls.get("country")   if cls["type"] == "geo" else None,
                 cls.get("city")      if cls["type"] == "geo" else None,
                 cls.get("folder"),
                 lat, lng,
                 datetime.now().isoformat(), h)
            )
    if moved_hashes and not args.dry_run:
        db.commit()

    # ── 3b. Re-classify existing .Amigos / .Whatsapp records ─────────────────
    # Photos already in DB under these roots may have old "general" classification.
    amigos_rows = db.execute(
        "SELECT hash, current_path, lat, lng FROM photos "
        "WHERE status='active' AND (current_path LIKE '.Amigos/%' OR current_path LIKE '.Whatsapp/%')"
    ).fetchall()
    if amigos_rows:
        log.info(f"Re-classifying {len(amigos_rows):,} .Amigos/.Whatsapp photos …")
        batch = []
        for row in amigos_rows:
            cls = classify_path(row["current_path"])
            lat, lng = row["lat"], row["lng"]
            if lat is None and cls["type"] == "geo":
                lat, lng = geocode(db, cls.get("city"), cls.get("country"))
            batch.append((
                cls.get("continent") if cls["type"] == "geo" else None,
                cls.get("country")   if cls["type"] == "geo" else None,
                cls.get("city")      if cls["type"] == "geo" else None,
                cls.get("folder"),
                lat, lng,
                datetime.now().isoformat(),
                row["hash"],
            ))
        if not args.dry_run:
            db.executemany(
                """UPDATE photos SET continent=?, country=?, city=?, general_folder=?,
                   lat=?, lng=?, updated_at=? WHERE hash=?""",
                batch,
            )
            db.commit()

    # ── 3c. Re-classify existing Camera/Europa/Visitas records ───────────────
    visitas_rows = db.execute(
        "SELECT hash, current_path, lat, lng FROM photos "
        "WHERE status='active' AND current_path LIKE 'Camera/Europa/Visitas/%'"
    ).fetchall()
    if visitas_rows:
        log.info(f"Re-classifying {len(visitas_rows):,} Visitas photos …")
        batch = []
        for row in visitas_rows:
            cls = classify_path(row["current_path"])
            lat, lng = row["lat"], row["lng"]
            if lat is None and cls["type"] == "geo":
                lat, lng = geocode(db, cls.get("city"), cls.get("country"))
            batch.append((
                cls.get("continent") if cls["type"] == "geo" else None,
                cls.get("country")   if cls["type"] == "geo" else None,
                cls.get("city")      if cls["type"] == "geo" else None,
                cls.get("folder"),
                lat, lng,
                datetime.now().isoformat(),
                row["hash"],
            ))
        if not args.dry_run:
            db.executemany(
                """UPDATE photos SET continent=?, country=?, city=?, general_folder=?,
                   lat=?, lng=?, updated_at=? WHERE hash=?""",
                batch,
            )
            db.commit()

    # ── 3d. Transcode existing non-MP4 videos that lack a proxy ──────────────
    proxy_needed_rows = db.execute(
        "SELECT hash, current_path FROM photos "
        "WHERE status='active' AND s3_uploaded=1 AND video_proxy_key IS NULL"
    ).fetchall()
    proxy_needed = [
        r for r in proxy_needed_rows
        if Path(r["current_path"]).suffix.lower() in NON_MP4_VIDEO_EXTS
    ]
    if proxy_needed:
        log.info(f"Transcoding {len(proxy_needed):,} non-MP4 videos to H.264 MP4 …")
        proxy_ok = proxy_fail = 0
        for row in proxy_needed:
            source = args.root / row["current_path"]
            if not source.exists():
                log.debug(f"Source missing for proxy: {source}")
                continue
            proxy_bytes = transcode_to_mp4(source)
            if proxy_bytes:
                pkey = upload_video_proxy(s3, proxy_bytes, row["hash"], args.dry_run)
                if pkey and not args.dry_run:
                    db.execute(
                        "UPDATE photos SET video_proxy_key=?, updated_at=? WHERE hash=?",
                        (pkey, datetime.now().isoformat(), row["hash"])
                    )
                proxy_ok += 1
            else:
                proxy_fail += 1
        if not args.dry_run:
            db.commit()
        log.info(f"  Proxy transcoding: {proxy_ok} ok, {proxy_fail} failed")

    # ── 4. Handle deletions — mark in DB and delete from S3 ──────────────────
    if deleted_hashes:
        log.info(f"Deleting {len(deleted_hashes):,} files (no longer on disk) …")
        if not args.dry_run:
            del_ok = del_fail = 0
            for h in deleted_hashes:
                row = db_active[h]
                for key in (row["s3_key"], row["thumb_key"]):
                    if not key:
                        continue
                    try:
                        s3.delete_object(Bucket=BUCKET, Key=key)
                        del_ok += 1
                    except Exception as e:
                        log.warning(f"S3 delete failed {key}: {e}")
                        del_fail += 1
            log.info(f"  S3 deletions: {del_ok} ok, {del_fail} failed")
            db.executemany(
                "UPDATE photos SET status='deleted', updated_at=? WHERE hash=?",
                [(datetime.now().isoformat(), h) for h in deleted_hashes]
            )
            db.commit()

    # ── 5. Geocode + classify new photos ─────────────────────────────────────
    log.info("Classifying and geocoding new files …")
    # Collect unique (city, country) pairs first to batch geocoding
    classification_cache: dict[str, dict] = {}
    geo_needed: set[tuple] = set()

    for h in new_hashes:
        rel = str(local[h].relative_to(args.root))
        cls = classify_path(rel)
        classification_cache[h] = cls
        if cls["type"] == "geo":
            geo_needed.add((cls.get("city"), cls.get("country")))

    log.info(f"Geocoding {len(geo_needed)} unique locations …")
    geo_results: dict[tuple, tuple] = {}
    geo_total = len(geo_needed)
    geo_fmt = "  Geocoding {n:>5,} / " + f"{geo_total:,}" + "  [{elapsed}<{remaining}]"
    for city, country in tqdm(geo_needed, bar_format=geo_fmt, unit="loc"):
        geo_results[(city, country)] = geocode(db, city, country)

    # ── 6. Prepare DB records for new photos ─────────────────────────────────
    now_iso = datetime.now().isoformat()
    new_records = []
    for h in new_hashes:
        path = local[h]
        rel  = str(path.relative_to(args.root))
        cls  = classification_cache[h]
        exif = extract_exif(path)

        # Use EXIF GPS if available; fall back to geocoded folder location
        lat = exif.pop("lat", None)
        lng = exif.pop("lng", None)
        if lat is None and cls["type"] == "geo":
            lat, lng = geo_results.get((cls.get("city"), cls.get("country")), (None, None))

        # Priority 1: EXIF DateTimeOriginal / DateTimeDigitized / DateTime
        # Priority 2: date embedded in filename  (e.g. IMG-20191019-WA0041, 20180904_120522)
        # Priority 3: year/month hinted by folder name  (e.g. "Barcelona - Agosto 2011")
        dt_iso = exif.get("datetime_taken")
        year   = exif.get("year")
        month  = exif.get("month")
        day    = exif.get("day")

        if not year:
            fn_iso, fn_y, fn_mo, fn_d = parse_filename_date(path.name)
            if fn_y:
                dt_iso, year, month, day = fn_iso, fn_y, fn_mo, fn_d

        if not year:
            year  = cls.get("folder_hint_year")
            month = month or cls.get("folder_hint_month")

        # Try to get image dimensions even for files we can't thumbnail
        width = exif.pop("width",  None)
        height= exif.pop("height", None)
        if width is None and path.suffix.lower() in IMAGE_EXTS - {".cr2",".nef",".arw",".dng"}:
            try:
                with Image.open(path) as im:
                    width, height = im.size
            except Exception:
                pass

        media_type = "video" if path.suffix.lower() in VIDEO_EXTS else "photo"

        new_records.append((
            h,                                          # hash
            None,                                       # s3_key (filled after upload)
            None,                                       # thumb_key
            rel,                                        # current_path
            path.name,                                  # filename
            lat, lng,
            dt_iso,
            year, month, day,
            cls.get("continent") if cls["type"] == "geo" else None,
            cls.get("country")   if cls["type"] == "geo" else None,
            cls.get("city")      if cls["type"] == "geo" else None,
            cls.get("folder"),
            exif.get("exif_make"),
            exif.get("exif_model"),
            width, height,
            path.stat().st_size,
            path.stat().st_mtime_ns,
            media_type,
            0, 0,                                       # s3_uploaded, thumb_uploaded
            "active",
            now_iso, now_iso,
        ))

    if new_records and not args.dry_run:
        db.executemany(
            """INSERT OR IGNORE INTO photos
               (hash, s3_key, thumb_key, current_path, filename,
                lat, lng, datetime_taken, year, month, day,
                continent, country, city, general_folder,
                exif_make, exif_model, width, height, size_bytes, mtime_ns,
                media_type, s3_uploaded, thumb_uploaded, status,
                created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            new_records,
        )
        db.commit()

    # ── 7. Upload new photos (parallel) ──────────────────────────────────────
    upload_needed = [
        h for h in new_hashes
        if not args.dry_run or True  # in dry_run we still prepare tasks for logging
    ]

    if upload_needed:
        log.info(f"Uploading {len(upload_needed):,} new files …")
        tasks = [
            (h, local[h], {}, s3, args.dry_run)
            for h in upload_needed
        ]
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(process_photo, t): t[0] for t in tasks}
            ok = fail = 0
            upload_total = len(futures)
            up_fmt = "  Uploading {n:>7,} / " + f"{upload_total:,}" + "  [{elapsed}<{remaining}  {rate_fmt}]"
            for future in tqdm(as_completed(futures), total=upload_total,
                               bar_format=up_fmt, unit="file"):
                res = future.result()
                h   = futures[future]
                if res["ok"]:
                    ok += 1
                    if not args.dry_run:
                        db.execute(
                            """UPDATE photos SET s3_key=?, thumb_key=?,
                               s3_uploaded=1, thumb_uploaded=?,
                               video_proxy_key=?, updated_at=? WHERE hash=?""",
                            (res["s3_key"],
                             res["thumb_key"],
                             1 if res["thumb_key"] else 0,
                             res["video_proxy_key"],
                             datetime.now().isoformat(), h)
                        )
                else:
                    fail += 1
                    log.warning(f"Upload failed {h[:8]}…: {res['error']}")

        if not args.dry_run:
            db.commit()
        log.info(f"Upload done – {ok:,} ok, {fail:,} failed")

    # ── 8. Build and upload index ─────────────────────────────────────────────
    if not args.skip_index:
        build_and_upload_index(db, s3, args.dry_run)

    # ── 9. Summary ────────────────────────────────────────────────────────────
    totals = db.execute(
        "SELECT COUNT(*) as n, SUM(size_bytes) as sz FROM photos WHERE status='active' AND s3_uploaded=1"
    ).fetchone()
    print()
    print("=" * 60)
    print(f"  Total in S3   : {totals['n']:,} files  "
          f"({(totals['sz'] or 0) / 1e9:.1f} GB)")
    print(f"  New uploaded  : {len(upload_needed):,}")
    print(f"  Moves updated : {len(moved_hashes):,}")
    print(f"  Marked deleted: {len(deleted_hashes):,}")
    print("=" * 60)

    db.close()


# ── CLI ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Photo Visor bulk ingest")
    parser.add_argument("--root",         type=Path, default=PHOTOS_ROOT,
                        help="Local photos root directory")
    parser.add_argument("--dry-run",      action="store_true",
                        help="Scan and classify without uploading")
    parser.add_argument("--reindex-only", action="store_true",
                        help="Rebuild index JSON from DB without scanning")
    parser.add_argument("--fix-dates",   action="store_true",
                        help="Fill missing datetimes from filenames, then reindex")
    parser.add_argument("--fix-geo",     action="store_true",
                        help="Re-classify Latinoamerica/Asia records and rebuild index")
    parser.add_argument("--skip-index",   action="store_true",
                        help="Upload photos but skip index rebuild")
    parser.add_argument("--workers",      type=int, default=UPLOAD_WORKERS,
                        help="Parallel upload threads (default 8)")
    parser.add_argument("--verbose",      action="store_true")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    run(args)
