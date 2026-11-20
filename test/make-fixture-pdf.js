// Makes test/fixtures/colours.pdf: headings (bookmarks), coloured text, a highlight,
// a photo, a black-and-white diagram drawn as an image, a table and links.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const here = __dirname;
(async () => {
fs.mkdirSync(path.join(here, "fixtures"), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<!doctype html><html><head><style>
  body { font: 15px/1.55 Georgia, serif; margin: 56px 64px; color: #111; }
  h1 { font-size: 34px; margin: 0 0 6px; } h2 { margin-top: 28px; color: #1b3a8a; }
  .red { color: #c0262d; } .green { color: #1d7a3a; } mark { background: #ffe94d; }
  table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #999; padding: 6px 8px; }
  th { background: #dfe7f5; } .box { background: #f2f2f2; border-left: 4px solid #e07b00; padding: 10px 14px; }
  img { display: block; margin: 14px 0; }
</style></head><body>
<h1>Night reading test</h1>
<p>Plain black body text sits on white paper. In Folio's Night mood it should become soft light ink on a dark page, with no glare. <span class="red">This sentence is red,</span> <span class="green">this one is green,</span> and <a href="https://example.com/folio">this is a link</a>. <mark>This bit is highlighted in yellow.</mark></p>
<div class="box">A grey call-out box with an orange rule. It should stay a slightly different shade from the page.</div>
<h2>A photo keeps its colours</h2>
<img id="photo" width="420" height="200">
<h2>A diagram that is really ink on paper</h2>
<img id="diagram" width="300" height="150">
<h2>A table</h2>
<table><tr><th>Mood</th><th>Page</th><th>Ink</th></tr><tr><td>Paper</td><td>White</td><td>Near-black</td></tr><tr><td>Mist</td><td>Sage white</td><td>Forest</td></tr><tr><td>Night</td><td>Plum dark</td><td>Lavender white</td></tr></table>
${Array.from({ length: 3 }, (_, i) => `<h2 style="page-break-before: always">Chapter ${i + 2}</h2>` + "<p>" + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus. ".repeat(18) + "</p>").join("")}
<script>
  const p = document.createElement("canvas"); p.width = 420; p.height = 200; const c = p.getContext("2d");
  const g = c.createLinearGradient(0, 0, 420, 200); g.addColorStop(0, "#ff7a59"); g.addColorStop(.5, "#ffd166"); g.addColorStop(1, "#3a86ff");
  c.fillStyle = g; c.fillRect(0, 0, 420, 200); c.fillStyle = "#2b9348"; c.beginPath(); c.arc(300, 210, 120, 0, 7); c.fill();
  c.fillStyle = "#fff8"; c.beginPath(); c.arc(90, 60, 30, 0, 7); c.fill();
  document.getElementById("photo").src = p.toDataURL();
  const d = document.createElement("canvas"); d.width = 300; d.height = 150; const x = d.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, 300, 150); x.strokeStyle = "#000"; x.lineWidth = 3;
  x.strokeRect(20, 30, 90, 60); x.strokeRect(190, 30, 90, 60); x.beginPath(); x.moveTo(110, 60); x.lineTo(190, 60); x.stroke();
  x.font = "16px Arial"; x.fillStyle = "#000"; x.fillText("Input", 40, 66); x.fillText("Output", 205, 66);
  document.getElementById("diagram").src = d.toDataURL();
</script></body></html>`);
await page.waitForTimeout(200);
await page.pdf({ path: path.join(here, "fixtures", "colours.pdf"), format: "A4", outline: true, tagged: true, printBackground: true });
await browser.close();
console.log("wrote fixtures/colours.pdf");
})();
