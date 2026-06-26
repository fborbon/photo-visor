#!/usr/bin/env python3
"""CI script: upload release AAB to Play Store production track.

Reads PLAY_KEY_FILE env var (path to service account JSON).
"""
import os
import sys
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

creds = service_account.Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES)
service = build("androidpublisher", "v3", credentials=creds)

edit = service.edits().insert(packageName=PKG, body={}).execute()
eid = edit["id"]

media = MediaFileUpload(AAB, mimetype="application/octet-stream")
bundle = service.edits().bundles().upload(packageName=PKG, editId=eid, media_body=media).execute()
vc = bundle["versionCode"]
print(f"Uploaded versionCode={vc}")

service.edits().tracks().update(
    packageName=PKG, editId=eid, track="production",
    body={"releases": [{"versionCodes": [vc], "status": "completed"}]},
).execute()

service.edits().commit(packageName=PKG, editId=eid).execute()
print("Published to production track.")
