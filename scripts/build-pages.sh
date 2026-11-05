#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/dist"

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

cp "$ROOT_DIR/index.html" "$OUTPUT_DIR/index.html"
cp -R "$ROOT_DIR/public" "$OUTPUT_DIR/public"

python3 "$ROOT_DIR/scripts/configure-posthog.py" "$OUTPUT_DIR/index.html"

if [[ -f "$ROOT_DIR/_headers" ]]; then
  cp "$ROOT_DIR/_headers" "$OUTPUT_DIR/_headers"
fi

echo "MERCY ARENA static site prepared in dist/"
