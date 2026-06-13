#!/usr/bin/env python3
"""
One-off: upload the 68 Ericeira photos that have status='new' with stale s3_uploaded=1.
Uploads photo + thumbnail to S3, then sets status='active', s3_uploaded=1, thumb_uploaded=1.
Run AFTER any running bulk-ingest.py finishes.
"""

import json, sqlite3
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE       = Path(__file__).parent
PHOTOS_ROOT = Path("/media/patito/seagate/Personal/Fotos")
_OUTPUTS   = json.loads((HERE.parent / "stack-outputs.json").read_text())
BUCKET     = _OUTPUTS["bucketName"]
REGION     = _OUTPUTS["region"]
DB_PATH    = HERE / "state.db"

import boto3
from PIL import Image, ImageOps
import io

THUMB_WIDTH   = 400
THUMB_QUALITY = 72


def generate_thumbnail(path: Path):
    try:
        img = Image.open(path)
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        w, h = img.size
        new_h = int(h * THUMB_WIDTH / w)
        img = img.resize((THUMB_WIDTH, new_h), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=THUMB_QUALITY, optimize=True)
        return buf.getvalue()
    except Exception as e:
        print(f"  thumb error: {e}")
        return None


def repair_one(row, s3):
    h          = row["hash"]
    rel_path   = row["current_path"]
    s3_key     = row["s3_key"]
    thumb_key  = row["thumb_key"]
    local_path = PHOTOS_ROOT / rel_path

    if not local_path.exists():
        return h, False, f"file not found: {local_path}"

    try:
        # Upload original
        ext = local_path.suffix.lower()
        ct  = "image/jpeg" if ext in {".jpg", ".jpeg", ".jpe"} else "application/octet-stream"
        s3.upload_file(
            Filename=str(local_path),
            Bucket=BUCKET,
            Key=s3_key,
            ExtraArgs={"StorageClass": "GLACIER_IR", "ContentType": ct},
        )

        # Upload thumbnail
        thumb_bytes = generate_thumbnail(local_path)
        thumb_ok = False
        if thumb_bytes:
            s3.put_object(Bucket=BUCKET, Key=thumb_key, Body=thumb_bytes,
                          ContentType="image/jpeg", CacheControl="max-age=2592000")
            thumb_ok = True

        return h, True, thumb_ok
    except Exception as e:
        return h, False, str(e)


def main():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT hash, current_path, s3_key, thumb_key FROM photos "
        "WHERE status='new' AND current_path LIKE '%Ericeira%'"
    ).fetchall()

    if not rows:
        print("No Ericeira photos with status='new' found — nothing to do.")
        con.close()
        return

    print(f"Found {len(rows)} Ericeira photos to repair")
    s3 = boto3.client("s3", region_name=REGION)

    ok = fail = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(repair_one, r, s3): r["hash"] for r in rows}
        for future in as_completed(futures):
            h, success, detail = future.result()
            if success:
                ok += 1
                thumb_ok = detail
                con.execute(
                    "UPDATE photos SET status='active', s3_uploaded=1, thumb_uploaded=? WHERE hash=?",
                    (1 if thumb_ok else 0, h)
                )
                if ok % 10 == 0:
                    con.commit()
                    print(f"  {ok}/{len(rows)} uploaded…")
            else:
                fail += 1
                print(f"  FAILED {h[:8]}: {detail}")

    con.commit()
    con.close()
    print(f"\nDone: {ok} ok, {fail} failed")


if __name__ == "__main__":
    main()
