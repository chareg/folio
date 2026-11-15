// Unit tests for app/editor/model.js. Run: node test/model.test.js
// Needs @xmldom/xmldom and jszip (npm install --no-save @xmldom/xmldom jszip).
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const JSZip = require("jszip");
const { Model } = require("../app/editor/model.js");

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS = `xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"`;
const mk = (body, styles) => new Model(
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`,
  { DOMParser, XMLSerializer, stylesXml: styles });
const out = (m) => m.serialize().replace(/^<\?xml[^>]*\?>\s*/, "").replace(/ xmlns:\w+="[^"]*"/g, "")
  .replace(/^<w:document><w:body>/, "").replace(/<w:sectPr\/><\/w:body><\/w:document>$/, "");
const text = (m, pid) => m.textModel(pid).text;

let n = 0;
function test(name, fn) {
  try { fn(); n++; } catch (e) { console.error("FAIL", name); throw e; }
}

test("text model mirrors what mammoth shows", () => {
  const m = mk(`<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>Hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>world</w:t><w:tab/><w:t>x</w:t><w:br/><w:br w:type="page"/></w:r>`
    + `<w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins><w:r><w:t>new</w:t></w:r></w:ins>`
    + `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
    + `<w:fldSimple w:instr="PAGE"><w:r><w:t>9</w:t></w:r></w:fldSimple><w:hyperlink><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>`);
  assert.strictEqual(text(m, "0"), "Hello world\tx\nnew7link");
});

test("typing splices into the existing run and keeps its formatting", () => {
  const m = mk(`<w:p><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>Hello</w:t></w:r></w:p>`);
  m.insertText("0", { after: 4 }, " there");
  assert.strictEqual(out(m), `<w:p><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t xml:space="preserve">Hello there</w:t></w:r></w:p>`);
  m.insertText("0", { before: 0 }, "Oh ");
  assert.strictEqual(text(m, "0"), "Oh Hello there");
});

test("deleting across runs removes emptied runs only", () => {
  const m = mk(`<w:p><w:r><w:t>ab</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>cd</w:t></w:r><w:bookmarkStart w:id="1" w:name="x"/><w:r><w:t>ef</w:t></w:r></w:p>`);
  m.deleteSlots("0", [1, 2, 3, 4]);
  assert.strictEqual(out(m), `<w:p><w:r><w:t xml:space="preserve">a</w:t></w:r><w:bookmarkStart w:id="1" w:name="x"/><w:r><w:t xml:space="preserve">f</w:t></w:r></w:p>`);
});

test("tabs and line breaks become real elements", () => {
  const m = mk(`<w:p><w:r><w:t>ab</w:t></w:r></w:p>`);
  m.insertText("0", { after: 0 }, "1\t2\n3");
  assert.strictEqual(text(m, "0"), "a1\t2\n3b");
  assert.ok(/<w:tab\/>/.test(out(m)) && /<w:br\/>/.test(out(m)));
});

test("formatting splits runs and writes properties in schema order", () => {
  const m = mk(`<w:p><w:r><w:rPr><w:rFonts w:ascii="Georgia"/><w:color w:val="00FF00"/></w:rPr><w:t>abcdef</w:t></w:r></w:p>`);
  m.setFormat("0", 2, 4, "b", true);
  const x = out(m);
  assert.strictEqual(x, `<w:p><w:r><w:rPr><w:rFonts w:ascii="Georgia"/><w:color w:val="00FF00"/></w:rPr><w:t xml:space="preserve">ab</w:t></w:r>`
    + `<w:r><w:rPr><w:rFonts w:ascii="Georgia"/><w:b/><w:bCs/><w:color w:val="00FF00"/></w:rPr><w:t xml:space="preserve">cd</w:t></w:r>`
    + `<w:r><w:rPr><w:rFonts w:ascii="Georgia"/><w:color w:val="00FF00"/></w:rPr><w:t xml:space="preserve">ef</w:t></w:r></w:p>`);
  m.setFormat("0", 0, 6, "u", false);
  assert.ok(/<w:color w:val="00FF00"\/><w:u w:val="none"\/>/.test(out(m)));
  m.setFormat("0", 2, 3, "b", false);
  assert.ok(/<w:b w:val="0"\/><w:bCs w:val="0"\/>/.test(out(m)));
});

test("splitting a paragraph keeps pPr, moves the section break to the second half", () => {
  const m = mk(`<w:p w14:paraId="1234ABCD"><w:pPr><w:jc w:val="center"/><w:sectPr><w:pgSz w:w="1"/></w:sectPr></w:pPr><w:hyperlink w:anchor="a"><w:r><w:rPr><w:i/></w:rPr><w:t>linktext</w:t></w:r></w:hyperlink><w:r><w:t> tail</w:t></w:r></w:p>`);
  const np = m.split("0", { after: 3 });
  assert.strictEqual(text(m, "0"), "link");
  assert.strictEqual(text(m, np), "text tail");
  const x = out(m);
  assert.strictEqual((x.match(/<w:sectPr>/g) || []).length, 1);
  assert.ok(x.indexOf("<w:sectPr>") > x.indexOf(">link</w:t>"), "section break follows the second half");
  assert.strictEqual((x.match(/w14:paraId/g) || []).length, 1, "paraId is not duplicated");
  assert.strictEqual((x.match(/<w:hyperlink w:anchor="a">/g) || []).length, 2);
  assert.strictEqual((x.match(/<w:jc w:val="center"\/>/g) || []).length, 2);
});

test("split at start and end, then merge back", () => {
  const m = mk(`<w:p><w:r><w:t>one</w:t></w:r></w:p><w:p><w:r><w:t>two</w:t></w:r></w:p>`);
  const before = out(m);
  const a = m.split("0", "end");
  m.insertText(a, { end: true }, "mid");
  assert.deepStrictEqual([text(m, "0"), text(m, a), text(m, "1")], ["one", "mid", "two"]);
  assert.strictEqual(m.merge("0", a), null);
  m.deleteSlots("0", [3, 4, 5]);
  assert.strictEqual(out(m), before, "back to byte-identical");
  const s = m.split("1", "start");
  assert.strictEqual(text(m, s), "");
  assert.strictEqual(text(m, "1"), "two");
});

test("merge refuses across tables and section breaks", () => {
  const m = mk(`<w:p><w:r><w:t>a</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>b</w:t></w:r></w:p><w:p><w:r><w:t>z</w:t></w:r></w:p>`);
  assert.strictEqual(m.canMerge("0", "1"), "structure");
  assert.strictEqual(m.canMerge("0", "2"), "structure");
  assert.strictEqual(m.canMerge("2", "3"), "section");
});

test("text next to a footnote mark gets the text's formatting, not the mark's", () => {
  const m = mk(`<w:p><w:r><w:rPr><w:sz w:val="30"/></w:rPr><w:t>Word</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>`);
  m.insertText("0", { after: 4 }, " more");
  assert.strictEqual(text(m, "0"), "Word￼ more");
  assert.ok(/<w:footnoteReference w:id="1"\/><\/w:r><w:r><w:rPr><w:sz w:val="30"\/><\/w:rPr><w:t xml:space="preserve"> more<\/w:t>/.test(out(m)));
});

test("empty paragraph borrows the paragraph mark's formatting", () => {
  const m = mk(`<w:p><w:pPr><w:rPr><w:ins w:id="1" w:author="a"/><w:color w:val="123456"/></w:rPr></w:pPr></w:p>`);
  m.insertText("0", { end: true }, "Hi");
  assert.ok(/<w:r><w:rPr><w:color w:val="123456"\/><\/w:rPr><w:t xml:space="preserve">Hi<\/w:t><\/w:r>/.test(out(m)), out(m));
});

test("next style and leaving a list use styles.xml", () => {
  const styles = `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"/><w:style w:type="paragraph" w:styleId="Heading1"><w:next w:val="Normal"/></w:style>`
    + `<w:style w:type="paragraph" w:styleId="ListBullet"><w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr></w:style></w:styles>`;
  const m = mk(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr></w:p>`, styles);
  assert.strictEqual(m.nextStyleFor("0"), "Normal");
  const np = m.split("0", "end", { nextStyle: "Normal" });
  assert.ok(!/pStyle/.test(new XMLSerializer().serializeToString(m.para(np))));
  m.leaveList("1");
  assert.ok(!/ListBullet/.test(out(m)));
});

test("locks text boxes and deleted paragraph marks", () => {
  const m = mk(`<w:p><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>box</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p><w:p><w:pPr><w:rPr><w:del w:id="1" w:author="a"/></w:rPr></w:pPr></w:p><w:p/>`);
  assert.strictEqual(m.lockReason("0"), "textbox");
  assert.strictEqual(m.lockReason("1"), "textbox");
  assert.strictEqual(m.lockReason("2"), "tracked");
  assert.strictEqual(m.lockReason("3"), null);
});

test("serialize strips pids and keeps the declaration", () => {
  const m = mk(`<w:p><w:r><w:t>a</w:t></w:r></w:p>`);
  const s = m.serialize();
  assert.ok(s.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'));
  assert.ok(!/folio/.test(s));
  assert.ok(/_folio_0/.test(m.forRendering()));
});

(async () => {
  // Every fixture: untouched serialize round-trips to an equivalent document.
  for (const f of ["test/fixtures/kitchen-sink.docx", "tools/sample.docx"]) {
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(__dirname, "..", f)));
    const xml = await zip.file("word/document.xml").async("string");
    const m = new Model(xml, { DOMParser, XMLSerializer });
    const again = new Model(m.serialize(), { DOMParser, XMLSerializer });
    assert.deepStrictEqual(again.census(), m.census());
    for (const pid in m.byPid) assert.strictEqual(again.textModel(pid).text, m.textModel(pid).text);
    n++;
  }
  console.log(`model: ${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
