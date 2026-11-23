# Contributing to ZikOffice

Thank you for wanting to help! ZikOffice is young, so almost everything is useful: bug reports,
sample files, translations, documentation, and code. By taking part you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## The most valuable thing you can do: report a file that goes wrong

An office suite lives or dies on real-world files. If a document, spreadsheet, presentation or PDF opens
badly, saves badly, or looks different from the original program:

1. [Open an issue](../../issues/new/choose) using the *Bug report* template.
2. Say what you did, what you expected and what happened. A screenshot of the original next to ZikOffice helps a lot.
3. **Attach the file** if you can share it. If it is confidential, make a copy and delete the sensitive content
   (many problems survive that), or describe the structure (e.g. "a table with merged cells inside a text box").

Never attach files containing personal data, passwords or secrets.

## Ways to help

| I want to… | Start here |
|---|---|
| Fix a typo or improve the docs | Edit the file and open a pull request — no need to ask first. |
| Fix or improve a translation | [docs/i18n.md](docs/i18n.md). Native speakers are especially needed: the current translations were never reviewed. |
| Fix a bug | Look for issues labelled `bug`; comment that you are working on it. |
| Add a feature | Open an issue first to agree on the idea (a short description is enough), especially for large changes. |
| Improve file compatibility | Issues labelled `compatibility` — usually a sample file and a comparison with the original program. |

## Setting up

Full instructions are in [docs/building.md](docs/building.md). The short version:

```bash
git clone https://github.com/encota/zikoffice && cd zikoffice/app
npm install
npm run tauri dev          # app with live reload
```

## Before you open a pull request

```bash
cd app
npx tsc --noEmit           # type check
npm test                   # interface tests (vitest)
npm run i18n               # lists user-visible strings that have no translation
cd .. && cargo test        # Rust tests
```

and, for changes that touch real files, the tests that use sample folders (they skip themselves when the
folder is not given — see the comments at the top of each test file):
`PPTX_SAMPLES=/some/folder npx vitest run tests/slides.test.ts`, `ZIKOFFICE_PDF_FIXTURES=… cargo test -- --ignored`, and so on.
The *self-test* runs the real app headlessly: `ZIKOFFICE_SELFTEST=/tmp/zik-test target/debug/zikoffice`
(with `npm run dev` running) and must print `SELFTEST OK`.

A good pull request:

- does **one thing** and explains **why** in the description;
- adds or updates **tests** (a failing test for a bug, then the fix);
- keeps the existing style; touches only what it needs;
- has a title in the Conventional Commits format (see below) — the changelog and the version number are generated from it;
- for visible changes, shows a before/after screenshot.

### How the code is organised

See [docs/architecture.md](docs/architecture.md). The interface is TypeScript with **no UI framework**
(a small `h()` helper builds DOM elements); heavy or system-level work (PDF editing, file access, OCR,
the terminal) is in Rust.

### Language of the code

The project started in Italian, so many **code comments and some identifiers are in Italian**, and the Italian
interface text is used as the *key* of the translation tables (see [docs/i18n.md](docs/i18n.md)). You do not need
to read Italian to contribute: write new comments and documentation in English, and ask in the issue or pull
request if something is unclear. Translating old comments is a welcome (and safe) first contribution.

### Commit messages and versions

Version numbers are **automatic**: nobody edits them by hand. They are computed from the commit messages
([release-please](https://github.com/googleapis/release-please)), so commits — and the **title of a pull request**, because
we squash-merge — follow [Conventional Commits](https://www.conventionalcommits.org):

| Prefix | Meaning | Effect on the version (0.x) |
|---|---|---|
| `fix:` | a bug fix | patch (0.1.0 → 0.1.1) |
| `feat:` | something new for users | minor (0.1.0 → 0.2.0) |
| `feat!:` or a `BREAKING CHANGE:` line | incompatible change | minor before 1.0, major after |
| `docs:` `test:` `refactor:` `chore:` `ci:` `perf:` | no new behaviour | no release by themselves |

Example: `fix: keep table widths when importing .docx`. Add a short body if the reason is not obvious, and
`Fixes #123` to link an issue. A bot keeps a "release PR" open with the next version and the changelog; the maintainer
merges it to publish a release (tag, `.deb`, AppImage, `.rpm`). The PR-title check enforces the format.

### Using AI assistants

Allowed — a large part of this project was written with one. You are responsible for what you submit:
understand it, run the tests, and say so in the pull request if a tool wrote a significant part.

## Licensing of contributions

ZikOffice is dual-licensed [MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE). By submitting a contribution
you agree that it is licensed under the same terms, with no additional conditions. Do not submit code you
have not written yourself or that comes from a project with an incompatible license (GPL, AGPL, proprietary).
In particular **do not copy code from LibreOffice, OnlyOffice or other copyleft office suites**; reading their
documentation of a file format is fine, copying their source is not.

## Questions

Open a [discussion](../../discussions). For anything private, use the repository's **Security → Report a vulnerability** form (see [SECURITY.md](SECURITY.md)).
