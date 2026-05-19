"""
Generate dummy photo-visor index files for the static demo build.
Output goes into frontend/public/ so Vite copies them into dist-demo/.
Usage: python scripts/generate_demo_index.py
"""
import json, random, hashlib
from pathlib import Path
from datetime import datetime, timedelta

rng = random.Random(42)
BASE = Path(__file__).parent.parent / "frontend" / "public"

LOCATIONS = [
    {"continent": "Europe",        "country": "Spain",         "city": "Barcelona",   "lat": 41.39,  "lng":   2.17},
    {"continent": "Europe",        "country": "France",        "city": "Paris",       "lat": 48.86,  "lng":   2.35},
    {"continent": "Europe",        "country": "Italy",         "city": "Rome",        "lat": 41.90,  "lng":  12.50},
    {"continent": "North America", "country": "USA",           "city": "New York",    "lat": 40.71,  "lng": -74.01},
    {"continent": "Asia",          "country": "Japan",         "city": "Tokyo",       "lat": 35.69,  "lng": 139.69},
    {"continent": "Oceania",       "country": "Australia",     "city": "Sydney",      "lat":-33.87,  "lng": 151.21},
    {"continent": "South America", "country": "Argentina",     "city": "Buenos Aires","lat":-34.60,  "lng": -58.38},
    {"continent": "Africa",        "country": "Kenya",         "city": "Nairobi",     "lat": -1.29,  "lng":  36.82},
]

YEARS   = list(range(2019, 2026))
PER_LOC = 22   # photos per location

def make_hash(seed: str) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()

def rand_dt(year: int) -> str:
    start = datetime(year, 1, 1)
    delta = timedelta(days=rng.randint(0, 364), hours=rng.randint(0, 23), minutes=rng.randint(0, 59))
    return (start + delta).isoformat() + "Z"

def loc_key(loc: dict) -> str:
    return loc["country"].replace(" ", "_") + "_" + loc["city"].replace(" ", "_")

# ── Generate all photos ────────────────────────────────────────────────────────
all_photos = []
by_loc: dict[str, list] = {}
by_year: dict[int, list] = {}
monthly: dict[str, int] = {}
total_per_loc: dict[str, int] = {}

for loc in LOCATIONS:
    key   = loc_key(loc)
    photos= []
    for i in range(PER_LOC):
        h    = make_hash(f"{key}_{i}")
        h8   = h[:8]
        year = rng.choice(YEARS)
        dt   = rand_dt(year)
        w, h_px = rng.choice([(4000,3000),(3000,4000),(5000,3333),(3840,2160)])
        tw, th   = (400, 300) if w >= h_px else (300, 400)
        entry = {
            "hash":    h,
            "s3_key":  f"seed/{h8}/1200/800",
            "thumb":   f"seed/{h8}/{tw}/{th}",
            "dt":      dt,
            "lat":     round(loc["lat"] + rng.uniform(-0.15, 0.15), 5),
            "lng":     round(loc["lng"] + rng.uniform(-0.15, 0.15), 5),
            "w":       w,
            "h":       h_px,
            "country": loc["country"],
            "city":    loc["city"],
            "folder":  f"Travel/{loc['country']}/{loc['city']}",
            "month":   int(dt[5:7]),
            "day":     int(dt[8:10]),
        }
        photos.append(entry)
        all_photos.append(entry)
        by_year.setdefault(year, []).append(entry)
        ym = dt[:7]
        monthly[ym] = monthly.get(ym, 0) + 1
    by_loc[key] = photos
    total_per_loc[key] = len(photos)

all_photos.sort(key=lambda p: p["dt"])

# add addedAt for recent (simulate ingest order = chronological order)
for i, p in enumerate(all_photos):
    p["addedAt"] = p["dt"]

# ── Write files ───────────────────────────────────────────────────────────────
(BASE / "index" / "time").mkdir(parents=True, exist_ok=True)
(BASE / "index" / "geo").mkdir(parents=True, exist_ok=True)
(BASE / "index" / "tags").mkdir(parents=True, exist_ok=True)

def dump(path: Path, obj):
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False))
    print(f"  {path.relative_to(BASE.parent.parent)}")

# summary.json
locs_out = []
for loc in LOCATIONS:
    key = loc_key(loc)
    locs_out.append({**loc, "count": total_per_loc[key]})

dump(BASE / "index" / "summary.json", {
    "generated":       "2026-05-19T10:00:00Z",
    "total":           len(all_photos),
    "locations":       locs_out,
    "years":           YEARS,
    "general_folders": ["Travel"],
})

# time/{year}.json
for year, photos in by_year.items():
    dump(BASE / "index" / "time" / f"{year}.json", photos)

# geo/{key}.json
for key, photos in by_loc.items():
    dump(BASE / "index" / "geo" / f"{key}.json", photos)

# recent.json
recent = sorted(all_photos, key=lambda p: p["dt"], reverse=True)[:30]
dump(BASE / "index" / "recent.json", {
    "updated": "2026-05-19T10:00:00Z",
    "photos":  recent,
})

# stats.json
by_month = sorted(({"ym": ym, "count": c} for ym, c in monthly.items()), key=lambda x: x["ym"])
dump(BASE / "index" / "stats.json", {
    "generated": "2026-05-19T10:00:00Z",
    "total":     len(all_photos),
    "no_date":   0,
    "by_month":  by_month,
})

# tags/shared.json (empty)
dump(BASE / "index" / "tags" / "shared.json", {"updated": "", "tags": {}})

# private.json (empty — nothing hidden)
dump(BASE / "index" / "private.json", {"photos": [], "albums": []})

print(f"\nDone — {len(all_photos)} demo photos across {len(LOCATIONS)} locations.")
