# 📷 Photo Visor

**[Live demo →](https://www.forwardforecasting.eu/photo-visor/)** (dummy albums, no sign-in required)

A personal family photo viewer hosted on AWS — exploring 194 000+ photos across a world map and timeline with tagging, favorites, phone-to-cloud sync, and a slot-machine random-discovery mode. The architecture is fully serverless and database-free: originals live in S3 Glacier Instant Retrieval, thumbnails and pre-computed JSON indexes are delivered via CloudFront, and an AWS Lambda handles EXIF processing for newly uploaded photos. A React 18 PWA serves the browser frontend; an Android app is available via Google Play Internal Testing.

**Main technologies:** React 18 + TypeScript + Vite (PWA) · AWS S3 (Glacier IR + Standard) · Amazon CloudFront · AWS Cognito · AWS Lambda (Python) · AWS CDK (TypeScript, infrastructure-as-code) · Leaflet + react-leaflet (world map) · Capacitor 6 (Android) · Pillow + exifread (EXIF processing)

**Monthly cost:** ~$2–3/month. Full breakdown in [Section 7 — AWS Cost Estimation](#7-aws-cost-estimation).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Data Processing Pipeline](#3-data-processing-pipeline)
4. [Libraries & Dependencies](#4-libraries--dependencies)
5. [Technologies NOT Used (and Why)](#5-technologies-not-used-and-why)
6. [Data Flow Diagram](#6-data-flow-diagram)
7. [AWS Cost Estimation](#7-aws-cost-estimation)
8. [Setup & Deployment](#8-setup--deployment)
9. [Auditing](#9-auditing)
10. [CI/CD](#10-cicd)

---

## 1. Overview

| Feature | Detail |
|---|---|
| Photos | 194 754 files · 475 GB |
| Storage | S3 Glacier Instant Retrieval (originals) + S3 Standard (thumbnails & indexes) |
| Delivery | Amazon CloudFront · custom domain `fotos.forwardforecasting.eu` |
| Auth | Amazon Cognito (User Pool + Identity Pool) |
| Frontend | React 18 + TypeScript + Vite + PWA |
| Mobile | Android via Capacitor 6 (Google Play Internal Testing) |
| Monthly cost | ~$2–3 USD |

Key user-facing tabs:

- **Map** — photos plotted on a Leaflet world map by GPS / folder geocoding; album headers show photo counts
- **Timeline** — photos browsed by year → month; auto-redirects to the latest month on open
- **Tags** — per-user private tags with optional family sharing
- **Latest** — recently added photos, newest tags, newest comments
- **Slot Machine** — random photo discovery (10 reels, slot-machine animation)
- **Sync** — owner-only phone-to-cloud album sync; favorites synced across phone and web via S3
- **Stats** — summary cards, per-year bar chart, top-countries breakdown

---

### Screenshots

All images below use placeholder photos — no personal content is included.

**🗺 Map** — photos plotted on a world map; clusters show photo count per region

<p align="center"><img src="docs/screenshots/01_map.svg" alt="Map tab" width="900"/></p>

**📅 Timeline** — browse by year → month → photo grid

<p align="center"><img src="docs/screenshots/02_timeline.svg" alt="Timeline tab" width="900"/></p>

**🏷 Tags** — private tags with photo grid; tags can optionally be shared with family

<p align="center"><img src="docs/screenshots/03_tags.svg" alt="Tags tab" width="900"/></p>

**🆕 Latest** — recently added, recently tagged, and recently commented photos

<p align="center"><img src="docs/screenshots/04_latest.svg" alt="Latest tab" width="900"/></p>

**🎰 Slots** — slot-machine random discovery; 10 reels each show a random photo

<p align="center"><img src="docs/screenshots/05_slots.svg" alt="Slot Machine tab" width="900"/></p>

**📊 Stats** — summary cards, photos-per-year bar chart, and top-countries breakdown

<p align="center"><img src="docs/screenshots/06_stats.svg" alt="Statistics tab" width="900"/></p>

**🔄 Sync** *(owner only)* — phone-to-cloud album sync over MTP/Wi-Fi; favorites toggle written to `index/favorites/{ownerKey}.json` and merged across devices by timestamp

<p align="center"><img src="docs/screenshots/07_sync.svg" alt="Sync tab" width="900"/></p>

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Local machine                                                     │
│  /mnt/sda2/Personal/Fotos  (475 GB, 194 754 files)                │
│                                                                    │
│  bulk-ingest.py  ──────────────────────────────────────────────►  │
└───────────────────────────────────────────────────────────────┬───┘
                                                                │  boto3 (S3 PutObject)
                                                                ▼
┌───────────────────────────────────────────────────────────────────┐
│  Amazon S3  (photo-visor-295936871972)                            │
│                                                                   │
│  photos/{ab}/{hash}.jpg   ← S3 Glacier Instant Retrieval         │
│  thumbs/{ab}/{hash}.jpg   ← S3 Standard                          │
│  index/summary.json       ← S3 Standard                          │
│  index/time/{year}.json   ← S3 Standard                          │
│  index/geo/{folder}.json  ← S3 Standard                          │
│  index/tags/{user}.json       ← S3 Standard (per-user private tags)      │
│  index/tags/shared.json       ← S3 Standard (family-shared tags)         │
│  index/favorites/{user}.json  ← S3 Standard (per-user favorites, synced) │
│  index/recent.json            ← S3 Standard (last 100 ingested)           │
│  index/private.json           ← S3 Standard (privacy overrides)           │
│  app/                     ← React PWA build                      │
└───────────────────────────┬───────────────────────────────────────┘
                            │  Origin Access Control (OAC)
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│  Amazon CloudFront  (fotos.forwardforecasting.eu)                 │
│  ACM certificate (us-east-1)                                      │
└───────────────────────────┬───────────────────────────────────────┘
                            │  HTTPS
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│  Browser / Android App                                            │
│  React SPA  ──  AWS Amplify (Cognito auth)                        │
│              ──  AWS SDK v3 (S3 direct upload)                    │
│              ──  CloudFront fetch (index JSON, thumbnails)        │
└───────────────────────────────────────────────────────────────────┘
                            │  S3 trigger (new upload)
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│  AWS Lambda  (photo-visor-exif-processor)                         │
│  Python · Pillow · exifread · Nominatim                           │
│  Updates index files in S3 for newly uploaded photos              │
└───────────────────────────────────────────────────────────────────┘
```

### Infrastructure-as-Code

All AWS resources are defined in **AWS CDK (TypeScript)** under `infra/`. A single `cdk deploy` provisions:

- S3 bucket with lifecycle rules (Glacier Instant Retrieval for `photos/*`)
- CloudFront distribution with OAC, custom domain, and ACM certificate
- Cognito User Pool + Identity Pool (Amplify auth)
- Lambda for post-upload EXIF processing

---

## 3. Data Processing Pipeline

### 3.1 Bulk Ingest (`scripts/bulk-ingest.py`)

The ingest script runs locally and processes all photos from the source folder tree. It is idempotent: re-runs skip unchanged files.

```
Source folder
    │
    ▼
[1] File discovery  ──  rglob over IMAGE_EXTS / VIDEO_EXTS
    │
    ▼
[2] Skip-cache check  ──  compare (path, size, mtime_ns) against SQLite DB
    │                     unchanged files reuse stored hash (no I/O)
    ▼
[3] Quick hash  ──  SHA-256 of (8-byte size ‖ first 64 KB ‖ last 64 KB)
    │               stable across renames and folder moves
    ▼
[4] EXIF extraction  ──  exifread reads GPS tags, DateTimeOriginal
    │                    Fallback: parse datetime from filename pattern
    │                    (WhatsApp "IMG-20191019-WA0041.jpg",
    │                     Android  "20180904_120522.jpg", etc.)
    ▼
[5] Folder classification  ──  heuristic: continent buckets → country → city
    │                          Nominatim reverse-geocode for GPS-tagged photos
    │                          Nominatim forward-geocode for folder city names
    │                          SQLite geocoding cache (1.1 s rate limit)
    ▼
[6] Thumbnail generation  ──  Pillow: 400 px wide, JPEG quality 72, EXIF-aware
    │                          HEIC/HEIF support via pillow-heif (optional)
    ▼
[7] S3 upload  ──  original → photos/{ab}/{hash}.ext  (Glacier Instant)
    │              thumbnail → thumbs/{ab}/{hash}.jpg  (Standard)
    │              Parallel upload with ThreadPoolExecutor (8 workers)
    ▼
[8] SQLite state update  ──  marks photo as 'active', stores geo/datetime/keys
    │
    ▼
[9] Index build  ──  reads all 'active' photos from SQLite
    │                generates JSON files and uploads to S3:
    │                  • index/summary.json      (totals, years, locations)
    │                  • index/time/{year}.json  (flat PhotoEntry[] per year)
    │                  • index/geo/{folder}.json (photos per location album)
    │                  • index/recent.json       (last 100 by ingested_at)
```

### 3.2 Lambda EXIF Processor (`lambdas/exif-processor/`)

Triggered by S3 `ObjectCreated` events on `photos/*`. Performs the same EXIF → geocoding → thumbnail → index-update pipeline for photos uploaded directly through the web app (owner upload tab).

### 3.3 Photo Identity

Photos are identified by a **quick hash** — SHA-256 of `8-byte file size ‖ first 64 KB ‖ last 64 KB`. This is ~400× faster than hashing the full file and has negligible collision probability for photographic content. The hash remains stable even if the file is moved or renamed, enabling change-tracking across incremental re-runs.

### 3.4 Datetime Recovery

20 196 photos had no EXIF datetime. A filename parser recovered 13 679 of them using patterns such as:

| Pattern | Example |
|---|---|
| Android camera | `20180904_120522.jpg` |
| WhatsApp image | `IMG-20191019-WA0041.jpg` |
| WhatsApp video | `VID-20200315-WA0002.mp4` |
| Screenshot | `Screenshot_2021-03-14-09-45-20.png` |

### 3.5 Geocoding

Geographic coordinates are resolved in two ways:
1. **EXIF GPS tags** → Nominatim reverse-geocode → city + country
2. **Folder name** → heuristic city/country token extraction → Nominatim forward-geocode

Results are cached in SQLite to respect the OSM fair-use policy (1.1 s delay between API calls).

### 3.6 Album Notifications (WhatsApp)

When a phone-sync or web upload tags a photo with a `Camera/...` album path, the Lambda sends a WhatsApp message via the [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) (free tier: 1,000 conversations/month):

- **New album created** → immediate message: `📷 New album created: Camera/...`
- **New photos in an existing album** → coalesced message: `🖼️ N new photo(s) added to album: Camera/...`, at most once per `NOTIFY_COOLDOWN_MIN` (default 10 min) — extra uploads within the cooldown are folded into the next message's count.

Each notification is sent as a forwardable WhatsApp **image message**: a collage of up to `NOTIFY_MAX_THUMBS` (3) thumbnails side-by-side (stored under `thumbs/notify/` with ASCII-safe keys) with a caption containing the bold album name and a short redirect URL (`fotos.forwardforecasting.eu/a/<slug>.html`). The redirect page shows a spinning hourglass animation before opening the album deep link. Without thumbnails, a plain text message is sent instead.

The Lambda also appends every phone-synced photo to `index/recent.json` (capped at 200, newest first) so all users see recently added photos in the Latest tab — not just the device that performed the sync.

State (including per-album pending counts and queued thumbnail keys) is tracked in `index/notify_state.json`. Bulk-ingest uploads (no `album-path` metadata) never trigger notifications — see [3.1](#31-bulk-ingest-scriptsbulk-ingestpy). Credentials live in SSM Parameter Store (never in this repo); see [Environment / Secrets](#environment--secrets) for setup.

### 3.7 Shared Comments

Comments can be shared across all family members or kept private. The comment modal includes a "Share with family" checkbox (default: checked for new comments). Shared comments are stored in `index/tags/shared.json` alongside shared tags; private comments remain in each user's personal tag file (`index/tags/{email}.json`). Both `getComment` and the Latest > Comments subtab merge shared and private comments, with shared taking precedence.

---

## 4. Libraries & Dependencies

### Python (ingest script & Lambda)

| Library | Purpose |
|---|---|
| **boto3** | AWS SDK for Python. Uploads photos, thumbnails, and index JSON files to S3; reads/writes index files from Lambda. |
| **Pillow (PIL)** | Image processing library. Generates 400 px JPEG thumbnails with EXIF-aware auto-rotation (`ImageOps.exif_transpose`). Also reads basic image dimensions. |
| **pillow-heif** | Optional plugin that adds HEIC/HEIF support to Pillow (common on iPhones). Registered with `register_heif_opener()` at runtime. |
| **exifread** | Pure-Python EXIF tag reader. Extracts `GPS GPSLatitude`, `GPS GPSLongitude`, `EXIF DateTimeOriginal`, `Image Orientation`. Lower-level than Pillow's EXIF module, giving access to raw GPS rational values. |
| **requests** | HTTP client used to call the Nominatim (OpenStreetMap) geocoding API. Includes `User-Agent` header per OSM fair-use policy. |
| **tqdm** | Terminal progress bars with ETA, rate, and total counts for the multi-step ingest pipeline. |
| **sqlite3** | Python standard library. Maintains `state.db`: tracks every photo's hash, S3 keys, datetime, geo coordinates, upload status, and mtime cache to avoid re-hashing unchanged files. |
| **hashlib** | Python standard library. Used for the quick-hash SHA-256 fingerprint. |
| **concurrent.futures** | Python standard library. `ThreadPoolExecutor` with 8 workers parallelises the S3 upload step. |
| **pathlib** | Python standard library. All file-system operations use `Path` objects for portability. |

### TypeScript / JavaScript (frontend)

| Library | Purpose |
|---|---|
| **React 18** | UI component framework. Context API manages global state (language, privacy, tags). |
| **TypeScript** | Static typing across the entire frontend. |
| **Vite 5** | Build tool and dev server. Produces the optimised PWA bundle. |
| **AWS Amplify v6** | Cognito authentication. Provides `Authenticator` UI component, `getCurrentUser`, `fetchAuthSession`. |
| **AWS SDK v3 (`@aws-sdk/client-s3`)** | Used client-side (with Cognito Identity Pool credentials) for direct S3 uploads from the browser and for writing per-user tag/comment JSON files. |
| **react-leaflet + leaflet** | Interactive world map. Photos are clustered by location using `leaflet.markercluster`. |
| **vite-plugin-pwa** | Generates Service Worker and Web App Manifest for offline capability and "Add to Home Screen". Uses Workbox under the hood (CacheFirst for thumbnails, NetworkFirst for index files). |
| **Capacitor 6** | Wraps the PWA in a native Android WebView for Google Play distribution. Supports Node 18 (unlike Capacitor 7 which requires Node 22). |
| **AWS CDK (TypeScript)** | Infrastructure-as-Code for all AWS resources. |

### AI / ML Technologies

**This project does not use any AI, machine learning, or generative AI technologies.** Specifically:

- No large language models (LLM) or generative AI (GenAI)
- No image classification or computer vision models
- No speech-to-text conversion
- No image diffusion models
- No chatbots or conversational AI
- No Retrieval-Augmented Generation (RAG)
- No agentic AI frameworks

The project was *developed* using Claude Code (Anthropic's AI coding assistant), but the deployed application contains no AI components.

---

## 5. Technologies NOT Used (and Why)

| Technology | Reason not used |
|---|---|
| **Kafka** | No event streaming required. The ingest pipeline runs as a local batch job; S3 events trigger Lambda directly. |
| **GraphQL** | No API server exists. All data is pre-computed JSON served as static files via CloudFront. GraphQL would add latency and cost without benefit. |
| **Kubernetes** | No containers or microservices. The backend is fully serverless (S3 + CloudFront + Lambda). |
| **FastAPI** | No REST API server. The architecture is "static-first": all index files are pre-built JSON uploaded to S3. No request-time computation is needed. |
| **PostgreSQL / any RDBMS** | A SQLite file (`state.db`) runs locally during ingest only; it is never deployed. The production system is database-free. |
| **Redis / ElastiCache** | CloudFront edge caching replaces an application cache layer. No session state is stored server-side. |

---

## 6. Data Flow Diagram

### 6.1 High-Level Architecture Flow

```mermaid
flowchart TD
    A["/mnt/sda2/Personal/Fotos\n194 754 files · 475 GB"] --> B

    subgraph INGEST["bulk-ingest.py  (local)"]
        B["[1] File discovery\nrglob · filter by extension"]
        B --> C["[2] Skip-cache check\nSQLite mtime_ns + size"]
        C --> D["[3] Quick hash\nSHA-256 · size‖first64KB‖last64KB"]
        D --> E["[4] EXIF extraction\nexifread · filename-date parser"]
        E --> F["[5] Geocoding\nNominatim API · SQLite cache"]
        F --> G["[6] Thumbnail generation\nPillow · 400px · quality 72"]
        G --> H["[7] S3 upload\nboto3 · 8 parallel workers"]
        H --> I["[8] SQLite update\nstatus=active · store keys"]
        I --> J["[9] Index build\nsummary · time · geo · recent"]
    end

    J -->|"PUT index/*.json"| S3

    subgraph S3["Amazon S3"]
        P["photos/{ab}/{hash}.ext\nGlacier Instant Retrieval"]
        T["thumbs/{ab}/{hash}.jpg\nS3 Standard"]
        IDX["index/*.json\nS3 Standard"]
        APP["app/\nReact PWA build"]
    end

    H --> P
    G --> T
    J --> IDX

    subgraph LAMBDA["AWS Lambda\nexif-processor"]
        L1["EXIF extract"]
        L2["Nominatim geocode"]
        L3["Pillow thumbnail"]
        L4["Update index files"]
    end

    P -->|"S3 ObjectCreated trigger"| L1
    L1 --> L2 --> L3 --> L4
    L4 -->|"PUT index updates"| IDX

    S3 -->|"OAC"| CF["Amazon CloudFront\nfotos.forwardforecasting.eu"]

    CF -->|"HTTPS"| FE

    subgraph FE["Browser / Android App"]
        AUTH["AWS Amplify\nCognito auth"]
        MAP["Map tab\nreact-leaflet · photo counts"]
        TL["Timeline tab\nauto-selects latest month"]
        TAGS["Tags tab\nprivate + shared JSON"]
        LATEST["Latest tab"]
        SLOTS["Slot Machine tab"]
        SYNC["Sync tab\nphone-to-cloud · favorites S3 sync"]
    end

    AUTH -->|"Identity Pool credentials"| SYNC
    SYNC -->|"PutObject (favorites)"| IDX
```

### 6.2 Function-Level Call Graph

Shows the actual Python functions and their call relationships in both the local ingest script and the Lambda.

```mermaid
flowchart TD
    subgraph INGEST["bulk-ingest.py — function call graph"]
        RUN["run(args)\norchestrator · parses CLI args"]
        RUN --> ODB["open_db()\nSQLite: create schema + return connection"]
        RUN --> SL["scan_local(root, db)\nrglob all media files\ncompare mtime_ns + size to SQLite cache"]
        SL -->|"8 ThreadPoolExecutor workers"| PP["process_photo(args)\nper-file worker function"]
        PP --> QH["quick_hash(path, size)\nSHA-256 of size ‖ head 64 KB ‖ tail 64 KB\n~400× faster than full-file hash"]
        PP --> EX["extract_exif(path)\nexifread → GPS rational values\nDateTimeOriginal / Orientation"]
        EX -->|"no EXIF date"| PFD["parse_filename_date(fname)\nregex: Android · WhatsApp IMG/VID\nScreenshot · generic YYYYMMDD"]
        PP --> CP["classify_path(rel_path)\ncontinent bucket → country → city tokens\nSpanish→English country normalisation"]
        CP --> GEO["geocode(db, city, country)\nNominatim forward geocode\nSQLite cache · 1.1 s rate-limit delay"]
        PP --> GT["generate_thumbnail(path)\nPillow · ImageOps.exif_transpose\nLANCZOS resize to 400 px wide\nJPEG quality 72"]
        PP --> UPH["upload_photo(s3, path, hash, dry_run)\nboto3 PutObject\n→ photos/{ab}/{hash}.ext\nStorageClass: GLACIER_IR"]
        PP --> UPT["upload_thumbnail(s3, thumb, hash, dry_run)\nboto3 PutObject\n→ thumbs/{ab}/{hash}.jpg\nStorageClass: STANDARD"]
        RUN --> BUI["build_and_upload_index(db, s3, dry_run)\nread all status=active rows from SQLite\nbuild JSON structures\n→ _put_index() for each file"]
        BUI --> IDX1["index/time/{year}.json\nPhotoEntry[] sorted by dt"]
        BUI --> IDX2["index/geo/{Country_City}.json\nper-location photo arrays"]
        BUI --> IDX3["index/summary.json\ntotals · years · locations list"]
        BUI --> IDX4["index/recent.json\nlast 100 by ingested_at"]
    end

    UPH -->|"S3 ObjectCreated event\n(web-uploaded photos only)"| TRIG

    subgraph LAMBDA["exif-processor/index.py — function call graph"]
        TRIG["handler(event, context)\nS3 trigger entry point\niterates over event Records"]
        TRIG --> PROC["_process(key)\ndownloads photo bytes from S3\nmain per-upload orchestrator"]
        PROC --> LEX["extract_exif(data: bytes)\nexifread on raw S3 bytes\nGPS rational → decimal · DateTimeOriginal"]
        PROC -->|"no EXIF date"| LFD["filename_date(name)\n3-pattern regex fallback\nYYYYMMDD_HHMMSS · YYYY-MM-DD · YYYYMMDD"]
        PROC --> LRG["reverse_geocode(lat, lng)\nNominatim reverse API\nurllib.request · zoom=10 · 1.1 s delay"]
        PROC --> LMT["make_thumbnail(data, ext)\nPillow LANCZOS → 400 px wide\nJPEG quality 72 · skip RAW formats"]
        PROC --> LRJ["_read_json(key)\nS3 GetObject + json.loads\nreturns [] or {} on missing key"]
        LRJ --> LWJ["_write_json(key, data)\nS3 PutObject + json.dumps\nCacheControl: max-age=3600"]
        LWJ --> LIDX1["index/time/{year}.json\nappend entry · sort by dt"]
        LWJ --> LIDX2["index/geo/{loc_key}.json\nappend entry if new hash"]
        LWJ --> LIDX3["index/summary.json\npatch total count · years set · locations list"]
    end
```

---

## 7. AWS Cost Estimation

Based on actual usage: **194 754 photos · 475 GB originals · ~20 GB thumbnails · ~0.1 GB indexes**.  
Assumes a family of ~5 users browsing occasionally (~10 GB CloudFront egress/month).

### 7.1 Storage

| Service | Resource | Unit price | Quantity | Monthly |
|---|---|---|---|---|
| S3 Glacier Instant Retrieval | Photo originals | $0.004 / GB | 475 GB | **$1.90** |
| S3 Standard | Thumbnails (400 px JPEG) | $0.023 / GB | 20 GB | **$0.46** |
| S3 Standard | Index JSON + app bundle | $0.023 / GB | ~0.5 GB | **$0.01** |
| | | | **Storage subtotal** | **≈ $2.37 / month** |

### 7.2 Processing & Requests

| Service | Resource | Unit price | Quantity | Monthly |
|---|---|---|---|---|
| Lambda | EXIF processor invocations | First 1 M req free | ~100 / month | **$0.00** |
| Lambda | Compute (128 MB · ~3 s / call) | Free tier covers it | ~100 / month | **$0.00** |
| S3 Glacier IR | GET / retrieval requests | $0.01 / 1 000 GETs | ~5 000 / month | **$0.05** |
| S3 Standard | PUT requests *(ingest, one-time)* | $0.005 / 1 000 | ~200 000 total | **$1.00** *(one-time)* |
| SSM Parameter Store | Standard parameter GetParameter | Free (standard tier) | ~100 / month | **$0.00** |
| Meta WhatsApp Cloud API | WhatsApp album notifications | Free tier (1,000 conversations/month) | ~10 / month | **$0.00** |
| | | | **Processing subtotal** | **≈ $0.05 / month** |

### 7.3 Connectivity

| Service | Resource | Unit price | Quantity | Monthly |
|---|---|---|---|---|
| CloudFront | Data transfer to internet | First 1 TB / month free | ~10 GB | **$0.00** |
| CloudFront | HTTPS requests | First 10 M / month free | ~100 K | **$0.00** |
| Nominatim (OSM) | Geocoding API calls | Free (fair-use) | ~1 000 one-time | **$0.00** |
| | | | **Connectivity subtotal** | **$0.00 / month** |

### 7.4 Auth & Infrastructure

| Service | Resource | Unit price | Quantity | Monthly |
|---|---|---|---|---|
| Cognito | Monthly active users | First 50 K free | ~5 users | **$0.00** |
| ACM | TLS certificate | Free with CloudFront | 1 cert | **$0.00** |
| Route 53 | DNS hosted zone | $0.50 / zone | 0 *(CNAME at registrar)* | **$0.00** |
| | | | **Auth subtotal** | **$0.00 / month** |

### 7.5 AI Services

This application uses **no AI services in production**. All geocoding is done via the free Nominatim (OpenStreetMap) API; all image processing is deterministic (Pillow). No LLM, no image classifier, no diffusion model, no chatbot, no RAG pipeline.

| Service | Usage | Monthly cost |
|---|---|---|
| Any LLM / GenAI in production | — | **$0.00** |
| Any image classification / diffusion | — | **$0.00** |
| Nominatim geocoding (OSM, free) | ~1 000 calls one-time during ingest | **$0.00** |
| **Anthropic Claude Code** *(development only)* | ~15–20 h of coding sessions | **$0.00 ongoing** |

One-time development cost using Claude Code (Claude Sonnet, billed per token): approximately **$30–60**.

### 7.6 Monthly & Annual Summary

| Category | Monthly | Annual |
|---|---|---|
| Storage | $2.37 | $28.44 |
| Processing & Requests | $0.05 | $0.60 |
| Connectivity | $0.00 | $0.00 |
| Auth & Infrastructure | $0.00 | $0.00 |
| AI Services | $0.00 | $0.00 |
| **Total ongoing** | **≈ $2.42** | **≈ $29.04** |

| One-time costs | Amount |
|---|---|
| S3 PUT requests for initial ingest (~200 K files) | ~$1.00 |
| Development with Claude Code (Anthropic) | ~$30–60 |
| **Total first-year cost** | **~$60–90** |
| **Subsequent years** | **~$29 / year** |

### Cost Scaling

| Scenario | Additional monthly cost |
|---|---|
| +100 GB new photos added | +$0.40 / month |
| Heavy browsing (100 GB CloudFront egress) | +$7.65 / month |
| 50 active users (Cognito still free tier) | +$0.00 |
| Adding an LLM feature (e.g., photo captioning) | +variable (API tokens) |

---

## 8. Setup & Deployment

### Prerequisites

- Node.js 18+, Python 3.11+, AWS CLI v2, AWS CDK v2
- AWS account with appropriate IAM permissions
- Photos at `/mnt/sda2/Personal/Fotos` (configurable in `bulk-ingest.py`)

### 1. Deploy AWS Infrastructure

```bash
cd infra
npm install
cdk bootstrap
cdk deploy
# Outputs written to ../stack-outputs.json
```

### 2. Configure Frontend

```bash
# stack-outputs.json is auto-read by src/config.ts
cd frontend
npm install
```

### 3. Run Bulk Ingest

```bash
cd scripts
pip install boto3 exifread pillow requests tqdm
python3 bulk-ingest.py --workers 8
# First run: ~24 h for 194 754 files
# Subsequent runs: minutes (skip-cache on unchanged files)
```

### 4. Build & Deploy Frontend

```bash
cd frontend
NODE_OPTIONS=--experimental-global-webcrypto npm run build
aws s3 sync dist s3://<bucket>/app/ --delete \
  --cache-control "no-cache" --exclude "*.js" --exclude "*.css"
aws s3 sync dist s3://<bucket>/app/ --delete \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude "*" --include "*.js" --include "*.css"
aws cloudfront create-invalidation \
  --distribution-id <id> --paths "/app/*"
```

### 5. Android Build (optional)

```bash
cd frontend
npm run build
npx cap sync android
npx cap open android
# Build release APK in Android Studio
```

### Environment / Secrets

No secrets are committed. The only configuration is `stack-outputs.json` (CDK outputs) and `src/config.ts` (reads from stack outputs). AWS credentials are managed via IAM roles and the standard AWS credential chain.

#### WhatsApp album notifications (optional)

To enable [album notifications](#36-album-notifications-whatsapp) via the Meta WhatsApp Cloud API free tier:

1. Create a [Meta Business account](https://business.facebook.com/) and a [WhatsApp Business app](https://developers.facebook.com/apps/).
2. In the app dashboard, go to **WhatsApp > API Setup**, note your **Phone number ID**, and add your personal WhatsApp number as a test recipient.
3. Generate an access token (temporary tokens last 24 h; for production, create a System User permanent token).
4. Store credentials in SSM Parameter Store (one-time, never committed to git):
   ```bash
   aws ssm put-parameter --name /photo-visor/whatsapp/access_token    --type SecureString --value "<access token>"
   aws ssm put-parameter --name /photo-visor/whatsapp/phone_number_id --type String       --value "<phone number ID>"
   aws ssm put-parameter --name /photo-visor/whatsapp/recipient_phone --type String       --value "<your number, e.g. 34717712853>"
   ```
5. `cdk deploy` once to grant the Lambda `ssm:GetParameter` on `/photo-visor/whatsapp/*`.

If these parameters don't exist, the Lambda silently skips notifications (no error). The free tier includes 1,000 conversations/month. Note: image messages (with collage) require an active 24-hour conversation window — if the recipient hasn't messaged the business number recently, the notification falls back to plain text.

---

## 9. Auditing

This section provides a structured checklist for review by an IT expert and a cloud-architecture / data-management subject-matter expert.

### Audit Items

- **Cost & resource minimization** — ~$2–3/month, dominated by S3 Glacier Instant Retrieval for 475 GB of photo originals ($1.90/month). CloudFront delivery and Lambda EXIF processing remain within AWS free tiers. Cost is well-optimized for the data volume.
- **IT architecture** — Fully serverless and database-free in production. CDK IaC provisions all resources reproducibly. Pre-computed JSON indexes eliminate query-time compute. CloudFront OAC enforces that S3 is never directly accessible. Architecture is appropriate and well-sized for a family photo viewer.
- **Code efficiency** — Quick-hash (8-byte size ‖ first 64 KB ‖ last 64 KB) is ~400× faster than full-file SHA-256 with negligible collision probability for photographic content. Parallel S3 uploads via `ThreadPoolExecutor` (8 workers). Incremental ingest skips unchanged files using SQLite `mtime_ns` + size cache.
- **Cybersecurity** — Cognito authentication is required for photo uploads (owner only). CloudFront OAC prevents direct S3 bucket access. No secrets are committed. Index JSON files (including `index/tags/{user}.json`) are served via CloudFront — if the URL structure is known, tag data could be read without authentication. Evaluating whether tag/comment indexes should require Cognito token validation is recommended.
- **Readability & maintainability** — Function-level Mermaid call graphs for both the ingest script and Lambda are the clearest architectural documentation in the portfolio. CDK TypeScript code is the single source of truth for infrastructure.
- **AI / ML** — No AI is used in production, which is appropriate for a photo viewer. The README explicitly notes that Claude Code was used for development only.
- **Data resilience** — 475 GB of photo originals are stored in a single S3 bucket. No S3 versioning, cross-region replication, or documented backup strategy is mentioned. Loss of the bucket (accidental deletion) would be unrecoverable.
- **Other** — Nominatim fair-use rate limit (1.1s delay) is respected. HEIC/HEIF support requires the optional `pillow-heif` package. No AWS cost alarm or budget alert is documented. Android app is in Google Play Internal Testing (not public).

### Summary Table

| Audit Item | Claude's Assessment | Human Expert Assessment |
|---|---|---|
| Cost & resource minimization | ~$2–3/month. S3 Glacier IR is the correct storage class for infrequently accessed originals. CloudFront and Lambda stay in free tier. | |
| IT architecture | Serverless + database-free design is clean and appropriately sized. CDK IaC ensures reproducibility. Pre-computed indexes avoid runtime queries. | |
| Code efficiency | Quick-hash is 400× faster than full SHA-256. Parallel uploads and incremental ingest minimize re-processing. | |
| Cybersecurity | Cognito upload auth and CloudFront OAC are correct. Tag/comment index files may be readable without auth if URL is known — review recommended. | |
| Readability & maintainability | Mermaid call graphs and CDK IaC are best-in-class for documentation and infrastructure reproducibility. | |
| AI / ML | No AI in production. Appropriate for this use case. | |
| Data resilience | No documented backup strategy for 475 GB of originals. S3 versioning or cross-region replication should be considered. | |
| Other | Nominatim rate-limit respected. No AWS budget alert documented. Android app in internal testing only. | |


---

## 10. CI/CD

### What is CI/CD?

**CI/CD** stands for **Continuous Integration / Continuous Deployment**. It is a software engineering practice that automates the steps of verifying, packaging, and releasing code whenever a change is pushed to the repository.

- **Continuous Integration (CI)** — each push triggers automated checks that confirm the change doesn't break the codebase.
- **Continuous Deployment (CD)** — once checks pass, the new version is automatically shipped to the live environment with no manual steps.

### Key Benefits

| Benefit | Description |
|---|---|
| **Speed** | Changes go live in seconds, not hours |
| **Consistency** | Every deploy follows the exact same steps — no human error |
| **Safety** | Broken code is caught before it reaches production |
| **Traceability** | Every deployment is linked to a specific commit and author |
| **Zero-downtime iterations** | Small frequent releases are safer than large rare ones |

### How it is applied here

Photo Visor is **fully serverless** — there is no EC2 instance to SSH into. On every push to `main`, GitHub Actions detects which paths changed and runs only the relevant job:

- **`frontend/`** changes → build React PWA with Vite → sync to S3 `/app/` → invalidate CloudFront cache
- **`lambdas/`** changes → install Python dependencies → zip → update the Lambda function in-place

Path filtering prevents unnecessary rebuilds: a README change triggers neither job. The two jobs run independently in parallel when both paths change. `index.html` is always uploaded with `no-cache` headers so browsers pick up the new shell immediately; hashed asset bundles (`index-AbCd1234.js`) use a 1-year immutable cache for maximum CDN efficiency.

**Trigger:** push to `main` (path-filtered per job)
**Runner:** `ubuntu-latest` (GitHub-hosted)
**Secrets required:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

### Implementation Diagram

```mermaid
flowchart TD
    DEV([👨‍💻 Developer\npushes to main])
    GH[GitHub repository\nfborbon/photo-visor]
    GA[GitHub Actions\nubuntu-latest runner]
    FILTER{paths-filter\ndetects changes}

    subgraph FRONTEND [Job: frontend]
        NCI[npm ci]
        BUILD[npm run build\nVite + TypeScript]
        S3[aws s3 sync\n→ S3 /app/]
        CF[CloudFront invalidation\n/app/*]
    end

    subgraph LAMBDA [Job: lambda]
        PIP[pip install\n→ package/]
        ZIP[zip package/\n→ function.zip]
        LMB[aws lambda\nupdate-function-code]
    end

    DONE1[✅ PWA live at\nfotos.forwardforecasting.eu]
    DONE2[✅ Lambda updated\nphoto-visor-exif-processor]

    DEV --> GH
    GH --> GA
    GA --> FILTER
    FILTER -->|frontend/** changed| NCI
    FILTER -->|lambdas/** changed| PIP
    NCI --> BUILD --> S3 --> CF --> DONE1
    PIP --> ZIP --> LMB --> DONE2

    style DEV fill:#4a90d9,color:#fff
    style DONE1 fill:#27ae60,color:#fff
    style DONE2 fill:#27ae60,color:#fff
    style FILTER fill:#8e44ad,color:#fff
    style S3 fill:#e67e22,color:#fff
    style LMB fill:#e67e22,color:#fff
```
