# Security policy

ZikOffice opens files that come from other people (documents, spreadsheets, presentations,
PDFs, archives). Bugs in the parsers can therefore be security problems, and we take them seriously.

## Supported versions

The project is at an early stage: only the **latest release** (and the `main` branch) receives fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting instead: go to the **Security** tab of this repository and choose
**Report a vulnerability**. Include, if you can:

- what you did and what you expected;
- the file that triggers the problem (or a way to build one) — it will be handled privately;
- your ZikOffice version (for the `.deb`: `dpkg -s zik-office | grep Version`) and operating system.

You will get an answer within a few days. When the problem is fixed we publish a release and credit you
in the release notes, unless you prefer to stay anonymous.

## Other private matters

The same private form (**Security → Report a vulnerability**) is also how to reach the maintainers about anything that should
not be public — for example a [Code of Conduct](CODE_OF_CONDUCT.md) report (start the title with "Conduct report").
Everything else — bugs, questions, ideas — is better as a public [issue](../../issues) or [discussion](../../discussions),
so that others can benefit from the answer.

## What is in scope

- Crashes, hangs or memory blow-ups caused by a crafted file (`.docx`, `.xlsx`, `.pptx`, `.pdf`, `.pages`, `.numbers`, `.odt`, `.rtf`, `.md`…).
- Code execution, or reading/writing files outside what the user asked for.
- Macros: ZikOffice **never runs macros** (`.xlsm`, `.pptm`, VBA). If you find a way to make it run one, that is a vulnerability.
- Passwords: files opened with a password are decrypted in memory; a way to leak the password or the plain-text file counts.

## Things to know

- The application makes **no network requests of its own** (the interface has a Content-Security-Policy that blocks them). The optional *Assistant* panel runs command-line tools that you installed yourself (`claude`, `agy`); what they send is decided by those tools. See [docs/assistant.md](docs/assistant.md).
- The built-in *Terminal* is a real shell with your user's permissions, like any terminal.
