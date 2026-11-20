// Folio's PDF view for the desktop: a continuous column of pages, rendered lazily with
// pdf.js and recoloured into the current mood (see recolor.js). PDFs are read-only.
//
// Ported from Folio for Android. Desktop extras: a text layer so you can select and copy,
// zoom with Ctrl + wheel / Ctrl + plus and minus, and relayout whenever the view resizes.
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import { makePalette, recolor, imageBoxes, toPixelBoxes, looksLikePaper } from "./recolor.js";

const base = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";

const GAP = 16;            // px between pages
const MAX_PIXELS = 16e6;   // per canvas; keeps memory sane when zoomed right in
export const MIN_ZOOM = 0.5, MAX_ZOOM = 4;

export class PdfView {
  constructor({ scroller, container, onPage, onLink }) {
    this.scroller = scroller;
    this.container = container;
    this.onPage = onPage || (() => {});
    this.onLink = onLink || ((url) => window.open(url, "_blank", "noopener"));
    this.onZoom = null;
    this.doc = null;
    this.zoom = 1;
    this.mode = "themed";
    this.palette = null;
    this.gen = 0;           // bumps whenever every page needs a fresh render
    this.queue = [];
    this.busy = false;
    this.current = 0;
    this._onScroll = () => { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.update(); }); };
    scroller.addEventListener("scroll", this._onScroll, { passive: true });
    this._lastW = scroller.clientWidth;
    this._ro = new ResizeObserver(() => {
      if (!this.doc || !this.pages) return;
      const w = this.scroller.clientWidth;
      if (w === this._lastW) { this.update(); return; }
      this._lastW = w;
      const at = this.position(); this.layout(); this.restore(at);
    });
    this._ro.observe(scroller);
    this._bindGestures();
  }

  async open(data) {
    const task = pdfjsLib.getDocument({
      data: new Uint8Array(data),
      cMapUrl: base + "cmaps/", cMapPacked: true,
      standardFontDataUrl: base + "standard_fonts/",
      isEvalSupported: false, enableXfa: false
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
      el.dataset.page = i + 1;
      el.innerHTML = '<span class="num">' + (i + 1) + "</span>";
      this.container.appendChild(el);
      this.pages.push({ el, canvas: null, key: "", links: false, text: false });
    }
    this._lastW = this.scroller.clientWidth;
    this.layout();
    this._measureRest(); // other page sizes, in the background
    return { pages: n };
  }

  async info() {
    try {
      const m = await this.doc.getMetadata();
      return { title: (m && m.info && m.info.Title) || "", author: (m && m.info && m.info.Author) || "" };
    } catch (e) { return { title: "", author: "" }; }
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
      if (doc !== this.doc) return;
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
    const gutter = w < 700 ? 12 : 40;
    return Math.max(200, Math.min(w - gutter * 2, 920));
  }
  pageWidth(i) {
    // Every page is scaled by the same factor as the widest-standard page, so a landscape
    // page in a portrait document is shown wider rather than shrunk.
    const ref = this.sizes[0][0];
    return this.fitWidth() * this.zoom * (this.sizes[i][0] / ref);
  }
  layout() {
    if (!this.pages) return;
    const cs = getComputedStyle(this.container);
    let y = parseFloat(cs.paddingTop) || 0;
    this.tops = [];
    this.heights = [];
    let maxW = 0;
    for (let i = 0; i < this.pages.length; i++) {
      const [w, h] = this.sizes[i];
      const pw = Math.round(this.pageWidth(i));
      const ph = Math.round(pw * h / w);
      const el = this.pages[i].el;
      el.style.width = pw + "px";
      el.style.height = ph + "px";
      el.style.setProperty("--scale-factor", String(pw / w));
      this.tops.push(y); this.heights.push(ph);
      y += ph + GAP;
      maxW = Math.max(maxW, pw);
    }
    const side = this.scroller.clientWidth < 700 ? 12 : 40;
    this.container.style.width = Math.max(this.scroller.clientWidth, Math.round(maxW) + side * 2) + "px";
    this.update();
  }

  /** Where we are, as page + fraction through it, so it survives relayout. */
  position() {
    if (!this.tops || !this.tops.length) return { page: 0, frac: 0, x: 0.5 };
    const top = this.scroller.scrollTop + 1;
    const i = this.pageAt(top);
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
  goTo(i, smooth) {
    if (!this.tops) return;
    i = Math.max(0, Math.min(this.pages.length - 1, i));
    const top = Math.max(0, this.tops[i] - 16);
    if (smooth && Math.abs(top - this.scroller.scrollTop) < this.scroller.clientHeight * 3) this.scroller.scrollTo({ top, behavior: "smooth" });
    else this.scroller.scrollTop = top;
    this.update();
  }
  pageAt(y) {
    const t = this.tops; let lo = 0, hi = t.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo;
  }
  get pageCount() { return this.pages ? this.pages.length : 0; }

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
    this.current = cur;
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

  _key(i) { return this.gen + "|" + Math.round(this.pageWidth(i)) + "|" + (window.devicePixelRatio || 1); }

  async _pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const i = this.queue.shift();
        const p = this.pages && this.pages[i];
        if (!p || p.key === this._key(i)) continue;
        await this._render(i).catch((e) => console.warn("page " + (i + 1), e && e.message));
      }
    } finally { this.busy = false; }
  }

  async _render(i) {
    const doc = this.doc, key = this._key(i), p = this.pages[i];
    const page = await doc.getPage(i + 1);
    const cssW = this.pageWidth(i);
    const v1 = page.getViewport({ scale: 1 });
    let scale = (cssW * Math.min(window.devicePixelRatio || 1, 3)) / v1.width;
    const px = v1.width * v1.height * scale * scale;
    if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: this.mode === "themed" });
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
    p.el.insertBefore(canvas, p.el.firstChild);
    if (old) old.remove(); else { const n = p.el.querySelector(".num"); if (n) n.remove(); }
    p.canvas = canvas;
    p.key = key;
    if (!p.text) { p.text = true; this._text(i, page).catch(() => { p.text = false; }); }
    if (!p.links) { p.links = true; this._links(i, page).catch(() => {}); }
  }

  _release(i) {
    const p = this.pages[i];
    if (!p || !p.canvas) return;
    p.canvas.width = p.canvas.height = 0;
    p.canvas.remove(); p.canvas = null; p.key = "";
    const tl = p.el.querySelector(".textLayer");
    if (tl && !p.el.contains(document.getSelection().anchorNode)) { tl.remove(); p.text = false; }
    if (!p.el.querySelector(".num")) p.el.insertAdjacentHTML("afterbegin", '<span class="num">' + (i + 1) + "</span>");
  }

  // Invisible text over the page, so it can be selected and copied. It's laid out at
  // scale 1 and sized with the --scale-factor CSS variable, so zooming never redoes it.
  async _text(i, page) {
    const layer = document.createElement("div");
    layer.className = "textLayer";
    const tl = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: layer,
      viewport: page.getViewport({ scale: 1 })
    });
    await tl.render();
    if (!this.pages || !this.pages[i]) return;
    const end = document.createElement("div"); end.className = "endOfContent"; layer.appendChild(end);
    const links = this.pages[i].el.querySelector(".links");
    this.pages[i].el.insertBefore(layer, links);
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
      if (a.url) { el.href = a.url; el.dataset.external = "1"; el.title = a.url; }
      else { el.href = "#"; el.dataset.dest = JSON.stringify(a.dest); }
      layer.appendChild(el);
    }
    if (!layer.childNodes.length || !this.pages || !this.pages[i]) return;
    this.pages[i].el.appendChild(layer);
    layer.addEventListener("click", async (e) => {
      const el = e.target.closest("a"); if (!el) return;
      e.preventDefault(); e.stopPropagation();
      if (el.dataset.external) { this.onLink(el.href); return; }
      const target = await this.resolveDest(JSON.parse(el.dataset.dest));
      if (target != null) this.goTo(target, true);
    });
  }

  /* ---------- zoom ---------- */
  setZoom(z, cx, cy) {
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 100) / 100));
    if (!this.pages || z === this.zoom) { if (this.onZoom) this.onZoom(this.zoom); return; }
    const s = this.scroller, c = this.container;
    if (cx == null) { cx = s.clientWidth / 2; cy = s.clientHeight / 2; }
    // the content point under (cx, cy) stays under it
    const padTop = parseFloat(getComputedStyle(c).paddingTop) || 0;
    const ratio = z / this.zoom;
    const oy = s.scrollTop + cy;
    const midBefore = c.offsetWidth / 2, ox = s.scrollLeft + cx;
    this.zoom = z;
    this.layout();
    const midAfter = c.offsetWidth / 2;
    s.scrollLeft = midAfter + (ox - midBefore) * ratio - cx;
    s.scrollTop = padTop + (oy - padTop) * ratio - cy;
    this.update();
    if (this.onZoom) this.onZoom(z);
  }
  zoomBy(step) { this.zoomByAt(step); }

  _bindGestures() {
    const s = this.scroller, c = this.container;
    let pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    // Touch screens (Surface and friends): pinch to zoom.
    s.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 2) return;
      const rect = s.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      pinch = { d0: dist(e.touches), cx, cy, scale: 1 };
      c.style.transformOrigin = (s.scrollLeft + cx) + "px " + (s.scrollTop + cy) + "px";
      c.style.willChange = "transform";
    }, { passive: true });
    s.addEventListener("touchmove", (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      let k = dist(e.touches) / pinch.d0;
      k = Math.max(MIN_ZOOM / this.zoom, Math.min(MAX_ZOOM / this.zoom, k));
      pinch.scale = k;
      c.style.transform = "scale(" + k + ")";
    }, { passive: false });
    const endPinch = () => {
      if (!pinch) return;
      const p = pinch; pinch = null;
      c.style.transform = ""; c.style.willChange = "";
      if (Math.abs(p.scale - 1) > 0.01) this.setZoom(this.zoom * p.scale, p.cx, p.cy);
    };
    s.addEventListener("touchend", (e) => { if (e.touches.length < 2) endPinch(); });
    s.addEventListener("touchcancel", endPinch);
    // Ctrl + wheel, and trackpad pinch (which arrives as Ctrl + wheel).
    let wheelZoom = null, wheelTimer = 0;
    s.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = s.getBoundingClientRect();
      // Mouse wheels jump between steps; trackpads glide.
      if (Math.abs(e.deltaY) >= 50 && e.deltaMode === 0 && Number.isInteger(e.deltaY)) {
        this.zoomByAt(e.deltaY < 0 ? 1 : -1, e.clientX - rect.left, e.clientY - rect.top);
        return;
      }
      wheelZoom = (wheelZoom || this.zoom) * Math.exp(-e.deltaY / 200);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => { wheelZoom = null; }, 200);
      this.setZoom(wheelZoom, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
  }
  zoomByAt(step, cx, cy) {
    const stops = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
    const z = this.zoom;
    const next = step > 0 ? stops.find((s) => s > z + 0.001) : stops.slice().reverse().find((s) => s < z - 0.001);
    if (next != null) this.setZoom(next, cx, cy);
  }

  async close() {
    const doc = this.doc;
    this.doc = null; this.pages = null; this.tops = null; this.queue = [];
    this.zoom = 1; this.themeKey = "";
    this.container.textContent = "";
    this.container.style.width = "";
    if (doc) { try { await doc.destroy(); } catch (e) {} }
  }
}
