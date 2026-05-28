#!/usr/bin/env bash
# Build and deploy the frontend to S3 + CloudFront.
# Usage: ./deploy.sh
set -e

BUCKET="photo-visor-295936871972"
CF_ID="E2JW5PYKNPPYOB"
DIST="dist"

echo "Building..."
BASE_URL=/app/ npx vite build

echo "Syncing assets (immutable cache)..."
# index/ is managed exclusively by bulk-ingest.py — never overwrite it here.
aws s3 sync "$DIST/" "s3://$BUCKET/app/" --delete \
  --exclude "index.html" --exclude "sw.js" --exclude "manifest.json" \
  --exclude "index/*"

echo "Uploading HTML/SW with no-cache headers..."
aws s3 cp "$DIST/index.html"   "s3://$BUCKET/app/index.html"   --cache-control "no-cache, no-store, must-revalidate" --content-type "text/html"
aws s3 cp "$DIST/sw.js"        "s3://$BUCKET/app/sw.js"        --cache-control "no-cache, no-store, must-revalidate" --content-type "text/javascript"
aws s3 cp "$DIST/manifest.json" "s3://$BUCKET/app/manifest.json" --cache-control "no-cache, no-store, must-revalidate" --content-type "application/manifest+json"

echo "Invalidating CloudFront..."
aws cloudfront create-invalidation --distribution-id "$CF_ID" \
  --paths "/app/index.html" "/app/sw.js" "/app/manifest.json" "/" \
  --query 'Invalidation.Status' --output text

echo "Done."
