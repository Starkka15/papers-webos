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
  underline, color, size, super- and subscript, alignment, indents and spacing,
  styles, bullets and numbering, tables (with plain thin lines).
- [x] **Plain text** (.txt, .csv as text).
- [x] **Reads any zip**: a small native helper (`native/ppzip.c`) unpacks office
  files, because the TouchPad's own unzip cannot read many current ones.
- [x] **Opens a file it is launched with** (`{target: "file:///..."}`).

## Most worth doing

- [ ] **Spreadsheets (.xlsx)**: sheets as scrolling grids, with sheet tabs, number
  and date formats, column widths, merged cells and cell colors.
- [ ] **Presentations (.pptx)**: slides drawn to scale, with a slide strip.
- [ ] **Old Word files, the rest**: pictures and drawings, the table borders and
  shading set in the file, headers and footers, footnotes, page size and
  margins, Word 95 and older, and Rich Text saved with a .doc name.
- [ ] **Take over from the old office app**: register for the document file
  types, so a tapped attachment or download opens here.
- [ ] **Pinch to zoom and fit to width**, and remember the place in a document.
- [ ] **Word documents, the rest**: headers and footers, footnotes, text boxes and
  floating pictures, columns, tab stops, table cell margins and shading from
  table styles, tracked changes, real pages.
- [ ] **A real icon.**

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
  a way to make zip archives, which the TouchPad lacks; likely the first plugin.
- [ ] **New documents** from templates.
- [ ] **Charts** in documents and spreadsheets.
- [ ] **Formulas** recalculated in spreadsheets.
- [ ] **Phone layout** for the Pre3 and Veer.
