import sqlite3
from pathlib import Path

db = sqlite3.connect(Path(__file__).parent / "state.db")
db.row_factory = sqlite3.Row

total        = db.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
active       = db.execute("SELECT COUNT(*) FROM photos WHERE status='active'").fetchone()[0]
uploaded     = db.execute("SELECT COUNT(*) FROM photos WHERE s3_uploaded=1").fetchone()[0]
has_thumb    = db.execute("SELECT COUNT(*) FROM photos WHERE thumb_uploaded=1").fetchone()[0]
has_geo      = db.execute("SELECT COUNT(*) FROM photos WHERE country IS NOT NULL").fetchone()[0]
has_year     = db.execute("SELECT COUNT(*) FROM photos WHERE year IS NOT NULL").fetchone()[0]
geo_cache    = db.execute("SELECT COUNT(*) FROM geo_cache").fetchone()[0]

print("DB summary")
print("  Total rows     :", total)
print("  Active         :", active)
print("  s3_uploaded=1  :", uploaded)
print("  thumb_uploaded :", has_thumb)
print("  has geo coords :", has_geo)
print("  has year       :", has_year)
print("  geo_cache rows :", geo_cache)

if total > 0:
    sample = db.execute(
        "SELECT hash, current_path, s3_key, thumb_key, s3_uploaded, country, city, year FROM photos LIMIT 3"
    ).fetchall()
    print("\nSample rows:")
    for r in sample:
        print(" ", dict(r))
