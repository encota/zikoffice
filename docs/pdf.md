# PDF: editing objects and OCR

A PDF opens in its own editor: every page is drawn, and on top of it there is a layer of **objects** (text, images, graphics).

- **Select** with a click (nearby text on the same line is selected together), `Shift`+click, or by dragging a rectangle.
- **Move** by dragging or with the arrow keys (`Shift` = 10 points), **resize** with the bottom-right handle, **delete** with `Del`.
  Undo and redo work on everything.
- **Pages** (Pages tab): rotate left/right, delete, move up/down; all undoable. To merge or extract pages from several files use
  *Merge PDF* / *Extract PDF pages* on the File screen.
- **OCR** (OCR tab): recognises the text of scanned pages and adds it as an invisible layer, so the PDF becomes selectable and
  searchable. *Extract text* then opens it as a document.
- Saving rewrites only the pages you touched. Password-protected PDFs open with the password and are saved without protection.

## How it works

The content of a page is a sequence of operators (`BT … Tj … ET` for text, `Do` for images). The engine
(`app/src-tauri/src/pdf_edit.rs`) reads them while tracking matrices and font widths, so it knows where every object is.
Moving an object means wrapping its operators in `q <cm> … Q`; deleting means removing them.

## Known limits

- The **text itself cannot be edited** (changing letters would need the embedded fonts).
- Text written with fonts that carry no character widths cannot be moved (to avoid damaging the line).
- PDFs with text clipping (rendering mode 4–7) are left alone.
- OCR has only been tested on a few generated scans, not on a large set of real scans.

## Requirements

`poppler-utils` (text and fallback drawing), `mupdf-tools` (drawing, recommended), and for OCR `tesseract-ocr` with the
language packs you need.

## Tests with real PDFs

```bash
ZIKOFFICE_PDF_FIXTURES=/folder/with/pdfs cargo test -- --ignored   # text positions and edits compared with poppler
ZIKOFFICE_SCAN_FIXTURES=/folder/scans   cargo test -- --ignored   # OCR layer position (scans at 0/90/180/270°)
```
