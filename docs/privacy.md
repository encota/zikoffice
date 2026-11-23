# Privacy

**ZikOffice does not track you.** Short version, then the details and how to check them yourself.

## What ZikOffice does *not* do

- No telemetry, analytics, usage statistics or crash reports.
- No accounts, no sign-in, no licence server.
- No update checks, no "phoning home", no advertising.
- Your documents are never uploaded, synchronised or scanned. They stay in the files where you keep them.

This is not just a promise: the application **contains no network code**. There is no HTTP client in its dependencies,
no updater and no analytics component, and the interface runs under a Content-Security-Policy that forbids it to contact
any server (`connect-src 'self' ipc: http://ipc.localhost`, i.e. only the application itself, in `app/src-tauri/tauri.conf.json`). You can check:

```bash
cd app/src-tauri
cargo tree -e normal | grep -iE "reqwest|hyper|ureq|curl|tungstenite|updater|sentry|analytics"   # prints nothing
grep -n "csp" tauri.conf.json
```

(Keep in mind this describes ZikOffice itself. If you find something that contradicts it, please report it as a
[security issue](../SECURITY.md).)

## What is stored on your computer

Everything stays on your machine, in your user account, and you can delete it at any time:

| What | Where | Why |
|---|---|---|
| Preferences, language, theme, recent files | `~/.local/share/app.zikoffice.desktop/localstorage/` | so the app remembers your settings |
| Temporary working copies of open PDFs | `…/app.zikoffice.desktop/pdfwork/` | the PDF editor works on a copy until you save |
| A marker that file associations were set | `~/.config/zikoffice/` | so it is done only once |
| Crash-recovery copies of unsaved documents | `…/app.zikoffice.desktop/recovery/` | to offer them back after a crash; removed when you save or discard |
| Previous versions of the files you save | `…/app.zikoffice.desktop/cronologia/` | the *Version history* feature |
| Your personal spelling dictionary | `…/app.zikoffice.desktop/dizionario-personale.txt` | words you added |

Deleting the folder `~/.local/share/app.zikoffice.desktop/` resets all of it.

## Where data *can* leave your computer — only if you choose to

ZikOffice itself never sends anything. But it can start other programs, and **those programs may**:

- **The Assistant panel** drives command-line tools that you installed and signed in to your own account: `claude` (Claude) and
  `agy` (Antigravity). When you press a button, the text you selected is passed to that tool, which sends it to the company that runs
  the service. From that moment **how your text is stored, used or kept is decided by that service and its terms — not by ZikOffice
  and not by its developers, who are not responsible for it.** Do not use it with confidential documents unless you know it is allowed.
- **The Terminal panel** is a normal shell. Anything you run there (including `claude`, `agy`, `git`, `curl`…) does whatever that program does.
- ZikOffice shows a **notice** in these two panels explaining this. You can close it, or tick *Don't show this notice again*,
  in which case it stays hidden until the next update of the application.
- **Local helper tools** — `poppler`, `mupdf`, `tesseract` (OCR), LibreOffice (conversion of `.doc`, `.ppt`, `.odp`) — are run on your
  computer to read, render or convert your files. ZikOffice does not use them to send anything anywhere.
- If you do not install `claude` or `agy`, the Assistant simply has nothing to call and nothing can leave.

## Files you open

Files from other people can contain links to remote images or content. ZikOffice cannot load them (the interface policy only allows
local images; in Markdown, online images are shown as placeholders) and **never runs macros** (`.xlsm`, `.pptm`, VBA).
