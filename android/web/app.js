// Folio for Android: the library, the Word reader and the PDF reader, in Folio's moods.
import { PdfView } from "./pdf-view.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const body = document.body;
const android = window.FolioAndroid || null;

/* ---------- storage ---------- */
function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v == null ? fallback : v; } catch (e) { return fallback; }
}
function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }

/* ---------- preferences + moods ---------- */
const prefs = Object.assign({ mood: "auto", size: 18, face: "serif", pages: "themed" }, load("folio-prefs", {}));
let systemDark = android ? !!android.isSystemDark() : matchMedia("(prefers-color-scheme: dark)").matches;
if (!android) matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => { systemDark = e.matches; applyPrefs(); });
window.folioSystemTheme = (dark) => { systemDark = !!dark; applyPrefs(); };

function mood() { return prefs.mood === "auto" ? (systemDark ? "night" : "paper") : prefs.mood; }
function cssVar(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }

function applyPrefs() {
  const m = mood();
  root.setAttribute("data-mood", m);
  root.style.setProperty("--fs", prefs.size + "px");
  root.style.setProperty("--body-face", prefs.face === "sans" ? "var(--sans)" : "var(--serif)");
  $("doc").classList.toggle("is-sans", prefs.face === "sans");
  $("sizeOut").textContent = prefs.size + " px";
  const pressed = (sel, key) => document.querySelectorAll(sel).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[key] === prefs[key])));
  pressed("#moodSeg button, #moodRow button", "mood");
  pressed("#faceSeg button", "face");
  pressed("#pagesSeg button", "pages");
  $("pagesNote").textContent = prefs.pages === "themed"
    ? (m === "night" ? "Pages turn dark with light text. Photos keep their colours." : "Pages take on the " + m[0].toUpperCase() + m.slice(1) + " paper and ink.")
    : "Pages look exactly as they were printed.";
  const bg = view === "pdf" ? cssVar("--desk") : cssVar("--bg");
  if (android) android.setChrome(bg, m !== "night");
  if (pdf) pdf.setTheme(cssVar("--page"), cssVar("--ink"), prefs.pages);
}
function savePrefs() { store("folio-prefs", prefs); }

function bindChoice(selector, key) {
  document.querySelectorAll(selector).forEach((b) => b.addEventListener("click", () => {
    prefs[key] = b.dataset[key]; applyPrefs(); savePrefs();
  }));
}
bindChoice("#moodSeg button, #moodRow button", "mood");
bindChoice("#faceSeg button", "face");
bindChoice("#pagesSeg button", "pages");
$("sizeDown").onclick = () => { prefs.size = Math.max(14, prefs.size - 1); applyPrefs(); savePrefs(); };
$("sizeUp").onclick = () => { prefs.size = Math.min(28, prefs.size + 1); applyPrefs(); savePrefs(); };

/* ---------- popover, drawer, toast ---------- */
const pop = $("pop");
function setPop(open) { pop.hidden = !open; $("typeBtn").setAttribute("aria-expanded", String(open)); }
$("typeBtn").onclick = (e) => { e.stopPropagation(); setPop(pop.hidden); };
document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest("#typeBtn")) setPop(false); });
$("railToggle").onclick = () => { setPop(false); body.classList.add("rail-open"); };
$("scrim").onclick = () => body.classList.remove("rail-open");

let toastTimer;
function toast(msg, action) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  if (action) {
    const b = document.createElement("button"); b.className = "toast-act"; b.textContent = action.label;
    b.onclick = () => { t.hidden = true; action.run(); };
    t.appendChild(b);
  }
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, action ? 7000 : 4500);
}
function loading(on, text) { $("loader").hidden = !on; if (text) $("loaderText").textContent = text; }

/* ---------- chrome that gets out of the way ---------- */
let lastY = 0;
function showChrome(show) { body.classList.toggle("chrome-hidden", !show); if (!show) setPop(false); }
function onReadScroll(y) {
  if (Math.abs(y - lastY) < 6) return;
  if (y > lastY && y > 80) showChrome(false); else if (y < lastY) showChrome(true);
  lastY = y;
}

/* ---------- library (recents) ---------- */
let recents = load("folio-recents", []);
function saveRecents() { store("folio-recents", recents.slice(0, 40)); }
function findRecent(uri) { return recents.find((r) => r.uri === uri); }
function remember(info, kind, extra) {
  if (!info.uri) return null;
  let r = findRecent(info.uri);
  if (!r) { r = { uri: info.uri }; recents.unshift(r); }
  else { recents.splice(recents.indexOf(r), 1); recents.unshift(r); }
  Object.assign(r, { name: info.name, kind, mime: info.mime || "", at: Date.now(), persisted: !!info.persisted, gone: false }, extra || {});
  saveRecents();
  return r;
}
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  const d = Math.round(s / 86400);
  if (d === 1) return "yesterday";
  if (d < 7) return d + " days ago";
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function prettyName(name) { return (name || "Document").replace(/\.(pdf|docx|docm|dotx)$/i, "").replace(/[_]+/g, " ").trim(); }
const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function renderHome() {
  const h = new Date().getHours();
  $("hello").textContent = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const list = $("recentList");
  list.textContent = "";
  const items = recents.slice(0, 12);
  $("recentsWrap").hidden = !items.length;
  $("homeEmpty").hidden = !!items.length;
  for (const r of items) {
    const li = document.createElement("li");
    li.className = "recent" + (r.gone ? " gone" : "");
    const progress = r.kind === "pdf" && r.pages ? Math.min(1, ((r.pos && r.pos.page) || 0) / Math.max(1, r.pages - 1))
      : (r.pos && r.pos.frac) || 0;
    let detail = r.kind === "pdf" && r.pages ? "Page " + (((r.pos && r.pos.page) || 0) + 1) + " of " + r.pages : (r.words ? r.words.toLocaleString() + " words" : "Word document");
    detail += " · " + (r.gone ? "can't find it anymore" : ago(r.at));
    li.innerHTML =
      '<button class="recent-main"><span class="kind ' + r.kind + '">' + (r.kind === "pdf" ? "PDF" : "DOCX") + "</span>" +
      '<span class="recent-txt"><strong></strong><small></small><span class="recent-bar"><i></i></span></span></button>' +
      '<button class="recent-x" aria-label="Remove from list">' + X_ICON + "</button>";
    li.querySelector("strong").textContent = prettyName(r.name);
    li.querySelector("small").textContent = detail;
    li.querySelector(".recent-bar i").style.width = Math.round(progress * 100) + "%";
    li.querySelector(".recent-main").onclick = () => openRecent(r);
    li.querySelector(".recent-x").onclick = () => {
      recents.splice(recents.indexOf(r), 1); saveRecents(); renderHome();
      if (android && r.persisted) android.forget(r.uri);
    };
    list.appendChild(li);
  }
}

function openRecent(r) {
  if (!android) { toast("Open the file again to read it here."); return; }
  loading(true, "Opening…");
  android.openRecent(r.uri);
}
window.folioOpenFailed = (uri) => {
  loading(false);
  const r = findRecent(uri);
  if (r) { r.gone = true; saveRecents(); renderHome(); }
  toast("Folio can't reach that file anymore. It may have moved, or it came from an app that only lent it for a moment.", {
    label: "Find it", run: pick
  });
};

/* ---------- opening documents ---------- */
function pick() {
  setPop(false);
  if (android) android.pickDocument(); else $("fileInput").click();
}
$("openBtn").onclick = pick;
$("openCard").onclick = pick;
$("fileInput").onchange = async () => {
  const f = $("fileInput").files[0]; $("fileInput").value = "";
  if (!f) return;
  loading(true, "Opening…");
  openBytes(await f.arrayBuffer(), { name: f.name, mime: f.type });
};
window.folioPickCancelled = () => loading(false);

// Android hands over a document: fetch its bytes from the app's private origin.
window.folioReceive = async (info) => {
  loading(true, "Opening " + prettyName(info.name) + "…");
  try {
    const res = await fetch("/__doc/" + info.token);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = await res.arrayBuffer();
    if (android) android.releaseToken(info.token);
    await openBytes(buf, info);
  } catch (e) {
    loading(false);
    console.error(e);
    toast("Couldn't open " + prettyName(info.name) + ".");
  }
};

function sniff(buf, info) {
  const b = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength));
  const head = String.fromCharCode.apply(null, b);
  if (head.indexOf("%PDF-") !== -1) return "pdf";
  if (b[0] === 0x50 && b[1] === 0x4b) return "docx";
  if (b[0] === 0xd0 && b[1] === 0xcf) return "doc";
  const n = (info.name || "").toLowerCase();
  if (/\.pdf$/.test(n) || /pdf/.test(info.mime || "")) return "pdf";
  if (/\.(docx|docm|dotx)$/.test(n)) return "docx";
  return null;
}

let view = "home";
let current = null; // { info, kind, recent }

async function openBytes(buf, info) {
  const kind = sniff(buf, info);
  if (kind === "doc") { loading(false); toast("That's an older .doc file. Save it as .docx (Word or Google Docs can) and Folio will open it."); return; }
  if (!kind) { loading(false); toast("Folio reads PDFs and Word .docx files. " + prettyName(info.name) + " doesn't look like either."); return; }
  await closeDocument(true);
  try {
    current = { info, kind, recent: null };
    if (kind === "pdf") await openPdf(buf, info);
    else await openDocx(buf, info);
  } catch (e) {
    console.error(e);
    current = null;
    showView("home");
    const pw = e && (e.name === "PasswordException" || /password/i.test(e.message || ""));
    toast(pw ? "This PDF is password-protected. Folio can't unlock it yet."
      : "Couldn't read " + prettyName(info.name) + ". The file may be damaged.");
  } finally {
    loading(false);
  }
}

function showView(v) {
  view = v;
  body.classList.remove("view-home", "view-docx", "view-pdf", "rail-open", "chrome-hidden");
  body.classList.add("view-" + v);
  $("home").hidden = v !== "home";
  $("docView").hidden = v !== "docx";
  $("pdfView").hidden = v !== "pdf";
  $("progress").style.transform = "scaleX(0)";
  setPop(false);
  if (v === "home") { $("docname").textContent = ""; document.title = "Folio"; renderHome(); }
  applyPrefs();
}

async function closeDocument(silent) {
  savePosition();
  if (pdf) { const p = pdf; pdf = null; await p.close(); }
  $("doc").textContent = "";
  $("toc").textContent = "";
  current = null;
  if (!silent) { showView("home"); window.scrollTo(0, 0); }
}

function setTitle(name) {
  $("docname").textContent = prettyName(name);
  document.title = prettyName(name) + " · Folio";
}

$("backBtn").onclick = () => closeDocument(false);
$("shareBtn").onclick = () => {
  setPop(false);
  if (current && android && current.info.uri) android.share(current.info.uri, current.info.mime || "", prettyName(current.info.name));
  else toast("Sharing works in the Android app.");
};

window.folioBack = () => {
  if (!pop.hidden) { setPop(false); return true; }
  if (body.classList.contains("rail-open")) { body.classList.remove("rail-open"); return true; }
  if (view !== "home") { closeDocument(false); return true; }
  return false;
};

/* ---------- reading position ---------- */
let posTimer = 0;
function savePosition() {
  if (!current || !current.recent) return;
  if (current.kind === "pdf" && pdf) current.recent.pos = pdf.position();
  if (current.kind === "docx") {
    const max = document.documentElement.scrollHeight - innerHeight;
    current.recent.pos = { frac: max > 0 ? Math.min(1, scrollY / max) : 0 };
  }
  saveRecents();
}
function queueSave() { clearTimeout(posTimer); posTimer = setTimeout(savePosition, 400); }
document.addEventListener("visibilitychange", () => { if (document.hidden) savePosition(); });

/* ================================================================== */
/* PDF                                                                 */
/* ================================================================== */
let pdf = null;
let pillTimer = 0;

async function openPdf(buf, info) {
  showView("pdf");
  setTitle(info.name);
  pdf = new PdfView({
    scroller: $("pdfScroll"),
    container: $("pdfPages"),
    onPage: (i, n) => {
      const pill = $("pagePill");
      pill.innerHTML = (i + 1) + " <b>/</b> " + n;
      pill.classList.add("show");
      clearTimeout(pillTimer); pillTimer = setTimeout(() => pill.classList.remove("show"), 1300);
      markTocPage(i);
    },
    onTap: () => showChrome(body.classList.contains("chrome-hidden"))
  });
  pdf.onLink = (url) => { if (android) android.openExternal(url); else window.open(url, "_blank", "noopener"); };
  applyPrefs();
  const { pages } = await pdf.open(buf);
  const before = findRecent(info.uri);
  current.recent = remember(info, "pdf", { pages });
  if (before && before.pos && before.pos.page) {
    pdf.restore(before.pos);
    toast("Back where you left off, on page " + (before.pos.page + 1) + ".", { label: "Start over", run: () => pdf && pdf.goTo(0) });
  } else $("pdfScroll").scrollTop = 0;
  lastY = $("pdfScroll").scrollTop;
  buildPdfToc(pages);
}
$("pdfScroll").addEventListener("scroll", () => { onReadScroll($("pdfScroll").scrollTop); queueSave(); }, { passive: true });

async function buildPdfToc(pages) {
  const toc = $("toc"), note = $("tocNote");
  $("gotoForm").hidden = false;
  $("gotoOf").textContent = "of " + pages;
  $("gotoInput").max = pages;
  toc.textContent = "";
  note.hidden = true;
  const items = pdf ? await pdf.outline() : [];
  if (!pdf) return;
  if (!items.length) {
    note.textContent = "This PDF has no bookmarks. Use Go to page, or just scroll.";
    note.hidden = false;
    return;
  }
  for (const it of items) {
    const li = document.createElement("li"); li.className = "l" + it.level;
    const a = document.createElement("a"); a.href = "#";
    const label = document.createElement("span"); label.textContent = it.title;
    a.appendChild(label);
    if (it.page != null) { a.dataset.page = it.page; const pg = document.createElement("span"); pg.className = "pg"; pg.textContent = it.page + 1; a.appendChild(pg); }
    a.onclick = (e) => {
      e.preventDefault();
      body.classList.remove("rail-open");
      if (it.page != null && pdf) pdf.goTo(it.page);
      else if (it.url && android) android.openExternal(it.url);
    };
    li.appendChild(a); toc.appendChild(li);
  }
  markTocPage(pdf.current);
}
function markTocPage(i) {
  const links = $("toc").querySelectorAll("a[data-page]");
  let best = null;
  links.forEach((a) => { if (+a.dataset.page <= i) best = a; });
  links.forEach((a) => a.classList.toggle("active", a === best));
}
$("gotoForm").onsubmit = (e) => {
  e.preventDefault();
  const n = parseInt($("gotoInput").value, 10);
  if (pdf && n > 0) { pdf.goTo(n - 1); body.classList.remove("rail-open"); $("gotoInput").blur(); $("gotoInput").value = ""; }
};

/* ================================================================== */
/* Word documents (the same reader as Folio on the desktop)           */
/* ================================================================== */
const docEl = $("doc"), tocEl = $("toc"), metaEl = $("meta");
const STYLE_MAP = [
  "p[style-name='Title'] => h1.doc-title:fresh",
  "p[style-name='Subtitle'] => p.doc-subtitle:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote.pull > p:fresh",
  "p[style-name='Block Text'] => blockquote > p:fresh",
  "u => u",
  "strike => s",
  "comment-reference => "
];

async function openDocx(buf, info) {
  const [result, extras] = await Promise.all([
    mammoth.convertToHtml({ arrayBuffer: buf }, { styleMap: STYLE_MAP }),
    readExtras(buf.slice(0))
  ]);
  showView("docx");
  setTitle(info.name);
  docEl.innerHTML = result.value || "<p><em>This document is empty.</em></p>";
  polish(extras);
  $("gotoForm").hidden = true;
  buildToc();
  const words = buildMeta(extras);
  const before = findRecent(info.uri);
  current.recent = remember(info, "docx", { words });
  window.scrollTo(0, 0);
  if (before && before.pos && before.pos.frac > 0.02) {
    requestAnimationFrame(() => {
      const max = document.documentElement.scrollHeight - innerHeight;
      window.scrollTo(0, before.pos.frac * max);
      updateProgress();
    });
    toast("Back where you left off.", { label: "Start over", run: () => window.scrollTo({ top: 0, behavior: "smooth" }) });
  }
  lastY = scrollY;
  updateProgress();
}

function readExtras(buf) {
  const out = { sizes: [], title: "", author: "", modified: "" };
  if (!window.JSZip) return Promise.resolve(out);
  return JSZip.loadAsync(buf).then((zip) => {
    const jobs = [];
    const d = zip.file("word/document.xml");
    if (d) jobs.push(d.async("string").then((xml) => {
      const x = new DOMParser().parseFromString(xml, "application/xml");
      const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
      const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
      const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
      const drawings = x.getElementsByTagNameNS(W, "drawing");
      for (let i = 0; i < drawings.length; i++) {
        const dr = drawings[i];
        if (!dr.getElementsByTagNameNS(A, "blip").length) continue;
        const ext = dr.getElementsByTagNameNS(WP, "extent")[0];
        const src = dr.getElementsByTagNameNS(A, "srcRect")[0];
        let crop = null;
        if (src) {
          crop = {};
          ["l", "t", "r", "b"].forEach((k) => { crop[k] = (parseInt(src.getAttribute(k) || "0", 10) || 0) / 100000; });
          if (!(crop.l || crop.t || crop.r || crop.b) || crop.l + crop.r >= 1 || crop.t + crop.b >= 1) crop = null;
        }
        out.sizes.push(ext ? {
          w: Math.round(parseInt(ext.getAttribute("cx"), 10) / 9525),
          h: Math.round(parseInt(ext.getAttribute("cy"), 10) / 9525),
          crop
        } : null);
      }
    }));
    const c = zip.file("docProps/core.xml");
    if (c) jobs.push(c.async("string").then((xml) => {
      const x = new DOMParser().parseFromString(xml, "application/xml");
      const pickTag = (local) => { const n = x.getElementsByTagNameNS("*", local)[0]; return n ? n.textContent.trim() : ""; };
      out.title = pickTag("title"); out.author = pickTag("creator"); out.modified = pickTag("modified");
    }));
    return Promise.all(jobs).then(() => out);
  }).catch(() => out);
}

function slug(s, used) {
  const b = s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 48) || "section";
  let id = b, n = 2; while (used[id]) id = b + "-" + n++;
  used[id] = true; return id;
}

function polish(extras) {
  const imgs = docEl.querySelectorAll("img");
  if (extras.sizes.length === imgs.length) {
    imgs.forEach((img, i) => {
      const s = extras.sizes[i];
      if (!s || !(s.w > 0)) return;
      if (s.crop && s.h > 0) {
        const c = s.crop, iw = s.w / (1 - c.l - c.r), ih = s.h / (1 - c.t - c.b);
        const frame = document.createElement("span"); frame.className = "crop";
        frame.style.width = s.w + "px"; frame.style.aspectRatio = s.w + " / " + s.h;
        img.parentNode.insertBefore(frame, img); frame.appendChild(img);
        img.style.width = (iw / s.w * 100) + "%";
        img.style.aspectRatio = iw + " / " + ih;
        img.style.marginLeft = (-c.l * iw / s.w * 100) + "%";
        img.style.marginTop = (-c.t * ih / s.w * 100) + "%";
      } else { img.style.width = s.w + "px"; img.classList.add("sized"); }
    });
  }
  imgs.forEach((img) => { if (!img.alt) img.alt = ""; img.decoding = "async"; });
  docEl.querySelectorAll("p").forEach((p) => { if (p.querySelector("img") && !p.textContent.trim()) p.classList.add("pic"); });
  docEl.querySelectorAll("table").forEach((t) => {
    if (t.parentElement.classList.contains("table-wrap")) return;
    const w = document.createElement("div"); w.className = "table-wrap";
    t.parentNode.insertBefore(w, t); w.appendChild(t);
  });
  docEl.querySelectorAll("a[href]").forEach((a) => {
    const h = a.getAttribute("href").trim();
    if (/^https?:|^mailto:|^tel:/i.test(h)) a.dataset.external = "1";
    else if (h.charAt(0) !== "#") a.removeAttribute("href");
  });
  docEl.querySelectorAll("p").forEach((p) => {
    for (let guard = 0; guard < 20; guard++) {
      let n = p; while (n.lastChild) n = n.lastChild;
      if (n === p) break;
      const isBr = n.nodeName === "BR", isBlank = n.nodeType === 3 && !n.textContent.trim();
      if (!isBr && !isBlank) break;
      let parent = n.parentNode; parent.removeChild(n);
      if (isBlank && !isBr) { const prev = parent.lastChild; if (!prev || prev.nodeName !== "BR") { if (parent !== p && !parent.childNodes.length) parent.remove(); break; } }
      while (parent !== p && !parent.childNodes.length) { const up = parent.parentNode; parent.remove(); parent = up; }
    }
  });
  docEl.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li").forEach((p) => { if (!p.textContent.trim() && !p.querySelector("img")) p.remove(); });
  docEl.querySelectorAll("blockquote, ul, ol").forEach((c) => { if (!c.textContent.trim() && !c.querySelector("img")) c.remove(); });
  const last = docEl.lastElementChild;
  if (last && last.tagName === "OL" && last.querySelector('li[id^="footnote"], li[id^="endnote"]')) last.classList.add("notes");
}

let spyTargets = [], activeId = null;
function buildToc() {
  tocEl.innerHTML = "";
  const used = {};
  let heads = Array.from(docEl.querySelectorAll("h1, h2, h3, h4"));
  const note = $("tocNote"); note.hidden = true;
  if (!heads.length) {
    heads = Array.from(docEl.querySelectorAll("p")).filter((p) => {
      const txt = p.textContent.trim();
      if (!txt || txt.length > 90) return false;
      const boldTxt = Array.from(p.querySelectorAll("strong")).map((s) => s.textContent).join("").trim();
      return boldTxt && boldTxt.replace(/\s+/g, " ") === txt.replace(/\s+/g, " ");
    });
    heads.forEach((p) => p.classList.add("pseudo-head"));
    if (heads.length) { note.textContent = "This document has no headings, so Folio is using its bold lines as signposts."; note.hidden = false; }
  }
  if (!heads.length) {
    tocEl.innerHTML = '<li><p class="toc-empty">No headings in this document. Scroll on, it’s all one piece.</p></li>';
    spyTargets = []; return;
  }
  let minLevel = 6;
  heads.forEach((h) => { const l = /^H\d$/.test(h.tagName) ? +h.tagName[1] : 1; if (!h.classList.contains("doc-title")) minLevel = Math.min(minLevel, l); });
  heads.forEach((h) => {
    const label = h.textContent.replace(/\s+/g, " ").trim(); if (!label) return;
    h.id = h.id || slug(label, used);
    let lvl = /^H\d$/.test(h.tagName) ? +h.tagName[1] : 1;
    lvl = h.classList.contains("doc-title") ? 1 : Math.max(1, lvl - minLevel + 1);
    const li = document.createElement("li"); li.className = "l" + lvl;
    const a = document.createElement("a"); a.href = "#" + h.id; a.textContent = label; a.dataset.target = h.id;
    li.appendChild(a); tocEl.appendChild(li);
  });
  spyTargets = heads.filter((h) => h.id);
  activeId = null;
}

function buildMeta(extras) {
  const text = docEl.textContent || "";
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  const mins = Math.max(1, Math.round(words / 230));
  const bits = ['<span class="chip">Document</span>'];
  bits.push("<span>" + words.toLocaleString() + " words</span>");
  bits.push("<span>" + (words < 115 ? "Under a minute" : mins + " min read") + "</span>");
  if (extras.modified) {
    const d = new Date(extras.modified);
    if (!isNaN(d)) bits.push("<span>Edited " + d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) + "</span>");
  }
  metaEl.innerHTML = bits.join("");
  return words;
}

function jumpTo(id) {
  const t = document.getElementById(id); if (!t) return;
  showChrome(true);
  t.scrollIntoView({ behavior: "smooth", block: "start" });
  t.classList.remove("flash"); void t.offsetWidth; t.classList.add("flash");
}
document.addEventListener("click", (e) => {
  const ext = e.target.closest("#doc a[data-external]");
  if (ext) { e.preventDefault(); if (android) android.openExternal(ext.href); else window.open(ext.href, "_blank", "noopener"); return; }
  const a = e.target.closest('a[href^="#"]'); if (!a || view !== "docx") return;
  const id = decodeURIComponent(a.getAttribute("href").slice(1)); if (!id) return;
  e.preventDefault(); body.classList.remove("rail-open"); jumpTo(id);
});
// Tap the page (not a link) to bring the bar back.
$("docView").addEventListener("click", (e) => { if (!e.target.closest("a") && !getSelection().toString()) showChrome(body.classList.contains("chrome-hidden")); });

let ticking = false;
function updateProgress() {
  ticking = false;
  if (view !== "docx") return;
  const max = document.documentElement.scrollHeight - innerHeight;
  const p = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 1;
  $("progress").style.transform = "scaleX(" + p + ")";
  const line = (parseFloat(cssVar("--bar-h")) || 52) + 60;
  let cur = null;
  for (const t of spyTargets) { if (t.getBoundingClientRect().top - line <= 0) cur = t.id; else break; }
  if (!cur && spyTargets.length) cur = spyTargets[0].id;
  if (p > 0.995 && spyTargets.length) cur = spyTargets[spyTargets.length - 1].id;
  if (cur !== activeId) {
    activeId = cur;
    tocEl.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.target === cur));
  }
}
addEventListener("scroll", () => {
  if (view !== "docx") return;
  onReadScroll(scrollY); queueSave();
  if (!ticking) { ticking = true; requestAnimationFrame(updateProgress); }
}, { passive: true });
addEventListener("resize", updateProgress);

/* ---------- start ---------- */
showView("home");
window.__folio = { openBytes, prefs, get pdf() { return pdf; } };
if (android) android.ready();
