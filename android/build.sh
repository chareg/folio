#!/usr/bin/env bash
# Builds Folio for Android (build/Folio.apk) without Gradle or the Android SDK manager.
#
# Needs: JDK 17+, Node 18+, python3 with Pillow (only to redraw icons), and Debian/Ubuntu's
# Android tools:  sudo apt-get install aapt apksigner zipalign dalvik-exchange
#
# Signing: set FOLIO_KEYSTORE (+ FOLIO_KEYSTORE_PASS, FOLIO_KEY_ALIAS) to sign with your
# release key, so new builds install over old ones. Without it, a throwaway key is made.
set -euo pipefail
cd "$(dirname "$0")"

VERSION_NAME="$(node -p "require('./package.json').version")"
VERSION_CODE="${FOLIO_VERSION_CODE:-$(node -p "const [a,b,c]=require('./package.json').version.split('.').map(Number); a*10000+b*100+c")}"
ANDROID_JAR="${ANDROID_JAR:-.cache/android-34.jar}"
OUT=build

if [ ! -f "$ANDROID_JAR" ]; then
  echo "• fetching android.jar (API 34)"
  mkdir -p "$(dirname "$ANDROID_JAR")"
  curl -fsSL -o "$ANDROID_JAR" https://raw.githubusercontent.com/Reginer/aosp-android-jar/main/android-34/android.jar
fi

echo "• web assets"
rm -rf "$OUT"; mkdir -p "$OUT/assets/www/vendor/pdfjs" "$OUT/gen" "$OUT/classes"
WWW="$OUT/assets/www"
cp web/*.html web/*.css web/*.js "$WWW/"
python3 tools/extract_css.py ../tools/web-template.html > "$WWW/folio-base.css"
cp ../app/fonts.css "$WWW/"; cp -r ../app/fonts "$WWW/fonts"
cp ../app/vendor/jszip.min.js ../app/vendor/mammoth.browser.min.js "$WWW/vendor/"
[ -d node_modules/pdfjs-dist ] || npm ci --no-audit --no-fund --silent || npm install --no-audit --no-fund --silent
PDFJS=node_modules/pdfjs-dist/legacy/build
cp "$PDFJS/pdf.min.mjs" "$PDFJS/pdf.worker.min.mjs" "$WWW/vendor/pdfjs/"
cp -r node_modules/pdfjs-dist/cmaps node_modules/pdfjs-dist/standard_fonts "$WWW/vendor/pdfjs/"
cp node_modules/pdfjs-dist/LICENSE "$WWW/vendor/pdfjs/LICENSE"

echo "• resources"
aapt2 compile --dir app/res -o "$OUT/res.zip"
aapt2 link -I "$ANDROID_JAR" --manifest app/AndroidManifest.xml -A "$OUT/assets" \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --java "$OUT/gen" -o "$OUT/unaligned.apk" "$OUT/res.zip"

echo "• java"
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$ANDROID_JAR" -encoding UTF-8 \
  -d "$OUT/classes" $(find app/java "$OUT/gen" -name '*.java')
dalvik-exchange --dex --min-sdk-version=26 --output="$OUT/classes.dex" "$OUT/classes"
(cd "$OUT" && zip -q -j unaligned.apk classes.dex)

echo "• align + sign"
zipalign -f -p 4 "$OUT/unaligned.apk" "$OUT/aligned.apk"
KS="${FOLIO_KEYSTORE:-}"
if [ -z "$KS" ]; then
  KS="$OUT/throwaway.jks"
  keytool -genkeypair -keystore "$KS" -storepass folio-dev -keypass folio-dev -alias folio \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Folio dev build" >/dev/null 2>&1
  FOLIO_KEYSTORE_PASS=folio-dev; FOLIO_KEY_ALIAS=folio
  echo "  (signed with a throwaway key; set FOLIO_KEYSTORE to use your own)"
fi
apksigner sign --ks "$KS" --ks-pass "pass:${FOLIO_KEYSTORE_PASS:?set FOLIO_KEYSTORE_PASS}" \
  --ks-key-alias "${FOLIO_KEY_ALIAS:-folio}" --out "$OUT/Folio.apk" "$OUT/aligned.apk"
apksigner verify "$OUT/Folio.apk"
rm -f "$OUT/unaligned.apk" "$OUT/aligned.apk" "$OUT/Folio.apk.idsig"
echo "✓ $OUT/Folio.apk ($VERSION_NAME, code $VERSION_CODE, $(du -h "$OUT/Folio.apk" | cut -f1))"
