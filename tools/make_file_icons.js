// Builds Folio's document icons (build/docx.ico, build/pdf.ico): the page-shaped
// icons Windows shows on .docx and .pdf files once Folio is their default app.
// The app icon (build/icon.ico) stays the dark "F." tile; these are a sheet of
// paper with that tile tucked into the corner, like Word does with its "W".
//
// Run: NODE_PATH=/opt/node22/lib/node_modules node tools/make_file_icons.js [--preview out.png]
// Needs Playwright with Chromium (it renders the SVG so the real Newsreader font is used).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

const TYPES = {
  docx: { label: 'DOCX', dot: '#f08bbe', ink: '#b8457e', soft: '#f7e4ee' },
  pdf:  { label: 'PDF',  dot: '#f58a6f', ink: '#c4513b', soft: '#fbe5df' },
};

const font = (file) => fs.readFileSync(path.join(ROOT, 'app/fonts', file)).toString('base64');
const FONT_CSS = `
@font-face { font-family: 'Newsreader'; font-style: italic; font-weight: 200 800;
  src: url(data:font/woff2;base64,${font('newsreader-latin-opsz-italic.woff2')}) format('woff2'); }
@font-face { font-family: 'Instrument Sans'; font-style: normal; font-weight: 400 700;
  src: url(data:font/woff2;base64,${font('instrument-sans-latin-wght-normal.woff2')}) format('woff2'); }`;

// Everything is drawn on a 256 grid. Smaller sizes get a simpler drawing with
// chunkier strokes rather than a shrunk copy, so they stay crisp in Explorer.
function svg(type, size) {
  const t = TYPES[type];
  const tier = size <= 24 ? 'small' : size <= 48 ? 'mid' : 'large';
  const fold = tier === 'small' ? 64 : 56;
  // Page: portrait sheet, folded top-right corner.
  const L = tier === 'small' ? 36 : 44, R = tier === 'small' ? 220 : 212, T = 12, B = 244, r = 10;
  const page = `M${L + r} ${T} H${R - fold} L${R} ${T + fold} V${B - r} Q${R} ${B} ${R - r} ${B} H${L + r} Q${L} ${B} ${L} ${B - r} V${T + r} Q${L} ${T} ${L + r} ${T} Z`;
  const flap = `M${R - fold} ${T} V${T + fold - 12} Q${R - fold} ${T + fold} ${R - fold + 12} ${T + fold} H${R} Z`;
  const stroke = tier === 'small' ? 10 : tier === 'mid' ? 6 : 3;

  // Badge: the app tile, overlapping the page's lower-left.
  const bs = tier === 'small' ? 132 : tier === 'mid' ? 124 : 104;
  const bx = tier === 'small' ? 8 : 16, by = B - bs - (tier === 'small' ? 0 : 8);
  const br = bs * 0.24;

  // Page contents, kept to the right of and above the badge.
  const lw = tier === 'small' ? 20 : tier === 'mid' ? 13 : 8; // line weight
  const cx0 = L + (tier === 'small' ? 24 : 26), cx1 = R - (tier === 'small' ? 24 : 20);
  const line = (x0, x1, y, c = '#cfc8d8', w = lw) =>
    `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
  let body = '';
  if (type === 'docx') {
    if (tier === 'large') {
      body += line(cx0, cx0 + 76, 50, t.ink, 10);
      for (const y of [80, 100, 120]) body += line(cx0, y === 120 ? cx1 - 22 : cx1, y);
      for (const y of [148, 168, 188]) body += line(bx + bs + 14, y === 188 ? cx1 - 14 : cx1, y);
    } else if (tier === 'mid') {
      body += line(cx0, cx0 + 64, 52, t.ink, 16);
      for (const y of [86, 114]) body += line(cx0, cx1, y);
      body += line(bx + bs + 16, cx1, 146);
    } else {
      body += line(cx0, cx0 + 72, 56, t.ink, 24);
      body += line(cx0, cx1, 98, '#c4bccf', 20);
    }
  } else {
    // A picture block and a few lines: a PDF is a laid-out page.
    if (tier === 'large') {
      const x0 = cx0, x1 = cx1 - 6, y0 = 36, y1 = 106;
      body += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="8" fill="${t.soft}"/>`;
      body += `<circle cx="${x0 + 26}" cy="${y0 + 22}" r="9" fill="${t.dot}"/>`;
      body += `<path d="M${x0} ${y1 - 4} L${x0 + 40} ${y0 + 34} L${x0 + 64} ${y0 + 54} L${x0 + 88} ${y0 + 30} L${x1} ${y1 - 8} V${y1 - 8} Q${x1} ${y1} ${x1 - 8} ${y1} H${x0 + 8} Q${x0} ${y1} ${x0} ${y1 - 8} Z" fill="${t.ink}" opacity=".85"/>`;
      for (const y of [128, 148, 168, 188]) body += line(bx + bs + 14, y === 188 ? cx1 - 14 : cx1, y);
    } else if (tier === 'mid') {
      const x0 = cx0, x1 = cx1, y0 = 34, y1 = 106;
      body += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="10" fill="${t.soft}"/>`;
      body += `<path d="M${x0} ${y1 - 6} L${x0 + 44} ${y0 + 30} L${x0 + 72} ${y0 + 52} L${x0 + 98} ${y0 + 26} L${x1} ${y1 - 10} Q${x1} ${y1} ${x1 - 10} ${y1} H${x0 + 10} Q${x0} ${y1} ${x0} ${y1 - 6} Z" fill="${t.ink}" opacity=".9"/>`;
      body += line(bx + bs + 16, cx1, 136);
    } else {
      const x0 = cx0, x1 = cx1, y0 = 34, y1 = 108;
      body += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="10" fill="${t.ink}"/>`;
    }
  }

  // "F." in the badge. Below 32px the letter turns to mush, so it's just the dot.
  let mark;
  if (tier === 'small') {
    mark = `<circle cx="${bx + bs * 0.5}" cy="${by + bs * 0.5}" r="${bs * 0.2}" fill="${t.dot}"/>`;
  } else {
    const fs_ = bs * 0.86;
    mark = `<text x="${bx + bs * 0.47}" y="${by + bs * 0.77}" text-anchor="middle" font-family="Newsreader" font-style="italic" font-weight="${tier === 'mid' ? 560 : 440}" font-size="${fs_}" fill="#f4eff8" style="font-variation-settings:'opsz' 72">F</text>` +
      `<ellipse cx="${bx + bs * 0.74}" cy="${by + bs * 0.69}" rx="${bs * 0.095}" ry="${bs * 0.105}" fill="${t.dot}" transform="rotate(14 ${bx + bs * 0.74} ${by + bs * 0.69})"/>`;
  }

  const label = size >= 96
    ? `<text x="${R - 16}" y="${B - 16}" text-anchor="end" font-family="Instrument Sans" font-weight="700" font-size="${t.label.length > 3 ? 20 : 23}" letter-spacing="1" fill="${t.ink}">${t.label}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="${size}" height="${size}">
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f4f1f8"/></linearGradient>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2436"/><stop offset="1" stop-color="#17151e"/></linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${tier === 'small' ? 0 : 3}" stdDeviation="${tier === 'large' ? 4 : 2}" flood-color="#1d1a26" flood-opacity="${tier === 'small' ? 0 : 0.22}"/></filter>
  </defs>
  <g filter="url(#sh)">
    <path d="${page}" fill="url(#paper)" stroke="#bdb5c8" stroke-width="${stroke}" stroke-linejoin="round" paint-order="stroke"/>
  </g>
  <path d="${page}" fill="url(#paper)"/>
  <path d="${flap}" fill="#e3dde9" stroke="#bdb5c8" stroke-width="${stroke}" stroke-linejoin="round"/>
  ${body}
  ${label}
  <g filter="url(#sh)">
    <rect x="${bx}" y="${by}" width="${bs}" height="${bs}" rx="${br}" fill="url(#tile)" stroke="#47405a" stroke-width="${tier === 'small' ? 0 : 2}"/>
  </g>
  ${mark}
</svg>`;
}

// ICO with a PNG per size (Windows Vista and later read PNG entries at every size).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

async function render(page, markup, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><style>${FONT_CSS} html,body{margin:0;background:transparent} svg{display:block}</style>${markup}`);
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const type of Object.keys(TYPES)) {
    const pngs = [];
    for (const size of SIZES) pngs.push({ size, data: await render(page, svg(type, size), size) });
    fs.writeFileSync(path.join(ROOT, 'build', `${type}.ico`), ico(pngs));
    console.log(`build/${type}.ico`, pngs.map((p) => p.size).join(' '));
  }

  const i = process.argv.indexOf('--preview');
  if (i > 0) {
    // A sheet showing every size on light and dark Explorer backgrounds.
    const row = (bg, fg) => Object.keys(TYPES).map((type) => `
      <div class="row" style="background:${bg};color:${fg}">
        ${[...SIZES].reverse().map((s) => `<figure>${svg(type, s)}<figcaption>${s}</figcaption></figure>`).join('')}
        <figure class="app"><img src="data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'build/icon.png')).toString('base64')}" width="64"><figcaption>app</figcaption></figure>
      </div>`).join('');
    const sheet = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1200, height: 800 } });
    await sheet.setContent(`<!doctype html><style>${FONT_CSS}
      body{margin:0;font:13px 'Instrument Sans',sans-serif}
      .row{display:flex;align-items:flex-end;gap:22px;padding:22px 28px}
      figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px}
      figcaption{opacity:.6}.app{margin-left:auto}</style>
      ${row('#ffffff', '#333')}${row('#1f1f1f', '#ddd')}`);
    await sheet.evaluate(() => document.fonts.ready);
    await sheet.screenshot({ path: process.argv[i + 1], fullPage: true });
    console.log('preview', process.argv[i + 1]);
  }
  await browser.close();
})();
