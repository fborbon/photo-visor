#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing dependencies..."
pip3 install -r "$DIR/requirements.txt" --target "$DIR/package" --quiet

echo "Copying handler..."
cp "$DIR/index.py" "$DIR/package/"

echo "Zipping..."
cd "$DIR/package"
zip -r "$DIR/function.zip" . -q

echo "Deploying to Lambda..."
aws lambda update-function-code \
  --function-name photo-visor-exif-processor \
  --zip-file fileb://"$DIR/function.zip" \
  --query "FunctionName" \
  --output text

echo "Done."
