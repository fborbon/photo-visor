import sqlite3
from pathlib import Path

db = sqlite3.connect(Path(__file__).parent / "state.db")
no_date = db.execute(
    "SELECT filename FROM photos WHERE datetime_taken IS NULL ORDER BY RANDOM() LIMIT 40"
).fetchall()
total_no_date = db.execute(
    "SELECT COUNT(*) FROM photos WHERE datetime_taken IS NULL"
).fetchone()[0]
print("Total missing datetime:", total_no_date)
print("\nRandom sample of filenames with no datetime:")
for row in no_date:
    print(" ", row[0])
