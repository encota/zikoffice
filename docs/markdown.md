# Markdown

ZikOffice opens, edits, creates and saves `.md` / `.markdown` files like any other document: you see and edit them
**as a document**, with all the styling tools of the ribbon, without needing to know the syntax
(code in `app/src/doc/markdown.ts`, parser [marked](https://marked.js.org)).

- **Source view** — *View → Source* (`Ctrl+Shift+M`) shows the Markdown text under the document. It follows the document as you type;
  if you edit it by hand, *Apply to document* (`Ctrl+Enter`) re-reads it (undo with `Ctrl+Z`). Images appear as `images/img-….png`, not as base64.
- **Read**: headings 1–6, bold, italic, strikethrough, `code`, links, bulleted and numbered lists (nested, with start number and
  `- [ ]` task boxes), quotes, code blocks (with language), rules, tables (with alignment), images, a leading YAML block
  (kept, not shown). Images with a relative path are read from the file's folder; online images are not downloaded
  (a placeholder is shown and the reference is kept as it is).
- **Full styling**: colours, sizes and fonts, highlighting, alignment, indents, spacing, paragraph shading, style names and
  image sizes are saved as standard HTML inside the file (`<span style>`, `<div align>`, `<img width>`). Modified styles, page,
  headers/footers, watermark and table properties go into a hidden comment at the end (`<!-- zikoffice:… -->`) that other
  programs ignore and ZikOffice reads back, so the document reopens identical. A file without special styling gets no HTML at all.
- **Saved**: images go to a folder next to the file (`note.md` → `note.assets/`). Before saving, the program lists what even this
  method cannot keep (tabs, page breaks, merged cells, table of contents, comments, roman numerals in lists).
- Other programs show plain Markdown but may ignore the HTML styles (GitHub, for example, removes colours and fonts and does not see the comment).
- **Not kept**: link titles (`[a](url "title")`), HTML not listed above, block quotes inside list items.

Checked on ~8,500 real `.md` files found on a computer (READMEs, changelogs, notes): no errors; 99.5 % come back with the same
text and a byte-identical file on the second conversion. The exceptions are badly-formed Markdown, complicated HTML and
auto-linked e-mail addresses. Real `.docx` files also convert and stay stable.
