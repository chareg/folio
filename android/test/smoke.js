// Drives the built reader (build/assets/www) in a phone-sized Chromium with a fake Android
// bridge, opens a PDF and a Word document in each mood, and saves screenshots to test/out/.
// Run after ./build.sh:  node test/smoke.js
const { chromium, devices } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const WWW = path.join(__dirname, "..", "build", "assets", "www");
const OUT = path.join(__dirname, "out");
const DOCS = {
  colours: path.join(__dirname, "fixtures", "colours.pdf"),
  sample: path.join(__dirname, "..", "..", "tools", "sample.docx"),
  ...(process.env.EXTRA_PDF ? { extra: process.env.EXTRA_PDF } : {})
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  let file;
  if (u.startsWith("/__doc/")) file = DOCS[u.slice(7)];
  else file = path.join(WWW, u === "/" ? "index.html" : u);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = "http://127.0.0.1:" + server.address().port + "/";
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["Pixel 7"] });
  await ctx.addInitScript(() => {
    window.__calls = [];
    window.FolioAndroid = {
      ready() { window.__calls.push(["ready"]); },
      isSystemDark() { return false; },
      pickDocument() { window.__calls.push(["pick"]); },
      openRecent(uri) { window.__calls.push(["openRecent", uri]); },
      forget() {}, releaseToken() {},
      setChrome(c, light) { window.__calls.push(["chrome", c, light]); },
      openExternal(u) { window.__calls.push(["external", u]); },
      share() {}
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()); });
  await page.goto(base + "index.html");
  await page.waitForFunction(() => window.__calls.some((c) => c[0] === "ready"));
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + ".png") });
  const setMood = (m) => page.evaluate((m) => { document.querySelector('#moodSeg [data-mood="' + m + '"]').click(); }, m);
  const open = (token, name, mime) => page.evaluate(([token, name, mime]) =>
    window.folioReceive({ token, name, uri: "content://test/" + token, mime, persisted: true }), [token, name, mime]);
  const settle = async () => { await page.waitForTimeout(250); await page.waitForFunction(() => !window.__folio.pdf || !window.__folio.pdf.busy); await page.waitForTimeout(250); };

  await shot("01-home-empty");

  // PDF in each mood
  await open("colours", "Night reading test.pdf", "application/pdf");
  await page.waitForSelector(".pdf-page canvas");
  await settle();
  for (const m of ["paper", "mist", "night"]) { await setMood(m); await settle(); await shot("pdf-" + m); }
  // pages "as printed" in night
  await page.click("#typeBtn"); await page.click('#pagesSeg [data-pages="original"]'); await settle();
  await shot("pdf-night-original-with-menu");
  await page.click('#pagesSeg [data-pages="themed"]'); await page.click("#typeBtn"); await settle();
  // contents drawer from bookmarks
  await page.click("#railToggle"); await page.waitForTimeout(400); await shot("pdf-night-contents");
  const tocCount = await page.locator("#toc a").count();
  await page.locator("#toc a").nth(2).click(); await settle();
  const pageAfterToc = await page.evaluate(() => window.__folio.pdf.current);
  await shot("pdf-night-after-toc");
  // zoom
  await page.evaluate(() => window.__folio.pdf.setZoom(2.2, 200, 300)); await settle();
  await shot("pdf-night-zoomed");
  await page.evaluate(() => window.__folio.pdf.setZoom(1)); await settle();

  // back to the library: recents
  const handled = await page.evaluate(() => window.folioBack());
  await page.waitForTimeout(300);
  await shot("02-home-recents-night");

  // Word document
  await open("sample", "Sample document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  await page.waitForSelector("#doc h1, #doc p");
  await page.waitForTimeout(500);
  await shot("docx-night");
  await setMood("paper"); await page.waitForTimeout(400); await shot("docx-paper");
  await page.evaluate(() => window.scrollTo(0, 1600)); await page.waitForTimeout(400); await shot("docx-paper-scrolled");
  await setMood("mist"); await page.evaluate(() => document.body.classList.remove("chrome-hidden")); await page.click("#railToggle"); await page.waitForTimeout(400); await shot("docx-mist-contents");
  await page.evaluate(() => window.folioBack()); await page.evaluate(() => window.folioBack());
  await page.waitForTimeout(300);
  await shot("03-home-mist");

  if (DOCS.extra) {
    await setMood("night");
    await open("extra", path.basename(DOCS.extra), "application/pdf");
    await page.waitForSelector(".pdf-page canvas"); await settle(); await shot("extra-night");
  }

  const calls = await page.evaluate(() => window.__calls);
  console.log(JSON.stringify({
    tocCount, pageAfterToc, backHandled: handled,
    recents: await page.evaluate(() => JSON.parse(localStorage.getItem("folio-recents")).map((r) => [r.name, r.kind, r.pos])),
    chrome: calls.filter((c) => c[0] === "chrome").slice(-3),
    errors
  }, null, 1));
  await browser.close();
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
