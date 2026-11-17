/*
 * Folio's edit mode.
 *
 * The page you edit is mammoth's rendering of the document, made
 * contenteditable. Every block carries data-pid, the id of the Word paragraph
 * it came from (see model.js). After each keystroke the block's visible text
 * is compared with what it was, and only the difference is applied to the
 * paragraph's XML. Enter, Backspace across paragraphs, paste and formatting
 * are handled here rather than by the browser, so the HTML and the XML always
 * change together.
 *
 * Safety nets:
 *  - every block is aligned character by character with its XML; a block
 *    Folio can't line up exactly is locked, never guessed at;
 *  - after every change the alignment is checked again, and a change that
 *    would make the screen and the file disagree is rolled back;
 *  - before a file is written, the saved package is re-read and compared
 *    with the original: every other part must be byte-identical.
 */
(function () {
  "use strict";
  var FM = window.FolioModel;
  var OBJ = FM.OBJ, WILD = FM.WILD;
  var DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  var BLOCK_SEL = "p,h1,h2,h3,h4,h5,h6,li";
  var NESTED = { UL: 1, OL: 1, TABLE: 1, P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BLOCKQUOTE: 1, DIV: 1, LI: 1 };
  var BITS = { b: 1, i: 2, u: 4, s: 8 };
  var CMDS = { bold: "b", italic: "i", underline: "u", strikeThrough: "s" };

  function EditError(code) { this.code = code; this.message = "edit check failed: " + code; }
  EditError.prototype = Object.create(Error.prototype);

  /* ---------- alignment (Myers diff) ---------- */
  function same(a, b) {
    if (b === WILD) return a !== OBJ && a !== "\n" && a !== "\t";
    if (a === " ") a = " ";
    if (b === " ") b = " ";
    return a === b;
  }
  // Pair up the characters of a (screen) and b (XML). Returns null if they differ too much.
  function align(a, b) {
    var n = a.length, m = b.length, ma = new Int32Array(n), mb = new Int32Array(m), i;
    ma.fill(-1); mb.fill(-1);
    var s = 0;
    while (s < n && s < m && same(a[s], b[s])) { ma[s] = s; mb[s] = s; s++; }
    var e = 0;
    while (e < n - s && e < m - s && same(a[n - 1 - e], b[m - 1 - e])) { ma[n - 1 - e] = m - 1 - e; mb[m - 1 - e] = n - 1 - e; e++; }
    var N = n - s - e, M = m - s - e;
    if (N && M) {
      var MAX = Math.min(N + M, 600), off = MAX + 1, V = new Int32Array(2 * MAX + 3), trace = [], d, k, x, y, done = -1;
      V[1 + off] = 0;
      for (d = 0; d <= MAX && done < 0; d++) {
        trace.push(V.slice());
        for (k = -d; k <= d; k += 2) {
          x = (k === -d || (k !== d && V[k - 1 + off] < V[k + 1 + off])) ? V[k + 1 + off] : V[k - 1 + off] + 1;
          y = x - k;
          while (x < N && y < M && same(a[s + x], b[s + y])) { x++; y++; }
          V[k + off] = x;
          if (x >= N && y >= M) { done = d; break; }
        }
      }
      if (done < 0) return null;
      x = N; y = M;
      for (d = done; d > 0; d--) {
        var Vp = trace[d];
        k = x - y;
        var pk = (k === -d || (k !== d && Vp[k - 1 + off] < Vp[k + 1 + off])) ? k + 1 : k - 1;
        var px = Vp[pk + off], py = px - pk;
        while (x > px && y > py) { x--; y--; ma[s + x] = s + y; mb[s + y] = s + x; }
        x = px; y = py;
      }
      while (x > 0 && y > 0) { x--; y--; ma[s + x] = s + y; mb[s + y] = s + x; }
    }
    var uh = 0, ux = 0;
    for (i = 0; i < n; i++) if (ma[i] < 0) uh++;
    for (i = 0; i < m; i++) if (mb[i] < 0) ux++;
    return { ma: ma, mb: mb, uh: uh, ux: ux };
  }

  /* ---------- reading a block ---------- */
  function isNested(c) { return c.hasAttribute("data-pid") || NESTED[c.tagName] === 1; }
  function fmtBits(el, block, cache) {
    var hit = cache.get(el);
    if (hit != null) return hit;
    var cs = getComputedStyle(el), f = 0;
    if ((parseInt(cs.fontWeight, 10) || 400) >= 600) f |= 1;
    if (cs.fontStyle && cs.fontStyle !== "normal") f |= 2;
    for (var e = el; e && e !== block && e.nodeType === 1; e = e.parentElement) {
      var t = e.tagName, td = (e.style && (e.style.textDecorationLine || e.style.textDecoration)) || "";
      if (t === "U" || t === "INS" || /underline/.test(td)) f |= 4;
      if (t === "S" || t === "STRIKE" || t === "DEL" || /line-through/.test(td)) f |= 8;
    }
    cache.set(el, f);
    return f;
  }
  // The block's visible characters, in the same terms as model.textModel.
  function readBlock(block, withFmt) {
    var text = "", fmt = [], pos = [], cache = new Map();
    (function walk(el) {
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          var d = c.data, f = withFmt ? fmtBits(el, block, cache) : 0;
          for (var i = 0; i < d.length; i++) { text += d.charAt(i); fmt.push(f); pos.push([c, i]); }
        } else if (c.nodeType === 1) {
          if (isNested(c)) continue;
          if (c.hasAttribute("data-atom") || c.tagName === "IMG" || c.tagName === "INPUT") { text += OBJ; fmt.push(-1); pos.push([c, -1]); continue; }
          if (c.tagName === "BR") { text += "\n"; fmt.push(-1); pos.push([c, -1]); continue; }
          walk(c);
        }
      }
    })(block);
    var ph = null;
    // A last <br> only holds the line open; it isn't a line break.
    if (pos.length && pos[pos.length - 1][1] === -1 && pos[pos.length - 1][0].tagName === "BR") {
      ph = pos.pop()[0]; fmt.pop(); text = text.slice(0, -1);
    }
    return { text: text, fmt: fmt, pos: pos, ph: ph };
  }
  function inlineEnd(block) {
    for (var c = block.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && isNested(c)) return c;
    return null;
  }
  function addPlaceholder(block) { block.insertBefore(document.createElement("br"), inlineEnd(block)); }
  // Keep a block's last line visible: empty blocks and blocks ending in a break need a spare <br>.
  function fixPlaceholder(block, expected) {
    var rb = readBlock(block, false);
    if (expected != null && rb.text !== expected && rb.text + "\n" === expected) { addPlaceholder(block); return; }
    if (!rb.text && !rb.ph) addPlaceholder(block);
  }
  function tidyInlines(block) {
    var els = block.querySelectorAll("strong,em,b,i,u,s,strike,span,a,sup,sub,code");
    for (var i = els.length - 1; i >= 0; i--) {
      var e = els[i];
      if (e.hasAttribute("data-atom") || e.closest("[data-atom]") || e.id) continue;
      if (!e.textContent && !e.querySelector("img,br,input,[data-atom]")) e.remove();
    }
  }

  /* ---------- the editor ---------- */
  function create(host) {
    var docEl = host.docEl, D = host.desktop || null;
    var S = null;            // the open document
    var states = {};         // pid -> {h, fmt, map, xmap, uh, ux}
    var editing = false, busy = false, composing = false;
    var undo = [], redo = [], seq = 0, savedId = 0, open = null;
    var dock = null, lockToastAt = 0, asideTimer = null, saving = false;

    /* ----- opening ----- */
    function load(buf, name, info) {
      info = info || {};
      states = {}; undo = []; redo = []; savedId = 0; open = null; seq = 0;
      S = { buf: buf.slice(0), name: name, path: info.path || null, mtime: info.mtimeMs || null,
        isSample: !!info.isSample, model: null, why: null, target: null };
      notify();
      if (!window.JSZip) { S.why = "The document engine didn't load."; return Promise.resolve(buf); }
      return JSZip.loadAsync(S.buf.slice(0)).then(function (zip) {
        var d = zip.file("word/document.xml"), st = zip.file("word/styles.xml");
        if (!d) throw new Error("no word/document.xml");
        return Promise.all([d.async("string"), st ? st.async("string") : null]);
      }).then(function (xs) {
        S.model = new FM.Model(xs[0], { stylesXml: xs[1] });
        return renderBuf();
      }).catch(function (e) {
        console.warn("Folio: editing unavailable", e);
        S.model = null;
        S.why = "Folio can read this document but can't edit it safely.";
        return buf.slice(0);
      });
    }
    // The document as mammoth should render it: the live XML, with a bookmark per paragraph.
    function renderBuf() {
      return JSZip.loadAsync(S.buf.slice(0)).then(function (zip) {
        zip.file("word/document.xml", S.model.forRendering(), { createFolders: false });
        return zip.generateAsync({ type: "arraybuffer", compression: "STORE" });
      });
    }

    /* ----- after each render ----- */
    function attach(editMode) {
      var dup = {};
      docEl.querySelectorAll('a[id^="_folio_"]').forEach(function (a) {
        var pid = a.id.slice(7), block = a.closest(BLOCK_SEL);
        a.remove();
        if (!block || !docEl.contains(block)) return;
        if (block.hasAttribute("data-pid")) { dup[block.dataset.pid] = dup[pid] = true; return; }
        block.dataset.pid = pid;
      });
      if (!editMode || !S || !S.model) { setEditing(false); return; }
      states = {};
      docEl.querySelectorAll("img, input").forEach(function (im) {
        var crop = im.parentElement && im.parentElement.classList.contains("crop") ? im.parentElement : null;
        (crop || im).setAttribute("data-atom", im.tagName === "IMG" ? "img" : "input");
        // a cropped picture is a span around the image: make it one solid thing
        if (crop) crop.contentEditable = "false";
      });
      docEl.querySelectorAll('a[href^="#footnote-"], a[href^="#endnote-"]').forEach(function (a) {
        if (!/^(footnote|endnote)-ref-/.test(a.id || "")) return;
        var top = a;
        while (top.parentElement && top.parentElement.tagName === "SUP") top = top.parentElement;
        top.setAttribute("data-atom", "note");
        top.contentEditable = "false";
      });
      docEl.querySelectorAll("[data-pid]").forEach(function (b) {
        var pid = b.dataset.pid, rb = readBlock(b, false);
        // mammoth never writes a spare <br>: a trailing one is a real line break and needs one to show
        if (rb.ph || !rb.text) addPlaceholder(b);
        var why = dup[pid] ? "merged" : S.model.lockReason(pid);
        if (!why) {
          var st = measure(b);
          if (!st || st.uh > 0) why = "mismatch"; else states[pid] = st;
        }
        if (why) lock(b, why);
        var pb = S.model.pageBreak(pid);
        if (pb) b.setAttribute("data-pb", pb);
        if (S.model.hasSection(pid)) b.setAttribute("data-sect", "");
      });
      lockUnmapped(docEl);
      setEditing(true);
    }
    function lock(el, why) { el.setAttribute("data-locked", why); el.contentEditable = "false"; }
    function lockUnmapped(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (c) {
        if (c.nodeType === 3) {
          if (!c.data.trim()) return;
          var sp = document.createElement("span");
          node.insertBefore(sp, c); sp.appendChild(c); lock(sp, "unmapped");
        } else if (c.nodeType === 1) {
          if (c.hasAttribute("data-pid") || c.hasAttribute("data-atom")) return;
          if (c.querySelector("[data-pid]")) lockUnmapped(c); else lock(c, "unmapped");
        }
      });
    }
    function setEditing(on) {
      editing = on;
      if (on) {
        docEl.contentEditable = "true";
        docEl.spellcheck = false;
        docEl.classList.add("editing");
        buildDock();
        dock.hidden = false;
      } else {
        docEl.removeAttribute("contenteditable");
        docEl.classList.remove("editing");
        if (dock) dock.hidden = true;
      }
      document.body.classList.toggle("is-editing", on);
      var b = document.getElementById("editBtn");
      if (b) {
        b.setAttribute("aria-pressed", String(on));
        var l = b.querySelector(".btn-label");
        if (l) l.textContent = on ? "Editing" : "Edit";
      }
      notify();
    }

    // Line a block up with its paragraph's XML.
    function measure(block) {
      var pid = block.dataset.pid, rb = readBlock(block, true), tm = S.model.textModel(pid), al = align(rb.text, tm.text);
      if (!al) return null;
      return { h: rb.text, fmt: rb.fmt, map: al.ma, xmap: al.mb, uh: al.uh, ux: al.ux };
    }
    function remeasure(block, limit) {
      var st = measure(block);
      if (!st) throw new EditError("lost");
      if (limit && (st.uh > limit.uh || st.ux > limit.ux)) throw new EditError("drift");
      states[block.dataset.pid] = st;
      return st;
    }

    /* ----- blocks and positions ----- */
    function blockOf(node) {
      var el = node && (node.nodeType === 1 ? node : node.parentElement);
      var b = el && el.closest("[data-pid]");
      return b && docEl.contains(b) ? b : null;
    }
    function editable(b) { return !!(b && !b.hasAttribute("data-locked") && !b.closest("[data-locked]") && states[b.dataset.pid]); }
    function allBlocks() { return Array.prototype.slice.call(docEl.querySelectorAll("[data-pid]")); }
    function hOffset(block, node, offset) {
      var rb = readBlock(block, false), r = document.createRange(), n = 0;
      r.setStart(node, offset);
      for (var i = 0; i < rb.pos.length; i++) {
        var p = rb.pos[i], endNode, endOff;
        if (p[1] >= 0) { endNode = p[0]; endOff = p[1] + 1; }
        else { endNode = p[0].parentNode; endOff = Array.prototype.indexOf.call(endNode.childNodes, p[0]) + 1; }
        // char i is before the point if its end is at or before the point
        if (r.comparePoint(endNode, endOff) <= 0) n = i + 1; else break;
      }
      return n;
    }
    function domAt(block, off) {
      var rb = readBlock(block, false), p;
      if (off < rb.pos.length) {
        p = rb.pos[off];
        return p[1] >= 0 ? [p[0], p[1]] : [p[0].parentNode, Array.prototype.indexOf.call(p[0].parentNode.childNodes, p[0])];
      }
      if (rb.pos.length) {
        p = rb.pos[rb.pos.length - 1];
        return p[1] >= 0 ? [p[0], p[1] + 1] : [p[0].parentNode, Array.prototype.indexOf.call(p[0].parentNode.childNodes, p[0]) + 1];
      }
      var at = rb.ph || inlineEnd(block);
      return at ? [at.parentNode, Array.prototype.indexOf.call(at.parentNode.childNodes, at)] : [block, block.childNodes.length];
    }
    function setCaret(block, off) {
      var p = domAt(block, off), sel = document.getSelection(), r = document.createRange();
      r.setStart(p[0], p[1]); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    }
    function saveSel() {
      var sel = document.getSelection();
      if (!sel.rangeCount) return null;
      var r = sel.getRangeAt(0), a = blockOf(r.startContainer), b = blockOf(r.endContainer);
      if (!a || !b) return null;
      return { a: a.dataset.pid, ao: hOffset(a, r.startContainer, r.startOffset), b: b.dataset.pid, bo: hOffset(b, r.endContainer, r.endOffset) };
    }
    function restoreSel(s) {
      if (!s) return;
      var a = docEl.querySelector('[data-pid="' + s.a + '"]'), b = docEl.querySelector('[data-pid="' + s.b + '"]');
      if (!a) return;
      try {
        var pa = domAt(a, s.ao), pb = b ? domAt(b, s.bo) : pa, r = document.createRange();
        r.setStart(pa[0], pa[1]); r.setEnd(pb[0], pb[1]);
        var sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        var el = pa[0].nodeType === 1 ? pa[0] : pa[0].parentElement;
        if (el && el.scrollIntoView) {
          var rect = el.getBoundingClientRect();
          if (rect.top < 80 || rect.bottom > innerHeight - 90) el.scrollIntoView({ block: "center" });
        }
      } catch (e) { /* best effort */ }
    }
    // What a selection covers: one block, or a run of blocks.
    function classify(r) {
      var a = blockOf(r.startContainer), b = r.collapsed ? a : blockOf(r.endContainer), trimmed = false;
      if (!a) return null;
      if (!r.collapsed && a !== b && (!b || hOffset(b, r.endContainer, r.endOffset) === 0)) {
        // A triple-click selects a paragraph up to the start of whatever follows it (the next
        // paragraph, a heading, a list, the footnotes). Only the paragraph itself is meant.
        var t = trimTail(r, a, b);
        if (t) { r = t.range; b = t.block; trimmed = true; }
      }
      if (!b) return null;
      if (!editable(a) || !editable(b)) return { range: r, first: a, last: b, multi: a !== b, bad: true, trimmed: trimmed };
      return { range: r, first: a, last: b, block: a, multi: a !== b, trimmed: trimmed };
    }
    // The selection ended just past a block (at the start of the next thing): pull its end back
    // to the end of the last block it really covers, if nothing visible lies in between.
    function trimTail(r, a, b) {
      var list = allBlocks(), ia = list.indexOf(a), endPt = document.createRange(), last = null;
      endPt.setStart(r.endContainer, r.endOffset);
      for (var i = ia; i >= 0 && i < list.length; i++) {
        // blocks that start before the end point; the last of them is where the selection really ends
        if (list[i] === b || endPt.comparePoint(list[i], 0) >= 0) break;
        last = list[i];
      }
      if (!last) return null;
      var end = domAt(last, readBlock(last, false).text.length), tail = document.createRange();
      try { tail.setStart(end[0], end[1]); tail.setEnd(r.endContainer, r.endOffset); } catch (e) { return null; }
      if (tail.collapsed) return null;
      // only the edges of blocks may lie in between: no text, no pictures
      if (tail.toString().trim() || tail.cloneContents().querySelector("img,input")) return null;
      var out = r.cloneRange();
      out.setEnd(end[0], end[1]);
      return { range: out, block: last };
    }
    // Make the live selection match a trimmed one, so the browser and Folio agree on what's selected.
    function useRange(r) {
      var sel = document.getSelection();
      sel.removeAllRanges(); sel.addRange(r.cloneRange());
    }
    function between(a, b) {
      var list = allBlocks(), i = list.indexOf(a), j = list.indexOf(b);
      return i < 0 || j < 0 || j < i ? [] : list.slice(i, j + 1);
    }

    /* ----- transactions and undo ----- */
    function topOf(node) { while (node.parentNode !== docEl) node = node.parentNode; return node; }
    function begin(kind, blocks) {
      var kids = Array.prototype.slice.call(docEl.childNodes), lo = Infinity, hi = -1;
      blocks.forEach(function (b) { var i = kids.indexOf(topOf(b)); lo = Math.min(lo, i); hi = Math.max(hi, i); });
      var xr = S.model.region(blocks.map(function (b) { return b.dataset.pid; }));
      var xkids = Array.prototype.slice.call(xr.parent.childNodes, xr.start, xr.start + xr.len);
      return {
        id: ++seq, kind: kind, changed: false, sel0: saveSel(),
        html: { start: lo, len: hi - lo + 1, count: kids.length, before: kids.slice(lo, hi + 1).map(function (n) { return n.cloneNode(true); }),
          blocks: blocksIn(kids.slice(lo, hi + 1)) },
        xml: { parent: xr.parent, start: xr.start, len: xr.len, count: xr.count, before: xkids.map(function (n) { return n.cloneNode(true); }) }
      };
    }
    // Every block in a stretch of top-level nodes, in order.
    function blocksIn(nodes) {
      var out = [];
      nodes.forEach(function (n) {
        if (n.nodeType !== 1) return;
        if (n.hasAttribute("data-pid")) out.push(n);
        out.push.apply(out, n.querySelectorAll("[data-pid]"));
      });
      return out;
    }
    function seal(tx) {
      tx.html.lenAfter = tx.html.len + (docEl.childNodes.length - tx.html.count);
      tx.xml.lenAfter = tx.xml.len + (tx.xml.parent.childNodes.length - tx.xml.count);
    }
    function commit(tx) {
      if (!tx.changed) return;
      seal(tx);
      tx.sel1 = saveSel();
      undo.push(tx);
      if (undo.length > 300) undo.shift();
      redo = [];
      notify();
    }
    function swapNodes(parent, start, curLen, incoming) {
      var out = [], i;
      for (i = 0; i < curLen; i++) out.push(parent.childNodes[start + i]);
      var ref = parent.childNodes[start + curLen] || null;
      out.forEach(function (n) { parent.removeChild(n); });
      incoming.forEach(function (n) { parent.insertBefore(n, ref); });
      return out;
    }
    // Put a transaction's region back the way it was (toBefore) or forward again.
    function swap(tx, toBefore) {
      busy = true;
      try {
        var h = tx.html, x = tx.xml;
        var hin = toBefore ? h.before : h.after, xin = toBefore ? x.before : x.after;
        var hout = swapNodes(docEl, h.start, toBefore ? h.lenAfter : h.len, hin);
        var xout = swapNodes(x.parent, x.start, toBefore ? x.lenAfter : x.len, xin);
        if (toBefore) { h.after = hout; x.after = xout; } else { h.before = hout; x.before = xout; }
        S.model.reindex();
        hin.forEach(function (n) {
          if (n.nodeType !== 1) return;
          var bs = n.hasAttribute("data-pid") ? [n] : [];
          bs.concat(Array.prototype.slice.call(n.querySelectorAll("[data-pid]"))).forEach(function (b) {
            if (b.hasAttribute("data-locked")) return;
            var st = measure(b);
            if (st) states[b.dataset.pid] = st; else lock(b, "mismatch");
          });
        });
      } finally { busy = false; }
    }
    function rollback(tx) { seal(tx); swap(tx, true); }
    function guard(tx, fn) {
      try { fn(); return true; } catch (e) {
        console.error("Folio edit rolled back:", e && e.code, e && e.stack);
        try { rollback(tx); } catch (e2) { console.error(e2); }
        if (open && open.tx === tx) open = null;
        host.toast(e && e.code === "section" ? "There's a section break there. Folio leaves those alone so your page layout stays put."
          : "Folio couldn't make that change safely, so it put things back the way they were.");
        notify();
        return false;
      }
    }
    function typing(block, kind) {
      var now = Date.now();
      if (open && open.block === block && open.kind === kind && now - open.last < 1500 && block.isConnected) { open.last = now; return; }
      closeTyping();
      open = { tx: begin(kind, [block]), block: block, kind: kind, last: now };
    }
    function closeTyping() { if (!open) return; var o = open; open = null; commit(o.tx); }
    function op(kind, blocks, fn) {
      closeTyping();
      var tx = begin(kind, blocks);
      busy = true;
      var ok;
      try { ok = guard(tx, function () { fn(tx); }); } finally { busy = false; }
      if (ok) { tx.changed = true; commit(tx); }
      aside();
      return ok;
    }
    function undoOp() {
      closeTyping();
      var tx = undo.pop();
      if (!tx) return;
      swap(tx, true); redo.push(tx); restoreSel(tx.sel0); notify(); aside();
    }
    function redoOp() {
      closeTyping();
      var tx = redo.pop();
      if (!tx) return;
      swap(tx, false); undo.push(tx); restoreSel(tx.sel1); notify(); aside();
    }

    /* ----- applying a block's changes to the XML ----- */
    function sync(block) {
      var pid = block.dataset.pid, st = states[pid];
      if (!st) throw new EditError("unknown");
      if (!composing) fixPlaceholder(block);
      var cur = readBlock(block, true), h0 = st.h, h1 = cur.text, n0 = h0.length, n1 = h1.length, i;
      var fmtSame = cur.fmt.length === st.fmt.length && cur.fmt.every(function (f, j) { return f === st.fmt[j]; });
      if (h1 === h0 && fmtSame) return false;
      var p = 0, s = 0;
      while (p < n0 && p < n1 && h0.charAt(p) === h1.charAt(p)) p++;
      while (s < n0 - p && s < n1 - p && h0.charAt(n0 - 1 - s) === h1.charAt(n1 - 1 - s)) s++;
      var ins = h1.slice(p, n1 - s).replace(/ /g, " "), pos = null, anchorH = -1;
      if (n0 - s > p || ins) {
        var idxs = [], first = -1, last = -1;
        for (i = p; i < n0 - s; i++) if (st.map[i] >= 0) { idxs.push(st.map[i]); if (first < 0) first = st.map[i]; last = st.map[i]; }
        // characters the screen never showed but that sit inside the deleted stretch go too
        for (i = first + 1; first >= 0 && i < last; i++) if (st.xmap[i] < 0 && idxs.indexOf(i) < 0) idxs.push(i);
        idxs.sort(function (a, b) { return a - b; });
        for (i = p - 1; i >= 0 && !pos; i--) if (st.map[i] >= 0) { pos = { after: st.map[i] }; anchorH = i; }
        for (i = n0 - s; i < n0 && !pos; i++) if (st.map[i] >= 0) { pos = { before: st.map[i] }; anchorH = i; }
        if (!pos) pos = { end: true };
        if (idxs.length) S.model.deleteSlots(pid, idxs);
        if (ins) {
          if (pos.before != null) pos = { before: pos.before - idxs.filter(function (x) { return x < pos.before; }).length };
          S.model.insertText(pid, pos, ins);
        }
      }
      var tm = S.model.textModel(pid), al = align(h1, tm.text);
      if (!al) throw new EditError("lost");
      // Formatting: compare each character with how it looked before (or, for new text,
      // with the character it was typed next to) and write only what changed.
      var base = anchorFmt(st, anchorH, block), changes = { b: [], i: [], u: [], s: [] };
      for (i = 0; i < n1; i++) {
        var f1 = cur.fmt[i];
        if (f1 < 0) continue;
        var f0 = i < p ? st.fmt[i] : (i >= n1 - s ? st.fmt[i - n1 + n0] : base);
        if (f0 == null || f0 < 0 || f0 === f1) continue;
        var slot = al.ma[i];
        if (slot < 0) continue;
        for (var k in BITS) if ((f0 ^ f1) & BITS[k]) changes[k].push([slot, !!(f1 & BITS[k])]);
      }
      for (var prop in changes) {
        var list = changes[prop].sort(function (a, b) { return a[0] - b[0]; }), j = 0;
        while (j < list.length) {
          var a = list[j][0], on = list[j][1], b = a;
          while (j + 1 < list.length && list[j + 1][0] === b + 1 && list[j + 1][1] === on) { j++; b++; }
          S.model.setFormat(pid, a, b + 1, prop, on);
          j++;
        }
      }
      if (al.uh > st.uh || al.ux > st.ux) throw new EditError("drift");
      states[pid] = { h: h1, fmt: cur.fmt, map: al.ma, xmap: al.mb, uh: al.uh, ux: al.ux };
      return true;
    }
    function anchorFmt(st, at, block) {
      for (var i = at; i >= 0 && i < st.fmt.length; i--) if (st.fmt[i] >= 0) return st.fmt[i];
      for (i = Math.max(at, 0); i < st.fmt.length; i++) if (st.fmt[i] >= 0) return st.fmt[i];
      var probe = document.createElement("span");
      probe.textContent = "x";
      block.insertBefore(probe, inlineEnd(block));
      var f = fmtBits(probe, block, new Map());
      probe.remove();
      return f;
    }
    function syncOpen() {
      if (!open) return;
      var tx = open.tx, block = open.block;
      guard(tx, function () {
        if (!block.isConnected || !block.hasAttribute("data-pid")) throw new EditError("vanished");
        if (sync(block)) tx.changed = true;
        checkRegion(tx);
      });
      notify();
    }
    // Native typing must only ever change text inside its block.
    function checkRegion(tx) {
      var kids = docEl.childNodes;
      if (kids.length !== tx.html.count) throw new EditError("structure");
      for (var i = tx.html.start; i < tx.html.start + tx.html.len; i++) {
        var n = kids[i];
        if (n.nodeType === 3 && n.data.trim()) throw new EditError("stray");
      }
      // ...and never merge, drop or add a paragraph (say, two list items run together)
      var now = blocksIn(Array.prototype.slice.call(kids, tx.html.start, tx.html.start + tx.html.len)), was = tx.html.blocks;
      if (now.length !== was.length) throw new EditError("blocks");
      for (i = 0; i < now.length; i++) if (now[i] !== was[i] || now[i].dataset.pid !== was[i].dataset.pid) throw new EditError("blocks");
    }

    /* ----- structural edits ----- */
    function deleteSelection(c) {
      var r = c.range;
      if (!c.multi) {
        r.deleteContents();
        sync(c.first);
        var off = hOffset(c.first, r.startContainer, r.startOffset);
        setCaret(c.first, Math.min(off, states[c.first.dataset.pid].h.length));
        return;
      }
      var F = c.first, L = c.last, list = between(F, L), mid = list.slice(1, -1);
      var keepF = hOffset(F, r.startContainer, r.startOffset);
      var rf = document.createRange(), endF = domAt(F, states[F.dataset.pid].h.length);
      rf.setStart(r.startContainer, r.startOffset); rf.setEnd(endF[0], endF[1]);
      var rl = document.createRange(), startL = domAt(L, 0);
      rl.setStart(startL[0], startL[1]); rl.setEnd(r.endContainer, r.endOffset);
      rl.deleteContents(); rf.deleteContents();
      if (readBlock(F, false).text.length !== keepF) throw new EditError("trim");
      sync(F); sync(L);
      mid.forEach(function (m) {
        var why = S.model.removePara(m.dataset.pid);
        if (why) throw new EditError(why);
        var parent = m.parentNode;
        m.remove(); delete states[m.dataset.pid]; prune(parent);
      });
      join(F, L);
      setCaret(F, keepF);
    }
    function spanProblem(c) {
      if (c.bad) return "locked";
      if (!c.multi) return null;
      var list = between(c.first, c.last);
      for (var i = 0; i < list.length; i++) {
        if (!editable(list[i])) return "locked";
        for (var j = 0; j < list.length; j++) if (i !== j && list[i].contains(list[j])) return "nested";
      }
      for (i = 0; i + 1 < list.length; i++) {
        var why = S.model.canMerge(list[i].dataset.pid, list[i + 1].dataset.pid);
        if (why) return why;
      }
      return null;
    }
    function sayWhy(why) {
      host.toast({
        section: "There's a section break there. Folio leaves those alone so your page layout stays put.",
        structure: "That would join text across a table or another block. Folio edits one stretch of paragraphs at a time.",
        locked: "Part of that selection is something Folio keeps exactly as it is (like a text box or footnote).",
        nested: "Try a smaller selection: Folio can't join nested list items in one go yet."
      }[why] || "Folio can't make that change here.");
    }
    function prune(parent) {
      while (parent && parent !== docEl && /^(UL|OL|BLOCKQUOTE)$/.test(parent.tagName) && !parent.querySelector("[data-pid]")) {
        var up = parent.parentNode; parent.remove(); parent = up;
      }
    }
    // Join block B onto the end of block A, in the XML and on screen.
    function join(A, B) {
      var sa = states[A.dataset.pid], sb = states[B.dataset.pid];
      var expected = sa.h + sb.h, limit = { uh: sa.uh + sb.uh, ux: sa.ux + sb.ux };
      var why = S.model.merge(A.dataset.pid, B.dataset.pid);
      if (why) throw new EditError(why);
      var ph = readBlock(A, false).ph;
      if (ph) ph.remove();
      var at = inlineEnd(A);
      while (B.firstChild) A.insertBefore(B.firstChild, at);
      var parent = B.parentNode;
      B.remove(); delete states[B.dataset.pid]; prune(parent);
      tidyInlines(A);
      fixPlaceholder(A, expected);
      var st = remeasure(A, limit);
      if (st.h !== expected) throw new EditError("join");
      return sa.h.length;
    }
    function mergeBack(block) {
      var list = allBlocks(), prev = list[list.indexOf(block) - 1];
      if (!prev) return;
      if (!editable(prev)) { sayWhy("locked"); return; }
      var why = S.model.canMerge(prev.dataset.pid, block.dataset.pid);
      if (why) { sayWhy(why); return; }
      op("merge", [prev, block], function () { var at = join(prev, block); setCaret(prev, at); });
    }
    function mergeForward(block) {
      var list = allBlocks(), next = list[list.indexOf(block) + 1];
      if (!next) return;
      if (!editable(next)) { sayWhy("locked"); return; }
      var why = S.model.canMerge(block.dataset.pid, next.dataset.pid);
      if (why) { sayWhy(why); return; }
      op("merge", [block, next], function () { var at = join(block, next); setCaret(block, at); });
    }
    function shellLike(block, asParagraph) {
      var n = document.createElement(asParagraph ? "p" : block.tagName);
      if (!asParagraph && block.className) n.className = block.className.replace(/\b(pseudo-head|pic)\b/g, "").trim();
      if (!n.className) n.removeAttribute("class");
      return n;
    }
    // Split the block at the caret (Enter).
    function splitHere(block, allowLeaveList) {
      var pid = block.dataset.pid, st = states[pid], sel = document.getSelection(), r = sel.getRangeAt(0);
      var k = hOffset(block, r.startContainer, r.startOffset), len = st.h.length, i;
      if (allowLeaveList && block.tagName === "LI" && !len && block.parentElement.parentElement === docEl && !inlineEnd(block)) {
        leaveList(block); return;
      }
      var pos = null;
      if (!len || k >= len) pos = "end";
      else if (k === 0) pos = "start";
      else {
        for (i = k - 1; i >= 0 && !pos; i--) if (st.map[i] >= 0) pos = { after: st.map[i] };
        for (i = k; i < len && !pos; i++) if (st.map[i] >= 0) pos = { before: st.map[i] };
        if (!pos) pos = "end";
      }
      var heading = /^H[1-6]$/.test(block.tagName) || /\bdoc-(title|subtitle)\b/.test(block.className);
      var next = pos === "end" && heading ? S.model.nextStyleFor(pid) : null;
      var newPid = S.model.split(pid, pos, { nextStyle: next });
      var nb = shellLike(block, !!next), rr = document.createRange(), caret = domAt(block, k);
      nb.dataset.pid = newPid;
      var a = st.h.slice(0, k), b = st.h.slice(k), limit = { uh: st.uh, ux: st.ux };
      if (pos === "start") {
        rr.setStart(block, 0); rr.setEnd(caret[0], caret[1]);
        nb.appendChild(rr.extractContents());
        block.parentNode.insertBefore(nb, block);
        fixPlaceholder(nb, ""); fixPlaceholder(block, st.h);
        var s1 = remeasure(nb), s2 = remeasure(block);
        if (s1.h || s2.h !== st.h || s1.ux + s2.ux > limit.ux || s1.uh + s2.uh > limit.uh) throw new EditError("split");
        setCaret(block, 0);
        return;
      }
      rr.setStart(caret[0], caret[1]); rr.setEnd(block, block.childNodes.length);
      nb.appendChild(rr.extractContents());
      block.parentNode.insertBefore(nb, block.nextSibling);
      tidyInlines(block); tidyInlines(nb);
      fixPlaceholder(block, a); fixPlaceholder(nb, b);
      var t1 = remeasure(block), t2 = remeasure(nb);
      if (t1.h !== a || t2.h !== b || t1.ux + t2.ux > limit.ux || t1.uh + t2.uh > limit.uh) throw new EditError("split");
      setCaret(nb, 0);
    }
    function leaveList(li) {
      var pid = li.dataset.pid, U = li.parentElement, before = 0, after = [];
      for (var n = U.firstElementChild; n && n !== li; n = n.nextElementSibling) if (n.tagName === "LI") before++;
      for (n = li.nextSibling; n; n = n.nextSibling) after.push(n);
      S.model.leaveList(pid);
      var p = document.createElement("p");
      p.dataset.pid = pid;
      while (li.firstChild) p.appendChild(li.firstChild);
      U.parentNode.insertBefore(p, U.nextSibling);
      if (after.length) {
        var U2 = U.cloneNode(false);
        after.forEach(function (x) { U2.appendChild(x); });
        if (U.tagName === "OL") U2.start = (U.start || 1) + before;
        p.parentNode.insertBefore(U2, p.nextSibling);
      }
      li.remove();
      if (!U.querySelector("li")) U.remove();
      fixPlaceholder(p, "");
      remeasure(p);
      setCaret(p, 0);
    }
    function caretBlock() {
      var sel = document.getSelection();
      return sel.rangeCount ? blockOf(sel.getRangeAt(0).startContainer) : null;
    }
    // Insert plain text at the caret; newlines become new paragraphs.
    function insertPlain(text) {
      text = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￼]/g, "");
      var lines = text.split("\n");
      lines.forEach(function (line, li) {
        var block = caretBlock();
        if (!block) throw new EditError("caret");
        if (li > 0) { splitHere(block, false); block = caretBlock(); }
        if (!line) return;
        var sel = document.getSelection(), r = sel.getRangeAt(0), node = r.startContainer, off = r.startOffset;
        if (node.nodeType === 3) {
          node.insertData(off, line);
          r = document.createRange(); r.setStart(node, off + line.length);
        } else {
          var tn = document.createTextNode(line);
          r.insertNode(tn);
          r = document.createRange(); r.setStart(tn, line.length);
        }
        r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
        sync(block);
      });
    }
    function selectionCtx() {
      var sel = document.getSelection();
      if (!sel.rangeCount) return null;
      return classify(sel.getRangeAt(0));
    }
    function replaceSelection(c, text, kind) {
      var why = spanProblem(c);
      if (why) { sayWhy(why); return false; }
      return op(kind || "replace", between(c.first, c.last), function () {
        if (!c.range.collapsed) deleteSelection(c);
        if (text) insertPlain(text);
      });
    }
    function enter(c) {
      var why = spanProblem(c);
      if (why) { sayWhy(why); return; }
      op("enter", between(c.first, c.last), function () {
        if (!c.range.collapsed) deleteSelection(c);
        splitHere(caretBlock(), true);
      });
    }
    function format(cmd) {
      var c = selectionCtx();
      if (!c || c.bad && !c.multi) return;
      if (c.trimmed) useRange(c.range);
      if (c.range.collapsed) {
        // Sets the style for the next character typed; sync() picks it up from the DOM.
        document.execCommand("styleWithCSS", false, false);
        document.execCommand(cmd, false, null);
        refreshDock();
        return;
      }
      var blocks = between(c.first, c.last).filter(editable);
      if (!blocks.length) return;
      op("format", blocks, function () {
        document.execCommand("styleWithCSS", false, false);
        document.execCommand(cmd, false, null);
        blocks.forEach(function (b) {
          if (!b.isConnected) throw new EditError("vanished");
          sync(b);
        });
      });
      refreshDock();
    }

    /* ----- browser events ----- */
    function onBeforeInput(e) {
      if (!editing) return;
      var t = e.inputType;
      if (t === "historyUndo" || t === "historyRedo") { e.preventDefault(); if (t === "historyUndo") undoOp(); else redoOp(); return; }
      if (/^format/.test(t)) {
        e.preventDefault();
        var cmd = { formatBold: "bold", formatItalic: "italic", formatUnderline: "underline", formatStrikeThrough: "strikeThrough" }[t];
        if (cmd) format(cmd);
        return;
      }
      if (/^insertFrom(Paste|Drop|Yank)|^deleteByDrag$|^insertLink$|List$|^insertHorizontalRule$/.test(t)) { if (e.cancelable) e.preventDefault(); return; }
      var c = selectionCtx();
      if (!c || (c.bad && !c.multi)) { if (e.cancelable) e.preventDefault(); nudgeLocked(); return; }
      // A trimmed selection (a triple-click) differs from the browser's own: from here on Folio
      // makes the change itself, so the paragraph after it is never touched.
      if (c.trimmed) useRange(c.range);
      if (t === "insertParagraph") { e.preventDefault(); enter(c); return; }
      if (t === "insertLineBreak") {
        // Chrome would type a bare newline here (the page is pre-wrap); Word needs a real break.
        e.preventDefault();
        if (!c.range.collapsed && !replaceSelection(c, "", "type")) return;
        lineBreak();
        return;
      }
      if (/^insert/.test(t)) {
        if (c.multi || c.trimmed) {
          if (e.cancelable) { e.preventDefault(); replaceSelection(c, e.data || "", "type"); }
          return;
        }
        typing(c.block, "type");
        return;
      }
      if (/^delete/.test(t)) {
        if (c.multi || c.trimmed) { e.preventDefault(); replaceSelection(c, "", "delete"); return; }
        var block = c.block, r = c.range;
        if (r.collapsed) {
          var back = /Backward$/.test(t), off = hOffset(block, r.startContainer, r.startOffset), len = states[block.dataset.pid].h.length;
          if (back && off === 0) { e.preventDefault(); mergeBack(block); return; }
          if (!back && off >= len) { e.preventDefault(); mergeForward(block); return; }
          var tr = e.getTargetRanges && e.getTargetRanges()[0];
          if (tr && (blockOf(tr.startContainer) !== block || blockOf(tr.endContainer) !== block)) { e.preventDefault(); return; }
        }
        typing(block, "delete");
        return;
      }
      if (e.cancelable) e.preventDefault();
    }
    function lineBreak() {
      var block = caretBlock();
      if (!block || !editable(block)) return;
      op("type", [block], function () {
        var sel = document.getSelection(), r = sel.getRangeAt(0), br = document.createElement("br");
        r.insertNode(br);
        r = document.createRange(); r.setStartAfter(br); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
        if (readBlock(block, false).ph === br) addPlaceholder(block);
        sync(block);
      });
    }
    function onInput() {
      if (!editing || busy) return;
      if (open) syncOpen();
      else {
        // An input we didn't see coming: catch the XML up without an undo step.
        var b = caretBlock();
        if (b && states[b.dataset.pid]) { try { sync(b); } catch (e) { console.error(e); } }
      }
      aside();
    }
    function onKeyDown(e) {
      if (!editing) return;
      var mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (mod && !e.altKey && k === "z") { e.preventDefault(); if (e.shiftKey) redoOp(); else undoOp(); return; }
      if (mod && !e.altKey && k === "y") { e.preventDefault(); redoOp(); return; }
      if (mod && !e.altKey && !e.shiftKey && (k === "b" || k === "i" || k === "u")) {
        e.preventDefault(); format({ b: "bold", i: "italic", u: "underline" }[k]); return;
      }
      if (mod && e.shiftKey && (k === "x" || k === "5")) { e.preventDefault(); format("strikeThrough"); return; }
      if (e.key === "Tab" && !mod && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) return;
        var c = selectionCtx();
        if (c && !c.bad) replaceSelection(c, "\t", "type");
      }
    }
    function onPaste(e) {
      if (!editing) return;
      e.preventDefault();
      var text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
      var c = selectionCtx();
      if (!c || (c.bad && !c.multi)) { nudgeLocked(); return; }
      if (text || !c.range.collapsed) replaceSelection(c, text, "paste");
    }
    function onCut(e) {
      if (!editing) return;
      var c = selectionCtx();
      if (!c || c.range.collapsed) return;
      e.preventDefault();
      if (e.clipboardData) e.clipboardData.setData("text/plain", c.range.toString());
      replaceSelection(c, "", "cut");
    }
    function nudgeLocked() {
      var now = Date.now();
      if (now - lockToastAt < 8000) return;
      lockToastAt = now;
      host.toast("Folio keeps this part exactly as it is. Text boxes, footnotes and a few other things can't be edited here yet.");
    }
    docEl.addEventListener("beforeinput", onBeforeInput);
    docEl.addEventListener("input", onInput);
    docEl.addEventListener("keydown", onKeyDown);
    docEl.addEventListener("paste", onPaste);
    docEl.addEventListener("cut", onCut);
    docEl.addEventListener("compositionstart", function () {
      composing = true;
      var c = editing && selectionCtx();
      if (c && c.trimmed) useRange(c.range);
    });
    docEl.addEventListener("compositionend", function () { composing = false; });
    docEl.addEventListener("dragstart", function (e) { if (editing) e.preventDefault(); });
    docEl.addEventListener("click", function (e) {
      if (!editing) return;
      var a = e.target.closest("a[href]");
      if (a && !/^#/.test(a.getAttribute("href"))) {
        e.preventDefault(); e.stopPropagation();
        if (e.ctrlKey || e.metaKey) window.open(a.href, "_blank", "noopener");
      }
      if (e.target.closest("[data-locked]")) nudgeLocked();
    }, true);
    document.addEventListener("selectionchange", function () {
      if (!editing) return;
      if (open && caretBlock() !== open.block) closeTyping();
      refreshDock();
    });

    /* ----- the dock ----- */
    var ICON = {
      undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
      redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>',
      copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-7A2.5 2.5 0 0 0 4 5.5v9A2.5 2.5 0 0 0 6.5 17H8"/></svg>',
      replace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m9 14 2 2 4-4"/></svg>',
      download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>'
    };
    function buildDock() {
      if (dock) return;
      dock = document.createElement("div");
      dock.className = "dock";
      dock.id = "dock";
      dock.setAttribute("role", "toolbar");
      dock.setAttribute("aria-label", "Editing");
      dock.hidden = true;
      dock.innerHTML =
        '<div class="dock-group">'
        + '<button class="dock-btn" data-cmd="bold" title="Bold (Ctrl+B)" aria-pressed="false"><b>B</b></button>'
        + '<button class="dock-btn" data-cmd="italic" title="Italic (Ctrl+I)" aria-pressed="false"><i>I</i></button>'
        + '<button class="dock-btn" data-cmd="underline" title="Underline (Ctrl+U)" aria-pressed="false"><u>U</u></button>'
        + '<button class="dock-btn" data-cmd="strikeThrough" title="Strikethrough (Ctrl+Shift+X)" aria-pressed="false"><s>S</s></button>'
        + '</div><span class="dock-sep"></span><div class="dock-group">'
        + '<button class="dock-btn" id="undoBtn" title="Undo (Ctrl+Z)" aria-label="Undo">' + ICON.undo + '</button>'
        + '<button class="dock-btn" id="redoBtn" title="Redo (Ctrl+Y)" aria-label="Redo">' + ICON.redo + '</button>'
        + '</div><span class="dock-sep"></span>'
        + '<span class="dock-status" id="dockStatus" role="status"><i></i><span>No changes yet</span></span>'
        + '<button class="dock-save" id="saveBtn" title="Save (Ctrl+S)">Save</button>'
        + '<button class="dock-done" id="doneBtn" title="Back to reading (Ctrl+E)">Done</button>';
      document.body.appendChild(dock);
      dock.addEventListener("mousedown", function (e) { if (e.target.closest(".dock-btn")) e.preventDefault(); });
      dock.querySelectorAll("[data-cmd]").forEach(function (b) { b.onclick = function () { format(b.dataset.cmd); }; });
      dock.querySelector("#undoBtn").onclick = undoOp;
      dock.querySelector("#redoBtn").onclick = redoOp;
      dock.querySelector("#saveBtn").onclick = function () { save("auto"); };
      dock.querySelector("#doneBtn").onclick = function () { stopEditing(); };
    }
    function refreshDock() {
      if (!dock || !editing) return;
      dock.querySelectorAll("[data-cmd]").forEach(function (b) {
        var on = false;
        try { on = document.queryCommandState(b.dataset.cmd); } catch (e) {}
        b.setAttribute("aria-pressed", String(!!on));
      });
    }
    function dirty() { return !!S && ((open && open.tx.changed) || (undo.length ? undo[undo.length - 1].id : 0) !== savedId); }
    function notify() {
      var d = dirty();
      if (dock) {
        dock.querySelector("#undoBtn").disabled = !undo.length && !(open && open.tx.changed);
        dock.querySelector("#redoBtn").disabled = !redo.length;
        var st = dock.querySelector("#dockStatus");
        st.classList.toggle("dirty", d);
        st.querySelector("span").textContent = d ? "Unsaved changes" : (S && S.savedOnce ? "All changes saved" : "No changes yet");
        dock.querySelector("#saveBtn").disabled = saving;
      }
      var dn = document.getElementById("docname");
      if (dn) { if (d) dn.setAttribute("data-edited", ""); else dn.removeAttribute("data-edited"); }
      if (D && D.setDirty) D.setDirty(d);
      if (host.onDirty) host.onDirty(d);
    }
    function aside() {
      clearTimeout(asideTimer);
      asideTimer = setTimeout(function () { if (host.refreshAside) host.refreshAside(); }, 700);
    }

    /* ----- switching modes ----- */
    function scrollAnchor() {
      var top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-h")) || 56) + 8;
      var list = allBlocks();
      for (var i = 0; i < list.length; i++) {
        var r = list[i].getBoundingClientRect();
        if (r.bottom > top && r.height) {
          return { pids: list.slice(i, i + 12).map(function (b) { return b.dataset.pid; }), dy: r.top };
        }
      }
      return null;
    }
    function restoreScroll(a) {
      if (!a) return;
      for (var i = 0; i < a.pids.length; i++) {
        var el = docEl.querySelector('[data-pid="' + a.pids[i] + '"]');
        if (el) { window.scrollBy(0, el.getBoundingClientRect().top - a.dy); return; }
      }
    }
    function rerender(toEdit) {
      var a = scrollAnchor();
      return renderBuf().then(function (buf) { return host.render(buf, { editing: toEdit, keep: true }); })
        .then(function () { restoreScroll(a); });
    }
    function startEditing() {
      if (!S) return Promise.resolve();
      if (!S.model) { host.toast(S.why || "This document can't be edited."); return Promise.resolve(); }
      if (editing) return Promise.resolve();
      return rerender(true).then(function () {
        var first = docEl.querySelector("[data-pid]:not([data-locked])");
        var sel = document.getSelection();
        if (first && !(sel.rangeCount && blockOf(sel.getRangeAt(0).startContainer))) {
          // put the caret in the first editable block that's on screen
          var top = 80, list = allBlocks().filter(editable);
          for (var i = 0; i < list.length; i++) if (list[i].getBoundingClientRect().bottom > top) { first = list[i]; break; }
          docEl.focus({ preventScroll: true });
          setCaret(first, 0);
        }
        try {
          if (!localStorage.getItem("folio-edit-hint")) {
            localStorage.setItem("folio-edit-hint", "1");
            host.toast("Edit away! Your original file stays exactly as it is until you choose to replace it.");
          }
        } catch (e) {}
      });
    }
    function stopEditing() {
      if (!editing) return Promise.resolve();
      closeTyping();
      return rerender(false);
    }
    function toggle() { return editing ? stopEditing() : startEditing(); }

    /* ----- saving ----- */
    function baseName() {
      return (S.name || "Document").replace(/\.(docx|docm|dotx)$/i, "").replace(/ \(edited( \d+)?\)$/i, "");
    }
    function buildDocx() {
      var xml = S.model.serialize(), census = S.model.census(), now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      return JSZip.loadAsync(S.buf.slice(0)).then(function (zip) {
        zip.file("word/document.xml", xml, { createFolders: false });
        var core = zip.file("docProps/core.xml");
        return (core ? core.async("string") : Promise.resolve(null)).then(function (c) {
          if (c && /<dcterms:modified\b[^>]*>[^<]*<\/dcterms:modified>/.test(c)) {
            zip.file("docProps/core.xml", c.replace(/(<dcterms:modified\b[^>]*>)[^<]*(<\/dcterms:modified>)/, "$1" + now + "$2"), { createFolders: false });
          }
          return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, mimeType: DOCX });
        });
      }).then(function (bytes) { return verify(bytes, census).then(function () { return bytes; }); });
    }
    function allText(m) {
      var ps = m.doc.getElementsByTagNameNS(FM.W, "p"), out = [];
      for (var i = 0; i < ps.length; i++) out.push(m.textModel(m.pidOf(ps[i])).text);
      return out.join(" ");
    }
    // Re-read the file about to be written and make sure nothing went missing.
    function verify(bytes, census) {
      return Promise.all([JSZip.loadAsync(bytes), JSZip.loadAsync(S.buf.slice(0))]).then(function (z) {
        var out = z[0], orig = z[1], jobs = [];
        Object.keys(orig.files).forEach(function (name) {
          var f = orig.files[name];
          if (f.dir || name === "word/document.xml" || name === "docProps/core.xml") return;
          var g = out.file(name);
          if (!g) throw new Error("missing part " + name);
          jobs.push(Promise.all([f.async("uint8array"), g.async("uint8array")]).then(function (ab) {
            var a = ab[0], b = ab[1];
            if (a.length !== b.length) throw new Error("changed part " + name);
            for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error("changed part " + name);
          }));
        });
        // nothing new either: a stray folder entry is enough to upset OneDrive
        Object.keys(out.files).forEach(function (name) { if (!orig.files[name]) throw new Error("unexpected part " + name); });
        jobs.push(out.file("word/document.xml").async("string").then(function (x) {
          var m2 = new FM.Model(x), c2 = m2.census();
          Object.keys(census).forEach(function (k) {
            if (census[k] !== c2[k]) throw new Error("census mismatch for " + k + ": " + census[k] + " vs " + c2[k]);
          });
          if (allText(m2) !== allText(S.model)) throw new Error("text changed in serialization");
        }));
        return Promise.all(jobs);
      });
    }
    function save(mode) {
      if (!S || !S.model || saving) return Promise.resolve(false);
      closeTyping();
      if (mode === "auto") {
        if (S.target) mode = "overwrite";
        else return chooseSave();
      }
      saving = true; notify();
      var label = mode === "copy" ? "copy" : "save";
      return buildDocx().then(function (bytes) {
        if (!D || !D.saveDocx) return download(bytes);
        return D.saveDocx({
          mode: mode, bytes: bytes, path: S.target || S.path, sourcePath: S.path,
          suggestedName: baseName() + " (edited).docx", expectedMtimeMs: S.mtime
        });
      }).then(function (res) {
        saving = false;
        if (!res || res.canceled) { notify(); return false; }
        if (res.conflict) {
          notify();
          return ask({
            title: "This file changed on disk",
            body: "Someone (or something) changed “" + (S.name || "this document") + "” after Folio opened it. Replacing it would throw those changes away.",
            buttons: [{ label: "Cancel", value: null, kind: "ghost" }, { label: "Replace anyway", value: "force", kind: "danger" }, { label: "Save a copy", value: "copy", kind: "primary" }]
          }).then(function (v) {
            if (v === "copy") return save("copy");
            if (v === "force") { S.mtime = null; return save("overwrite"); }
            return false;
          });
        }
        if (res.error) {
          notify();
          host.toast(res.error === "locked"
            ? "Couldn't save: the file is open in another app (probably Word). Close it there, or save a copy instead."
            : "Couldn't save the file: " + res.error);
          return false;
        }
        savedId = undo.length ? undo[undo.length - 1].id : 0;
        S.savedOnce = true;
        if (res.path) { S.target = res.path; S.path = res.path; }
        if (res.mtimeMs) S.mtime = res.mtimeMs;
        if (res.name) { S.name = res.name; if (host.setName) host.setName(res.name); }
        notify();
        host.toast(res.downloaded ? "Downloaded “" + res.name + "” ✨" : "Saved “" + (res.name || "your document") + "” ✨",
          res.path && D && D.showInFolder ? { action: { label: "Show in folder", run: function () { D.showInFolder(res.path); } } } : null);
        return true;
      }).catch(function (e) {
        saving = false; notify();
        console.error("Folio save failed", e);
        host.toast("Folio stopped the " + label + " because something didn't look right. Your file wasn't changed.");
        return false;
      });
    }
    function download(bytes) {
      var name = baseName() + " (edited).docx";
      var url = URL.createObjectURL(new Blob([bytes], { type: DOCX }));
      var a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      return { ok: true, name: name, downloaded: true };
    }
    function chooseSave() {
      var nm = baseName(), canReplace = !!(D && D.saveDocx && S.path);
      var choices = [{ value: "copy", icon: D ? ICON.copy : ICON.download, title: D ? "Save as a copy" : "Download a copy", rec: true,
        sub: "Your original stays untouched. The copy is called “" + nm + " (edited).docx”." }];
      if (canReplace) choices.push({ value: "overwrite", icon: ICON.replace, title: "Replace the original",
        sub: "Saves over “" + nm + ".docx”. Folio tucks a backup of the old version away, just in case." });
      return ask({ title: "Save your edits", body: "How would you like to keep them?", choices: choices,
        buttons: [{ label: "Cancel", value: null, kind: "ghost" }] }).then(function (v) { return v ? save(v) : false; });
    }
    // Before something would throw unsaved edits away. Resolves true to go ahead.
    function confirmDiscard(what) {
      if (!dirty()) return Promise.resolve(true);
      return ask({
        title: "Keep your edits?",
        body: "You've changed “" + baseName() + "”" + (what ? " and " + what : "") + ". Save your edits first?",
        buttons: [{ label: "Keep editing", value: null, kind: "ghost" }, { label: "Discard edits", value: "discard", kind: "danger" }, { label: "Save…", value: "save", kind: "primary" }]
      }).then(function (v) {
        if (v === "discard") { savedId = undo.length ? undo[undo.length - 1].id : 0; open = null; notify(); return true; }
        if (v === "save") return save("auto").then(function (ok) { return !!ok && !dirty(); });
        return false;
      });
    }

    /* ----- a small modal ----- */
    var modalOpen = false;
    function ask(o) {
      return new Promise(function (resolve) {
        modalOpen = true;
        var scrim = document.createElement("div");
        scrim.className = "sheet-scrim";
        var html = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle"><h2 id="sheetTitle"></h2><p class="sheet-sub"></p>';
        if (o.choices) html += '<div class="choices"></div>';
        html += '<div class="sheet-foot"></div></div>';
        scrim.innerHTML = html;
        scrim.querySelector("h2").textContent = o.title;
        scrim.querySelector(".sheet-sub").textContent = o.body || "";
        var prevFocus = document.activeElement, sel = document.getSelection(), saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        function done(v) {
          modalOpen = false;
          document.removeEventListener("keydown", onKey, true);
          scrim.classList.add("leaving");
          setTimeout(function () { scrim.remove(); }, 160);
          if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
          if (saved && editing) { try { sel.removeAllRanges(); sel.addRange(saved); } catch (e) {} }
          resolve(v);
        }
        (o.choices || []).forEach(function (c) {
          var b = document.createElement("button");
          b.className = "choice";
          b.innerHTML = '<span class="choice-ic">' + c.icon + '</span><span class="choice-txt"><strong></strong><small></small></span>';
          b.querySelector("strong").textContent = c.title;
          if (c.rec) { var r = document.createElement("em"); r.className = "rec"; r.textContent = "Recommended"; b.querySelector("strong").appendChild(r); }
          b.querySelector("small").textContent = c.sub;
          b.onclick = function () { done(c.value); };
          scrim.querySelector(".choices").appendChild(b);
        });
        (o.buttons || []).forEach(function (c) {
          var b = document.createElement("button");
          b.className = "sheet-btn " + (c.kind || "");
          b.textContent = c.label;
          b.onclick = function () { done(c.value); };
          scrim.querySelector(".sheet-foot").appendChild(b);
        });
        scrim.addEventListener("mousedown", function (e) { if (e.target === scrim) done(null); });
        function onKey(e) {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); }
        }
        document.addEventListener("keydown", onKey, true);
        document.body.appendChild(scrim);
        var first = scrim.querySelector(".choice, .sheet-btn.primary, .sheet-btn");
        if (first) first.focus();
      });
    }

    /* ----- desktop: closing the window with unsaved edits ----- */
    if (D && D.onConfirmClose) D.onConfirmClose(function () {
      if (modalOpen) return;
      confirmDiscard("are closing Folio").then(function (go) { if (go && D.closeNow) D.closeNow(); });
    });

    return {
      load: load, attach: attach, toggle: toggle, enter: startEditing, exit: stopEditing, save: save,
      confirmDiscard: confirmDiscard, isDirty: dirty, isEditing: function () { return editing; },
      canEdit: function () { return !!(S && S.model); },
      // for tests
      _debug: function () { return { S: S, states: states, undo: undo, redo: redo, model: S && S.model, buildDocx: buildDocx }; }
    };
  }

  window.FolioEditor = { create: create, _align: align };
})();
