// Folio's page recolouring for PDFs.
//
// pdf.js paints each page as if on white paper. To show it "in my mood", every pixel is
// re-mapped: how much ink a pixel has (1 - its luminance) picks a point between the
// mood's paper colour and ink colour, and the pixel's own colour (its chroma) is added
// back on top. So black text becomes the mood's ink, white paper becomes the mood's page,
// and red text stays red (just lighter on dark pages) instead of turning grey.
//
// Photos would look wrong with their lightness flipped, so the areas where the PDF draws
// images are left as they are (slightly dimmed on dark pages). Images that are really
// "paper" (scanned pages, black-and-white diagrams) are recoloured like everything else.

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
  if (!m) return [255, 255, 255];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

export function makePalette(pageHex, inkHex) {
  const paper = hexToRgb(pageHex), ink = hexToRgb(inkHex);
  const lum = (c) => (c[0] * 54 + c[1] * 183 + c[2] * 19) / 256;
  const dark = lum(paper) < lum(ink);
  // Lookup tables: amount of ink (0..255) -> channel value.
  const lut = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
  for (let t0 = 0; t0 < 256; t0++) {
    // Off-white paper (scans, cream pages) counts as paper: the first few steps of ink are dropped.
    const t = Math.max(0, Math.round((t0 - 14) * 255 / 241));
    // A gentle curve on dark pages keeps thin grey text readable without glare.
    const k = dark ? Math.pow(t / 255, 0.9) : t / 255;
    for (let c = 0; c < 3; c++) lut[c][t0] = paper[c] + (ink[c] - paper[c]) * k;
  }
  return {
    paper, ink, dark, lut,
    chroma: dark ? 0.92 : 1,      // how much of each pixel's own colour survives
    photoDim: dark ? 0.86 : 1     // photos on dark pages are dimmed a little
  };
}

// Is this image region more like paper (a scan, a line drawing) than a photo?
export function looksLikePaper(data, width, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return false;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000)));
  let n = 0, light = 0, chromaSum = 0, dark = 0;
  for (let y = y0; y < y1; y += step) {
    let i = (y * width + x0) * 4;
    for (let x = x0; x < x1; x += step, i += step * 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const y8 = (r * 54 + g * 183 + b * 19) >> 8;
      chromaSum += max - min;
      if (y8 > 200) light++;
      else if (y8 < 90) dark++;
      n++;
    }
  }
  if (!n) return false;
  const chroma = chromaSum / n, lightFrac = light / n, midFrac = 1 - (light + dark) / n;
  // Mostly-white, low-colour, few mid tones: paper with ink on it.
  return chroma < 22 && lightFrac > 0.5 && midFrac < 0.3;
}

/**
 * Recolour an ImageData in place.
 * keep: array of [x0, y0, x1, y1] pixel boxes to leave as-is (photos).
 */
export function recolor(img, pal, keep) {
  const d = img.data, W = img.width, H = img.height;
  let mask = null;
  if (keep && keep.length) {
    mask = new Uint8Array(W * H);
    for (const [x0, y0, x1, y1] of keep) {
      for (let y = y0; y < y1; y++) mask.fill(1, y * W + x0, y * W + x1);
    }
  }
  const L0 = pal.lut[0], L1 = pal.lut[1], L2 = pal.lut[2];
  const k = pal.chroma, dim = pal.photoDim;
  for (let p = 0, i = 0, n = W * H; p < n; p++, i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (mask && mask[p]) {
      if (dim !== 1) { d[i] = r * dim; d[i + 1] = g * dim; d[i + 2] = b * dim; }
      continue;
    }
    const y = (r * 54 + g * 183 + b * 19) >> 8;
    const t = 255 - y;
    if (r === g && g === b) {
      d[i] = L0[t]; d[i + 1] = L1[t]; d[i + 2] = L2[t];
    } else {
      d[i] = L0[t] + (r - y) * k;
      d[i + 1] = L1[t] + (g - y) * k;
      d[i + 2] = L2[t] + (b - y) * k;
    }
  }
  return img;
}

// ---- Finding where a page draws images, from pdf.js's operator list ----

function mul(m, t) {
  return [
    m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5]
  ];
}
function unitBox(m) {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Boxes (in PDF user space) of every image the page paints. */
export function imageBoxes(opList, OPS) {
  const { fnArray, argsArray } = opList;
  const stack = [];
  let m = [1, 0, 0, 1, 0, 0];
  const out = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push(m); break;
      case OPS.restore: m = stack.pop() || m; break;
      case OPS.transform: m = mul(m, a); break;
      case OPS.paintFormXObjectBegin:
        stack.push(m);
        if (Array.isArray(a[0]) && a[0].length === 6) m = mul(m, a[0]);
        break;
      case OPS.beginGroup:
        stack.push(m);
        if (a[0] && Array.isArray(a[0].matrix) && a[0].matrix.length === 6) m = mul(m, a[0].matrix);
        break;
      case OPS.beginAnnotation:
        stack.push(m);
        if (Array.isArray(a[2])) m = mul(m, a[2]);
        if (Array.isArray(a[3])) m = mul(m, a[3]);
        break;
      case OPS.paintFormXObjectEnd: case OPS.endGroup: case OPS.endAnnotation:
        m = stack.pop() || m; break;
      case OPS.paintImageXObject: case OPS.paintInlineImageXObject:
        out.push(unitBox(m)); break;
      case OPS.paintImageXObjectRepeat: {
        const sx = a[1], sy = a[2], pos = a[3] || [];
        for (let j = 0; j + 1 < pos.length; j += 2) out.push(unitBox(mul(m, [sx, 0, 0, sy, pos[j], pos[j + 1]])));
        break;
      }
      case OPS.paintInlineImageXObjectGroup: {
        for (const e of (a[1] || [])) if (e && e.transform) out.push(unitBox(mul(m, e.transform)));
        break;
      }
    }
  }
  return out;
}

/** Convert user-space boxes to clipped integer pixel boxes on a canvas. */
export function toPixelBoxes(boxes, vpTransform, W, H) {
  const res = [];
  for (const b of boxes) {
    const pb = unitBox(mul(vpTransform, [b[2] - b[0], 0, 0, b[3] - b[1], b[0], b[1]]));
    // Round inwards, so the paper-coloured anti-aliased rim still gets recoloured.
    const x0 = Math.max(0, Math.ceil(pb[0] + 0.5)), y0 = Math.max(0, Math.ceil(pb[1] + 0.5));
    const x1 = Math.min(W, Math.floor(pb[2] - 0.5)), y1 = Math.min(H, Math.floor(pb[3] - 0.5));
    if (x1 - x0 >= 2 && y1 - y0 >= 2) res.push([x0, y0, x1, y1]);
  }
  return res;
}
