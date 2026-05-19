import sqlite3
from pathlib import Path

db = sqlite3.connect(Path(__file__).parent / "state.db")
db.row_factory = sqlite3.Row

# What statuses exist?
statuses = db.execute("SELECT status, COUNT(*) as n FROM photos GROUP BY status").fetchall()
print("Status breakdown:")
for r in statuses:
    print("  %-12s : %d" % (r["status"], r["n"]))

# Sample a deleted record to compare path vs actual disk
sample = db.execute(
    "SELECT hash, current_path, s3_uploaded FROM photos WHERE status='deleted' LIMIT 3"
).fetchall()
print("\nSample deleted rows:")
for r in sample:
    p = Path("/mnt/sda2/Personal/Fotos") / r["current_path"]
    print("  exists=%-5s  s3_uploaded=%d  %s" % (p.exists(), r["s3_uploaded"], r["current_path"]))
