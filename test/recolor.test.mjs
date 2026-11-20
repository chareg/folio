// Unit tests for the PDF page recolouring. Run: node test/recolor.test.mjs
import assert from "node:assert/strict";
import { makePalette, recolor, toPixelBoxes, looksLikePaper } from "../app/pdf/recolor.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok  " + name); };
const img = (pixels) => ({ width: pixels.length, height: 1, data: new Uint8ClampedArray(pixels.flat().map((v, i) => v)) });
const px = (im, i) => Array.from(im.data.slice(i * 4, i * 4 + 3));
const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

const night = makePalette("#201c29", "#e3dde9");
test("night: white paper becomes the plum page", () => {
  const im = img([[255, 255, 255, 255]]); recolor(im, night, []);
  assert.ok(near(px(im, 0), [0x20, 0x1c, 0x29]), px(im, 0));
});
test("night: off-white (scanned) paper also becomes the page", () => {
  const im = img([[247, 245, 240, 255]]); recolor(im, night, []);
  assert.ok(near(px(im, 0), [0x20, 0x1c, 0x29], 6), px(im, 0));
});
test("night: black text becomes lavender ink", () => {
  const im = img([[0, 0, 0, 255]]); recolor(im, night, []);
  assert.ok(near(px(im, 0), [0xe3, 0xdd, 0xe9]), px(im, 0));
});
test("night: red text stays red, not grey", () => {
  const im = img([[200, 30, 40, 255]]); recolor(im, night, []);
  const [r, g, b] = px(im, 0);
  assert.ok(r > g + 60 && r > b + 60, [r, g, b]);
});
test("night: photos inside kept boxes keep their colours (a little dimmer)", () => {
  const im = img([[255, 255, 255, 255], [40, 160, 80, 255]]); recolor(im, night, [[1, 0, 2, 1]]);
  assert.ok(near(px(im, 0), [0x20, 0x1c, 0x29]));
  assert.ok(near(px(im, 1), [34, 138, 69]), px(im, 1));
});
test("paper: white stays white and black becomes Folio's ink", () => {
  const paper = makePalette("#ffffff", "#1d1a26");
  const im = img([[255, 255, 255, 255], [0, 0, 0, 255]]); recolor(im, paper, []);
  assert.ok(near(px(im, 0), [255, 255, 255])); assert.ok(near(px(im, 1), [0x1d, 0x1a, 0x26]));
});
test("image boxes map to canvas pixels, rounded inwards", () => {
  // a 100x50 user-space box at (10,20) on a page drawn at 2x with y flipped (height 400)
  const boxes = toPixelBoxes([[10, 20, 110, 70]], [2, 0, 0, -2, 0, 400], 300, 400);
  assert.deepEqual(boxes, [[21, 261, 219, 359]]);
});
test("a black-and-white diagram counts as paper; a photo does not", () => {
  const W = 40, H = 40, d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const ink = i % W === 5 || (i / W | 0) === 5; d.set(ink ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4); }
  assert.equal(looksLikePaper(d, W, 0, 0, W, H), true);
  for (let i = 0; i < W * H; i++) d.set([(i * 7) % 255, 120, 200 - (i % 150), 255], i * 4);
  assert.equal(looksLikePaper(d, W, 0, 0, W, H), false);
});
console.log("recolor: " + passed + " tests passed");
