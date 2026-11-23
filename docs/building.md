# Building ZikOffice from source

## Requirements

| Tool | Version |
|---|---|
| Rust | stable, 1.85 or newer (edition 2024); developed with 1.100 — install with [rustup](https://rustup.rs) |
| Node.js | 22.12 or newer (Vitest requires it; developed with 24) |
| System libraries (Debian/Ubuntu) | `build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libssl-dev librsvg2-dev libxdo-dev libayatana-appindicator3-dev patchelf` |

Other distributions: the equivalents of the [Tauri 2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

Runtime tools used by some features (not needed to build or run the tests):
`poppler-utils` (`pdftotext`, `pdftoppm`), `mupdf-tools` (`mutool`), `tesseract-ocr` (+ languages),
`libreoffice` (`soffice`, only for `.doc`/`.ppt`/`.odp`), Hunspell dictionaries.

## Run

```bash
cd app
npm install
npm run tauri dev
```

The first Rust build takes several minutes (WebKitGTK bindings, PDF libraries); later builds are incremental.

## Test

```bash
cd app && npx tsc --noEmit && npm test     # type check + interface tests
cd .. && cargo test                        # Rust tests
```

Some tests need real sample files that are not in the repository (and are skipped without them):

| Variable | Used by |
|---|---|
| `PPTX_SAMPLES=/folder` | `tests/slides.test.ts` — every `.pptx` in the folder is opened, saved and reopened |
| `ZIKOFFICE_IWORK_FIXTURES=/folder` | `tests/iwork.test.ts` — `Pages_4.pages`, `Pages_5.pages`, `test-2.numbers`, `test-bullets.numbers` |
| `ZIKOFFICE_PDF_FIXTURES=/folder` | `cargo test -- --ignored` — text positions and edits compared with poppler |
| `ZIKOFFICE_SCAN_FIXTURES=/folder` | `cargo test -- --ignored` — position of the OCR layer on scans rotated 0/90/180/270° |

### Self-test inside the real app

```bash
cd app && npm run dev &                     # the dev server must be running
cd .. && cargo build
ZIKOFFICE_SELFTEST=/tmp/zik-selftest target/debug/zikoffice
```

The app creates, saves and reopens a document, a spreadsheet, a presentation and a PDF, checks the spell checker,
the terminal and the PDF engine inside the real WebView, prints `SELFTEST OK` or the failure, and exits.

## Package

```bash
cd app && npm run tauri build -- --bundles deb
```

The package is written to `target/release/bundle/deb/`. The `.deb` post-install script (`app/src-tauri/deb/postinst.sh`)
makes ZikOffice the default application for its file types for the user who runs `sudo apt install`.
AppImage and `.rpm` are enabled in `tauri.conf.json` but have not been tested.

## Releases (maintainers)

Releases are automatic (`.github/workflows/release.yml`): commits to `main` follow Conventional Commits, a bot keeps a
release PR open with the computed version (`package.json`, `tauri.conf.json` and `Cargo.toml` are updated for you) and the
changelog; merging it creates the tag and the GitHub release, and `package.yml` builds the `.deb`, the AppImage and the `.rpm`
on Ubuntu 22.04 and attaches them, with `SHA256SUMS.txt`. A **nightly** pre-release (`nightly` tag) is rebuilt every day at 20:00 Italian time if anything other than documentation changed since
the previous one (workflow `nightly.yml`; it can also be started by hand, and then always builds). To get the packages without making a release, run
*Actions → Packages → Run workflow* and download the artifact.

To build the AppImage locally: `cd app && NO_STRIP=true npm run tauri build -- --bundles appimage`
(it runs on distributions with a glibc at least as new as the one you built on, so build on an old one for wide compatibility).

## Troubleshooting

- *`webkit2gtk-4.1` not found*: install `libwebkit2gtk-4.1-dev` (not the older `-4.0`).
- *Blank window on Wayland with some GPUs*: try `WEBKIT_DISABLE_COMPOSITING_MODE=1 zik`.
- *Tests complain about the IronCalc WebAssembly*: run `npm install` again in `app/`.
