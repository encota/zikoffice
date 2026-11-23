# Third-party licenses

ZikOffice itself is licensed under [MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE).
It is built on the open-source components below. Every license involved is permissive
(MIT, Apache-2.0, BSD, ISC, Zlib, Unicode, …) except **MPL-2.0** components (file-level copyleft; they are used unmodified
as libraries: `spellbook`, `cssparser`, `selectors` and a few small crates of the Tauri/WebKit stack).
No GPL or AGPL code is compiled into the application. It uses the system's GTK and WebKitGTK (LGPL), dynamically linked, as every Tauri application on Linux does.

## Direct dependencies — Rust (`app/src-tauri/Cargo.toml`)

| Crate | Version | License |
|---|---|---|
| [calamine](https://github.com/tafia/calamine) | 0.38.0 | MIT |
| [csv](https://github.com/BurntSushi/rust-csv) | 1.4.0 | Unlicense/MIT |
| [gtk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [ironcalc](https://github.com/ironcalc/ironcalc/) | 0.9.1 | MIT OR Apache-2.0 |
| [lopdf](https://github.com/J-F-Liu/lopdf.git) | 0.42.0 | MIT |
| [office-crypto](https://github.com/udbhav1/office-crypto) | 0.4.0 | MIT |
| [pdf-extract](https://github.com/jrmuizel/pdf-extract) | 0.12.1 | MIT |
| [portable-pty](https://github.com/wezterm/wezterm) | 0.9.0 | MIT |
| [serde](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 |
| [serde_json](https://github.com/serde-rs/json) | 1.0.154 | MIT OR Apache-2.0 |
| [spellbook](https://github.com/helix-editor/spellbook) | 0.4.2 | MPL-2.0 |
| [tauri](https://github.com/tauri-apps/tauri) | 2.12.7 | Apache-2.0 OR MIT |
| [tauri-build](https://github.com/tauri-apps/tauri) | 2.7.6 | Apache-2.0 OR MIT |
| [tauri-plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | 2.8.4 | Apache-2.0 OR MIT |
| [tauri-plugin-single-instance](https://github.com/tauri-apps/plugins-workspace) | 2.5.5 | Apache-2.0 OR MIT |
| [webkit2gtk](https://github.com/tauri-apps/webkit2gtk-rs) | 2.0.2 | MIT |
| [zip](https://github.com/zip-rs/zip2) | 9.8.1 | MIT |

## Direct dependencies — JavaScript (`app/package.json`)

| Package | Version | License |
|---|---|---|
| [@ironcalc/wasm](https://github.com/ironcalc/IronCalc) | 0.9.1 | MIT OR Apache-2.0 |
| [@tauri-apps/api](https://github.com/tauri-apps/tauri) | 2.12.5 | Apache-2.0 OR MIT |
| [@tauri-apps/plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | 2.8.4 | MIT OR Apache-2.0 |
| [@xterm/addon-fit](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit) | 0.11.0 | MIT |
| [@xterm/xterm](https://github.com/xtermjs/xterm.js) | 6.0.0 | MIT |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT |
| [lucide](https://github.com/lucide-icons/lucide) | 1.77.0 | ISC |
| [marked](https://github.com/markedjs/marked) | 18.1.3 | MIT |

## Complete lists

The full list, with transitive dependencies, can be generated at any time:

```bash
cargo metadata --format-version 1 --manifest-path app/src-tauri/Cargo.toml \
  | python3 -c "import json,sys; [print(p['name'], p['version'], p.get('license')) for p in json.load(sys.stdin)['packages']]"
cd app && npx license-checker --production --summary
```

## External programs (not bundled, not linked)

Called as separate programs when installed: `poppler-utils` (GPL-2.0+), `mupdf-tools` (AGPL-3.0), `tesseract-ocr` (Apache-2.0),
`libreoffice` (MPL-2.0), and, if you choose to use them, `claude` and `agy`. ZikOffice only runs them as separate commands; it does not
include or link their code (this matters for MuPDF, which is AGPL). Fonts and Hunspell dictionaries are taken from the system and are not distributed with ZikOffice.

## Images

The application icons and the logo in `brand/` are described in [brand/README.md](brand/README.md). The interface icons are
from [Lucide](https://lucide.dev) (ISC).
