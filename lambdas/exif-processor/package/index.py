"""
EXIF processor Lambda — fires on every photos/* upload.
Extracts metadata, generates thumbnail, updates S3 index files.
"""
import io
import os
import re
import json
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote

import boto3
import exifread
from PIL import Image, ImageOps
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

s3             = boto3.client("s3")
BUCKET         = os.environ["BUCKET_NAME"]
THUMB_WIDTH    = int(os.environ.get("THUMB_WIDTH",   "400"))
THUMB_QUALITY  = int(os.environ.get("THUMB_QUALITY", "72"))
NOMINATIM_URL  = "https://nominatim.openstreetmap.org/reverse"
NOMINATIM_UA   = "PhotoVisorLambda/1.0 (family photo archive)"

# ── EXIF helpers ──────────────────────────────────────────────────────────────

def _gps_decimal(values, ref: str):
    try:
        d = float(values[0].num) / float(values[0].den)
        m = float(values[1].num) / float(values[1].den)
        s = float(values[2].num) / float(values[2].den)
        dec = d + m / 60 + s / 3600
        return -dec if ref in ("S", "W") else dec
    except Exception:
        return None

def extract_exif(data: bytes) -> dict:
    result = {}
    try:
        tags = exifread.process_file(io.BytesIO(data), stop_tag="GPS GPSImgDirection", details=False)
        lat_t = tags.get("GPS GPSLatitude");  lat_r = tags.get("GPS GPSLatitudeRef")
        lng_t = tags.get("GPS GPSLongitude"); lng_r = tags.get("GPS GPSLongitudeRef")
        if lat_t and lat_r and lng_t and lng_r:
            lat = _gps_decimal(lat_t.values, str(lat_r))
            lng = _gps_decimal(lng_t.values, str(lng_r))
            if lat and lng and not (lat == 0.0 and lng == 0.0):
                result["lat"] = round(lat, 6)
                result["lng"] = round(lng, 6)
        for tag in ("EXIF DateTimeOriginal", "EXIF DateTimeDigitized", "Image DateTime"):
            dt = tags.get(tag)
            if dt:
                try:
                    d = datetime.strptime(str(dt), "%Y:%m:%d %H:%M:%S")
                    result["dt"] = d.isoformat()
                    result["year"]  = d.year
                    result["month"] = d.month
                    result["day"]   = d.day
                    break
                except ValueError:
                    pass
    except Exception as e:
        print(f"EXIF error: {e}")

    # Fallback: for HEIC/HEIF files use pillow_heif metadata when exifread fails
    if not result.get("year"):
        try:
            from PIL import Image as PILImage
            with PILImage.open(io.BytesIO(data)) as img:
                exif_data = img.getexif()
                # DateTimeOriginal = tag 36867, DateTime = 306
                for tag_id in (36867, 36868, 306):
                    raw = exif_data.get(tag_id)
                    if raw:
                        d = datetime.strptime(str(raw), "%Y:%m:%d %H:%M:%S")
                        result["dt"]    = d.isoformat()
                        result["year"]  = d.year
                        result["month"] = d.month
                        result["day"]   = d.day
                        break
                # GPS IFD = tag 34853
                gps_ifd = exif_data.get_ifd(34853)
                if gps_ifd:
                    lat_vals = gps_ifd.get(2); lat_ref = gps_ifd.get(1, "N")
                    lng_vals = gps_ifd.get(4); lng_ref = gps_ifd.get(3, "E")
                    if lat_vals and lng_vals:
                        def _dms(vals):
                            return float(vals[0]) + float(vals[1])/60 + float(vals[2])/3600
                        lat = _dms(lat_vals) * (-1 if lat_ref == "S" else 1)
                        lng = _dms(lng_vals) * (-1 if lng_ref == "W" else 1)
                        if lat and lng and not (lat == 0.0 and lng == 0.0):
                            result["lat"] = round(lat, 6)
                            result["lng"] = round(lng, 6)
        except Exception:
            pass

    return result

_FN_PATTERNS = [
    re.compile(r"(?<!\d)(\d{4})(\d{2})(\d{2})[_\-](\d{2})(\d{2})(\d{2})(?!\d)"),
    re.compile(r"(\d{4})-(\d{2})-(\d{2})"),
    re.compile(r"(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)"),
]

def filename_date(name: str) -> dict:
    stem = Path(name).stem
    for pat in _FN_PATTERNS:
        m = pat.search(stem)
        if not m:
            continue
        g = m.groups()
        try:
            y, mo, d = int(g[0]), int(g[1]), int(g[2])
            if not (1990 <= y <= 2035 and 1 <= mo <= 12 and 1 <= d <= 31):
                continue
            if len(g) >= 6:
                h, mi, s = int(g[3]), int(g[4]), int(g[5])
                if 0 <= h <= 23 and 0 <= mi <= 59 and 0 <= s <= 59:
                    return {"dt": f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:02d}",
                            "year": y, "month": mo, "day": d}
            return {"dt": f"{y:04d}-{mo:02d}-{d:02d}", "year": y, "month": mo, "day": d}
        except Exception:
            continue
    return {}

# ── Thumbnail ─────────────────────────────────────────────────────────────────

def make_thumbnail(data: bytes, ext: str) -> bytes | None:
    if ext.lower() in (".cr2", ".nef", ".arw", ".dng"):
        return None
    try:
        with Image.open(io.BytesIO(data)) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            img.thumbnail((THUMB_WIDTH, THUMB_WIDTH * 3), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=THUMB_QUALITY, optimize=True)
            return buf.getvalue()
    except Exception as e:
        print(f"Thumbnail error: {e}")
        return None

# ── Reverse geocode ───────────────────────────────────────────────────────────

def reverse_geocode(lat: float, lng: float) -> tuple[str | None, str | None]:
    try:
        url = f"{NOMINATIM_URL}?lat={lat}&lon={lng}&format=json&zoom=10"
        req = urllib.request.Request(url, headers={"User-Agent": NOMINATIM_UA})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read())
        addr = data.get("address", {})
        city = (addr.get("city") or addr.get("town") or addr.get("village")
                or addr.get("county") or addr.get("state"))
        country = addr.get("country")
        return city, country
    except Exception as e:
        print(f"Geocode error: {e}")
        return None, None

# ── S3 index helpers ──────────────────────────────────────────────────────────

def _read_json(key: str) -> list | dict:
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=key)
        return json.loads(obj["Body"].read())
    except s3.exceptions.NoSuchKey:
        return [] if key.startswith("index/time/") or key.startswith("index/geo/") else {}
    except Exception:
        return []

def _write_json(key: str, data, cache_control: str = "max-age=3600"):
    s3.put_object(
        Bucket=BUCKET, Key=key,
        Body=json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        ContentType="application/json",
        CacheControl=cache_control,
    )

def _loc_key(country: str | None, city: str | None) -> str:
    return re.sub(r"[^\w\-]", "_", f"{country or 'Unknown'}_{city or 'Unknown'}")

def _path_seg_slug(path: str) -> str:
    return re.sub(r"[^\w\-/]", "_", path)

def _update_path_tags_and_general(album_path: str, hash_str: str, photo_entry: dict):
    """Update index/path_tags.json and index/general/*.json for a Camera/ album upload."""
    inner = album_path[len("Camera/"):]
    parts = inner.split("/")

    new_entries = [
        {"display": "Camera/" + "/".join(parts[:d]), "s3": _path_seg_slug("/".join(parts[:d]))}
        for d in range(1, len(parts) + 1)
    ]

    # Merge into path_tags.json
    try:
        obj = s3.get_object(Bucket=BUCKET, Key="index/path_tags.json")
        path_tags = json.loads(obj["Body"].read())
        if not isinstance(path_tags, list):
            path_tags = []
    except Exception:
        path_tags = []
    existing = {e["display"] for e in path_tags}
    to_add = [e for e in new_entries if e["display"] not in existing]
    if to_add:
        _write_json("index/path_tags.json", path_tags + to_add,
                    "no-cache, no-store, must-revalidate")

    # Merge into index/general/{folder_key}.json
    folder_key = _path_seg_slug(inner)
    gen_key = f"index/general/{folder_key}.json"
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=gen_key)
        gen_data = json.loads(obj["Body"].read())
        if not isinstance(gen_data, list):
            gen_data = []
    except Exception:
        gen_data = []
    if not any(p.get("hash") == hash_str for p in gen_data):
        gen_data.append({**photo_entry, "folder": inner,
                         "path": "Camera/" + inner + "/_"})
        _write_json(gen_key, gen_data, "no-cache, no-store, must-revalidate")

# ── Main handler ──────────────────────────────────────────────────────────────

def handler(event, context):
    for record in event.get("Records", []):
        key = record["s3"]["object"]["key"]
        try:
            _process(key)
        except Exception as e:
            print(f"ERROR {key}: {e}")
    return {"statusCode": 200}

def _process(key: str):
    # key = photos/ab/abc123...jpg
    parts    = key.split("/")
    filename = parts[-1]
    hash_str = Path(filename).stem
    ext      = Path(filename).suffix.lower()
    thumb_key = f"thumbs/{hash_str[:2]}/{hash_str}.jpg"

    print(f"Processing {key}")

    # Download (metadata included in GetObject response)
    obj  = s3.get_object(Bucket=BUCKET, Key=key)
    data = obj["Body"].read()
    album_path_raw = obj.get("Metadata", {}).get("album-path")
    album_path = unquote(album_path_raw) if album_path_raw else None
    album_inner = album_path[len("Camera/"):] if album_path and album_path.startswith("Camera/") else None

    # Extract metadata
    meta = extract_exif(data)
    if not meta.get("year"):
        meta.update(filename_date(filename))

    lat = meta.get("lat")
    lng = meta.get("lng")
    city = country = None
    if lat and lng:
        city, country = reverse_geocode(lat, lng)
    time.sleep(1.1)  # Nominatim rate limit

    year  = meta.get("year")
    month = meta.get("month")
    day   = meta.get("day")
    dt    = meta.get("dt")

    # Thumbnail
    thumb_bytes = make_thumbnail(data, ext)
    if thumb_bytes:
        s3.put_object(Bucket=BUCKET, Key=thumb_key, Body=thumb_bytes,
                      ContentType="image/jpeg", CacheControl="max-age=2592000",
                      StorageClass="STANDARD")

    photo_entry = {
        "hash":    hash_str,
        "s3_key":  key,
        "thumb":   thumb_key if thumb_bytes else None,
        "dt":      dt,
        "lat":     lat,
        "lng":     lng,
        "country": country,
        "city":    city,
        "folder":  album_inner,
        "path":    ("Camera/" + album_inner + "/" + filename) if album_inner else None,
        "w":       None,
        "h":       None,
    }

    # Update time index
    if year:
        tkey  = f"index/time/{year}.json"
        tdata = _read_json(tkey)
        if isinstance(tdata, list):
            photo_entry["month"] = month
            photo_entry["day"]   = day
            if not any(p.get("hash") == hash_str for p in tdata):
                tdata.append(photo_entry)
                tdata.sort(key=lambda p: p.get("dt") or "")
                _write_json(tkey, tdata)

    # Update geo index
    if country or city:
        gkey  = f"index/geo/{_loc_key(country, city)}.json"
        gdata = _read_json(gkey)
        if isinstance(gdata, list):
            if not any(p.get("hash") == hash_str for p in gdata):
                gdata.append(photo_entry)
                _write_json(gkey, gdata)

    # Update summary (load → patch → save)
    summary = _read_json("index/summary.json")
    if isinstance(summary, dict):
        summary["total"] = summary.get("total", 0) + 1
        years = set(summary.get("years", []))
        if year:
            years.add(year)
        summary["years"] = sorted(years)
        locs = summary.get("locations", [])
        if country or city:
            loc_match = next((l for l in locs
                              if l.get("country") == country and l.get("city") == city), None)
            if loc_match:
                loc_match["count"] = loc_match.get("count", 0) + 1
            else:
                locs.append({"country": country, "city": city, "continent": None,
                             "count": 1, "lat": lat, "lng": lng})
            summary["locations"] = locs
        _write_json("index/summary.json", summary)

    # Update path tree and general album index if uploaded via phone sync with a Camera/ force path
    if album_path and album_path.startswith("Camera/"):
        try:
            _update_path_tags_and_general(album_path, hash_str, photo_entry)
        except Exception as e:
            print(f"path_tags update error: {e}")

    print(f"Done: {key} → year={year} city={city} country={country} album={album_path}")
