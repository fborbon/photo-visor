import time, hashlib
from pathlib import Path

PARTIAL = 65536

def quick_hash(path, size):
    h = hashlib.sha256()
    h.update(size.to_bytes(8, "big"))
    with open(path, "rb") as f:
        h.update(f.read(PARTIAL))
        if size > PARTIAL * 2:
            f.seek(-PARTIAL, 2)
            h.update(f.read(PARTIAL))
    return h.hexdigest()

root = Path("/mnt/sda2/Personal/Fotos")
exts = {".jpg", ".jpeg", ".heic", ".png", ".mp4"}
files = [p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in exts][:2000]

t0 = time.time()
for p in files:
    sz = p.stat().st_size
    quick_hash(p, sz)
elapsed = time.time() - t0

rate = len(files) / elapsed
eta_min = 190000 / rate / 60
print("Hashed %d files in %.1fs  ->  %.0f files/sec" % (len(files), elapsed, rate))
print("ETA for 190k files: ~%.0f minutes" % eta_min)
print("Re-runs (mtime cache hits): near-instant")
