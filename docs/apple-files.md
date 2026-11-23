# Apple Pages and Numbers

ZikOffice opens `.pages` and `.numbers` by itself, without LibreOffice or any other program
(code in `app/src/doc/iwork/`).

- **Container**: an iWork file is a zip with `.iwa` blocks (Snappy without CRC) holding protobuf objects. The reader (`iwa.ts`)
  parses protobuf without schemas and interprets only the fields whose meaning is known; the rest is ignored.
  Keynote uses the same container, but there is no importer yet.
- **Pages** — text, paragraph styles (headings → *Heading 1…*, body, caption), bold / italic / underline / strike,
  fonts and colours, bulleted and numbered lists, embedded images and tables, page size and margins. The old XML
  format (Pages '09) is also supported.
- **Numbers** — each table becomes a sheet with the *displayed* values (dates, numbers, text, rich text). Formulas are not
  translated: the results stay.
- **Saving** is not supported: *Save* offers `.docx` or `.xlsx`, which Pages and Numbers open.
- **Not read**: notes, comments, headers/footers, footnotes, cell styles, merged cells, number formats (currency becomes a
  plain number), password-protected documents, Pages files whose text lives only in floating text boxes.

Verified on a handful of small files only (two Pages files from 2015, Numbers files from the `numbers-parser` project).
Modern documents made on a recent iPad or Mac, with images and tables in the body, are the least tested area — samples are very welcome.

Tests: `cd app && ZIKOFFICE_IWORK_FIXTURES=/folder npx vitest run tests/iwork.test.ts`. The folder must contain
`Pages_4.pages`, `Pages_5.pages`, `test-2.numbers` and `test-bullets.numbers` (from the LibreOffice and `numbers-parser`
projects); without it only the synthetic tests run.
