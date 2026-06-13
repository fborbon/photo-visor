#!/usr/bin/env python3
"""
download-phone-sync.py — Download phone-synced photos from S3 to the external HD.

Phone sync stores photos in S3 as  photos/{hash[:2]}/{hash}.ext  with the
original filename in two places:
  1. S3 object metadata:  x-amz-meta-original-filename
  2. The user's tag JSON: index/tags/{email_slug}.json  →  PhotoEntry.name

This script fetches the user's tag JSON, finds Camera/-tagged photos that are
NOT yet on the hard drive (checked via state.db), downloads them from S3, and
saves them using their original filename in the correct folder.

After running, execute bulk-ingest.py to index the newly downloaded files.

Usage:
    python3 download-phone-sync.py --email correoprincipal2021@hotmail.com
    python3 download-phone-sync.py --email correoprincipal2021@hotmail.com --dry-run
    python3 download-phone-sync.py --email correoprincipal2021@hotmail.com --tag "Camera/Europa/España/..."
"""

import os
import re
import sys
import json
import sqlite3
import argparse
import hashlib
import logging
from pathlib import Path

import boto3
import requests

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
log = logging.getLogger(__name__)

_HERE    = Path(__file__).parent
_OUTPUTS = json.loads((_HERE.parent / "stack-outputs.json").read_text())

BUCKET        = _OUTPUTS["bucketName"]
CF_URL        = _OUTPUTS["cloudFrontUrl"].rstrip("/")
PHOTOS_ROOT   = Path("/media/patito/seagate/Personal/Fotos")
DB_PATH       = _HERE / "state.db"
REGION        = _OUTPUTS["region"]


def email_to_tags_key(email: str) -> str:
    """Reproduce the emailToTagsKey() logic from the frontend."""
    slug = re.sub(r"[^a-z0-9]", "_", email.lower())
    return f"index/tags/{slug}.json"


def get_existing_hashes() -> set[str]:
    """Return all hashes already indexed in state.db (already on the HD)."""
    if not DB_PATH.exists():
        return set()
    db = sqlite3.connect(DB_PATH)
    rows = db.execute("SELECT hash FROM photos WHERE status='active'").fetchall()
    db.close()
    return {r[0] for r in rows}


def fetch_user_tags(email: str) -> dict:
    key = email_to_tags_key(email)
    url = f"{CF_URL}/{key}?nc=1"
    r = requests.get(url, timeout=30)
    if r.status_code == 404:
        log.error(f"No tag file found for {email}. Have you synced from the phone?")
        sys.exit(1)
    r.raise_for_status()
    return r.json()


def get_original_filename(s3_client, s3_key: str, entry: dict) -> str | None:
    """
    Return the original filename for a photo.
    Priority: tag JSON 'name' field → S3 metadata → None (skip).
    """
    # 1. Stored in tag JSON (new syncs after this fix)
    if entry.get("name"):
        return entry["name"]

    # 2. S3 object metadata (also stored by new syncs)
    try:
        head = s3_client.head_object(Bucket=BUCKET, Key=s3_key)
        meta = head.get("Metadata", {})
        if meta.get("original-filename"):
            return meta["original-filename"]
    except Exception:
        pass

    return None


def download_photo(s3_client, s3_key: str, dest: Path) -> bool:
    """Download a single photo from S3. Returns True on success."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        obj = s3_client.get_object(Bucket=BUCKET, Key=s3_key)
        data = obj["Body"].read()
        dest.write_bytes(data)
        return True
    except Exception as e:
        log.warning(f"  Download failed {s3_key}: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Download phone-synced photos to HD")
    parser.add_argument("--email",   required=True,  help="User email used during phone sync")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be downloaded, don't download")
    parser.add_argument("--tag",     default="",     help="Only process photos under this tag prefix (e.g. 'Camera/Europa')")
    args = parser.parse_args()

    s3 = boto3.client("s3", region_name=REGION)

    log.info(f"Fetching tag index for {args.email} …")
    user_data = fetch_user_tags(args.email)
    all_tags: dict = user_data.get("tags", {})

    # Only Camera/ tags map 1-to-1 to HD folder paths.
    # Strip trailing slash from tag names (phone sync sometimes adds one).
    camera_tags = {
        tag.rstrip("/"): photos
        for tag, photos in all_tags.items()
        if tag.startswith("Camera/") and (not args.tag or tag.rstrip("/").startswith(args.tag))
    }

    if not camera_tags:
        log.info("No Camera/ tags found (or none matching --tag filter). Nothing to download.")
        return

    log.info(f"Found {len(camera_tags)} Camera/ tag(s) to process.")
    existing_hashes = get_existing_hashes()
    log.info(f"  {len(existing_hashes):,} photos already indexed in state.db — will skip.")

    total_downloaded = 0
    total_skipped    = 0
    total_no_name    = 0

    for tag_name, tag_entry in sorted(camera_tags.items()):
        photos: list[dict] = tag_entry.get("photos", []) if isinstance(tag_entry, dict) else []
        if not photos:
            continue

        # tag "Camera/Europa/España/..." → HD folder PHOTOS_ROOT / "Camera/Europa/España/..."
        folder = PHOTOS_ROOT / tag_name

        new_photos = [p for p in photos if p.get("hash") not in existing_hashes]
        if not new_photos:
            log.info(f"[{tag_name}] all {len(photos)} photo(s) already on HD — skip.")
            continue

        log.info(f"[{tag_name}] {len(new_photos)}/{len(photos)} photo(s) need downloading → {folder}")

        for entry in new_photos:
            hash_val = entry.get("hash", "")
            s3_key   = entry.get("s3_key") or ""

            orig_name = get_original_filename(s3, s3_key, entry)
            if not orig_name:
                log.warning(f"  No original filename for hash {hash_val[:8]}… — skipping "
                            f"(sync before this fix was applied). Re-sync from phone to get it.")
                total_no_name += 1
                continue

            dest = folder / orig_name

            if dest.exists():
                log.debug(f"  Already exists: {dest.name}")
                total_skipped += 1
                continue

            if args.dry_run:
                log.info(f"  [DRY-RUN] Would download: {orig_name}")
                total_downloaded += 1
                continue

            log.info(f"  ↓ {orig_name}")
            if download_photo(s3, s3_key, dest):
                total_downloaded += 1
            else:
                total_no_name += 1

    log.info("")
    log.info(f"Done.  Downloaded: {total_downloaded}  |  Skipped: {total_skipped}  |  No-name/errors: {total_no_name}")

    if total_downloaded > 0 and not args.dry_run:
        log.info("")
        log.info("Next step: run bulk-ingest.py to index the downloaded photos:")
        log.info("  python3 bulk-ingest.py")


if __name__ == "__main__":
    main()
