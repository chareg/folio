from docx import Document
from docx.shared import Pt
d = Document()
d.add_paragraph("On Reading Slowly", style="Title")
d.add_paragraph("A small field guide for people who open documents and actually want to enjoy them", style="Subtitle")
p = d.add_paragraph()
p.add_run("This is a sample document. ").bold = True
p.add_run("Drop any ")
p.add_run(".docx").italic = True
p.add_run(" file onto this page, or press Open, and it will appear here in the same calm layout. Nothing is uploaded anywhere: your file never leaves your device.")
d.add_heading("Why the page matters", 1)
d.add_paragraph("Most documents are written in a hurry and read in a hurry. Line lengths sprawl across wide monitors, the type is whatever the default happened to be, and the margins are an afterthought. Reading becomes a chore you push through rather than something you settle into.")
d.add_paragraph("A good reading surface fixes the small things you never notice when they are right: a measure of around sixty-five characters, generous leading, a typeface designed for long stretches of text, and contrast that is clear without being harsh.")
d.add_paragraph("The eye does not read letters. It reads shapes, and it reads them best when they are given room to breathe.", style="Intense Quote")
d.add_heading("Things to try", 1)
d.add_heading("Make it yours", 2)
for t in ["Switch between Paper, Mist and Night moods under Appearance.",
          "Nudge the text size up or down until it feels right.",
          "Choose a serif or sans face for the body text.",
          "Widen or narrow the column to suit your screen."]:
    d.add_paragraph(t, style="List Bullet")
d.add_heading("Find your way around", 2)
d.add_paragraph("Every heading in your document becomes an entry in the contents panel on the left. The entry for the section you are reading lights up as you scroll, and the thin bar at the very top shows how far through you are.")
for t in ["Open a document with the button or Ctrl+O.", "Jump between sections from the contents panel.", "Press F to hide everything except the text."]:
    d.add_paragraph(t, style="List Number")
d.add_heading("What survives the trip", 1)
d.add_paragraph("The reader keeps the structure of your document and lets go of its decoration. Headings, emphasis, lists, quotes, tables, links, images and footnotes all come through. Exact fonts, colours and page breaks are replaced by the reader's own typography, which is rather the point.")
t = d.add_table(rows=1, cols=3)
t.style = "Table Grid"
hdr = t.rows[0].cells
hdr[0].text, hdr[1].text, hdr[2].text = "Element", "Kept", "Notes"
for row in [("Headings 1 to 6", "Yes", "Also build the contents panel"),
            ("Bold, italic, underline", "Yes", "Strikethrough too"),
            ("Tables", "Yes", "Scroll sideways when wide"),
            ("Images", "Yes", "Embedded straight from the file"),
            ("Exact fonts and colours", "No", "Replaced by the reading theme")]:
    c = t.add_row().cells
    for i, v in enumerate(row): c[i].text = v
d.add_heading("A note on pace", 3)
d.add_paragraph("The estimate in the corner assumes about 230 words a minute, which is a relaxed adult pace. You are welcome to beat it. You are even more welcome to ignore it.")
d.save(__import__("os").path.join(__import__("os").path.dirname(__file__), "sample.docx"))
