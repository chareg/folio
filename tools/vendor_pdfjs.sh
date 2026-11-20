#!/usr/bin/env bash
# Refreshes app/vendor/pdfjs from npm. Usage: tools/vendor_pdfjs.sh [version]
set -euo pipefail
cd "$(dirname "$0")/.."
V="${1:-4.10.38}"
TMP="$(mktemp -d)"
(cd "$TMP" && npm init -y >/dev/null && npm install --no-audit --no-fund --silent "pdfjs-dist@$V")
P="$TMP/node_modules/pdfjs-dist"
rm -rf app/vendor/pdfjs && mkdir -p app/vendor/pdfjs
cp "$P/legacy/build/pdf.min.mjs" "$P/legacy/build/pdf.worker.min.mjs" "$P/LICENSE" app/vendor/pdfjs/
cp -r "$P/cmaps" "$P/standard_fonts" app/vendor/pdfjs/
rm -rf "$TMP"
echo "pdf.js $V vendored into app/vendor/pdfjs"
