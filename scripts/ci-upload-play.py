#!/usr/bin/env python3
"""CI script: upload release AAB to Play Store production track.

Reads PLAY_KEY_FILE env var (path to service account JSON).
"""
import json
import os
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

KEY_FILE = os.environ["PLAY_KEY_FILE"]
AAB = os.environ.get(
    "AAB_PATH",
    "frontend/android/app/build/outputs/bundle/release/app-release.aab",
)
PKG = "com.photovisor.family"
SCOPES = ["https://www.googleapis.com/auth/androidpublisher"]

pkg_json = os.path.join(os.path.dirname(__file__), "../frontend/package.json")
version_name = json.load(open(pkg_json))["version"]

creds = service_account.Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES)
service = build("androidpublisher", "v3", credentials=creds)

edit = service.edits().insert(packageName=PKG, body={}).execute()
eid = edit["id"]

media = MediaFileUpload(AAB, mimetype="application/octet-stream")
bundle = service.edits().bundles().upload(packageName=PKG, editId=eid, media_body=media).execute()
vc = bundle["versionCode"]
print(f"Uploaded versionCode={vc}, versionName={version_name}")

release_body = {
    "versionCodes": [vc],
    "status": "completed",
    "releaseNotes": [{"language": "en-US", "text": f"Version {version_name}"}],
}

# Always publish to internal testing (guaranteed to work)
service.edits().tracks().update(
    packageName=PKG, editId=eid, track="internal",
    body={"releases": [release_body]},
).execute()

# Also attempt production; fails gracefully if store listing is incomplete
try:
    service.edits().tracks().update(
        packageName=PKG, editId=eid, track="production",
        body={"releases": [release_body]},
    ).execute()
    print(f"Published v{version_name} to production track.")
except Exception as e:
    print(f"Production track skipped ({e}). Complete the Play Store listing to enable auto-production releases.")

service.edits().commit(packageName=PKG, editId=eid).execute()
print(f"Published v{version_name} to internal testing track.")
