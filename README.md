# Folio

A calm, beautiful reader for Word documents on Windows.

Open a `.docx`, or drop one onto the window, and Folio shows it in an easy-to-read layout. You get a contents list, reading progress, and three moods: Paper, Mist and Night. You can adjust the text size, typeface and column width. Your files never leave your computer.

## Install

Download **Folio-Setup-x.y.z.exe** from the [latest release](https://github.com/chareg/folio/releases/latest) and run it.

The installer isn't code-signed yet, so the first time you run it Windows may show "Windows protected your PC". Click **More info**, then **Run anyway**.

## Updates

Folio checks for a new version a few seconds after it starts, and downloads it in the background. When the update is ready, a **Restart to update** button appears in the toolbar. You can also check by hand under **Appearance → Check for updates**.

## Shipping a new version

1. Bump `version` in `package.json` (for example `1.0.1`) and commit.
2. Tag it and push: `git tag v1.0.1 && git push origin main --tags`
3. The **Release** workflow builds the installer on Windows and publishes it as a GitHub Release. Installed copies update themselves from there.

## Develop

```bash
npm install
npm start
```

## Layout

| Path | What it is |
| --- | --- |
| `main.js` | Electron main process: window, file opening, updates |
| `preload.js` | The small, safe bridge between the window and the main process |
| `app/` | The reader itself: `index.html`, bundled fonts, mammoth.js and JSZip |
| `build/` | App icons |
| `web/index.html` | The browser version of Folio |
| `tools/` | `make_desktop.py` regenerates `app/index.html` from `tools/web-template.html`; `make_sample_docx.py` builds the welcome document |

Folio uses [mammoth.js](https://github.com/mwilliamson/mammoth.js) to turn `.docx` into clean HTML. Exact Word fonts, colours and page layout are swapped for Folio's own typography on purpose.
