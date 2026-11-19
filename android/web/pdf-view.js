// Folio's PDF view: a continuous column of pages, rendered lazily with pdf.js and
// recoloured into the current mood. Pinch or double-tap to zoom.
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";
import { makePalette, recolor, imageBoxes, toPixelBoxes, looksLikePaper } from "./recolor.js";

const base = new URL("./vendor/pdfjs/", import.meta.url).href;
let workerReady = null;
function ensureWorker() {
  // Load the worker from a blob so it never depends on how the WebView serves worker scripts.
  workerReady ||= (async () => {
    try {
      const src = await (await fetch(base + "pdf.worker.min.mjs")).text();
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(url, { type: "module" });
    } catch (e) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";
    }
  })();
  return workerReady;
}

const GAP = 12;            // px between pages
const MAX_PIXELS = 14e6;   // per canvas; keeps memory sane when zoomed right in
const MIN_ZOOM = 1, MAX_ZOOM = 5;

export class PdfView {
  constructor({ scroller, container, onPage, onTap }) {
    this.scroller = scroller;
    this.container = container;
    this.onPage = onPage || (() => {});
    this.onTap = onTap || (() => {});
    this.doc = null;
    this.zoom = 1;
    this.mode = "themed";
    this.palette = null;
    this.gen = 0;           // bumps whenever every page needs a fresh render
    this.queue = [];
    this.busy = false;
    this.current = 0;
    this._onScroll = () => { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.update(); }); };
    this._onResize = () => { if (this.doc) { const at = this.position(); this.layout(); this.restore(at); } };
    scroller.addEventListener("scroll", this._onScroll, { passive: true });
    window.addEventListener("resize", this._onResize);
    this._bindGestures();
  }

  async open(data) {
    await ensureWorker();
    const task = pdfjsLib.getDocument({
      data: new Uint8Array(data),
      cMapUrl: base + "cmaps/", cMapPacked: true,
      standardFontDataUrl: base + "standard_fonts/",
      useWorkerFetch: false, isEvalSupported: false, enableXfa: false
    });
    this.task = task;
    this.doc = await task.promise;
    const n = this.doc.numPages;
    const first = await this.doc.getPage(1);
    const v = first.getViewport({ scale: 1 });
    this.sizes = new Array(n).fill(null).map(() => [v.width, v.height]);
    this.pages = [];
    this.container.textContent = "";
    for (let i = 0; i < n; i++) {
      const el = document.createElement("div");
      el.className = "pdf-page";
      el.innerHTML = '<span class="num">' + (i + 1) + "</span>";
      this.container.appendChild(el);
      this.pages.push({ el, canvas: null, key: "", links: false });
    }
    this.layout();
    this._measureRest(); // other page sizes, in the background
    return { pages: n };
  }

  async _measureRest() {
    const doc = this.doc;
    let changed = false;
    for (let i = 1; i < this.sizes.length; i++) {
      if (doc !== this.doc) return;
      try {
        const p = await doc.getPage(i + 1);
        const v = p.getViewport({ scale: 1 });
        if (Math.abs(v.width - this.sizes[i][0]) > 0.5 || Math.abs(v.height - this.sizes[i][1]) > 0.5) {
          this.sizes[i] = [v.width, v.height]; changed = true;
        }
      } catch (e) { /* keep the guess */ }
      if (changed && (i % 20 === 0 || i === this.sizes.length - 1)) {
        const at = this.position(); this.layout(); this.restore(at); changed = false;
      }
    }
  }

  async outline() {
    if (!this.doc) return [];
    let items;
    try { items = await this.doc.getOutline(); } catch (e) { return []; }
    if (!items) return [];
    const out = [];
    const walk = async (list, level) => {
      for (const it of list) {
        if (out.length > 400) return;
        const page = await this.resolveDest(it.dest);
        out.push({ title: (it.title || "").trim() || "Untitled", level, page, url: it.url || null });
        if (it.items && it.items.length && level < 3) await walk(it.items, level + 1);
      }
    };
    await walk(items, 1);
    return out;
  }

  async resolveDest(dest) {
    try {
      if (typeof dest === "string") dest = await this.doc.getDestination(dest);
      if (!Array.isArray(dest) || !dest.length) return null;
      const ref = dest[0];
      if (typeof ref === "number") return ref;
      return await this.doc.getPageIndex(ref);
    } catch (e) { return null; }
  }

  /* ---------- layout ---------- */
  fitWidth() {
    const w = this.scroller.clientWidth;
    const gutter = w < 700 ? 8 : 24;
    return Math.min(w - gutter * 2, 1000);
  }
  layout() {
    if (!this.pages) return;
    const fit = this.fitWidth() * this.zoom;
    const cs = getComputedStyle(this.container);
    let y = parseFloat(cs.paddingTop) || 0;
    this.tops = [];
    this.heights = [];
    let maxW = 0;
    for (let i = 0; i < this.pages.length; i++) {
      const [w, h] = this.sizes[i];
      const ph = Math.round(fit * h / w);
      const el = this.pages[i].el;
      el.style.width = Math.round(fit) + "px";
      el.style.height = ph + "px";
      this.tops.push(y); this.heights.push(ph);
      y += ph + GAP;
      maxW = Math.max(maxW, fit);
    }
    const side = this.scroller.clientWidth < 700 ? 8 : 24;
    this.container.style.width = Math.max(this.scroller.clientWidth, Math.round(maxW) + side * 2) + "px";
    this.update();
  }

  /** Where we are, as page + fraction through it, so it survives relayout. */
  position() {
    if (!this.tops || !this.tops.length) return { page: 0, frac: 0, x: 0 };
    const top = this.scroller.scrollTop + 1;
    let i = this.pageAt(top);
    const frac = Math.max(0, Math.min(1, (top - this.tops[i]) / (this.heights[i] + GAP)));
    const xw = this.container.scrollWidth - this.scroller.clientWidth;
    return { page: i, frac, x: xw > 0 ? this.scroller.scrollLeft / xw : 0.5 };
  }
  restore(at) {
    if (!at || !this.tops) return;
    const i = Math.max(0, Math.min(this.pages.length - 1, at.page | 0));
    this.scroller.scrollTop = this.tops[i] + (at.frac || 0) * (this.heights[i] + GAP) - 1;
    const xw = this.container.scrollWidth - this.scroller.clientWidth;
    if (xw > 0) this.scroller.scrollLeft = xw * (at.x ?? 0.5);
    this.update();
  }
  goTo(i) {
    if (!this.tops) return;
    i = Math.max(0, Math.min(this.pages.length - 1, i));
    const barH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-h")) || 52;
    this.scroller.scrollTop = this.tops[i] - barH - 12 + 1;
    this.update();
  }
  pageAt(y) {
    const t = this.tops; let lo = 0, hi = t.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo;
  }

  /* ---------- rendering ---------- */
  setTheme(page, ink, mode) {
    const key = page + ink + mode;
    if (key === this.themeKey) return;
    this.themeKey = key;
    this.mode = mode;
    this.palette = makePalette(page, ink);
    this.gen++;
    this.update();
  }

  update() {
    if (!this.tops || !this.tops.length) return;
    const top = this.scroller.scrollTop, h = this.scroller.clientHeight;
    const first = this.pageAt(top), last = this.pageAt(top + h);
    const cur = this.pageAt(top + h * 0.4);
    if (cur !== this.current) { this.current = cur; }
    this.onPage(cur, this.pages.length);
    const want = [];
    for (let i = first; i <= last; i++) want.push(i);
    if (last + 1 < this.pages.length) want.push(last + 1);
    if (first - 1 >= 0) want.push(first - 1);
    this.queue = want;
    // free pages far from view
    for (let i = 0; i < this.pages.length; i++) {
      if (i < first - 4 || i > last + 4) this._release(i);
    }
    this._pump();
  }

  _key() { return this.gen + "|" + Math.round(this.fitWidth() * this.zoom) + "|" + (window.devicePixelRatio || 1); }

  async _pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const i = this.queue.shift();
        const p = this.pages && this.pages[i];
        if (!p || p.key === this._key()) continue;
        await this._render(i).catch((e) => console.warn("page " + (i + 1), e && e.message));
      }
    } finally { this.busy = false; }
  }

  async _render(i) {
    const doc = this.doc, key = this._key(), p = this.pages[i];
    const page = await doc.getPage(i + 1);
    const cssW = this.fitWidth() * this.zoom;
    const v1 = page.getViewport({ scale: 1 });
    let scale = (cssW * Math.min(window.devicePixelRatio || 1, 3)) / v1.width;
    const px = v1.width * v1.height * scale * scale;
    if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    if (doc !== this.doc) return;

    if (this.mode === "themed" && this.palette) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let keep = [];
      try {
        if (!p.imageBoxes) {
          const ops = await page.getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.ENABLE });
          p.imageBoxes = imageBoxes(ops, pdfjsLib.OPS);
        }
        keep = toPixelBoxes(p.imageBoxes, vp.transform, canvas.width, canvas.height)
          .filter((b) => !looksLikePaper(img.data, canvas.width, b[0], b[1], b[2], b[3]));
      } catch (e) { keep = []; }
      recolor(img, this.palette, keep);
      ctx.putImageData(img, 0, 0);
    }
    if (doc !== this.doc || !this.pages) return;
    const old = p.canvas;
    canvas.className = old ? "" : "fresh";
    p.el.appendChild(canvas);
    if (old) old.remove(); else { const n = p.el.querySelector(".num"); if (n) n.remove(); }
    p.canvas = canvas;
    p.key = key;
    if (!p.links) { p.links = true; this._links(i, page).catch(() => {}); }
    page.cleanup();
  }

  _release(i) {
    const p = this.pages[i];
    if (!p || !p.canvas) return;
    p.canvas.width = p.canvas.height = 0;
    p.canvas.remove(); p.canvas = null; p.key = "";
    if (!p.el.querySelector(".num")) p.el.insertAdjacentHTML("afterbegin", '<span class="num">' + (i + 1) + "</span>");
  }

  async _links(i, page) {
    const annots = await page.getAnnotations({ intent: "display" });
    const vp = page.getViewport({ scale: 1 });
    const layer = document.createElement("div");
    layer.className = "links";
    for (const a of annots) {
      if (a.subtype !== "Link" || !a.rect) continue;
      if (!a.url && a.dest == null) continue;
      const r = vp.convertToViewportRectangle(a.rect);
      const x0 = Math.min(r[0], r[2]), x1 = Math.max(r[0], r[2]), y0 = Math.min(r[1], r[3]), y1 = Math.max(r[1], r[3]);
      const el = document.createElement("a");
      el.style.left = (x0 / vp.width * 100) + "%";
      el.style.top = (y0 / vp.height * 100) + "%";
      el.style.width = ((x1 - x0) / vp.width * 100) + "%";
      el.style.height = ((y1 - y0) / vp.height * 100) + "%";
      if (a.url) { el.href = a.url; el.dataset.external = "1"; }
      else { el.href = "#"; el.dataset.dest = JSON.stringify(a.dest); }
      layer.appendChild(el);
    }
    if (layer.childNodes.length) this.pages[i].el.appendChild(layer);
    layer.addEventListener("click", async (e) => {
      const el = e.target.closest("a"); if (!el) return;
      e.preventDefault(); e.stopPropagation();
      if (el.dataset.external) { this.onLink && this.onLink(el.href); return; }
      const target = await this.resolveDest(JSON.parse(el.dataset.dest));
      if (target != null) this.goTo(target);
    });
  }

  /* ---------- zoom ---------- */
  setZoom(z, cx, cy) {
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const s = this.scroller, c = this.container;
    if (cx == null) { cx = s.clientWidth / 2; cy = s.clientHeight / 2; }
    // the content point under (cx, cy) should stay under it
    const ox = s.scrollLeft + cx - c.offsetLeft, oy = s.scrollTop + cy;
    const padTop = parseFloat(getComputedStyle(c).paddingTop) || 0;
    const ratio = z / this.zoom;
    const sideBefore = (c.offsetWidth - this.fitWidth() * this.zoom) / 2;
    this.zoom = z;
    this.layout();
    const sideAfter = (c.offsetWidth - this.fitWidth() * this.zoom) / 2;
    s.scrollLeft = (ox - sideBefore) * ratio + sideAfter - cx + c.offsetLeft;
    s.scrollTop = padTop + (oy - padTop) * ratio - cy;
    this.update();
  }

  _bindGestures() {
    const s = this.scroller, c = this.container;
    let pinch = null, lastTap = 0, tapX = 0, tapY = 0, tapTimer = 0, moved = false, startX = 0, startY = 0;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    s.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        clearTimeout(tapTimer);
        const rect = s.getBoundingClientRect();
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        pinch = { d0: dist(e.touches), cx, cy, scale: 1,
          ox: s.scrollLeft + cx - c.offsetLeft, oy: s.scrollTop + cy };
        c.style.transformOrigin = pinch.ox + "px " + pinch.oy + "px";
        c.style.willChange = "transform";
      } else if (e.touches.length === 1) {
        moved = false; startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      }
    }, { passive: true });
    s.addEventListener("touchmove", (e) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        let k = dist(e.touches) / pinch.d0;
        k = Math.max(MIN_ZOOM / this.zoom, Math.min(MAX_ZOOM / this.zoom, k));
        pinch.scale = k;
        c.style.transform = "scale(" + k + ")";
      } else if (e.touches.length === 1 && Math.hypot(e.touches[0].clientX - startX, e.touches[0].clientY - startY) > 10) moved = true;
    }, { passive: false });
    const endPinch = () => {
      const p = pinch; pinch = null;
      c.style.transform = ""; c.style.willChange = "";
      if (Math.abs(p.scale - 1) > 0.01) this.setZoom(this.zoom * p.scale, p.cx, p.cy);
    };
    s.addEventListener("touchend", (e) => {
      if (pinch) { if (e.touches.length < 2) endPinch(); moved = true; return; }
      if (moved || e.touches.length) return;
      if (e.target.closest(".links a")) return;
      const t = e.changedTouches[0];
      const rect = s.getBoundingClientRect();
      const now = Date.now();
      if (now - lastTap < 300 && Math.hypot(t.clientX - tapX, t.clientY - tapY) < 40) {
        clearTimeout(tapTimer); lastTap = 0;
        e.preventDefault();
        this.setZoom(this.zoom > 1.05 ? 1 : 2.2, t.clientX - rect.left, t.clientY - rect.top);
        return;
      }
      lastTap = now; tapX = t.clientX; tapY = t.clientY;
      tapTimer = setTimeout(() => this.onTap(), 280);
    });
    s.addEventListener("touchcancel", () => { if (pinch) endPinch(); });
    // Ctrl + wheel / trackpad pinch on tablets with a keyboard, and for testing on desktop.
    s.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = s.getBoundingClientRect();
      this.setZoom(this.zoom * Math.exp(-e.deltaY / 300), e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
  }

  async close() {
    const doc = this.doc;
    this.doc = null; this.pages = null; this.tops = null; this.queue = [];
    this.zoom = 1;
    this.container.textContent = "";
    this.container.style.width = "";
    if (doc) { try { await doc.destroy(); } catch (e) {} }
  }
}
