# File formats: what works and what is lost

ZikOffice reads and writes the formats below with its own code. The goal is that a file you open, edit
and save looks the same in the original program. The sections list what is **kept** and what is **not**.

How it was checked: real files from real programs were opened, saved and reopened, and the renderings
compared (LibreOffice and `poppler` as the reference). It was **not** checked with Microsoft Office,
Apple iWork or Adobe software. If a file looks different in the original program, please
[report it](../CONTRIBUTING.md) with the file.

| Kind | Open | Save |
|---|---|---|
| Documents | `.docx` `.odt` `.rtf` `.html` `.md` `.txt` · `.pages` · `.doc` (LibreOffice) | `.docx` `.odt` `.md` `.txt` |
| Spreadsheets | `.xlsx` `.xlsm` `.xls` `.xlsb` `.ods` `.csv` `.tsv` · `.numbers` | `.xlsx` `.ods` `.csv` |
| Presentations | `.pptx` `.ppsx` `.potx` `.pptm` · `.ppt` `.odp` (LibreOffice) | `.pptx` |
| PDF | `.pdf` | `.pdf` |

Password-protected `.docx`, `.xlsx` and `.pptx` (the Office encryption container) are decrypted in memory; this path
has **not** been tested on a real encrypted file. Encrypted PDFs are tested.
`.ppsx`, `.potx` and `.pptm` use the same structure as `.pptx` but have not been tested with real files.

## Documents

- **`.docx`** — styles, numbering and lists, tables (merged cells, borders, shading), images, headers and footers,
  footnotes, comments, fields (page number, table of contents), page size and margins, simple text boxes.
  Strict OOXML and `mc:AlternateContent` are handled. Not kept (or only approximately): equations, SmartArt, embedded
  objects, complex floating layouts, deleted text in tracked changes.
- **`.odt`** — paragraphs, styles, lists, tables, images, headers/footers.
- **`.md`** — see [markdown.md](markdown.md).
- **`.pages`** — see [apple-files.md](apple-files.md).
- **`.doc`** (Word 97–2003) is converted to `.docx` by LibreOffice (`soffice --headless`), which must be installed.

## Spreadsheets

The calculation engine is [IronCalc](https://www.ironcalc.com). Formulas are stored in the standard (English) form
in `.xlsx`, so a file written in one interface language opens in all the others.

- Saved as standard `.xlsx` (visible in Excel and LibreOffice): values, formulas, number formats, fonts, fills, borders,
  merged cells, column widths, frozen panes.
- **Saved only in a ZikOffice extension** (an extra part, `zikoffice/extras.json`, inside the `.xlsx`): charts, conditional
  formats, cell notes, data validation and named ranges. ZikOffice restores them when you reopen the file; **Excel and
  LibreOffice ignore them** (they do not break the file, but you will not see them there). Writing them in the standard
  form is on the roadmap and is a good first contribution.
- Macros in `.xlsm` are **never** run and are dropped when saved as `.xlsx`.
- `.xls` and `.xlsb` are read (values, formulas and formatting that the reader exposes) and saved as `.xlsx`.
- `.csv` keeps only the values of the active sheet (semicolon separated; the app asks before saving).
- `.numbers` — see [apple-files.md](apple-files.md).

## Presentations

See [presentations.md](presentations.md).

## PDF

See [pdf.md](pdf.md).
