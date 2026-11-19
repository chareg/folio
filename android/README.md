# Folio for Android

A calm reader for **PDFs** and **Word documents** on your phone, in Folio's three moods: Paper, Mist and Night. It's read-only: no editing, nothing uploaded, your files never leave the phone.

## What it does

- **Dark PDFs that actually look good.** In Night, every page is redrawn as light ink on a plum-dark page. Coloured text keeps its colour (red stays red, links stay blue, just lighter), highlights stay visible, and **photos keep their real colours**, slightly dimmed. Scanned pages and black-and-white diagrams count as paper, so they turn dark too. Mist gives pages a soft sage paper. Switch to *As printed* under **Aa** any time.
- **Word documents** open in the same reading layout as Folio on Windows: proper headings, contents, reading time, text size and serif/sans.
- **Contents drawer**: PDF bookmarks or Word headings, plus *Go to page* for PDFs.
- **Pinch or double-tap to zoom** PDFs. Tap a page to hide or show the top bar; it also tucks itself away as you scroll down.
- **Picks up where you left off**, and keeps a *Recently read* list.
- Appears in **Open with** and **Share** menus for PDFs and .docx files.

## Install

Download `Folio.apk` to your phone and open it. Android asks you to allow installs from that app (your browser or Files) the first time. Android 8.0 or newer.

## Build

No Gradle or Android Studio needed, just the small Android tools Debian/Ubuntu ship:

```bash
sudo apt-get install aapt apksigner zipalign dalvik-exchange
cd android
npm ci
./build.sh            # → build/Folio.apk
node test/smoke.js    # optional: screenshots of every mood in test/out/ (needs Playwright)
```

Set `FOLIO_KEYSTORE`, `FOLIO_KEYSTORE_PASS` and `FOLIO_KEY_ALIAS` to sign with the release key, so new versions install over old ones. Without them the build uses a throwaway key. The **Android** GitHub workflow builds the APK on every push (add `FOLIO_ANDROID_KEYSTORE_B64` and `FOLIO_ANDROID_KEYSTORE_PASS` secrets to sign there too).

## How it fits together

| Path | What it is |
| --- | --- |
| `app/java/.../MainActivity.java` | The native shell: a WebView, the file picker, Open with / Share, status-bar colours, back button |
| `web/app.js` | Library, recents, the Word reader (shared with the desktop reader) |
| `web/pdf-view.js` | Lazy page rendering with pdf.js, zoom, links, bookmarks |
| `web/recolor.js` | The mood recolouring for PDF pages, and finding where photos are |
| `web/android.css` | Phone layout. Themes, fonts and document styles come from Folio's shared `tools/web-template.html` and `app/` at build time |
| `build.sh` | aapt2 → javac → dx → zipalign → apksigner |
