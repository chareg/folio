// The PDF reader in the real Electron app: open, recolour, bookmarks, zoom, go to page,
// remembering your place, and switching back to a Word document.
// Run: npm ci && xvfb-run -a node test/pdf.e2e.js   (needs playwright, installed globally or with --no-save)
const { _electron } = require("playwright");
const assert = require("assert/strict");
const path = require("path");
const fs = require("fs");

const repo = path.join(__dirname, "..");
const PDF = path.join(__dirname, "fixtures", "colours.pdf");
const DOCX = path.join(__dirname, "fixtures", "kitchen-sink.docx");
let passed = 0, failed = 0;

(async () => {
  const userData = fs.mkdtempSync(path.join(require("os").tmpdir(), "folio-pdf-"));
  const app = await _electron.launch({
    executablePath: path.join(repo, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron"),
    args: ["--no-sandbox", "--user-data-dir=" + userData, repo, PDF]
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  const step = async (name, fn) => {
    try { await fn(); passed++; console.log("  ok  " + name); }
    catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
  };
  const state = () => win.evaluate(() => ({
    view: __folio.view, pages: __folio.pdf && __folio.pdf.pageCount, current: __folio.pdf && __folio.pdf.current,
    canvases: document.querySelectorAll(".pdf-page canvas").length,
    toc: [...document.querySelectorAll("#toc a")].map((a) => a.querySelector(".t") ? a.querySelector(".t").textContent : a.textContent),
    active: (document.querySelector("#toc a.active .t") || {}).textContent || null,
    zoom: document.getElementById("zoomReset").textContent,
    editVisible: getComputedStyle(document.getElementById("editBtn")).display !== "none",
    name: document.getElementById("docname").textContent
  }));
  // the middle of the first page's photo, and a patch of plain paper, as the canvas has them
  const sample = () => win.evaluate(() => {
    const c = document.querySelector('.pdf-page[data-page="1"] canvas');
    const ctx = c.getContext("2d"); const f = c.width / 595.28;
    const at = (x, y) => Array.from(ctx.getImageData(Math.round(x * f), Math.round(y * f), 1, 1).data.slice(0, 3));
    return { paper: at(30, 30), photo: at(100, 300) };
  });
  const waitRender = () => win.waitForFunction(() => document.querySelector('.pdf-page[data-page="1"] canvas'), null, { timeout: 15000 });
  const openFile = async (file) => {
    const b64 = fs.readFileSync(file).toString("base64");
    await win.evaluate(([b, name, p]) => { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); return __folio.openBuffer(u.buffer, name, { path: p }); }, [b64, path.basename(file), file]);
  };
  const pickMood = async (mood, pages) => {
    await win.click("#typeBtn");
    await win.click(`#moodSeg button[data-mood="${mood}"]`);
    if (pages) await win.click(`#pagesSeg button[data-pages="${pages}"]`);
    await win.keyboard.press("Escape");
    await win.waitForTimeout(900);
  };

  await step("opens a PDF passed on the command line", async () => {
    await waitRender();
    const s = await state();
    assert.equal(s.view, "pdf"); assert.equal(s.pages, 4); assert.equal(s.name, "colours");
    assert.equal(s.editVisible, false, "no Edit button for PDFs");
  });
  await step("bookmarks fill the contents rail", async () => {
    await win.waitForFunction(() => document.querySelectorAll("#toc a[data-page]").length > 0);
    const s = await state();
    assert.deepEqual(s.toc.slice(0, 2), ["Night reading test", "A photo keeps its colours"]);
    assert.equal(s.active, "Night reading test");
  });
  await step("Night mood: dark paper, light ink, photo keeps its colour", async () => {
    await pickMood("night", "themed");
    const { paper, photo } = await sample();
    assert.ok(paper.every((v) => v < 60), "paper should be dark: " + paper);
    assert.ok(Math.max(...photo) - Math.min(...photo) > 40, "photo should stay colourful: " + photo);
  });
  await step("As printed: white paper again", async () => {
    await pickMood("night", "original");
    const { paper } = await sample();
    assert.ok(paper.every((v) => v > 245), "paper should be white: " + paper);
  });
  await step("Mist mood tints the paper", async () => {
    await pickMood("mist", "themed");
    const { paper } = await sample();
    assert.ok(Math.abs(paper[0] - 0xf6) < 4 && Math.abs(paper[1] - 0xf8) < 4, "mist paper: " + paper);
  });
  await step("zoom with the keyboard and back", async () => {
    await win.keyboard.press("Control+=");
    assert.equal((await state()).zoom, "110%");
    await win.keyboard.press("Control+0");
    assert.equal((await state()).zoom, "100%");
  });
  await step("text can be selected for copying", async () => {
    await win.waitForFunction(() => document.querySelectorAll(".textLayer span").length > 10);
    const text = await win.evaluate(() => [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')].map((s) => s.textContent).join(""));
    assert.match(text, /Night reading test/);
  });
  await step("go to page from the rail", async () => {
    await win.fill("#gotoInput", "3"); await win.press("#gotoInput", "Enter");
    await win.waitForTimeout(400);
    const s = await state();
    assert.equal(s.current, 2); assert.equal(s.active, "Chapter 3");
  });
  await step("opening a Word document switches back, with editing", async () => {
    await openFile(DOCX);
    await win.waitForTimeout(800);
    const s = await state();
    assert.equal(s.view, "docx"); assert.equal(s.editVisible, true);
    assert.equal(await win.evaluate(() => document.getElementById("pdfView").hidden), true);
    assert.equal(await win.evaluate(() => __folio.editor.canEdit()), true);
  });
  await step("reopening the PDF returns to the same page", async () => {
    await openFile(PDF); await waitRender(); await win.waitForTimeout(300);
    const s = await state();
    assert.equal(s.current, 2);
    assert.match(await win.textContent("#toast"), /Back where you left off, on page 3/);
  });
  await step("a damaged PDF is refused kindly", async () => {
    await win.evaluate(() => __folio.openBuffer(new TextEncoder().encode("%PDF-1.4 nothing here").buffer, "broken.pdf", {}));
    await win.waitForTimeout(1500);
    assert.match(await win.textContent("#toast"), /Couldn.t read broken/);
  });
  await step("no page errors", async () => assert.deepEqual(errors, []));

  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
