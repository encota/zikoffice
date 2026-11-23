# Terminal and Assistant panels

*View → Panels* (or the backtick key with `Ctrl` for the terminal, `Ctrl+Shift+A` for the assistant) opens a resizable panel at the bottom.

## Terminal

A real shell (`$SHELL`) that starts in the folder of the open file. Use `claude`, `agy`, `git`, anything.
`Ctrl+Shift+C` copies, `Ctrl+Shift+V` pastes.

## Assistant

Summarise, rewrite, proofread, translate, or give a free instruction about the selected text (or the whole document).
It drives command-line programs **you have already installed and signed in to your own account**:
`claude` (Claude Code) and `agy` (Antigravity). ZikOffice has no AI service of its own and no API keys.

- Nothing changes until you press *Replace* or *Insert below*, and it can be undone with `Ctrl+Z`.
- In spreadsheets it works on the selected cells; in PDFs on the text (copy only); in presentations on the slide or the whole deck.
- **Privacy**: ZikOffice shows a notice about this in the Assistant and Terminal panels (dismissible; *Don't show again* hides it until the next update). The text leaves your computer, towards the service run by the tool you chose. The program is started in an
  empty temporary folder, without tools enabled. If you do not want this, simply do not install those tools: ZikOffice works fully without them.
- The instructions sent to the engines are written in Italian; the engines understand them and answer in the language of your text.

Tests with the real engines: `cd app/src-tauri && cargo test ai_engines -- --ignored --nocapture`.
