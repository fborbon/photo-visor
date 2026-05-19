"""
Smoke-test: run bulk-ingest dry-run on a small subset (50 files) and
print classification breakdown + a few sample records.
"""
import json, sqlite3, sys, unittest.mock, re
from pathlib import Path
from typing import Optional

# Load the module without triggering __main__
src = open("bulk-ingest.py").read().split('if __name__ == "__main__"')[0]
mock_out = json.dumps({"bucketName": "photo-visor-295936871972", "region": "eu-west-1"})
with unittest.mock.patch("pathlib.Path.read_text", return_value=mock_out):
    exec(compile(src, "bulk-ingest.py", "exec"))

root = Path("/mnt/sda2/Personal/Fotos")
exts = IMAGE_EXTS | VIDEO_EXTS

# Pick 10 files from each of 5 representative folders
sample_folders = [
    "Europa/España/Barcelona - Agosto 2011 - Vacaciones",
    "Europa/España/Diciembre 2014 - Nacionalidad y Tesis",
    "Costa Rica/Familia/Navidad 2005",
    "Atardeceres",
    "World Tour 2016/Tokyo",
]

files = []
for folder in sample_folders:
    folder_path = root / folder
    if folder_path.exists():
        found = [p for p in folder_path.iterdir() if p.is_file() and p.suffix.lower() in exts]
        files.extend(found[:10])

print("Classifying %d sample files ...\n" % len(files))

geo_count = general_count = 0
for p in files:
    rel = str(p.relative_to(root))
    cls = classify_path(rel)
    t   = cls["type"]
    loc = ""
    if t == "geo":
        geo_count += 1
        loc = "%s / %s" % (cls.get("country","?"), cls.get("city","?"))
    else:
        general_count += 1
        loc = "general: %s" % cls.get("folder","?")
    print("  [%s]  %-55s  %s" % (t, rel[:55], loc))

print("\n---")
print("geo: %d   general: %d" % (geo_count, general_count))
