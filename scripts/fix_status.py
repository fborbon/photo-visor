"""
Fix column-alignment bug introduced when mtime_ns was added via ALTER TABLE.
The positional INSERT wrote 0 (thumb_uploaded's default) into the status column.
All uploaded photos should be 'active'.
"""
import sqlite3
from pathlib import Path

db = sqlite3.connect(Path(__file__).parent / "state.db")

before = db.execute("SELECT COUNT(*) FROM photos WHERE status='active'").fetchone()[0]
print("active before fix:", before)

# All rows with s3_uploaded=1 and status != 'active' should be 'active'
db.execute("UPDATE photos SET status='active' WHERE s3_uploaded=1 AND status != 'active'")
db.commit()

after = db.execute("SELECT COUNT(*) FROM photos WHERE status='active'").fetchone()[0]
print("active after fix :", after)
print("done")
