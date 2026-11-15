// End-to-end editing tests in a real Chromium, driving the desktop page with
// real keystrokes. Run: node test/e2e.js  (writes results to test/out/)
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const JSZip = require("jszip");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const STUB = `
  window.__saves = [];
  window.folioDesktop = {
    onOpenFile(cb) { window.__open = cb; },
    openDialog() {}, setTitleColors() {}, toggleFullscreen() {}, platform: "win32",
    getVersion: async () => "test", checkForUpdates() {}, installUpdate() {}, onUpdateStatus() {},
    saveDocx: async (req) => {
      window.__saves.push({ mode: req.mode, bytes: Array.from(req.bytes), path: req.path, suggestedName: req.suggestedName });
      if (window.__nextSave) { const r = window.__nextSave; window.__nextSave = null; return r; }
      const name = req.mode === "copy" ? req.suggestedName : "orig.docx";
      return { ok: true, path: "C:/docs/" + name, name, mtimeMs: 2 };
    },
    showInFolder() {}, setDirty(v) { window.__dirty = v; }, onConfirmClose(cb) { window.__confirmClose = cb; }, closeNow() { window.__closed = true; }
  };`;

let failures = 0, passes = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log("  ok  " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); }
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => { errors.push(String(e)); console.log("       [pageerror]", String(e)); });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") { errors.push(m.text()); console.log("       [console]", m.text().slice(0, 400)); } });
  await page.addInitScript(STUB);
  await page.goto("file://" + path.join(ROOT, "app/index.html"));
  await page.waitForSelector("#doc h1");

  const H = {
    async open(file) {
      const bytes = Array.from(fs.readFileSync(file));
      await page.evaluate(({ bytes, name }) => window.__open({ name, path: "C:/docs/" + name, bytes: new Uint8Array(bytes), mtimeMs: 1 }),
        { bytes, name: path.basename(file) });
      await page.waitForFunction((n) => document.getElementById("docname").textContent.length && !document.body.classList.contains("loading"), path.basename(file));
      await page.waitForTimeout(150);
    },
    async edit() { await page.click("#editBtn"); await page.waitForSelector("#doc.editing"); await page.waitForTimeout(100); },
    async done() { await page.click("#doneBtn"); await page.waitForFunction(() => !document.getElementById("doc").classList.contains("editing")); },
    // caret into the block whose text contains `needle`, at needle's start + delta
    async caret(needle, delta = 0, which = 0) {
      const ok = await page.evaluate(({ needle, delta, which }) => {
        const blocks = [...document.querySelectorAll("#doc [data-pid]")].filter((b) => b.textContent.includes(needle));
        const b = blocks[which];
        if (!b) return false;
        const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        let acc = "", nodes = [];
        while (walker.nextNode()) { nodes.push([walker.currentNode, acc.length]); acc += walker.currentNode.data; }
        let at = acc.indexOf(needle) + delta;
        for (const [n, start] of nodes) {
          if (at < start + n.data.length || n === nodes[nodes.length - 1][0]) {
            const r = document.createRange(); r.setStart(n, at - start); r.collapse(true);
            const s = getSelection(); s.removeAllRanges(); s.addRange(r);
            document.getElementById("doc").focus({ preventScroll: true });
            return true;
          }
        }
        return false;
      }, { needle, delta, which });
      assert.ok(ok, "caret target not found: " + needle);
    },
    async select(fromNeedle, toNeedle, toDelta = 0) {
      const ok = await page.evaluate(({ fromNeedle, toNeedle, toDelta }) => {
        function point(needle, delta) {
          const b = [...document.querySelectorAll("#doc [data-pid]")].find((b) => b.textContent.includes(needle));
          if (!b) return null;
          const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
          let acc = "", nodes = [];
          while (walker.nextNode()) { nodes.push([walker.currentNode, acc.length]); acc += walker.currentNode.data; }
          const at = acc.indexOf(needle) + delta;
          for (const [n, start] of nodes) if (at <= start + n.data.length) return [n, at - start];
          return null;
        }
        const a = point(fromNeedle, 0), z = point(toNeedle, toDelta);
        if (!a || !z) return false;
        const r = document.createRange(); r.setStart(a[0], a[1]); r.setEnd(z[0], z[1]);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        document.getElementById("doc").focus({ preventScroll: true });
        return true;
      }, { fromNeedle, toNeedle, toDelta });
      assert.ok(ok, "selection target not found");
    },
    async bytes() {
      const arr = await page.evaluate(async () => Array.from(await window.__folio.editor._debug().buildDocx()));
      return Buffer.from(arr);
    },
    async xml() { return page.evaluate(() => window.__folio.editor._debug().model.serialize()); },
    async texts() {
      return page.evaluate(() => {
        const m = window.__folio.editor._debug().model;
        return [...m.doc.getElementsByTagNameNS(window.FolioModel.W, "p")].map((p) => m.textModel(m.pidOf(p)).text);
      });
    },
    async consistent() {
      // every editable block's screen text equals its paragraph's XML text
      return page.evaluate(() => {
        const ed = window.__folio.editor._debug(), bad = [];
        document.querySelectorAll("#doc [data-pid]:not([data-locked])").forEach((b) => {
          const st = ed.states[b.dataset.pid];
          if (!st) return;
          const x = ed.model.textModel(b.dataset.pid).text.replace(/\u00a0/g, " ");
          if (st.uh || st.ux) bad.push([b.dataset.pid, "unmatched", st.uh, st.ux, st.h, x]);
        });
        return bad;
      });
    },
    async save(name) { const b = await H.bytes(); const f = path.join(OUT, name); fs.writeFileSync(f, b); return f; },
    key: (k) => page.keyboard.press(k),
    type: (t) => page.keyboard.type(t, { delay: 5 })
  };

  const sink = path.join(__dirname, "fixtures/kitchen-sink.docx");

  console.log("kitchen sink");
  await H.open(sink);
  const original = await H.xml();
  await H.edit();

  await check("locks the text box paragraphs and footnotes, edits the rest", async () => {
    const locked = await page.evaluate(() => [...document.querySelectorAll("#doc [data-locked]")].map((e) => e.getAttribute("data-locked") + ":" + e.textContent.slice(0, 30)));
    assert.ok(locked.some((l) => l.startsWith("textbox:Before the box")), locked.join(" | "));
    assert.ok(locked.some((l) => l.startsWith("textbox:Inside the box")), locked.join(" | "));
    assert.ok(locked.some((l) => l.startsWith("unmapped:") && l.includes("footnote text")), locked.join(" | "));
    const editable = await page.evaluate(() => document.querySelectorAll("#doc [data-pid]:not([data-locked])").length);
    assert.ok(editable > 30, "editable blocks: " + editable);
    assert.deepStrictEqual(await H.consistent(), []);
  });

  await check("typing in a coloured, resized run keeps its formatting", async () => {
    await H.caret("red Comic text", 3);
    await H.type(" (really)");
    const x = await H.xml();
    assert.ok(/<w:color w:val="C01010"\/>(<w:sz[^>]*\/>)*(<w:szCs[^>]*\/>)*<\/w:rPr><w:t xml:space="preserve">red \(really\) Comic text<\/w:t>/.test(x) ||
      /red \(really\) Comic text/.test(x), "text landed");
    const run = x.slice(x.lastIndexOf("<w:r>", x.indexOf("red (really) Comic")), x.indexOf("red (really) Comic"));
    assert.ok(/Comic Sans MS/.test(run) && /C01010/.test(run) && /w:sz w:val="30"/.test(run), run);
  });

  await check("backspace and delete inside a paragraph", async () => {
    await H.caret("Plain middle", 5);
    await H.key("Backspace"); await H.key("Backspace"); await H.key("Backspace"); await H.key("Backspace"); await H.key("Backspace");
    await H.type("Calm");
    await H.key("Delete");
    await H.type(" ");
    const t = (await H.texts()).find((s) => s.startsWith("Bold start."));
    assert.strictEqual(t, "Bold start. Calm middle with italic and red (really) Comic text then the end.");
  });

  await check("bold a selection with Ctrl+B, then unbold part of it", async () => {
    await H.select("middle", "middle", 6);
    await H.key("Control+b");
    let x = await H.xml();
    assert.ok(/<w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">middle<\/w:t>/.test(x), "middle is bold");
    await H.select("mid", "mid", 3);
    await H.key("Control+b");
    x = await H.xml();
    assert.ok(/<w:b w:val="0"\/><w:bCs w:val="0"\/><\/w:rPr><w:t xml:space="preserve">mid<\/w:t>|<w:t xml:space="preserve">mid<\/w:t>/.test(x));
    assert.deepStrictEqual(await H.consistent(), []);
  });

  await check("typing at the end of a link stays part of the paragraph", async () => {
    await H.caret("our website", 11);
    await H.type("!");
    const t = (await H.texts()).find((s) => s.startsWith("Visit"));
    assert.strictEqual(t, "Visit our website! or read page 7 for more.");
    const x = await H.xml();
    assert.ok(/<w:instrText xml:space="preserve"> PAGE <\/w:instrText>/.test(x), "field code intact");
  });

  await check("Enter splits a paragraph and keeps the bookmark", async () => {
    await H.caret("words stay put", 6);
    await H.key("Enter");
    const ts = await H.texts();
    assert.ok(ts.includes("Bookmarked words ") && ts.includes("stay put."), ts.join(" | "));
    const x = await H.xml();
    assert.ok(/<w:bookmarkStart w:id="77" w:name="keep_me"\/>/.test(x) && /<w:bookmarkEnd w:id="77"\/>/.test(x));
  });

  await check("Backspace at the start joins them again", async () => {
    await H.caret("stay put", 0);
    await H.key("Backspace");
    const ts = await H.texts();
    assert.ok(ts.includes("Bookmarked words stay put."), ts.join(" | "));
  });

  await check("Shift+Enter adds a line break, tabs survive", async () => {
    await H.caret("break inside", 5);
    await H.key("Shift+Enter");
    await H.type("new line");
    const t = (await H.texts()).find((s) => s.startsWith("Tabs"));
    assert.strictEqual(t, "Tabs\there and a line\nbreak\nnew line inside one paragraph.");
  });

  await check("text after a footnote mark keeps body formatting", async () => {
    await H.caret(" and text after it", 0);
    await H.type(" (see note)");
    const x = await H.xml();
    const i = x.indexOf(" (see note)");
    const run = x.slice(x.lastIndexOf("<w:r>", i), i);
    assert.ok(!/superscript|FootnoteReference/.test(run), run);
    assert.ok(/<w:footnoteReference w:id="1"\/>/.test(x));
  });

  await check("Enter at the end of a heading makes body text", async () => {
    await H.caret("Lists", 5);
    await H.key("Enter");
    await H.type("A paragraph under the heading.");
    const x = await H.xml();
    const i = x.indexOf("A paragraph under the heading.");
    const para = x.slice(x.lastIndexOf("<w:p>", i) >= 0 ? x.lastIndexOf("<w:p", i) : 0, i);
    assert.ok(!/Heading1/.test(para), para);
    const tag = await page.evaluate(() => [...document.querySelectorAll("#doc [data-pid]")].find((b) => b.textContent === "A paragraph under the heading.").tagName);
    assert.strictEqual(tag, "P");
  });

  await check("lists: new item, then Enter on an empty item leaves the list", async () => {
    await H.caret("Third bullet", 12);
    await H.key("Enter");
    await H.type("Fourth bullet");
    await H.key("Enter");
    await H.key("Enter");
    await H.type("After the list.");
    const info = await page.evaluate(() => {
      const b = [...document.querySelectorAll("#doc [data-pid]")];
      return { fourth: b.find((x) => x.textContent === "Fourth bullet").tagName, after: b.find((x) => x.textContent === "After the list.").tagName };
    });
    assert.deepStrictEqual(info, { fourth: "LI", after: "P" });
    const x = await H.xml();
    const i = x.indexOf("After the list."), para = x.slice(x.lastIndexOf("<w:p", i), i);
    assert.ok(!/ListBullet/.test(para), para);
  });

  await check("edit a table cell", async () => {
    await H.caret("Writes code", 11);
    await H.type(" and tests");
    const t = (await H.texts()).find((s) => s.startsWith("Writes"));
    assert.strictEqual(t, "Writes code and tests");
  });

  await check("joining a paragraph onto a table is refused", async () => {
    await H.caret("Pictures", 0);
    const before = await H.xml();
    await H.key("Backspace");
    assert.strictEqual(await H.xml(), before);
  });

  await check("deleting a picture removes only its drawing", async () => {
    await H.caret(" picture in a sentence", 0);
    await H.key("Backspace");
    const x = await H.xml();
    assert.strictEqual((x.match(/<w:drawing>/g) || []).length, (original.match(/<w:drawing>/g) || []).length - 1);
    assert.ok(/Inline <\/w:t>|Inline /.test(x));
    await H.key("Control+z");
    assert.strictEqual(((await H.xml()).match(/<w:drawing>/g) || []).length, (original.match(/<w:drawing>/g) || []).length);
  });

  await check("selection across paragraphs: type over it", async () => {
    await H.select("First bullet", "Second bullet", 6);
    await H.type("Merged");
    const ts = await H.texts();
    assert.ok(ts.includes("Merged bullet"), ts.join(" | "));
    assert.ok(!ts.includes("First bullet"));
  });

  await check("paste plain text with two lines", async () => {
    await H.caret("Step one", 8);
    await page.evaluate(() => {
      const dt = new DataTransfer(); dt.setData("text/plain", " pasted\nStep one and a half");
      document.getElementById("doc").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const ts = await H.texts();
    assert.ok(ts.includes("Step one pasted") && ts.includes("Step one and a half"), ts.join(" | "));
  });

  await check("a section break blocks joining across it", async () => {
    await H.caret("Section two", 0);
    const before = await H.xml();
    await H.key("Backspace"); // previous block is the section's last paragraph
    await H.key("Backspace");
    const x = await H.xml();
    assert.strictEqual((x.match(/<w:sectPr/g) || []).length, (before.match(/<w:sectPr/g) || []).length);
  });

  await check("symbol and nbsp paragraph edits", async () => {
    await H.caret(" done.", 5);
    await H.type(" and dusted");
    const t = (await H.texts()).find((s) => s.startsWith("Spaces"));
    assert.ok(t.endsWith(" done and dusted."), JSON.stringify(t));
  });

  await check("screen and XML agree everywhere", async () => {
    assert.deepStrictEqual(await H.consistent(), []);
  });

  const editedFile = await H.save("kitchen-sink-edited.docx");
  await check("saved package keeps every other part byte-identical", async () => {
    const a = await JSZip.loadAsync(fs.readFileSync(sink)), b = await JSZip.loadAsync(fs.readFileSync(editedFile));
    for (const name of Object.keys(a.files)) {
      if (a.files[name].dir || name === "word/document.xml" || name === "docProps/core.xml") continue;
      const x = await a.file(name).async("nodebuffer"), y = await b.file(name).async("nodebuffer");
      assert.ok(x.equals(y), name);
    }
  });

  await check("undo everything returns the exact original XML", async () => {
    for (let i = 0; i < 80; i++) await H.key("Control+z");
    assert.strictEqual(await H.xml(), original);
    for (let i = 0; i < 80; i++) await H.key("Control+y");
    const redone = await H.bytes();
    fs.writeFileSync(path.join(OUT, "kitchen-sink-redone.docx"), redone);
    const a = await (await JSZip.loadAsync(redone)).file("word/document.xml").async("string");
    const b = await (await JSZip.loadAsync(fs.readFileSync(editedFile))).file("word/document.xml").async("string");
    assert.strictEqual(a, b, "redo reaches the same document");
  });

  await check("save flow: first save asks, copy is the default", async () => {
    await page.click("#saveBtn");
    await page.waitForSelector(".sheet .choice");
    const titles = await page.$$eval(".sheet .choice strong", (els) => els.map((e) => e.textContent));
    assert.ok(titles[0].startsWith("Save as a copy") && titles[1].startsWith("Replace the original"), titles.join(","));
    await page.click(".sheet .choice");
    await page.waitForFunction(() => window.__saves.length === 1);
    const s = await page.evaluate(() => ({ mode: window.__saves[0].mode, name: window.__saves[0].suggestedName, dirty: window.__dirty, label: document.querySelector("#dockStatus span").textContent }));
    assert.deepStrictEqual(s, { mode: "copy", name: "kitchen-sink (edited).docx", dirty: false, label: "All changes saved" });
    // Ctrl+S now saves straight to the copy
    await H.caret("Last paragraph", 0);
    await H.type("Truly: ");
    assert.strictEqual(await page.evaluate(() => window.__dirty), true);
    await H.key("Control+s");
    await page.waitForFunction(() => window.__saves.length === 2);
    const s2 = await page.evaluate(() => ({ mode: window.__saves[1].mode, path: window.__saves[1].path }));
    assert.deepStrictEqual(s2, { mode: "overwrite", path: "C:/docs/kitchen-sink (edited).docx" });
  });

  await check("closing with unsaved edits asks first", async () => {
    await H.type("x");
    await page.evaluate(() => window.__confirmClose());
    await page.waitForSelector(".sheet");
    const btns = await page.$$eval(".sheet .sheet-btn", (els) => els.map((e) => e.textContent));
    assert.deepStrictEqual(btns, ["Keep editing", "Discard edits", "Save…"]);
    await page.click(".sheet .sheet-btn.danger");
    await page.waitForFunction(() => window.__closed === true);
  });

  await check("Done re-renders from the edited XML", async () => {
    await H.done();
    const txt = await page.$eval("#doc", (d) => d.textContent);
    assert.ok(txt.includes("Truly: xLast paragraph") && txt.includes("Merged bullet") && !txt.includes("First bullet"), txt.slice(0, 2000));
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll("#doc [contenteditable]").length), 0);
  });

  // ---------- the real-world signature template ----------
  const sig = path.join(__dirname, "fixtures/signature.docx");
  if (fs.existsSync(sig)) {
    console.log("signature template");
    await page.evaluate(() => { window.__closed = false; });
    await H.open(sig);
    const sigOrig = await H.xml();
    await H.edit();
    await check("signature: consistent and mostly editable", async () => {
      const bad = await H.consistent();
      assert.deepStrictEqual(bad, [], JSON.stringify(bad));
      const n = await page.evaluate(() => ({ ed: document.querySelectorAll("#doc [data-pid]:not([data-locked])").length, locked: [...document.querySelectorAll("#doc [data-locked]")].map((e) => e.getAttribute("data-locked") + ":" + e.textContent.slice(0, 40)) }));
      console.log("       editable blocks:", n.ed, "locked:", JSON.stringify(n.locked));
      assert.ok(n.ed > 3);
    });
    await check("signature: edit a name line and save", async () => {
      const first = await page.evaluate(() => {
        const b = [...document.querySelectorAll("#doc [data-pid]:not([data-locked])")].find((b) => b.textContent.trim().length > 3);
        return b.textContent.trim().slice(0, 12);
      });
      await H.caret(first, 0);
      await H.type("Dr ");
      assert.deepStrictEqual(await H.consistent(), []);
      await H.save("signature-edited.docx");
      for (let i = 0; i < 10; i++) await H.key("Control+z");
      assert.strictEqual(await H.xml(), sigOrig);
    });
    await H.done();
  }

  // ---------- the welcome sample ----------
  console.log("sample");
  await H.open(path.join(ROOT, "tools/sample.docx"));
  await H.edit();
  await check("sample: everything editable and consistent", async () => {
    assert.deepStrictEqual(await H.consistent(), []);
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll("#doc [data-locked]").length), 0);
  });
  await check("sample: select all + delete is refused politely (tables)", async () => {
    const before = await H.xml();
    await H.caret("On Reading Slowly", 0);
    await H.key("Control+a");
    await H.key("Delete");
    assert.strictEqual(await H.xml(), before);
  });

  await page.screenshot({ path: path.join(OUT, "edit-mode.png") });
  await check("no page errors", async () => { assert.deepStrictEqual(errors.filter((e) => !/favicon/.test(e)), []); });
  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
