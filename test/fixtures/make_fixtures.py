"""Builds test/fixtures/kitchen-sink.docx: a document packed with the things an
editor must never break. Run from the repo root: python3 test/fixtures/make_fixtures.py
"""
import copy, os
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_BREAK
from docx.oxml.ns import qn
from lxml import etree

HERE = os.path.dirname(os.path.abspath(__file__))
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def xml(s):
    return etree.fromstring(
        '<root xmlns:w="%s" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">%s</root>' % (W, s)
    )[0]


d = Document()

# Letterhead in the header: a logo and coloured text Folio never shows.
sec = d.sections[0]
hp = sec.header.paragraphs[0]
hp.add_run().add_picture(os.path.join(HERE, "green.png"), width=Inches(2))
hr = hp.add_run("  Acme Health · Letterhead")
hr.font.color.rgb = RGBColor(0x2B, 0x6A, 0x55)
hr.font.name = "Georgia"
fp = sec.footer.paragraphs[0]
fp.add_run("Page ")
fp._p.append(xml('<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>'))

d.add_paragraph("Kitchen Sink", style="Title")
d.add_paragraph("Everything an editor must keep safe", style="Subtitle")

p = d.add_paragraph()
r = p.add_run("Bold start. ")
r.bold = True
p.add_run("Plain middle with ")
r = p.add_run("italic")
r.italic = True
p.add_run(" and ")
r = p.add_run("red Comic text")
r.font.color.rgb = RGBColor(0xC0, 0x10, 0x10)
r.font.name = "Comic Sans MS"
r.font.size = Pt(15)
p.add_run(" then the end.")

d.add_heading("Links and fields", 1)
p = d.add_paragraph("Visit ")
# a real w:hyperlink
part = d.part
rid = part.relate_to("https://example.com/", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)
p._p.append(xml('<w:hyperlink r:id="%s"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>our website</w:t></w:r></w:hyperlink>' % rid))
p.add_run(" or read page ")
# a complex PAGE field
p._p.append(xml('<w:r><w:fldChar w:fldCharType="begin"/></w:r>'))
p._p.append(xml('<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'))
p._p.append(xml('<w:r><w:fldChar w:fldCharType="separate"/></w:r>'))
p._p.append(xml('<w:r><w:t>7</w:t></w:r>'))
p._p.append(xml('<w:r><w:fldChar w:fldCharType="end"/></w:r>'))
p.add_run(" for more.")

p = d.add_paragraph()
p._p.append(xml('<w:bookmarkStart w:id="77" w:name="keep_me"/>'))
p.add_run("Bookmarked words stay put.")
p._p.append(xml('<w:bookmarkEnd w:id="77"/>'))

p = d.add_paragraph("Tabs\there and a line")
p.runs[0].add_break()
p.add_run("break inside one paragraph.")

p = d.add_paragraph("A sentence with a footnote")
p._p.append(xml('<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>'))
p.add_run(" and text after it.")

p = d.add_paragraph("Tracked ")
p._p.append(xml('<w:ins w:id="90" w:author="Ann" w:date="2024-01-01T00:00:00Z"><w:r><w:t xml:space="preserve">inserted </w:t></w:r></w:ins>'))
p._p.append(xml('<w:del w:id="91" w:author="Ann" w:date="2024-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">deleted </w:delText></w:r></w:del>'))
p.add_run("changes.")

d.add_heading("Lists", 1)
for t in ["First bullet", "Second bullet", "Third bullet"]:
    d.add_paragraph(t, style="List Bullet")
for t in ["Step one", "Step two"]:
    d.add_paragraph(t, style="List Number")

d.add_paragraph("")  # an empty paragraph
d.add_heading("A table", 2)
t = d.add_table(rows=3, cols=3)
t.style = "Table Grid"
vals = [["Name", "Role", "Notes"], ["Ada", "Engineer", "Writes code"], ["Bo", "Designer", ""]]
for i, row in enumerate(vals):
    for j, v in enumerate(row):
        t.cell(i, j).text = v
t.cell(2, 2).paragraphs[0].add_run("Draws ")
rr = t.cell(2, 2).paragraphs[0].add_run("things")
rr.bold = True

d.add_heading("Pictures", 2)
d.add_paragraph().add_run().add_picture(os.path.join(HERE, "pink.png"), width=Inches(1.5))
p = d.add_paragraph("Inline ")
p.add_run().add_picture(os.path.join(HERE, "green.png"), width=Inches(1))
p.add_run(" picture in a sentence.")

# A text box (Folio must not edit it, but it must survive)
p = d.add_paragraph("Before the box. ")
p._p.append(xml('''<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="1828800" cy="457200"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="50" name="Text Box 50"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:txbx><w:txbxContent><w:p><w:r><w:t>Inside the box</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape id="tb50" style="width:144pt;height:36pt" type="#_x0000_t202"><v:textbox><w:txbxContent><w:p><w:r><w:t>Inside the box</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>'''))
p.add_run("After the box.")

p = d.add_paragraph("End of section one.")
p.runs[0].add_break(WD_BREAK.PAGE)
d.add_section()
d.add_heading("Section two", 1)
p = d.add_paragraph("Spaces  double, nbsp here, and a symbol ")
p._p.append(xml('<w:r><w:sym w:font="Wingdings" w:char="F04A"/></w:r>'))
p.add_run(" done.")
d.add_paragraph("Last paragraph of the document.")

d.save(os.path.join(HERE, "kitchen-sink.docx"))

# Add a footnotes part by hand (python-docx doesn't write one).
import zipfile, shutil
src = os.path.join(HERE, "kitchen-sink.docx")
tmp = src + ".tmp"
FOOT = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="%s"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> The footnote text.</w:t></w:r></w:p></w:footnote></w:footnotes>''' % W
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == "[Content_Types].xml":
            data = data.replace(b"</Types>", b'<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>')
        if item.filename == "word/_rels/document.xml.rels":
            data = data.replace(b"</Relationships>", b'<Relationship Id="rIdFoot1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>')
        zout.writestr(item, data)
    zout.writestr("word/footnotes.xml", FOOT)
shutil.move(tmp, src)
print("wrote", src)
