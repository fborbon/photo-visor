# 📷 Photo Visor

A personal family photo viewer hosted on AWS — exploring 190 000+ photos across a world map and timeline with tagging, commenting, upload, and a slot-machine discovery mode. Built for minimal cost (~$2–3/month) with no database and no server.

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

- **Map** — photos plotted on a Leaflet world map by GPS / folder geocoding
- **Timeline** — photos browsed by year → month
- **Tags** — per-user private tags with optional family sharing
- **Latest** — recently added photos, newest tags, newest comments
- **Slot Machine** — random photo discovery (10 reels, slot-machine animation)
- **Upload** — owner-only direct upload to S3 with EXIF processing

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
│  index/tags/{user}.json   ← S3 Standard (per-user private tags)  │
│  index/tags/shared.json   ← S3 Standard (family-shared tags)     │
│  index/recent.json        ← S3 Standard (last 100 ingested)      │
│  index/private.json       ← S3 Standard (privacy overrides)      │
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
        MAP["Map tab\nreact-leaflet"]
        TL["Timeline tab"]
        TAGS["Tags tab\nprivate + shared JSON"]
        LATEST["Latest tab"]
        SLOTS["Slot Machine tab"]
        UP["Upload tab\nS3 direct upload"]
    end

    AUTH -->|"Identity Pool credentials"| UP
    UP -->|"PutObject"| P
```

---

## 7. AWS Cost Estimation

Based on actual usage: **194 754 photos · 475 GB originals · ~20 GB thumbnails · ~0.1 GB indexes**.  
Assumes a family of ~5 users browsing occasionally (~10 GB CloudFront egress/month).

### Monthly Cost Breakdown

| Service | Resource | Unit price | Quantity | Monthly cost |
|---|---|---|---|---|
| **S3 Glacier Instant** | Originals storage | $0.004 / GB | 475 GB | **$1.90** |
| **S3 Standard** | Thumbnails storage | $0.023 / GB | 20 GB | **$0.46** |
| **S3 Standard** | Index files storage | $0.023 / GB | 0.1 GB | **$0.00** |
| **S3 Glacier Instant** | Retrieval requests | $0.01 / 1000 GET | ~5 000/month | **$0.05** |
| **S3 Standard** | PUT requests (ingest) | $0.005 / 1000 | ~200 000 one-time | **$1.00** *(one-time)* |
| **CloudFront** | Egress to internet | First 1 TB free | ~10 GB/month | **$0.00** |
| **CloudFront** | HTTPS requests | First 10M free | ~100K/month | **$0.00** |
| **Cognito** | Monthly active users | First 50K free | ~5 users | **$0.00** |
| **Lambda** | EXIF processor | First 1M req free | ~100/month | **$0.00** |
| **ACM** | TLS certificate | Free with CloudFront | 1 | **$0.00** |
| **Route 53** | DNS hosted zone | $0.50 / zone | 0 *(CNAME at registrar)* | **$0.00** |
| | | | **Total/month** | **≈ $2.40** |

### Yearly Cost

| | Cost |
|---|---|
| Recurring (storage + retrieval) | **~$28 / year** |
| One-time ingest S3 PUT requests | **~$1** |
| **Total first year** | **~$29** |
| **Subsequent years** | **~$28 / year** |

### Cost Scaling

| Scenario | Additional monthly cost |
|---|---|
| +100 GB new photos added | +$0.40 / month |
| Heavy browsing (100 GB CloudFront egress) | +$7.65 / month |
| 50 users (Cognito still free tier) | +$0.00 |

### Anthropic (Development Cost)

The application was developed using **Claude Code** (Anthropic's AI coding assistant). There is **no ongoing Anthropic API cost** in production — the app contains no AI components.

Estimated development sessions: ~15–20 hours of Claude Code usage.  
Approximate one-time development cost: **$30–60** (Claude Sonnet API pricing, billed per token).

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
