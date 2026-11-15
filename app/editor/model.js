/*
 * Folio document model.
 *
 * Folio shows a .docx through mammoth, which throws away anything it can't
 * display (letterheads, fonts, colours, spacing, section layout...). So edits
 * are never written back from the HTML. Instead this model keeps the original
 * word/document.xml as a live XML DOM and applies each edit to it in place:
 * characters are spliced into the existing <w:t> nodes, runs are split only
 * where formatting changes, and every element Folio doesn't understand is
 * left exactly as it was.
 *
 * Paragraphs are tagged with a temporary folio:pid attribute so the editor can
 * pair each one with the block it rendered. The attribute is stripped on save.
 *
 * Works in the browser and in Node (with @xmldom/xmldom) so it can be tested.
 */
(function (global) {
  "use strict";

  var W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  var A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  var V = "urn:schemas-microsoft-com:vml";
  var MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
  var W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
  var XML_NS = "http://www.w3.org/XML/1998/namespace";
  var FNS = "urn:folio:edit";
  var OBJ = "￼";  // a picture or a note reference
  var WILD = ""; // a w:sym: mammoth draws some glyph, so it matches any character

  // Run property order from the schema (CT_RPr). Word rejects out-of-order children.
  var RPR_ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike",
    "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color",
    "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText",
    "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath"];
  var RPR_INDEX = {};
  RPR_ORDER.forEach(function (n, i) { RPR_INDEX[n] = i; });

  // Things that may sit between two paragraphs without belonging to either.
  var MARKERS = { bookmarkStart: 1, bookmarkEnd: 1, proofErr: 1, permStart: 1, permEnd: 1,
    commentRangeStart: 1, commentRangeEnd: 1, moveFromRangeStart: 1, moveFromRangeEnd: 1,
    moveToRangeStart: 1, moveToRangeEnd: 1, customXmlInsRangeStart: 1, customXmlInsRangeEnd: 1,
    customXmlDelRangeStart: 1, customXmlDelRangeEnd: 1 };

  var FORMAT_TAGS = { b: ["b", "bCs"], i: ["i", "iCs"], u: ["u"], s: ["strike"] };

  /* ---------- small DOM helpers ---------- */
  function isW(n, name) { return !!n && n.nodeType === 1 && n.namespaceURI === W && (!name || n.localName === name); }
  function firstW(el, name) {
    for (var c = el.firstChild; c; c = c.nextSibling) if (isW(c, name)) return c;
    return null;
  }
  function firstNS(el, ns, name) {
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c.namespaceURI === ns && c.localName === name) return c;
    return null;
  }
  function attr(el, name) {
    if (!el.hasAttributeNS(W, name)) return null;
    return el.getAttributeNS(W, name);
  }
  function hasDesc(el, ns, name) { return el.getElementsByTagNameNS(ns, name).length > 0; }
  function ancestor(el, ns, name) {
    for (var n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) if (n.namespaceURI === ns && n.localName === name) return n;
    return null;
  }
  function textOf(t) {
    var s = "";
    for (var c = t.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 || c.nodeType === 4) s += c.data;
    return s;
  }
  function remove(n) { if (n && n.parentNode) n.parentNode.removeChild(n); }
  function insertAfter(n, ref) { ref.parentNode.insertBefore(n, ref.nextSibling); }
  function elementChildren(el) {
    var out = [];
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c);
    return out;
  }
  // A child that is properties, not content.
  function isProps(n) { return isW(n, "rPr") || isW(n, "pPr") || isW(n, "sdtPr") || isW(n, "sdtEndPr"); }
  function hasContentBefore(n) {
    for (var c = n.previousSibling; c; c = c.previousSibling) if (c.nodeType === 1 && !isProps(c)) return true;
    return false;
  }
  function isOn(el) {
    if (!el) return false;
    var v = attr(el, "val");
    return v == null || !/^(0|false|off|none)$/i.test(v);
  }

  /* ---------- the model ---------- */
  function Model(xmlString, opts) {
    opts = opts || {};
    var Parser = opts.DOMParser || global.DOMParser;
    this.Serializer = opts.XMLSerializer || global.XMLSerializer;
    var m = /^\s*(<\?xml[^>]*\?>)/.exec(xmlString);
    this.decl = m ? m[1] : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    var doc = new Parser().parseFromString(xmlString, "application/xml");
    var root = doc.documentElement;
    if (!root || root.getElementsByTagName("parsererror").length || root.localName === "parsererror" || !isW(root, "document")) {
      throw new Error("word/document.xml could not be read");
    }
    this.doc = doc;
    this.P = root.prefix || "w";
    this.body = firstW(root, "body");
    if (!this.body) throw new Error("This document has no body");
    this.styles = null;
    if (opts.stylesXml) {
      try {
        var sd = new Parser().parseFromString(opts.stylesXml, "application/xml");
        if (sd.documentElement && isW(sd.documentElement, "styles")) this.styles = sd;
      } catch (e) { /* styles are only used for niceties */ }
    }
    var ps = doc.getElementsByTagNameNS(W, "p");
    this.byPid = {};
    this.nextPid = 0;
    for (var i = 0; i < ps.length; i++) this._tag(ps[i]);
  }

  Model.prototype._tag = function (p) {
    var pid = String(this.nextPid++);
    p.setAttributeNS(FNS, "folio:pid", pid);
    this.byPid[pid] = p;
    return pid;
  };
  Model.prototype.pidOf = function (p) { return p.getAttributeNS(FNS, "pid") || null; };
  Model.prototype.para = function (pid) {
    var p = this.byPid[pid];
    if (p && p.ownerDocument === this.doc && ancestorIsDoc(p)) return p;
    this.reindex();
    return this.byPid[pid] || null;
  };
  function ancestorIsDoc(n) {
    while (n.parentNode) { n = n.parentNode; if (n.nodeType === 9) return true; }
    return false;
  }
  // After undo swaps nodes in and out, rebuild the pid table.
  Model.prototype.reindex = function () {
    this.byPid = {};
    var ps = this.doc.getElementsByTagNameNS(W, "p");
    for (var i = 0; i < ps.length; i++) {
      var pid = this.pidOf(ps[i]);
      if (pid) this.byPid[pid] = ps[i];
    }
  };

  Model.prototype.el = function (name, val) {
    var e = this.doc.createElementNS(W, this.P + ":" + name);
    if (val != null) e.setAttributeNS(W, this.P + ":val", String(val));
    return e;
  };
  Model.prototype.setText = function (t, s) {
    while (t.firstChild) t.removeChild(t.firstChild);
    if (s) t.appendChild(this.doc.createTextNode(s));
    t.setAttributeNS(XML_NS, "xml:space", "preserve");
  };

  /* Why a paragraph can't be edited, or null if it can. */
  Model.prototype.lockReason = function (pid) {
    var p = this.para(pid);
    if (!p) return "missing";
    if (ancestor(p, W, "txbxContent") || hasDesc(p, W, "txbxContent")) return "textbox";
    var pPr = firstW(p, "pPr"), rPr = pPr && firstW(pPr, "rPr");
    if (rPr && (firstW(rPr, "del") || firstW(rPr, "moveFrom"))) return "tracked";
    return null;
  };
  Model.prototype.hasSection = function (pid) {
    var p = this.para(pid), pPr = p && firstW(p, "pPr");
    return !!(pPr && firstW(pPr, "sectPr"));
  };
  // Where a page break sits, so edit mode can show it: "before", "after" or null.
  Model.prototype.pageBreak = function (pid) {
    var p = this.para(pid);
    if (!p) return null;
    var pPr = firstW(p, "pPr");
    if (pPr && isOn(firstW(pPr, "pageBreakBefore"))) return "before";
    var brs = p.getElementsByTagNameNS(W, "br"), page = null;
    for (var i = 0; i < brs.length; i++) if (attr(brs[i], "type") === "page") { page = brs[i]; break; }
    if (!page) return null;
    var slots = this.textModel(pid).slots, seenText = false, found = false;
    (function walk(n) {
      for (var c = n.firstChild; c && !found; c = c.nextSibling) {
        if (c === page) { found = true; return; }
        for (var k = 0; k < slots.length; k++) if (slots[k].node === c) { seenText = true; break; }
        if (c.nodeType === 1) walk(c);
      }
    })(p);
    return seenText ? "after" : "before";
  };

  /*
   * The paragraph's visible characters, in the order mammoth draws them.
   * Each slot points at the XML node that holds it. Anything mammoth doesn't
   * draw (field codes, deleted text, page breaks, bookmarks) has no slot, so
   * edits can never touch it.
   */
  Model.prototype.textModel = function (pid) {
    var p = this.para(pid), slots = [];
    if (!p) return { text: "", slots: slots };
    function push(c, k, node, run, off) { slots.push({ c: c, k: k, node: node, run: run, off: off || 0 }); }
    function hasImage(el) { return hasDesc(el, A, "blip") || hasDesc(el, V, "imagedata"); }
    function walkRun(r) {
      for (var c = r.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        if (c.namespaceURI === MC && c.localName === "AlternateContent") {
          var fb = firstNS(c, MC, "Fallback");
          if (fb && hasImage(fb)) push(OBJ, "img", c, r);
          continue;
        }
        if (c.namespaceURI !== W) continue;
        switch (c.localName) {
          case "t":
            var s = textOf(c);
            for (var i = 0; i < s.length; i++) push(s.charAt(i), "t", c, r, i);
            break;
          case "tab": push("\t", "tab", c, r); break;
          case "br":
            var ty = attr(c, "type");
            if (!ty || ty === "textWrapping") push("\n", "br", c, r);
            break;
          case "noBreakHyphen": push("‑", "nbh", c, r); break;
          case "softHyphen": push("­", "sh", c, r); break;
          case "sym": push(WILD, "sym", c, r); break;
          case "drawing": case "pict": case "object":
            if (hasImage(c)) push(OBJ, "img", c, r);
            break;
          case "footnoteReference": case "endnoteReference": push(OBJ, "note", c, r); break;
        }
      }
    }
    function walk(el) {
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        if (c.namespaceURI === MC && c.localName === "AlternateContent") {
          var fb = firstNS(c, MC, "Fallback");
          if (fb) walk(fb);
          continue;
        }
        if (c.namespaceURI !== W) continue;
        switch (c.localName) {
          case "r": walkRun(c); break;
          case "hyperlink": case "ins": case "smartTag": walk(c); break;
          case "sdt": var sc = firstW(c, "sdtContent"); if (sc) walk(sc); break;
        }
      }
    }
    walk(p);
    var text = "";
    for (var i = 0; i < slots.length; i++) text += slots[i].c;
    return { text: text, slots: slots };
  };

  /* ---------- deleting ---------- */
  Model.prototype.deleteSlots = function (pid, idxs) {
    var tm = this.textModel(pid), byNode = [], atoms = [], runs = [], self = this;
    idxs.forEach(function (i) {
      var s = tm.slots[i];
      if (!s) return;
      runs.push(s.run);
      if (s.k === "t") {
        var entry = null;
        for (var j = 0; j < byNode.length; j++) if (byNode[j].node === s.node) { entry = byNode[j]; break; }
        if (!entry) { entry = { node: s.node, offs: {} }; byNode.push(entry); }
        entry.offs[s.off] = true;
      } else atoms.push(s.node);
    });
    byNode.forEach(function (e) {
      var str = textOf(e.node), out = "";
      for (var i = 0; i < str.length; i++) if (!e.offs[i]) out += str.charAt(i);
      self.setText(e.node, out);
    });
    atoms.forEach(remove);
    this._tidy(runs);
  };

  // Remove what a deletion emptied: blank w:t, runs with nothing left, empty links.
  Model.prototype._tidy = function (runs) {
    var seen = [];
    runs.forEach(function (r) {
      if (seen.indexOf(r) !== -1) return;
      seen.push(r);
      if (!r.parentNode) return;
      elementChildren(r).forEach(function (c) { if (isW(c, "t") && !textOf(c)) remove(c); });
      var content = elementChildren(r).filter(function (c) { return !isW(c, "rPr"); });
      if (content.length) return;
      var parent = r.parentNode;
      remove(r);
      while (parent && (isW(parent, "hyperlink") || isW(parent, "smartTag") || isW(parent, "ins")) && !elementChildren(parent).length) {
        var up = parent.parentNode;
        remove(parent);
        parent = up;
      }
    });
  };

  /* ---------- inserting ---------- */
  // Turn a string into w:t / w:tab / w:br nodes.
  Model.prototype._content = function (str) {
    var out = [], self = this;
    str.split(/([\t\n])/).forEach(function (part) {
      if (part === "\t") out.push(self.el("tab"));
      else if (part === "\n") out.push(self.el("br"));
      else if (part) { var t = self.el("t"); self.setText(t, part); out.push(t); }
    });
    return out;
  };
  function cleanRPr(rPr) {
    var c = rPr.cloneNode(true);
    elementChildren(c).forEach(function (k) {
      if (isW(k, "ins") || isW(k, "del") || isW(k, "moveFrom") || isW(k, "moveTo") || isW(k, "rPrChange")) remove(k);
    });
    return c;
  }
  Model.prototype._markRPr = function (p) {
    var pPr = firstW(p, "pPr"), rPr = pPr && firstW(pPr, "rPr");
    if (!rPr) return null;
    var c = cleanRPr(rPr);
    // a paragraph mark's rPr is CT_ParaRPr: rename-free, but make it a plain w:rPr
    var r = this.el("rPr");
    while (c.firstChild) r.appendChild(c.firstChild);
    return r;
  };
  // Formatting for new text that can't join an existing run: borrow the nearest text run's.
  Model.prototype._donor = function (p, tm, from, dir) {
    var order = dir < 0 ? [-1, 1] : [1, -1];
    for (var o = 0; o < 2; o++) {
      var step = order[o];
      for (var i = from + step; i >= 0 && i < tm.slots.length; i += step) {
        var s = tm.slots[i];
        if (s.k === "t" || s.k === "tab" || s.k === "br") {
          var rPr = firstW(s.run, "rPr");
          return rPr ? cleanRPr(rPr) : null;
        }
      }
    }
    return this._markRPr(p);
  };
  Model.prototype._newRun = function (rPr, nodes) {
    var r = this.el("r");
    if (rPr) r.appendChild(rPr);
    nodes.forEach(function (n) { r.appendChild(n); });
    return r;
  };
  Model.prototype._splitRun = function (run, node) {
    var r2 = run.cloneNode(false), rPr = firstW(run, "rPr");
    if (rPr) r2.appendChild(rPr.cloneNode(true));
    while (node) { var nx = node.nextSibling; r2.appendChild(node); node = nx; }
    insertAfter(r2, run);
    return r2;
  };
  Model.prototype._splitT = function (t, off) {
    var s = textOf(t), t2 = this.el("t");
    this.setText(t2, s.slice(off));
    this.setText(t, s.slice(0, off));
    insertAfter(t2, t);
    return t2;
  };

  /*
   * Insert text at a position given relative to a visible character:
   *   { after: i } | { before: i } | { end: true }
   * New text joins the run of the character beside it, so it inherits that
   * run's fonts, colours and size, just like typing in Word.
   */
  Model.prototype.insertText = function (pid, pos, str) {
    str = String(str).replace(/\r\n?/g, "\n").replace(/[￼\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    if (!str) return;
    var p = this.para(pid), tm = this.textModel(pid);
    var idx = pos.after != null ? pos.after : pos.before;
    var s = (pos.end || idx == null) ? null : tm.slots[idx];
    if (!s) {
      p.appendChild(this._newRun(this._donor(p, tm, tm.slots.length, -1), this._content(str)));
      return;
    }
    var after = pos.after != null, nodes;
    if (s.k === "t") {
      var off = after ? s.off + 1 : s.off, cur = textOf(s.node);
      if (!/[\t\n]/.test(str)) { this.setText(s.node, cur.slice(0, off) + str + cur.slice(off)); return; }
      var right = off < cur.length ? this._splitT(s.node, off) : null;
      nodes = this._content(str);
      var ref = s.node;
      nodes.forEach(function (n) { insertAfter(n, ref); ref = n; });
      if (right && !textOf(right)) remove(right);
      if (!textOf(s.node)) remove(s.node);
      return;
    }
    nodes = this._content(str);
    if (s.k !== "img" && s.k !== "note") {
      // tabs, breaks, hyphens and symbols live in ordinary text runs
      var anchor = s.node;
      if (after) nodes.forEach(function (n) { insertAfter(n, anchor); anchor = n; });
      else nodes.forEach(function (n) { anchor.parentNode.insertBefore(n, anchor); });
      return;
    }
    // Next to a picture or a footnote mark: a run of its own, styled like the nearby text.
    var run = s.run, rPr = this._donor(p, tm, idx, after ? -1 : 1), nr = this._newRun(rPr, nodes);
    if (after) {
      var nxt = s.node.nextSibling;
      while (nxt && nxt.nodeType !== 1) nxt = nxt.nextSibling;
      if (nxt) this._splitRun(run, nxt);
      insertAfter(nr, run);
    } else {
      if (hasContentBefore(s.node)) run = this._splitRun(run, s.node);
      run.parentNode.insertBefore(nr, run);
    }
  };

  /* ---------- formatting ---------- */
  // Split runs so that slot i starts a run.
  Model.prototype._splitBefore = function (pid, i) {
    var tm = this.textModel(pid), s = tm.slots[i];
    if (!s) return;
    var node = s.node;
    if (s.k === "t" && s.off > 0) node = this._splitT(s.node, s.off);
    if (hasContentBefore(node)) this._splitRun(s.run, node);
  };
  Model.prototype._setProp = function (run, prop, on) {
    var rPr = firstW(run, "rPr");
    if (!rPr) { rPr = this.el("rPr"); run.insertBefore(rPr, run.firstChild); }
    var names = FORMAT_TAGS[prop];
    elementChildren(rPr).forEach(function (c) { if (c.namespaceURI === W && names.indexOf(c.localName) !== -1) remove(c); });
    var self = this;
    names.forEach(function (n) {
      var e = prop === "u" ? self.el("u", on ? "single" : "none") : self.el(n, on ? null : "0");
      var at = RPR_INDEX[n], before = null;
      for (var c = rPr.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        var ci = c.namespaceURI === W && RPR_INDEX[c.localName] != null ? RPR_INDEX[c.localName] : 999;
        if (ci > at) { before = c; break; }
      }
      rPr.insertBefore(e, before);
    });
  };
  // Make slots [i, j) bold / italic / underlined / struck through (or not).
  Model.prototype.setFormat = function (pid, i, j, prop, on) {
    if (!FORMAT_TAGS[prop] || j <= i) return;
    this._splitBefore(pid, i);
    this._splitBefore(pid, j);
    var tm = this.textModel(pid), runs = [];
    for (var k = i; k < j && k < tm.slots.length; k++) if (runs.indexOf(tm.slots[k].run) === -1) runs.push(tm.slots[k].run);
    var self = this;
    runs.forEach(function (r) { self._setProp(r, prop, on); });
  };

  /* ---------- paragraphs ---------- */
  Model.prototype._shell = function (p) {
    var np = p.cloneNode(false);
    if (np.hasAttributeNS(W14, "paraId")) np.removeAttributeNS(W14, "paraId");
    if (np.hasAttributeNS(W14, "textId")) np.removeAttributeNS(W14, "textId");
    np.removeAttributeNS(FNS, "pid");
    var pPr = firstW(p, "pPr");
    if (pPr) {
      var c = pPr.cloneNode(true);
      elementChildren(c).forEach(function (k) { if (isW(k, "pPrChange") || isW(k, "sectPr")) remove(k); });
      var rPr = firstW(c, "rPr");
      if (rPr) elementChildren(rPr).forEach(function (k) {
        if (isW(k, "ins") || isW(k, "del") || isW(k, "moveFrom") || isW(k, "moveTo") || isW(k, "rPrChange")) remove(k);
      });
      np.appendChild(c);
    }
    return np;
  };
  // A section break lives in the paragraph that ends the section, so it follows the last piece.
  Model.prototype._moveSection = function (from, to) {
    var pPr = firstW(from, "pPr"), sp = pPr && firstW(pPr, "sectPr");
    if (!sp) return;
    var tp = firstW(to, "pPr");
    if (!tp) { tp = this.el("pPr"); to.insertBefore(tp, to.firstChild); }
    var change = firstW(tp, "pPrChange");
    tp.insertBefore(sp, change);
  };
  Model.prototype._cloneShellOf = function (n) {
    var c = n.cloneNode(false);
    if (isW(n, "r")) { var rPr = firstW(n, "rPr"); if (rPr) c.appendChild(rPr.cloneNode(true)); }
    if (isW(n, "sdt")) {
      var sp = firstW(n, "sdtPr");
      if (sp) { var spc = sp.cloneNode(true), id = firstW(spc, "id"); if (id) remove(id); c.appendChild(spc); }
    }
    return c;
  };

  /*
   * Split a paragraph in two (the Enter key). pos is "start", "end",
   * { after: i } or { before: i }. Returns the new paragraph's pid, which is
   * the first half for "start" and the second half otherwise.
   */
  Model.prototype.split = function (pid, pos, opts) {
    opts = opts || {};
    var p = this.para(pid), np = this._shell(p);
    if (pos === "start") {
      p.parentNode.insertBefore(np, p);
      return this._tag(np);
    }
    this._moveSection(p, np);
    if (pos === "end" && opts.nextStyle) this._setStyle(np, opts.nextStyle);
    insertAfter(np, p);
    if (pos !== "end") {
      var tm = this.textModel(pid), after = pos.after != null, s = tm.slots[after ? pos.after : pos.before];
      if (s) {
        var P = s.run, X;
        if (after) X = (s.k === "t" && s.off < textOf(s.node).length - 1) ? this._splitT(s.node, s.off + 1) : s.node.nextSibling;
        else X = (s.k === "t" && s.off > 0) ? this._splitT(s.node, s.off) : s.node;
        while (P !== p) {
          if (!X) { X = P.nextSibling; P = P.parentNode; continue; }
          if (!hasContentBefore(X)) { X = P; P = P.parentNode; continue; }
          var P2 = this._cloneShellOf(P);
          while (X) { var nx = X.nextSibling; P2.appendChild(X); X = nx; }
          insertAfter(P2, P);
          X = P2; P = P.parentNode;
        }
        while (X) { var n2 = X.nextSibling; np.appendChild(X); X = n2; }
        this._tidy(elementChildren(p).concat(elementChildren(np)).filter(function (n) { return isW(n, "r"); }));
      }
    }
    return this._tag(np);
  };

  // Paragraphs can join only when nothing but bookmarks and the like sits between them.
  Model.prototype.canMerge = function (pidA, pidB) {
    var a = this.para(pidA), b = this.para(pidB);
    if (!a || !b || a === b) return "missing";
    if (a.parentNode !== b.parentNode) return "structure";
    for (var n = a.nextSibling; n !== b; n = n.nextSibling) {
      if (!n) return "structure";
      if (n.nodeType === 1 && !(n.namespaceURI === W && MARKERS[n.localName])) return "structure";
    }
    if (this.hasSection(pidA) || this.hasSection(pidB)) return "section";
    return null;
  };
  // Join paragraph B onto the end of A (Backspace at the start of B).
  Model.prototype.merge = function (pidA, pidB) {
    var why = this.canMerge(pidA, pidB);
    if (why) return why;
    var a = this.para(pidA), b = this.para(pidB);
    elementChildren(b).forEach(function (c) { if (!isW(c, "pPr")) a.appendChild(c); });
    remove(b);
    delete this.byPid[pidB];
    return null;
  };
  Model.prototype.removePara = function (pid) {
    if (this.hasSection(pid)) return "section";
    var p = this.para(pid);
    if (!p) return "missing";
    remove(p);
    delete this.byPid[pid];
    return null;
  };

  /* ---------- styles ---------- */
  Model.prototype._style = function (id) {
    if (!this.styles || !id) return null;
    var all = this.styles.getElementsByTagNameNS(W, "style");
    for (var i = 0; i < all.length; i++) if (attr(all[i], "styleId") === id) return all[i];
    return null;
  };
  Model.prototype._defaultParaStyle = function () {
    if (!this.styles) return null;
    var all = this.styles.getElementsByTagNameNS(W, "style");
    for (var i = 0; i < all.length; i++) {
      var def = attr(all[i], "default");
      if (attr(all[i], "type") === "paragraph" && def != null && /^(1|true|on)$/i.test(def)) return attr(all[i], "styleId");
    }
    return null;
  };
  Model.prototype.styleOf = function (pid) {
    var p = this.para(pid), pPr = p && firstW(p, "pPr"), ps = pPr && firstW(pPr, "pStyle");
    return ps ? attr(ps, "val") : this._defaultParaStyle();
  };
  // Word's "style for following paragraph": Enter at the end of a heading gives body text.
  Model.prototype.nextStyleFor = function (pid) {
    var id = this.styleOf(pid), st = this._style(id), nx = st && firstW(st, "next");
    var next = nx && attr(nx, "val");
    return next && next !== id ? next : null;
  };
  Model.prototype._setStyle = function (p, id) {
    var pPr = firstW(p, "pPr");
    if (!pPr) { pPr = this.el("pPr"); p.insertBefore(pPr, p.firstChild); }
    var ps = firstW(pPr, "pStyle");
    if (id === this._defaultParaStyle()) { if (ps) remove(ps); return; }
    if (!ps) { ps = this.el("pStyle"); pPr.insertBefore(ps, pPr.firstChild); }
    ps.setAttributeNS(W, this.P + ":val", id);
  };
  Model.prototype._styleNumbered = function (id) {
    for (var guard = 0; id && guard < 12; guard++) {
      var st = this._style(id);
      if (!st) return false;
      var pPr = firstW(st, "pPr");
      if (pPr && firstW(pPr, "numPr")) return true;
      var b = firstW(st, "basedOn");
      id = b && attr(b, "val");
    }
    return false;
  };
  // Enter on an empty list item: leave the list, like Word does.
  Model.prototype.leaveList = function (pid) {
    var p = this.para(pid), pPr = p && firstW(p, "pPr");
    if (!pPr) return;
    var np = firstW(pPr, "numPr");
    if (np) remove(np);
    var ps = firstW(pPr, "pStyle"), id = ps && attr(ps, "val");
    if (id && (this._styleNumbered(id) || /^list/i.test(id))) remove(ps);
    if (this._styleNumbered(this.styleOf(pid))) {
      var n = this.el("numPr"), numId = this.el("numId", 0);
      n.appendChild(numId);
      var after = firstW(pPr, "pStyle") || firstW(pPr, "keepNext") || null;
      pPr.insertBefore(n, after ? after.nextSibling : pPr.firstChild);
    }
  };

  /* ---------- output ---------- */
  Model.prototype._cleanClone = function () {
    var c = this.doc.cloneNode(true);
    var ps = c.getElementsByTagNameNS(W, "p");
    for (var i = 0; i < ps.length; i++) if (ps[i].hasAttributeNS(FNS, "pid")) ps[i].removeAttributeNS(FNS, "pid");
    return c;
  };
  Model.prototype.serialize = function () {
    var s = new this.Serializer().serializeToString(this._cleanClone());
    if (!/^\s*<\?xml/.test(s)) s = this.decl + (/^\r?\n/.test(s) ? "" : "\r\n") + s;
    return s;
  };
  // The copy mammoth renders: each paragraph starts with a bookmark named after its pid,
  // which mammoth turns into <a id="_folio_N">, so every block can be matched to its paragraph.
  Model.prototype.forRendering = function () {
    var c = this.doc.cloneNode(true), ps = c.getElementsByTagNameNS(W, "p"), list = [];
    for (var i = 0; i < ps.length; i++) list.push(ps[i]);
    var P = this.P;
    list.forEach(function (p) {
      var pid = p.getAttributeNS(FNS, "pid");
      p.removeAttributeNS(FNS, "pid");
      if (!pid) return;
      var b = c.createElementNS(W, P + ":bookmarkStart");
      b.setAttributeNS(W, P + ":id", String(2000000000 + +pid));
      b.setAttributeNS(W, P + ":name", "_folio_" + pid);
      var pPr = firstW(p, "pPr");
      p.insertBefore(b, pPr ? pPr.nextSibling : p.firstChild);
    });
    var s = new this.Serializer().serializeToString(c);
    if (!/^\s*<\?xml/.test(s)) s = this.decl + s;
    return s;
  };
  // Counts used to check a saved file kept everything it should.
  Model.prototype.census = function (doc) {
    doc = doc || this.doc;
    var out = {};
    [["p", W], ["tbl", W], ["sectPr", W], ["drawing", W], ["pict", W], ["footnoteReference", W], ["endnoteReference", W],
      ["bookmarkStart", W], ["hyperlink", W], ["txbxContent", W], ["fldChar", W], ["instrText", W], ["del", W], ["ins", W],
      ["AlternateContent", MC], ["headerReference", W], ["footerReference", W]].forEach(function (k) {
      out[k[0]] = doc.getElementsByTagNameNS(k[1], k[0]).length;
    });
    return out;
  };
  // Region helpers for undo: a run of siblings under one parent that covers some paragraphs.
  Model.prototype.region = function (pids) {
    var self = this, nodes = pids.map(function (id) { return self.para(id); }).filter(Boolean);
    if (!nodes.length) return null;
    var chains = nodes.map(function (n) { var c = []; for (var x = n; x; x = x.parentNode) c.unshift(x); return c; });
    var depth = 0;
    while (chains.every(function (c) { return c[depth + 1] && c[depth + 1] === chains[0][depth + 1]; })) depth++;
    var parent = chains[0][depth];
    // the LCA must contain the nodes, not be one of them
    if (nodes.indexOf(parent) !== -1) { parent = parent.parentNode; depth--; }
    var kids = Array.prototype.slice.call(parent.childNodes), lo = Infinity, hi = -1;
    chains.forEach(function (c) { var i = kids.indexOf(c[depth + 1]); lo = Math.min(lo, i); hi = Math.max(hi, i); });
    return { parent: parent, start: lo, len: hi - lo + 1, count: kids.length };
  };

  var api = { Model: Model, W: W, OBJ: OBJ, WILD: WILD, FNS: FNS };
  global.FolioModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
