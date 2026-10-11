#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
mkdir -p "$DIST"
rm -f "$DIST/firefox.zip" "$DIST/chrome.zip"
EXCLUDES=(
  -x "node_modules/*" -x "dist/*" -x "*.zip" -x ".git/*"
  -x "test/*" -x "*.bak" -x ".env" -x ".dev.vars" -x ".wrangler/*"
  -x "*.log" -x "store/*" -x "prototype.html" -x "Neon Code Refresh Icon.png"
)
(cd "$ROOT" && zip -q "$DIST/firefox.zip" -r . "${EXCLUDES[@]}")
(cd "$ROOT" && zip -q "$DIST/chrome.zip" -r . "${EXCLUDES[@]}")
echo "built: $DIST/firefox.zip, $DIST/chrome.zip"
