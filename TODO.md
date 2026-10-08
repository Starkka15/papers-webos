# TODO

Papers is an open-source replacement for the TouchPad's office app: an Enyo 1 web
app that reads documents itself, in JavaScript. LibreOffice's import code is the
reference for how each format is read (a checkout of the relevant parts is kept
outside this repo). A native plugin is built only where the web engine cannot do
the job.

## Done so far

- [x] **File browser** in the old app's layout: places on the left, every document
  on the TouchPad on the right, with search and a Show filter.
- [x] **Word documents (.docx)**: styles with inheritance, fonts by kind, bold,
  italic, underline, color, size, highlight, super- and subscript, alignment,
  indents and spacing, bulleted and numbered lists, tables with merged cells and
  borders, pictures, links, page breaks.
- [x] **Old Word documents (.doc, Word 97 to 2003)**: text with fonts, bold, italic,
  underline, color, size, shading, super- and subscript, alignment, indents and
  spacing, paragraph borders, styles, bullets and numbering, links; tables with
  the file's borders, shading, widths and merged cells; pictures (PNG, JPEG,
  bitmap) in the text and floating; text boxes and drawn boxes, ovals and level
  or upright lines with their fill and outline; the header and footer; footnotes
  and endnotes; page size and margins.
- [x] **Plain text** (.txt, .csv as text).
- [x] **Reads any zip**: a small native helper (`native/ppzip.c`) unpacks office
  files, because the TouchPad's own unzip cannot read many current ones.
- [x] **Opens a file it is launched with** (`{target: "file:///..."}`).

## Most worth doing

- [ ] **Spreadsheets (.xlsx)**: sheets as scrolling grids, with sheet tabs, number
  and date formats, column widths, merged cells and cell colors.
- [ ] **Presentations (.pptx)**: slides drawn to scale, with a slide strip.
- [ ] **Finish old Word files (.doc)** before starting another format:
  - [ ] Footnotes and endnotes are written but untested: find or make a file with some.
  - [x] Groups of shapes (diagrams) and objects that overlap text.
  - [x] Preset shapes (arrows, stars, callouts, flowchart symbols...): all 199 are
    drawn from LibreOffice's table (`ShapeTable.js`, made by `tools/gen-shapes.js`)
    with its evaluator translated in `Shapes.js`.
  - [x] Slanted and dashed lines, arrowheads (one style of head so far).
  - [x] Shapes lie behind the text only when the shape says so, as LibreOffice decides it.
  - [x] Freeform shapes, whose outline is stored in the document (polygons, curves),
    and preset shapes with parts of their outline replaced.
  - [ ] Turned shapes, and text that runs up or down a text box.
  - [ ] WordArt (text on a path): its guide lines are drawn, not its text.
  - [ ] Gradient fills and shadows on shapes (drawn as a flat color).
  - [x] Windows metafile pictures (.wmf), drawn on a canvas by `Wmf.js`.
  - [ ] Enhanced metafile pictures (.emf): a box marks their place. LibreOffice's
    reader is `emfio/source/reader/emfreader.cxx`.
  - [ ] Tab stops, and text in columns.
  - [x] Long documents. The TouchPad's web engine keeps positions in 16 bits, so
    nothing more than 32,767 pixels down a page can be reached. When a document is
    taller than that, only the pages around the one being read are kept in the page
    (`DocView.js`). Checked with a 35-sheet, 37,000-pixel file.
  - [x] Pages: each page the document starts (page break, new section) is a sheet
    of its own, a full page high.
  - [ ] Dividing text into pages where the document does not (a long section is
    one tall sheet), and a sheet taller than 32,767 pixels on its own.
  - [ ] Each section's own page size, header and footer (the first section's are used).
  - [ ] Word 95 and older, and Rich Text saved with a .doc name.
- [ ] **Finish Word documents (.docx)** to the same level: headers and footers,
  footnotes, text boxes and floating pictures, drawn shapes, tab stops, table
  shading from table styles, tracked changes.
- [ ] **Take over from the old office app**: register for the document file
  types, so a tapped attachment or download opens here.
- [ ] **Pinch to zoom and fit to width**, and remember the place in a document.
- [ ] **A real icon.**

## How documents are checked

LibreOffice (kept outside this repo) renders each test document to PDF, and the
pages are compared with what Papers draws on the TouchPad. `tools/open-doc.ps1`
opens a document on the TouchPad from a cold start and reports any graphics
trouble. Document content is always drawn in software: see the note in
`app/source/DocView.js`.

## Smaller wins

- [ ] **Open faster the first time**: unpack only the parts a document needs
  (the pictures can follow), and keep the service awake while browsing.
- [ ] **Old Excel and PowerPoint files (.xls, .ppt).**
- [ ] **OpenDocument files (.odt, .ods, .odp)**, LibreOffice's own formats.
- [ ] **Rich Text (.rtf).**
- [ ] **Search inside a document.**
- [ ] **Follow links** (open the browser) and jump to headings (an outline).
- [ ] **Folders and other places**: browse by folder, and show files kept by the
  Nextcloud app.
- [ ] **Windows metafile pictures** (.emf, .wmf), shown as a placeholder for now.

## Later

- [ ] **Editing**: type and format text, change cells, save. Writing a file needs
  a way to make zip archives, which the TouchPad lacks: extend `ppzip` to write them.
  Decided: Papers does not write binary `.doc`. An edited `.doc` is saved as `.docx`
  or as OpenDocument (`.odt`), and the person saving picks which.
- [ ] **New documents** from templates.
- [ ] **Charts** in documents and spreadsheets.
- [ ] **Formulas** recalculated in spreadsheets.
- [ ] **Phone layout** for the Pre3 and Veer.
