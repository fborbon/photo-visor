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

PHOTOS_ROOT   = Path("/mnt/sda2/Personal/Fotos")
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
SKIP_EXTS  = {".ds_store", ".ini", ".txt", ".htm", ".html", ".js", ".css", ".pdf",
              ".doc", ".pps", ".zip", ".nomedia", ".thm", ".gif"}

# ── Geographic classification tables ─────────────────────────────────────────

# Top-level folders that are purely geographic (continent buckets)
GEO_CONTINENT_ROOTS = {
    "Africa":       "Africa",
    "Europa":       "Europe",
    "Suramerica":   "South America",
    "Norteamerica": "North America",
}

# Top-level folders treated as non-geographic → everything goes to general/
NON_GEO_ROOTS = {
    "Apuntes", "Atardeceres", "Automoviles", "Comics-Arts",
    "Comidas y recetas", "Google Earth", "Lecturas", "Memes",
    "Ordenar", "Otros", "Películas", "Wallpapers",
    ".Amigos", ".Whatsapp",
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
    "Paises Balticos": None,  # sub-folders give actual city
    "Egipto": "Egypt",
    "Colombia": "Colombia", "Cuba": "Cuba", "Guatemala": "Guatemala",
    "Chile": "Chile", "Argentina": "Argentina", "Uruguay": "Uruguay",
    "Peru": "Peru", "Bolivia": "Bolivia",
    "Costa Rica": "Costa Rica",
    "Canada": "Canada",
}

# Folder names at continent/country level-2 that are NOT countries
_NON_COUNTRY_LEVEL2 = {
    "Inmobiliaria", "Mónica", "Monica",
    # "Andorra - Girona" is geographic – handled by the " - " branch below
    "Semana Santa con Anita - Francia - Holanda - Belgica - Abril 2012",
    "Viaje Europa - Rosibel e Ileana - Julio 2008",
    "Viaje Europa - Rosibel y Pablo - Agosto 2014",
    "Viaje Rosibel Canada - Agosto 2010",
    "Viaje Monica - Julio 2015",
}

# Words that disqualify the first token of a folder name from being a city
_NON_CITY_WORDS = {
    "Diciembre", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Setiembre", "Octubre", "Noviembre",
    "Imprimir", "Repetidos", "Inmobiliaria", "Celular", "Viaje",
    "Reunion", "Clausura", "Bejiga", "Boda", "Defensa", "Graduacion",
    "Graduación", "Gijon", "DIS",
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
    # Build path → (size_bytes, mtime_ns, hash) cache from DB
    path_cache: dict[str, tuple[int, int, str]] = {}
    for row in db.execute(
        "SELECT current_path, size_bytes, mtime_ns, hash FROM photos WHERE status='active'"
    ):
        if row["mtime_ns"] is not None:
            path_cache[row["current_path"]] = (
                row["size_bytes"], row["mtime_ns"], row["hash"]
            )

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

            if h in result:
                log.debug(f"Duplicate {h[:8]}…: {result[h].name}  vs  {p.name}")
            result[h] = p
        except OSError as e:
            log.warning(f"Cannot read {p}: {e}")

    if cached_count:
        log.info(f"  {cached_count:,} files matched cache (no re-hash needed)")
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


def classify_path(rel_path: str) -> dict:
    """
    Classify a relative photo path into geo or general metadata.

    Returns one of:
      {'type': 'geo',     'continent': ..., 'country': ..., 'city': ...,
                          'folder_hint_year': ..., 'folder_hint_month': ...}
      {'type': 'general', 'folder': <original rel dir, dot-stripped>}
    """
    parts = Path(rel_path).parts   # includes filename as last element
    if len(parts) < 2:
        return {"type": "general", "folder": parts[0] if parts else "unknown"}

    root = parts[0]

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

        # ── "Andorra - Girona" style two-place level-2 folder (Europa root) ──
        if " - " in level2 and root == "Europa":
            # Treat the whole level-2 name as a city-like string
            city = _extract_city_token(level2) or level2
            country = COUNTRY_NORMALIZE.get(level2.split(" - ")[0], None)
            hy, hm = _date_from_folder(level2)
            return {"type": "geo", "continent": continent,
                    "country": country, "city": city,
                    "folder_hint_year": hy, "folder_hint_month": hm}

        # ── Standard Continent / Country / City structure ────────────────────
        country = COUNTRY_NORMALIZE.get(level2, level2)
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
                # level-3 name looks non-geographic → general, preserve full path
                folder = str(Path(*parts[:-1])).lstrip(".")
                return {"type": "general", "folder": folder}
        else:
            # File is directly inside the country folder – no city sub-folder
            city = hy = hm = None

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
                "w":       row["width"],
                "h":       row["height"],
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
            "w":       row["width"],
            "h":       row["height"],
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
            "w":       row["width"],
            "h":       row["height"],
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
               lat, lng, country, city, general_folder, width, height, created_at
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
        "w":       r["width"],
        "h":       r["height"],
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

    log.info(f"Index: {len(by_year)} year files, {len(by_location)} location files, "
             f"{len(by_folder)} general files, {len(recent_photos)} recent, "
             f"{len(by_month)} monthly stats")


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
    result = {"hash": file_hash, "ok": False, "moved": False, "error": None}

    try:
        # Thumbnail
        thumb_bytes = generate_thumbnail(path)
        thumb_key = None
        if thumb_bytes:
            thumb_key = upload_thumbnail(s3, thumb_bytes, file_hash, dry_run)

        # Photo upload
        s3_key = upload_photo(s3, path, file_hash, dry_run)

        result.update({"ok": True, "s3_key": s3_key, "thumb_key": thumb_key})
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


def run(args):
    db = open_db()
    s3 = boto3.client("s3", region_name=REGION)

    if args.reindex_only:
        build_and_upload_index(db, s3, args.dry_run)
        return

    if args.fix_dates:
        _fix_dates(db, args.dry_run)
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

    # ── 3. Handle moves (no re-upload needed, just update DB + index path) ────
    for h in moved_hashes:
        new_rel = str(local[h].relative_to(args.root))
        old_path = db_active[h]["current_path"]
        log.info(f"Moved {h[:8]}…  {old_path}  →  {new_rel}")
        if not args.dry_run:
            db.execute(
                "UPDATE photos SET current_path=?, filename=?, updated_at=? WHERE hash=?",
                (new_rel, local[h].name, datetime.now().isoformat(), h)
            )
    if moved_hashes and not args.dry_run:
        db.commit()

    # ── 4. Handle deletions ───────────────────────────────────────────────────
    if deleted_hashes:
        log.info(f"Marking {len(deleted_hashes):,} files as deleted")
        if not args.dry_run:
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
            cls.get("folder")    if cls["type"] == "general" else None,
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
                               updated_at=? WHERE hash=?""",
                            (res["s3_key"],
                             res["thumb_key"],
                             1 if res["thumb_key"] else 0,
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
    parser.add_argument("--skip-index",   action="store_true",
                        help="Upload photos but skip index rebuild")
    parser.add_argument("--workers",      type=int, default=UPLOAD_WORKERS,
                        help="Parallel upload threads (default 8)")
    parser.add_argument("--verbose",      action="store_true")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    run(args)
