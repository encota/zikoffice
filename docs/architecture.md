# Architecture

ZikOffice is a [Tauri 2](https://tauri.app) application: a native window that shows a web interface
(TypeScript + Vite, **no UI framework**) and talks to a Rust back end through typed commands.

```
app/
  index.html, src/
    main.ts            application shell: tabs, file open/save, backstage, preferences, key bindings
    dom.ts             h() helper that builds DOM elements (translates visible text), toast()
    files.ts           file dialogs and the calls to the Rust side
    ribbon/            ribbon definitions (definitions.ts) and rendering (ribbon.ts)
    views/view.ts      DocumentView interface: what each editor must provide
    doc/               text documents: model, layout, editor, import/export (docx, odt, rtf, md, html, pages)
      iwork/           reader for Apple Pages/Numbers (protobuf container)
    sheet/             spreadsheet: canvas grid (sheetView.ts), IronCalc engine (WebAssembly), charts, pivot, filters
    slides/            presentations: model, auto layout, themes, renderer, editor, .pptx import/export, slide show
    pdf/               PDF editor (calls the Rust PDF engine)
    ui/                menus, colour picker, dialogs
    i18n/              translation layer and tables (see i18n.md)
    dock.ts            bottom panel: terminal, assistant, markdown source
    selftest.ts        self-test that runs inside the real app (development builds only)
  src-tauri/src/       Rust: files, workbooks, PDF editing and OCR, terminal, spell check, history, recovery
  tests/               vitest tests
docs/                  documentation
brand/                 logos
```

## Principles

- **One interface per document kind**, all implementing `DocumentView` (`views/view.ts`): `DocEditor`, `SheetView`, `SlideView`, `PdfEditor`.
  The ribbon asks the active view for the state of its buttons and sends it the commands.
- **The model is plain data** (documents: `doc/model.ts`; presentations: `slides/model.ts`) with pure functions for operations, so
  it can be tested without a browser. Rendering and layout are separate from the model.
- **The Rust side does only what a browser cannot or should not**: reading and writing files atomically, encrypted Office files,
  the PDF object engine, OCR, a pseudo-terminal, Hunspell, converting legacy formats through LibreOffice.
  Large data goes through raw-bytes commands, not JSON.
- **Everything is local.** The content-security policy forbids network access from the interface.
- **Don't trust the file.** Importers are written to survive hostile and broken input: unknown elements are skipped, and
  anything the editor does not understand is kept and written back untouched where possible (charts, SmartArt, spreadsheet extras).

## Adding a file format (import or export)

1. Write the importer/exporter in `app/src/doc/`, `sheet/` or `slides/` as pure functions on bytes (`Uint8Array`) ↔ the model.
2. Add the extension to the checks in `app/src/files.ts` and to the open/save code paths in `app/src/main.ts`.
3. Add the extension and MIME type to `bundle.fileAssociations` in `app/src-tauri/tauri.conf.json` (this also feeds
   the `.deb` file associations and `zik --register-file-types`).
4. Write tests with a synthetic file and, if you can, a real one (see the sample-folder environment variables in [building.md](building.md)).
5. Document what is kept and lost in [formats.md](formats.md).

## Tests and verification

- Unit tests (vitest + jsdom) for models, importers/exporters, layout, translations.
- Rust tests for file handling, the PDF engine and IPC.
- A self-test inside the real WebView (`ZIKOFFICE_SELFTEST`) exercising save/open round trips, the terminal, spell check and PDF.
- Round trips of real files, checked visually through LibreOffice renderings (see [formats.md](formats.md) for how, and for what has *not* been verified).
