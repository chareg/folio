# Folio

A calm, beautiful reader for Word documents and PDFs on Windows.

Open a `.docx` or a PDF, or drop one onto the window, and Folio shows it in an easy-to-read layout. You get a contents list, reading progress, and three moods: Paper, Mist and Night. You can adjust the text size, typeface and column width. Your files never leave your computer.

## PDFs

PDFs open as a continuous column of pages, in your mood. In **Night**, pages turn plum-dark with soft lavender ink, coloured text stays coloured, and photos keep their real colours. Scans and black-and-white diagrams are recoloured like the rest of the page. **Paper** and **Mist** give pages their own paper and ink.

Want the page exactly as it was printed? Open **Appearance** and choose **Pages → As printed**.

- The contents rail shows the PDF's bookmarks and follows along as you read. **Go to page** jumps anywhere.
- Zoom with the − / + pill at the bottom, Ctrl + mouse wheel, a trackpad pinch, or Ctrl+= and Ctrl+−. Ctrl+0 fits the page to the window again.
- Select text and copy it as usual. Links work: web links open in your browser, and links inside the PDF jump to their page.
- Folio remembers which page you were on in each PDF.
- PDFs are read-only. Password-protected PDFs can't be opened yet.

## Editing

Press **Edit** (or Ctrl+E) to fix typos and tweak wording right on the page. You can type, delete, press Enter for a new paragraph, paste plain text, and use bold, italic, underline and strikethrough (Ctrl+B, Ctrl+I, Ctrl+U). Undo and redo are Ctrl+Z and Ctrl+Y.

Saving never throws away what Folio doesn't show. Folio edits the document's own XML in place, so letterheads, headers and footers, fonts, colours, pictures, signatures, tables, fields and section layout all come through untouched. Every other part of the file is copied byte for byte, and Folio re-reads each file before writing it to check that nothing went missing.

The first save asks how you'd like to keep your edits:

- **Save as a copy** (recommended) saves next to the original as "Name (edited).docx".
- **Replace the original** saves over it. Folio keeps a backup of the old version in `%APPDATA%\Folio\Backups` first.

After that, Ctrl+S saves to the same place. Ctrl+Shift+S always saves a new copy. If you close Folio or open another file with unsaved edits, it asks first.

A few things are shown but locked, so they can't be damaged: text boxes, footnotes and endnotes, and paragraphs with tracked deletions of their paragraph mark. Folio also won't join paragraphs across a table or a section break.

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

## Tests

```bash
npm install --no-save @xmldom/xmldom jszip playwright
python3 test/fixtures/make_fixtures.py   # rebuilds the kitchen-sink test document
node test/model.test.js                  # the XML editing model
node test/e2e.js                         # real keystrokes in Chromium, then save and compare
node test/recolor.test.mjs               # PDF page recolouring
npm ci && xvfb-run -a node test/pdf.e2e.js   # the PDF reader in the real Electron app (xvfb-run only on Linux)
```

## Layout

| Path | What it is |
| --- | --- |
| `main.js` | Electron main process: window, file opening, updates |
| `preload.js` | The small, safe bridge between the window and the main process |
| `app/` | The reader itself: `index.html`, bundled fonts, mammoth.js and JSZip |
| `app/pdf/` | The PDF view (`pdf-view.js`) and the mood recolouring (`recolor.js`) |
| `app/vendor/pdfjs/` | pdf.js 4.10.38 (legacy build), its CMaps and standard fonts. Refresh with `tools/vendor_pdfjs.sh` |
| `app/editor/` | Edit mode: `model.js` edits the document XML in place, `editor.js` runs the page |
| `test/` | Model tests, browser tests and the fixture generator |
| `build/` | App icons |
| `web/index.html` | The browser version of Folio (Word documents only; PDFs need the desktop app) |
| `tools/` | `make_desktop.py` regenerates `app/index.html` from `tools/web-template.html`; `make_sample_docx.py` builds the welcome document |

Folio uses [mammoth.js](https://github.com/mwilliamson/mammoth.js) to turn `.docx` into clean HTML. Exact Word fonts, colours and page layout are swapped for Folio's own typography on purpose.
