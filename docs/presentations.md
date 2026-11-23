# Presentations

A slide editor that is deliberately **simpler than PowerPoint**: the *theme decides where things go*.

## How layout works

Every slide layout (title, title and content, two contents, section header, title only, blank) has fixed places for the
title, subtitle and content (`app/src/slides/layout.ts`). Whatever you add — text, images, tables — arranges itself in the
free space:

- one text box and one picture share the slide, text on the left;
- several pictures go in a grid, keeping their proportions;
- a table sits at the top of the content area;
- text that is too long for its box is scaled down to fit (like PowerPoint's *Shrink text on overflow*).

Drag an element and it stays where you put it. *Auto layout* puts everything back.
Changing the theme (Design → Themes) changes colours, fonts, sizes and decorations of every slide at once.
Built-in themes: Light, Dark, Midnight blue, Paper, Green, Essential (`app/src/slides/themes.ts`).

## Editing

Text with bold / italic / colours / sizes, multi-level lists (`Tab` / `Shift+Tab`), shapes, tables, pictures (insert, paste
or drop), speaker notes, hidden slides, copy / paste, undo.
**Slide show**: `F5` (from the start) or `Shift+F5` (from the current slide); arrows, space or click to advance, `B` black
screen, `W` white screen, `S` notes. Printing and PDF export produce one page per slide.

## Files

- **Opens and saves `.pptx`** (also reads `.ppsx`, `.potx`, `.pptm`). Positions and styles are written explicitly, together with
  real placeholders and layouts, so PowerPoint, Keynote and LibreOffice show the same thing.
- `.ppt` and `.odp` are converted with LibreOffice when opened and saved as `.pptx`.
- **Read from PowerPoint files**: text (caps, letter spacing, line spacing), shapes including hand-drawn ones, groups,
  pictures, tables, backgrounds, master and layout decorations, notes, transitions, several slide masters.
- Charts, SmartArt, video and embedded objects cannot be edited: they appear as a placeholder and are written back
  into the saved file exactly as they were.
- **Not supported yet**: animations (lost on save), shadows and reflections, picture cropping, vertical text, Keynote, saving to `.odp`.

## How well does it work?

It was verified on three real decks made with PowerPoint (up to 58 slides, two slide masters, 24 layouts, photos and SVG):
opened, saved and reopened in LibreOffice they look nearly identical to the originals (shadows and effects are lost).
It has **not** been tried in real PowerPoint or Keynote — if you can, please check that files saved by ZikOffice open without
a repair prompt and report what you see.

## Tests

`cd app && npx vitest run tests/slides.test.ts`. With `PPTX_SAMPLES=/folder` every `.pptx` in the folder is opened, saved and reopened,
and the text and number of elements must be unchanged.
