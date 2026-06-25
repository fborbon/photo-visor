#!/usr/bin/env python3
"""Upload latest release AAB to Play Store internal testing track."""

import subprocess
import sys
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

ROOT = Path(__file__).parent.parent / "frontend"
KEY_FILE = Path.home() / "Developments/otros/photo-visor-584a5dee26e5.json"
PACKAGE_NAME = "com.photovisor.family"
AAB_PATH = ROOT / "android/app/build/outputs/bundle/release/app-release.aab"
TRACK = "internal"
SCOPES = ["https://www.googleapis.com/auth/androidpublisher"]


def build_aab():
    print("Building web assets...")
    subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)
    subprocess.run(["npx", "cap", "sync", "android"], cwd=ROOT, check=True)
    print("Building AAB...")
    subprocess.run(
        ["./gradlew", "bundleRelease"],
        cwd=ROOT / "android",
        env={**__import__("os").environ, "JAVA_HOME": "/home/patito/android-studio/jbr"},
        check=True,
    )
    print(f"AAB: {AAB_PATH} ({AAB_PATH.stat().st_size // 1024}KB)")


def upload_aab():
    creds = service_account.Credentials.from_service_account_file(str(KEY_FILE), scopes=SCOPES)
    service = build("androidpublisher", "v3", credentials=creds)

    edit = service.edits().insert(packageName=PACKAGE_NAME, body={}).execute()
    edit_id = edit["id"]

    media = MediaFileUpload(str(AAB_PATH), mimetype="application/octet-stream")
    bundle = service.edits().bundles().upload(
        packageName=PACKAGE_NAME, editId=edit_id, media_body=media
    ).execute()
    version_code = bundle["versionCode"]
    print(f"Uploaded versionCode={version_code}")

    service.edits().tracks().update(
        packageName=PACKAGE_NAME, editId=edit_id, track=TRACK,
        body={"releases": [{"versionCodes": [version_code], "status": "completed"}]},
    ).execute()

    service.edits().commit(packageName=PACKAGE_NAME, editId=edit_id).execute()
    print(f"Published to {TRACK} track.")


if __name__ == "__main__":
    build_only = "--build-only" in sys.argv
    upload_only = "--upload-only" in sys.argv

    if not upload_only:
        build_aab()
    if not build_only:
        upload_aab()
