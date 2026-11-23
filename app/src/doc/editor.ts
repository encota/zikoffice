// Editor di testo: pagine disegnate su canvas, cursore, selezione, tastiera, mouse, annulla.
import { h, toast } from "../dom";
import { onThemeChange } from "../theme";
import type { CommandState, DocumentView } from "../views/view";
import { fragmentsToHtml, htmlToParagraphs } from "./clipboard";
import { caretX, layoutDocument, measure, offsetAtX, type Layout, type Line, type PageBox } from "./layout";
import { paragraphLength, paragraphText, type DocumentModel, type ImageRun, type Paragraph, type RunProps } from "./model";
import * as ops from "./ops";
import type { Pos, Range, StoryName } from "./ops";
import { SpellChecker, wordsIn } from "./spell";
import { effectivePara, effectiveRun } from "./styles";

import { localeTag, t } from "../i18n";
const PX = 96 / 72; // punti → pixel CSS a zoom 100%
const GAP = 24;     // spazio tra le pagine (px)

export interface DocHost {
  changed(): void;
  selectionChanged(): void;
}

interface UndoEntry { doc: DocumentModel; sel: Range; story: StoryName; kind: string; at: number }

/** Appunti interni: conservano la formattazione quando si incolla nello stesso programma. */
let internalClip: { text: string; paras: Paragraph[] } | null = null;

export class DocEditor implements DocumentView {
  readonly kind = "doc" as const;
  readonly el: HTMLElement;
  dirty = false;

  doc: DocumentModel;
  layout!: Layout;
  sel: Range;
  story: StoryName = "body";
  /** Proprietà da usare per il prossimo testo scritto (es. Grassetto premuto senza selezione). */
  pending: RunProps | null = null;

  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private input: HTMLTextAreaElement;
  private rulerCanvas: HTMLCanvasElement;
  private ruler: HTMLElement;
  readonly overlay: HTMLElement;
  private zoom = 1;
  private raf = 0;
  private caretOn = true;
  private blink = 0;
  private goalX: number | null = null;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private composing = false;
  private dragging: false | "select" | "word" = false;
  /** Ridimensionamento di un'immagine con la maniglia in basso a destra. */
  private imageDrag: { pid: number; off: number; x0: number; w0: number; ratio: number; w: number } | null = null;
  private images = new Map<string, HTMLImageElement>();
  private wordsCache: { rev: number; words: number } = { rev: -1, words: 0 };
  private rev = 0;
  readonly spell = new SpellChecker(() => this.draw());
  /** Paragrafi trovati dalla ricerca (evidenziati). */
  highlights: { pid: number; from: number; to: number; current?: boolean }[] = [];

  constructor(doc: DocumentModel, private state: CommandState, private host: DocHost) {
    this.doc = doc;
    const first = ops.storyParagraphs(doc, "body")[0];
    this.sel = { anchor: { pid: first.id, off: 0 }, focus: { pid: first.id, off: 0 } };

    this.rulerCanvas = h("canvas", { class: "ruler-canvas" });
    this.ruler = h("div", { class: "ruler", "aria-hidden": "true" }, this.rulerCanvas);
    this.canvas = h("canvas", { class: "doc-canvas" });
    this.ctx = this.canvas.getContext("2d")!;
    this.spacer = h("div", { class: "doc-spacer" });
    this.scroller = h("div", { class: "doc-scroller" }, this.spacer);
    this.input = h("textarea", {
      class: "doc-input", "data-doc-input": "", "aria-label": "Testo del documento",
      autocapitalize: "off", autocomplete: "off", spellcheck: "false",
    });
    this.overlay = h("div", { class: "doc-overlay" });
    const area = h("div", { class: "doc-area" }, this.canvas, this.scroller, this.input, this.overlay);
    this.el = h("div", { class: "doc-view" }, this.ruler, area);

    this.relayout();
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(area);
    onThemeChange(() => { this.draw(); this.drawRuler(); });
    this.blink = window.setInterval(() => {
      if (document.activeElement !== this.input) return;
      this.caretOn = !this.caretOn;
      this.draw();
    }, 530);
  }

  // ---------- geometria ----------

  private get scale(): number { return PX * this.zoom; }
  private get pageW(): number { return this.doc.page.width * this.scale; }
  private get pageH(): number { return this.doc.page.height * this.scale; }
  private pageTop(i: number): number { return GAP + i * (this.pageH + GAP) - this.scroller.scrollTop; }
  private pageLeft(): number {
    return Math.max(GAP, (this.scroller.clientWidth - this.pageW) / 2) - this.scroller.scrollLeft;
  }
  /** Da coordinate della pagina (pt) a coordinate dello schermo (px nell'area). */
  private toScreen(page: number, x: number, y: number): { x: number; y: number } {
    return { x: this.pageLeft() + x * this.scale, y: this.pageTop(page) + y * this.scale };
  }

  private updateSpacer(): void {
    const n = this.layout.pages.length;
    this.spacer.style.height = `${GAP + n * (this.pageH + GAP)}px`;
    this.spacer.style.width = `${this.pageW + 2 * GAP}px`;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.scroller.clientWidth, hgt = this.scroller.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hgt * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hgt}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.updateSpacer();
    this.drawRuler();
    this.draw();
  }

  // ---------- layout e cambiamenti ----------

  relayout(): void {
    this.layout = layoutDocument(this.doc);
    this.updateSpacer?.();
  }

  /** Esegue una modifica con possibilità di annullarla. */
  edit(kind: string, fn: () => void): void {
    const now = Date.now();
    const last = this.undoStack[this.undoStack.length - 1];
    // Le lettere scritte di seguito si annullano insieme (come in Word).
    const coalesce = kind === "typing" && last?.kind === "typing" && now - last.at < 1500;
    if (!coalesce) {
      this.undoStack.push({ doc: structuredClone(this.doc), sel: structuredClone(this.sel), story: this.story, kind, at: now });
      if (this.undoStack.length > 200) this.undoStack.shift();
    } else last.at = now;
    this.redoStack = [];
    fn();
    this.afterChange();
  }

  private afterChange(): void {
    this.rev++;
    this.dirty = true;
    this.relayout();
    this.clampSelection();
    this.caretOn = true;
    this.scrollToCaret();
    this.draw();
    this.drawRuler();
    this.host.changed();
  }

  undo(): void {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push({ doc: structuredClone(this.doc), sel: structuredClone(this.sel), story: this.story, kind: e.kind, at: Date.now() });
    this.doc = e.doc; this.sel = e.sel; this.story = e.story;
    this.afterChange();
  }

  redo(): void {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push({ doc: structuredClone(this.doc), sel: structuredClone(this.sel), story: this.story, kind: e.kind, at: Date.now() });
    this.doc = e.doc; this.sel = e.sel; this.story = e.story;
    this.afterChange();
  }

  /** Dopo una modifica la selezione potrebbe puntare a paragrafi spariti. */
  private clampSelection(): void {
    const fix = (p: Pos): Pos => {
      const loc = ops.locate(this.doc, p.pid);
      if (!loc) {
        const first = ops.storyParagraphs(this.doc, this.story)[0] ?? ops.storyParagraphs(this.doc, "body")[0];
        return { pid: first.id, off: 0 };
      }
      return { pid: p.pid, off: Math.min(p.off, paragraphLength(loc.para)) };
    };
    this.sel = { anchor: fix(this.sel.anchor), focus: fix(this.sel.focus) };
  }

  // ---------- selezione ----------

  private get storyParas(): Paragraph[] { return ops.storyParagraphs(this.doc, this.story); }
  private get order(): Map<number, number> { return ops.orderMap(this.storyParas); }
  get collapsed(): boolean { return ops.isCollapsed(this.sel); }
  get range(): [Pos, Pos] { return ops.ordered(this.order, this.sel); }
  para(pid: number): Paragraph | undefined { return ops.locate(this.doc, pid)?.para; }

  setSelection(anchor: Pos, focus: Pos = anchor, keepGoal = false): void {
    this.sel = { anchor, focus };
    if (!keepGoal) this.goalX = null;
    this.pending = null;
    this.caretOn = true;
    this.scrollToCaret();
    this.draw();
    this.drawRuler();
    this.host.selectionChanged();
  }

  /** Linee del racconto attivo in ordine di lettura, con la pagina. */
  private storyLines(): { page: number; line: Line }[] {
    const out: { page: number; line: Line }[] = [];
    const pages = this.story === "body" ? this.layout.pages : [this.layout.pages[this.visiblePage()]];
    for (const pg of pages) for (const line of pg.lines) if (line.story === this.story) out.push({ page: pg.index, line });
    return out;
  }

  /** Pagina più visibile al momento (per intestazione e piè di pagina). */
  visiblePage(): number {
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    return Math.max(0, Math.min(this.layout.pages.length - 1, Math.floor((mid - GAP) / (this.pageH + GAP))));
  }

  /** Riga e pagina in cui si trova una posizione. */
  lineOf(pos: Pos): { page: number; line: Line } | null {
    let arr = this.layout.lines.get(pos.pid);
    if (this.story !== "body") {
      const pg = this.layout.pages[this.visiblePage()];
      arr = pg.lines.filter((l) => l.pid === pos.pid).map((line) => ({ page: pg.index, line }));
    }
    if (!arr?.length) return null;
    for (const e of arr) if (pos.off < e.line.end || (pos.off === e.line.end && e.line.last)) return e;
    return arr[arr.length - 1];
  }

  caretRect(pos: Pos = this.sel.focus): { page: number; x: number; y: number; h: number } | null {
    const at = this.lineOf(pos);
    if (!at) return null;
    return { page: at.page, x: caretX(at.line, pos.off), y: at.line.y, h: at.line.height };
  }

  private scrollToCaret(): void {
    const c = this.caretRect();
    if (!c) return;
    const s = this.scroller;
    const top = GAP + c.page * (this.pageH + GAP) + c.y * this.scale;
    const bottom = top + c.h * this.scale;
    if (top < s.scrollTop + 20) s.scrollTop = top - 40;
    else if (bottom > s.scrollTop + s.clientHeight - 20) s.scrollTop = bottom - s.clientHeight + 40;
    // Il campo di input segue il cursore: le finestre di composizione (accenti, IME) appaiono nel punto giusto.
    const p = this.toScreen(c.page, c.x, c.y);
    this.input.style.left = `${p.x}px`;
    this.input.style.top = `${p.y}px`;
  }

  // ---------- coordinate dello schermo → posizione ----------

  hitTest(x: number, y: number, story: StoryName = this.story): { pos: Pos; page: number; region: StoryName } | null {
    if (!this.layout.pages.length) return null;
    const page = Math.max(0, Math.min(this.layout.pages.length - 1, Math.floor((y + this.scroller.scrollTop - GAP / 2) / (this.pageH + GAP))));
    const px = (x - this.pageLeft()) / this.scale;
    const py = (y - this.pageTop(page)) / this.scale;
    const pg = this.layout.pages[page];
    const dp = this.doc.page;
    const region: StoryName = py < dp.marginTop - 6 ? "header" : py > dp.height - dp.marginBottom + 6 ? "footer" : "body";
    let best: Line | null = null, bestScore = Infinity;
    for (const line of pg.lines) {
      if (line.story !== story || line.pid < 0) continue;
      const dy = py < line.y ? line.y - py : py > line.y + line.height ? py - (line.y + line.height) : 0;
      const left = line.x, right = line.x + line.width;
      const dx = px < left ? left - px : px > right ? px - right : 0;
      const score = dy * 1000 + dx;
      if (score < bestScore) { bestScore = score; best = line; }
    }
    if (!best) {
      // Racconto vuoto su questa pagina (es. intestazione senza paragrafi)
      const paras = ops.storyParagraphs(this.doc, story);
      if (!paras.length) return null;
      return { pos: { pid: paras[0].id, off: 0 }, page, region };
    }
    return { pos: { pid: best.pid, off: offsetAtX(best, px) }, page, region };
  }

  // ---------- eventi ----------

  private bindEvents(): void {
    const s = this.scroller;
    s.addEventListener("scroll", () => { this.draw(); });
    let clicks = 0, lastClick = 0, lastX = 0, lastY = 0;
    const local = (e: MouseEvent) => {
      const r = s.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    s.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const { x, y } = local(e);
      if (x >= s.clientWidth || y >= s.clientHeight) return;
      e.preventDefault();
      const now = Date.now();
      clicks = now - lastClick < 400 && Math.abs(x - lastX) < 5 && Math.abs(y - lastY) < 5 ? clicks + 1 : 1;
      lastClick = now; lastX = x; lastY = y;

      // Doppio clic sull'intestazione o sul piè di pagina: si entra a modificarli (come Word).
      const probe = this.hitTest(x, y, "body");
      if (probe && clicks === 2 && probe.region !== "body" && this.story === "body") { this.enterStory(probe.region); return; }
      if (probe && this.story !== "body" && probe.region === "body" && clicks >= 1) {
        const inStory = this.hitTest(x, y);
        const pg = this.layout.pages[probe.page];
        const near = pg.lines.some((l) => l.story === this.story && Math.abs((y - this.pageTop(probe.page)) / this.scale - (l.y + l.height / 2)) < 30);
        if (!near || !inStory) { this.exitStory(); }
      }
      // Maniglia dell'immagine selezionata, oppure clic su un'immagine.
      const selImg = this.selectedImage();
      if (selImg && this.onImageHandle(selImg, x, y)) {
        s.setPointerCapture(e.pointerId);
        this.imageDrag = { pid: selImg.pid, off: selImg.off, x0: x, w0: selImg.run.width, ratio: selImg.run.width / selImg.run.height, w: selImg.run.width };
        return;
      }
      const img = this.imageAt(x, y);
      if (img && clicks === 1 && !e.shiftKey) {
        this.input.focus({ preventScroll: true });
        this.setSelection({ pid: img.pid, off: img.off }, { pid: img.pid, off: img.off + 1 });
        return;
      }
      const hit = this.hitTest(x, y);
      if (!hit) return;
      this.input.focus({ preventScroll: true });
      s.setPointerCapture(e.pointerId);
      const p = this.para(hit.pos.pid);
      if (clicks === 2 && p) {
        const [a, b] = ops.wordAt(p, hit.pos.off);
        this.setSelection({ pid: p.id, off: a }, { pid: p.id, off: b });
        this.dragging = "word";
      } else if (clicks >= 3 && p) {
        this.setSelection({ pid: p.id, off: 0 }, { pid: p.id, off: paragraphLength(p) });
        this.dragging = false;
      } else {
        if (e.shiftKey) this.setSelection(this.sel.anchor, hit.pos);
        else this.setSelection(hit.pos);
        this.dragging = "select";
      }
      // Ctrl+clic su un collegamento lo apre.
      if ((e.ctrlKey || e.metaKey) && p && clicks === 1) {
        const props = ops.runPropsAt(p, hit.pos.off + 1);
        if (props.link) window.open(props.link, "_blank", "noopener");
      }
    });
    s.addEventListener("pointermove", (e) => {
      const { x, y } = local(e);
      if (this.imageDrag) {
        const pg = this.doc.page;
        const maxW = pg.width - pg.marginLeft - pg.marginRight;
        this.imageDrag.w = Math.max(12, Math.min(maxW, this.imageDrag.w0 + (x - this.imageDrag.x0) / this.scale));
        this.draw();
        return;
      }
      const selImg = this.selectedImage();
      if (selImg && this.onImageHandle(selImg, x, y)) { s.style.cursor = "nwse-resize"; return; }
      const hit = this.hitTest(x, y);
      s.style.cursor = this.imageAt(x, y) ? "default" : "text";
      if (!this.dragging || !hit) return;
      if (this.dragging === "word") {
        const p = this.para(hit.pos.pid);
        if (!p) return;
        const [a, b] = ops.wordAt(p, hit.pos.off);
        const forward = ops.comparePos(this.order, hit.pos, this.sel.anchor) >= 0;
        this.setSelection(this.sel.anchor, { pid: p.id, off: forward ? b : a });
      } else this.setSelection(this.sel.anchor, hit.pos);
      // Trascinando oltre il bordo, la pagina scorre.
      if (y < 10) s.scrollTop -= 20; else if (y > s.clientHeight - 10) s.scrollTop += 20;
    });
    s.addEventListener("pointerup", () => {
      const drag = this.imageDrag;
      if (drag) {
        this.imageDrag = null;
        if (Math.abs(drag.w - drag.w0) > 0.5) {
          this.edit("image", () => {
            const run = this.imageRun(drag.pid, drag.off);
            if (run) { run.width = drag.w; run.height = drag.w / drag.ratio; }
          });
        } else this.draw();
        return;
      }
      const wasDragging = this.dragging;
      this.dragging = false;
      if (wasDragging && this.onMouseSelect) this.onMouseSelect();
    });
    s.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const { x, y } = local(e);
      const hit = this.hitTest(x, y);
      if (hit && (this.collapsed || !this.inSelection(hit.pos))) this.setSelection(hit.pos);
      this.input.focus({ preventScroll: true });
      this.contextMenu?.(e.clientX, e.clientY);
    });

    const inp = this.input;
    inp.addEventListener("keydown", (e) => this.onKey(e));
    inp.addEventListener("compositionstart", () => { this.composing = true; });
    inp.addEventListener("compositionend", (e) => {
      this.composing = false;
      if (e.data) this.typeText(e.data);
      inp.value = "";
    });
    inp.addEventListener("input", (e) => {
      if (this.composing) return;
      const ie = e as InputEvent;
      const text = ie.data ?? inp.value;
      inp.value = "";
      if (ie.inputType === "insertText" && text) this.typeText(text);
    });
    inp.addEventListener("focus", () => { this.caretOn = true; this.draw(); });
    inp.addEventListener("blur", () => this.draw());
    inp.addEventListener("copy", (e) => this.onCopy(e, false));
    inp.addEventListener("cut", (e) => this.onCopy(e, true));
    inp.addEventListener("paste", (e) => this.onPaste(e));
  }

  /** Run immagine alla posizione indicata. */
  private imageRun(pid: number, off: number): ImageRun | null {
    const p = this.para(pid);
    if (!p) return null;
    let pos = 0;
    for (const r of p.runs) {
      const len = r.type === "image" || r.type === "field" ? 1 : r.text.length;
      if (pos === off && r.type === "image") return r;
      pos += len;
      if (pos > off) break;
    }
    return null;
  }

  /** Immagine selezionata (la selezione copre esattamente un'immagine). */
  selectedImage(): { pid: number; off: number; run: ImageRun; rect: { x: number; y: number; w: number; h: number } } | null {
    const [a, b] = this.range;
    if (a.pid !== b.pid || b.off - a.off !== 1) return null;
    const run = this.imageRun(a.pid, a.off);
    if (!run) return null;
    const rect = this.imageRect(a.pid, a.off);
    return rect ? { pid: a.pid, off: a.off, run, rect } : null;
  }

  /** Rettangolo a schermo di un'immagine. */
  private imageRect(pid: number, off: number): { x: number; y: number; w: number; h: number } | null {
    for (const { page, line } of this.layout.lines.get(pid) ?? []) {
      for (const f of line.fragments) {
        if (!f.image || f.start !== off) continue;
        const tl = this.toScreen(page, line.x + f.x, line.y + line.baseline - f.image.height);
        return { x: tl.x, y: tl.y, w: f.image.width * this.scale, h: f.image.height * this.scale };
      }
    }
    return null;
  }

  private imageAt(x: number, y: number): { pid: number; off: number } | null {
    for (const pg of this.layout.pages) {
      const top = this.pageTop(pg.index);
      if (y < top || y > top + this.pageH) continue;
      for (const line of pg.lines) {
        if (line.story !== this.story) continue;
        for (const f of line.fragments) {
          if (!f.image) continue;
          const r = this.imageRect(line.pid, f.start);
          if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { pid: line.pid, off: f.start };
        }
      }
    }
    return null;
  }

  private onImageHandle(img: { rect: { x: number; y: number; w: number; h: number } }, x: number, y: number): boolean {
    return Math.abs(x - (img.rect.x + img.rect.w)) <= 7 && Math.abs(y - (img.rect.y + img.rect.h)) <= 7;
  }

  private inSelection(pos: Pos): boolean {
    const [a, b] = this.range;
    return ops.comparePos(this.order, pos, a) >= 0 && ops.comparePos(this.order, pos, b) <= 0;
  }

  /** Parola sbagliata sotto il cursore (per i suggerimenti del tasto destro). */
  misspelledAtCaret(): { pid: number; start: number; end: number; word: string } | null {
    const pos = this.sel.focus;
    const p = this.para(pos.pid);
    if (!p) return null;
    for (const w of wordsIn(paragraphText(p))) {
      if (pos.off >= w.start && pos.off <= w.end && this.spell.isWrong(w.word)) return { pid: p.id, ...w };
    }
    return null;
  }

  /** Menu del tasto destro (fornito dai comandi). */
  contextMenu?: (x: number, y: number) => void;
  /** Chiamato alla fine di una selezione col mouse (usato da Copia formato). */
  onMouseSelect?: () => void;
  isActive?: (id: string) => boolean | undefined;
  selectValue?: (id: string) => string | undefined;
  setSelect?: (id: string, value: string) => boolean;

  // ---------- scrittura ----------

  typeText(text: string): void {
    if (!text) return;
    const props = this.pending ? { ...this.currentProps(), ...this.pending } : undefined;
    this.edit("typing", () => {
      let pos = this.deleteSelection();
      pos = ops.insertText(this.doc, pos, text, props);
      this.sel = { anchor: pos, focus: pos };
    });
    if (props) this.pending = null;
    this.autoFormat();
  }

  /** Correzioni automatiche come in Word: "- " o "1. " a inizio paragrafo creano un elenco. */
  private autoFormat(): void {
    const pos = this.sel.focus;
    const p = this.para(pos.pid);
    if (!p || p.props.numId !== undefined || this.story !== "body") return;
    const text = paragraphText(p);
    const m = /^(\*|-|•|1[.)]) $/.exec(text);
    if (!m || pos.off !== text.length) return;
    const kind = m[1].startsWith("1") ? "number" : "bullet";
    this.edit("autoformat", () => {
      ops.deleteRange(this.doc, { pid: p.id, off: 0 }, { pid: p.id, off: text.length });
      ops.toggleList(this.doc, { anchor: { pid: p.id, off: 0 }, focus: { pid: p.id, off: 0 } }, kind);
      this.sel = { anchor: { pid: p.id, off: 0 }, focus: { pid: p.id, off: 0 } };
    });
  }

  /** Cancella la selezione (se c'è) e restituisce la posizione del cursore. */
  deleteSelection(): Pos {
    if (this.collapsed) return this.sel.focus;
    const [a, b] = this.range;
    const pos = ops.deleteRange(this.doc, a, b);
    this.sel = { anchor: pos, focus: pos };
    return pos;
  }

  currentProps(): RunProps {
    const pos = this.collapsed ? this.sel.focus : this.range[0];
    const p = this.para(pos.pid);
    if (!p) return {};
    const off = this.collapsed ? pos.off : pos.off + 1;
    return ops.runPropsAt(p, off);
  }

  /** Proprietà effettive (con stile) al cursore, per il ribbon. */
  effectiveProps(): RunProps {
    const pos = this.collapsed ? this.sel.focus : this.range[0];
    const p = this.para(pos.pid);
    if (!p) return {};
    const off = this.collapsed ? pos.off : pos.off + 1;
    const props = effectiveRun(this.doc, p, { props: { ...ops.runPropsAt(p, off), ...(this.pending ?? {}) } });
    return props;
  }

  currentPara(): Paragraph | undefined {
    return this.para(this.sel.focus.pid);
  }

  // ---------- tastiera ----------

  private onKey(e: KeyboardEvent): void {
    if (this.composing || e.isComposing) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const focus = this.sel.focus;
    const p = this.para(focus.pid);
    if (!p) return;
    const move = (pos: Pos, keepGoal = false) => {
      e.preventDefault();
      this.setSelection(shift ? this.sel.anchor : pos, pos, keepGoal);
    };
    const paras = this.storyParas;
    const idx = paras.indexOf(p);

    switch (e.key) {
      case "ArrowLeft": {
        if (!shift && !this.collapsed) return move(this.range[0]);
        if (ctrl) {
          const off = ops.wordBoundary(p, focus.off, -1);
          if (off === focus.off && idx > 0) return move({ pid: paras[idx - 1].id, off: paragraphLength(paras[idx - 1]) });
          return move({ pid: p.id, off });
        }
        if (focus.off > 0) return move({ pid: p.id, off: focus.off - 1 });
        if (idx > 0) return move({ pid: paras[idx - 1].id, off: paragraphLength(paras[idx - 1]) });
        e.preventDefault();
        return;
      }
      case "ArrowRight": {
        if (!shift && !this.collapsed) return move(this.range[1]);
        const len = paragraphLength(p);
        if (ctrl) {
          const off = ops.wordBoundary(p, focus.off, 1);
          if (off === focus.off && idx < paras.length - 1) return move({ pid: paras[idx + 1].id, off: 0 });
          return move({ pid: p.id, off });
        }
        if (focus.off < len) return move({ pid: p.id, off: focus.off + 1 });
        if (idx < paras.length - 1) return move({ pid: paras[idx + 1].id, off: 0 });
        e.preventDefault();
        return;
      }
      case "ArrowUp": case "ArrowDown": {
        if (ctrl) {
          // Ctrl+su/giù: inizio del paragrafo precedente/successivo
          const target = e.key === "ArrowUp" ? (focus.off > 0 ? p : paras[idx - 1]) : paras[idx + 1];
          if (target) return move({ pid: target.id, off: 0 });
          e.preventDefault();
          return;
        }
        return move(this.verticalMove(focus, e.key === "ArrowUp" ? -1 : 1), true);
      }
      case "PageUp": case "PageDown": {
        const lines = Math.max(1, Math.floor(this.scroller.clientHeight / (16 * this.scale)));
        let pos = focus;
        for (let i = 0; i < lines; i++) pos = this.verticalMove(pos, e.key === "PageUp" ? -1 : 1);
        return move(pos, true);
      }
      case "Home": {
        if (ctrl) return move({ pid: paras[0].id, off: 0 });
        const at = this.lineOf(focus);
        return move({ pid: p.id, off: at ? at.line.start : 0 });
      }
      case "End": {
        if (ctrl) { const lp = paras[paras.length - 1]; return move({ pid: lp.id, off: paragraphLength(lp) }); }
        const at = this.lineOf(focus);
        if (!at) return move({ pid: p.id, off: paragraphLength(p) });
        const end = at.line.last ? at.line.end : Math.max(at.line.start, at.line.end - 1);
        return move({ pid: p.id, off: end });
      }
      case "Backspace": {
        e.preventDefault();
        if (!this.collapsed) { this.edit("delete", () => this.deleteSelection()); return; }
        if (focus.off === 0) {
          this.edit("delete", () => { const pos = ops.joinWithPrevious(this.doc, focus); this.sel = { anchor: pos, focus: pos }; });
          return;
        }
        const from = ctrl ? ops.wordBoundary(p, focus.off, -1) : focus.off - 1;
        this.edit(ctrl ? "delete" : "typing", () => {
          ops.deleteRange(this.doc, { pid: p.id, off: from }, focus);
          this.sel = { anchor: { pid: p.id, off: from }, focus: { pid: p.id, off: from } };
        });
        return;
      }
      case "Delete": {
        e.preventDefault();
        if (!this.collapsed) { this.edit("delete", () => this.deleteSelection()); return; }
        if (focus.off >= paragraphLength(p)) { this.edit("delete", () => { ops.joinWithNext(this.doc, focus); }); return; }
        const to = ctrl ? ops.wordBoundary(p, focus.off, 1) : focus.off + 1;
        this.edit("delete", () => { ops.deleteRange(this.doc, focus, { pid: p.id, off: to }); });
        return;
      }
      case "Enter": {
        e.preventDefault();
        if (ctrl) { this.insertPageBreak(); return; }
        if (shift) { this.typeText("\u000b"); return; }
        this.edit("enter", () => {
          const pos = ops.splitParagraph(this.doc, this.deleteSelection());
          this.sel = { anchor: pos, focus: pos };
        });
        return;
      }
      case "Tab": {
        e.preventDefault();
        const cell = ops.adjacentCell(this.doc, p.id, shift ? -1 : 1);
        if (ops.tableAt(this.doc, p.id)) {
          if (cell) { const cp = this.para(cell.pid)!; this.setSelection({ pid: cell.pid, off: 0 }, { pid: cell.pid, off: paragraphLength(cp) }); }
          else if (!shift) this.edit("row", () => { const pos = ops.addTableRow(this.doc, p.id, true); if (pos) this.sel = { anchor: pos, focus: pos }; });
          return;
        }
        if (p.props.numId !== undefined && (focus.off === 0 || !this.collapsed)) {
          this.edit("indent", () => ops.changeIndent(this.doc, this.sel, shift ? -1 : 1));
          return;
        }
        if (!shift) this.typeText("\t");
        return;
      }
      case "Escape":
        if (this.story !== "body") { e.preventDefault(); this.exitStory(); }
        return;
    }
    if (ctrl && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "a") { e.preventDefault(); this.selectAll(); }
    }
  }

  /** Riga sopra/sotto mantenendo la colonna (come fanno tutti gli editor). */
  private verticalMove(pos: Pos, dir: 1 | -1): Pos {
    const lines = this.storyLines();
    const at = this.lineOf(pos);
    if (!at) return pos;
    const i = lines.findIndex((l) => l.line === at.line);
    const x = this.goalX ?? caretX(at.line, pos.off);
    this.goalX = x;
    const target = lines[i + dir];
    if (!target) {
      if (dir < 0) return { pid: at.line.pid, off: 0 };
      const p = this.para(at.line.pid)!;
      return { pid: p.id, off: paragraphLength(p) };
    }
    if (target.line.pid < 0) return this.verticalMove({ pid: target.line.pid, off: target.line.start }, dir);
    return { pid: target.line.pid, off: offsetAtX(target.line, x) };
  }

  selectAll(): void {
    const paras = this.storyParas;
    const last = paras[paras.length - 1];
    this.setSelection({ pid: paras[0].id, off: 0 }, { pid: last.id, off: paragraphLength(last) });
  }

  insertPageBreak(): void {
    if (this.story !== "body") return;
    this.edit("break", () => {
      let pos = this.deleteSelection();
      pos = ops.insertText(this.doc, pos, "\f");
      // Dopo l'interruzione si continua in un nuovo paragrafo.
      pos = ops.splitParagraph(this.doc, pos);
      this.sel = { anchor: pos, focus: pos };
    });
  }

  // ---------- intestazione e piè di pagina ----------

  enterStory(story: StoryName): void {
    const list = story === "header" ? this.doc.header : this.doc.footer;
    if (!list.length) {
      this.edit("story", () => {
        list.push({ type: "p", id: this.doc.nextId++, props: { style: story === "header" ? "Header" : "Footer" }, runs: [] });
      });
    }
    this.story = story;
    const p = list[list.length - 1];
    this.setSelection({ pid: p.id, off: paragraphLength(p) });
    this.input.focus({ preventScroll: true });
    toast(story === "header" ? "Stai modificando l'intestazione (Esc per tornare al testo)" : "Stai modificando il piè di pagina (Esc per tornare al testo)");
  }

  exitStory(): void {
    if (this.story === "body") return;
    this.story = "body";
    const first = ops.storyParagraphs(this.doc, "body")[0];
    this.setSelection({ pid: first.id, off: 0 });
  }

  // ---------- appunti ----------

  selectedText(): string {
    if (this.collapsed) return "";
    const [a, b] = this.range;
    return ops.extractRange(this.doc, a, b).map(paragraphText).join("\n").replace(/[\f\u000b]/g, "\n").replace(/￼/g, "");
  }

  /** Testo per l'assistente: la selezione, oppure (o se `whole`) il corpo del documento. */
  aiText(whole: boolean): { text: string; selection: boolean } {
    if (!whole && !this.collapsed) return { text: this.selectedText(), selection: true };
    const text = ops.storyParagraphs(this.doc, "body").map(paragraphText).join("\n").replace(/[\f\u000b]/g, "\n").replace(/￼/g, "");
    return { text, selection: false };
  }

  /** Scrive il risultato dell'assistente: sostituisce il testo di partenza o lo aggiunge dopo. */
  /** Sostituisce tutto il documento (es. dopo aver modificato il sorgente Markdown); si annulla con Ctrl+Z. */
  replaceDocument(doc: DocumentModel): void {
    this.edit("source", () => { this.doc = doc; this.story = "body"; });
  }

  aiApply(mode: "replace" | "insert", text: string, selection: boolean): void {
    if (selection) {
      if (mode === "insert") this.setSelection(this.range[1]);
    } else {
      this.story = "body";
      this.selectAll();
      if (mode === "insert") this.setSelection(this.range[1]);
    }
    this.typeText(mode === "insert" ? `\n${text}` : text);
  }

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    e.preventDefault();
    if (this.collapsed) return;
    const [a, b] = this.range;
    const paras = ops.extractRange(this.doc, a, b);
    const text = this.selectedText();
    internalClip = { text, paras };
    e.clipboardData?.setData("text/plain", text);
    e.clipboardData?.setData("text/html", fragmentsToHtml(this.doc, paras));
    if (cut) this.edit("cut", () => this.deleteSelection());
  }

  private onPaste(e: ClipboardEvent): void {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const html = e.clipboardData?.getData("text/html") ?? "";
    this.paste(text, html);
  }

  paste(text: string, html = ""): void {
    let frag: Paragraph[] | null = null;
    if (internalClip && internalClip.text === text) frag = structuredClone(internalClip.paras);
    else if (html) frag = htmlToParagraphs(this.doc, html);
    this.edit("paste", () => {
      let pos = this.deleteSelection();
      pos = frag && frag.length ? ops.insertFragment(this.doc, pos, frag) : ops.insertText(this.doc, pos, text.replace(/\r\n?/g, "\n"));
      this.sel = { anchor: pos, focus: pos };
    });
  }

  async pasteFromMenu(): Promise<void> {
    if (internalClip) { this.paste(internalClip.text); return; }
    try { this.paste(await navigator.clipboard.readText()); } catch { toast("Per incollare da un'altra applicazione usa Ctrl+V"); }
  }

  copyFromMenu(cut: boolean): void {
    this.input.focus();
    document.execCommand(cut ? "cut" : "copy");
  }

  // ---------- disegno ----------

  draw(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }

  private image(src: string): HTMLImageElement | null {
    let img = this.images.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => this.draw();
      img.src = src;
      this.images.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  private paint(): void {
    const ctx = this.ctx;
    const W = this.scroller.clientWidth, H = this.scroller.clientHeight;
    if (!W || !H) return;
    const cs = getComputedStyle(this.el);
    ctx.fillStyle = cs.getPropertyValue("--canvas-bg").trim() || "#e9ebef";
    ctx.fillRect(0, 0, W, H);
    const scale = this.scale;
    const accent = cs.getPropertyValue("--doc-accent").trim() || "#2f5bd3";
    const showMarks = this.state.isOn("showMarks");
    const focused = document.activeElement === this.input;
    const [selA, selB] = this.range;
    const order = this.order;

    for (const pg of this.layout.pages) {
      const top = this.pageTop(pg.index);
      if (top > H || top + this.pageH < 0) continue;
      const left = this.pageLeft();
      // Pagina
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.18)";
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 1;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(left, top, this.pageW, this.pageH);
      ctx.restore();

      ctx.save();
      ctx.translate(left, top);
      ctx.scale(scale, scale);
      ctx.beginPath();
      ctx.rect(0, 0, this.doc.page.width, this.doc.page.height);
      ctx.clip();

      for (const f of pg.fills) { ctx.fillStyle = f.color; ctx.fillRect(f.x, f.y, f.w, f.h); }

      // Filigrana diagonale (se impostata)
      if (this.doc.watermark) {
        ctx.save();
        ctx.translate(this.doc.page.width / 2, this.doc.page.height / 2);
        ctx.rotate(-Math.PI / 5.2);
        ctx.fillStyle = "rgba(128, 128, 128, 0.16)";
        ctx.font = "bold 64px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(this.doc.watermark, 0, 0);
        ctx.restore();
      }

      // Selezione (sotto il testo)
      if (!this.collapsed) {
        ctx.fillStyle = "rgba(47, 91, 211, 0.22)";
        for (const line of pg.lines) {
          if (line.story !== this.story) continue;
          const oi = order.get(line.pid);
          if (oi === undefined) continue;
          const ai = order.get(selA.pid)!, bi = order.get(selB.pid)!;
          if (oi < ai || oi > bi) continue;
          const from = oi === ai ? Math.max(line.start, selA.off) : line.start;
          const to = oi === bi ? Math.min(line.end, selB.off) : line.end;
          if (to < from || (to === from && !(line.last && oi < bi))) continue;
          if (from > line.end || to < line.start) continue;
          const x1 = caretX(line, from);
          let x2 = caretX(line, to);
          if (line.last && oi < bi) x2 += 4; // il segno di paragrafo è selezionato
          ctx.fillRect(x1, line.y, Math.max(2, x2 - x1), line.height);
        }
      }
      // Risultati della ricerca
      for (const hl of this.highlights) {
        const arr = this.layout.lines.get(hl.pid);
        if (!arr) continue;
        for (const { page, line } of arr) {
          if (page !== pg.index || hl.to <= line.start || hl.from >= line.end) continue;
          const x1 = caretX(line, Math.max(hl.from, line.start)), x2 = caretX(line, Math.min(hl.to, line.end));
          ctx.fillStyle = hl.current ? "rgba(255, 150, 0, 0.55)" : "rgba(255, 213, 0, 0.45)";
          ctx.fillRect(x1, line.y, x2 - x1, line.height);
        }
      }

      for (const line of pg.lines) {
        const dim = line.story !== this.story;
        ctx.globalAlpha = dim ? 0.45 : 1;
        this.paintLine(line, showMarks && !dim);
      }
      ctx.globalAlpha = 1;
      for (const b of pg.borders) {
        ctx.strokeStyle = b.color;
        ctx.lineWidth = b.width;
        ctx.setLineDash(b.style === "dashed" ? [3, 2] : b.style === "dotted" ? [1, 1.5] : []);
        ctx.beginPath();
        ctx.moveTo(b.x1, b.y1);
        ctx.lineTo(b.x2, b.y2);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Confine di intestazione / piè di pagina quando si modificano
      if (this.story !== "body") {
        const dp = this.doc.page;
        const y = this.story === "header" ? dp.marginTop - 8 : dp.height - dp.marginBottom + 8;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 0.75;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(dp.width, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = accent;
        ctx.font = "7.5px system-ui, sans-serif";
        ctx.fillText(this.story === "header" ? "Intestazione" : "Piè di pagina", dp.marginLeft, this.story === "header" ? y + 9 : y - 3);
      }

      // Cursore
      if (this.collapsed && focused && this.caretOn) {
        const c = this.caretRect();
        if (c && (c.page === pg.index || this.story !== "body")) {
          const props = this.effectiveProps();
          ctx.fillStyle = props.color ?? "#000000";
          ctx.fillRect(c.x - 0.4, c.y + 1, Math.max(0.8, 1 / scale * 1.5), c.h - 2);
        }
      }
      ctx.restore();
    }
    // Immagine selezionata: cornice e maniglie (anteprima mentre si ridimensiona)
    const img = this.selectedImage();
    if (img) {
      const w = this.imageDrag ? this.imageDrag.w * this.scale : img.rect.w;
      const hh = this.imageDrag ? (this.imageDrag.w / this.imageDrag.ratio) * this.scale : img.rect.h;
      const y0 = img.rect.y + img.rect.h - hh; // l'immagine poggia sulla linea di base
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      if (this.imageDrag) ctx.setLineDash([5, 3]);
      ctx.strokeRect(img.rect.x + 0.5, y0 + 0.5, w, hh);
      ctx.setLineDash([]);
      ctx.fillStyle = "#fff";
      for (const [hx, hy] of [[0, 0], [w, 0], [0, hh], [w, hh], [w / 2, 0], [w / 2, hh], [0, hh / 2], [w, hh / 2]]) {
        ctx.beginPath();
        ctx.arc(img.rect.x + hx + 0.5, y0 + hy + 0.5, hx === w && hy === hh ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private paintLine(line: Line, showMarks: boolean): void {
    const ctx = this.ctx;
    const spell = this.spell.enabled && line.story === this.story;
    const baseY = line.y + line.baseline;
    for (const f of line.fragments) {
      const x = line.x + f.x;
      if (f.image) {
        const img = this.image(f.image.src);
        const y = baseY - f.image.height;
        if (img) ctx.drawImage(img, x, y, f.image.width, f.image.height);
        else { ctx.strokeStyle = "#bbb"; ctx.lineWidth = 0.5; ctx.strokeRect(x, y, f.image.width, f.image.height); }
        continue;
      }
      if (f.props.highlight && !f.label) { ctx.fillStyle = f.props.highlight; ctx.fillRect(x, line.y, f.width, line.height); }
      if (f.tab) {
        if (f.tab.leader === "dot") {
          ctx.fillStyle = f.props.color ?? "#000";
          const step = 3.2;
          for (let dx = Math.ceil(x / step) * step + 1; dx < x + f.width - 3; dx += step) ctx.fillRect(dx, baseY - 0.8, 0.8, 0.8);
        }
        if (showMarks) { ctx.fillStyle = "#7a8cc2"; ctx.font = "8px system-ui"; ctx.fillText("→", x + f.width / 2 - 3, baseY); }
        continue;
      }
      if (!f.text) {
        if (showMarks && line.pageBreak) {
          ctx.fillStyle = "#7a8cc2"; ctx.font = "7px system-ui";
          ctx.fillText("···· Interruzione di pagina ····", x + 2, baseY);
        }
        continue;
      }
      ctx.font = f.font;
      ctx.fillStyle = f.props.color ?? "#000000";
      const y = baseY + f.shift;
      if (f.justify) {
        // Riga giustificata: ogni spazio si allarga di `justify`.
        let cx = x;
        for (const part of f.text.split(/( )/)) {
          if (part === " ") { cx += measure(f.font, " ") + f.justify; continue; }
          ctx.fillText(part, cx, y);
          cx += measure(f.font, part);
        }
      } else ctx.fillText(f.text, x, y);
      const size = f.props.size ?? 11;
      if (spell && !f.label) this.paintSpelling(line, f, x, y, size);
      if (f.props.underline) ctx.fillRect(x, y + size * 0.12, f.width, Math.max(0.5, size * 0.06));
      if (f.props.strike) ctx.fillRect(x, y - size * 0.3, f.width, Math.max(0.5, size * 0.06));
      if (showMarks && f.text.includes(" ")) {
        ctx.fillStyle = "#7a8cc2";
        let cx = x;
        for (const ch of f.text) {
          const w = measure(f.font, ch) + (ch === " " ? f.justify ?? 0 : 0);
          if (ch === " ") ctx.fillRect(cx + w / 2 - 0.5, y - size * 0.3, 1, 1);
          cx += w;
        }
      }
    }
    if (showMarks && line.last) {
      ctx.fillStyle = "#7a8cc2";
      ctx.font = `${Math.min(11, line.height * 0.8)}px system-ui`;
      ctx.fillText("¶", caretX(line, line.end) + 1, line.y + line.baseline);
    }
  }

  /** Sottolineatura ondulata rossa sotto le parole sbagliate. */
  private paintSpelling(line: Line, f: Line["fragments"][number], x: number, y: number, size: number): void {
    const ctx = this.ctx;
    const caret = this.collapsed && this.sel.focus.pid === line.pid ? this.sel.focus.off : -1;
    for (const w of wordsIn(f.text)) {
      // La parola che si sta scrivendo non si segnala finché non la si finisce.
      if (caret >= f.start + w.start && caret <= f.start + w.end) continue;
      if (this.spell.isWrong(w.word) !== true) continue;
      const spaces = f.justify ? f.text.slice(0, w.start).split(" ").length - 1 : 0;
      const x1 = x + measure(f.font, f.text.slice(0, w.start)) + spaces * (f.justify ?? 0);
      const x2 = x1 + measure(f.font, f.text.slice(w.start, w.end));
      const base = y + size * 0.2;
      ctx.save();
      ctx.strokeStyle = "#e0312b";
      ctx.lineWidth = Math.max(0.5, size * 0.05);
      ctx.beginPath();
      const step = Math.max(1.4, size * 0.13);
      for (let px = x1, up = true; px < x2; px += step, up = !up) {
        if (px === x1) ctx.moveTo(px, base);
        ctx.lineTo(Math.min(px + step, x2), base + (up ? -step / 2 : 0));
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---------- righello ----------

  drawRuler(): void {
    const c = this.rulerCanvas;
    const w = this.ruler.clientWidth, hgt = this.ruler.clientHeight;
    if (!w || !hgt || this.ruler.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = hgt * dpr;
    c.style.width = `${w}px`; c.style.height = `${hgt}px`;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(this.el);
    ctx.fillStyle = cs.getPropertyValue("--surface").trim();
    ctx.fillRect(0, 0, w, hgt);
    const dp = this.doc.page, s = this.scale;
    const left = this.pageLeft();
    ctx.fillStyle = cs.getPropertyValue("--canvas-bg").trim();
    ctx.fillRect(left, 4, this.pageW, hgt - 8);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(left + dp.marginLeft * s, 4, (dp.width - dp.marginLeft - dp.marginRight) * s, hgt - 8);
    ctx.fillStyle = cs.getPropertyValue("--text-muted").trim();
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    const cmPx = (72 / 2.54) * s;
    const origin = left + dp.marginLeft * s;
    for (let i = -Math.floor(dp.marginLeft / (72 / 2.54)); origin + i * cmPx < left + this.pageW; i++) {
      const x = origin + i * cmPx;
      if (i !== 0 && i % 1 === 0) ctx.fillText(String(Math.abs(i)), x, hgt / 2 + 3);
      ctx.fillRect(x + cmPx / 2, hgt / 2 - 1, 1, 2);
    }
    // Rientri del paragrafo corrente
    const p = this.currentPara();
    if (p && this.story === "body") {
      const props = effectivePara(this.doc, p);
      const accent = cs.getPropertyValue("--doc-accent").trim();
      ctx.fillStyle = accent;
      const il = origin + (props.indentLeft ?? 0) * s;
      const fl = il + (props.firstLine ?? 0) * s;
      const ir = left + (dp.width - dp.marginRight - (props.indentRight ?? 0)) * s;
      tri(ctx, fl, 4, false); tri(ctx, il, hgt - 4, true); tri(ctx, ir, hgt - 4, true);
    }
  }

  // ---------- DocumentView ----------

  /** Il conteggio delle parole si aggiorna poco dopo l'ultima modifica, non a ogni tasto. */
  private wordsTimer = 0;
  private scheduleWordCount(): void {
    if (this.wordsTimer) return; // già in programma: non lo rimandiamo all'infinito
    this.wordsTimer = window.setTimeout(() => {
      this.wordsTimer = 0;
      this.wordsCache = { rev: this.rev, words: ops.wordCount(this.doc) };
      this.host.selectionChanged();
    }, this.wordsCache.rev < 0 ? 0 : 600);
  }

  status(): string[] {
    if (this.wordsCache.rev < 0) this.wordsCache = { rev: this.rev, words: ops.wordCount(this.doc) };
    else if (this.wordsCache.rev !== this.rev) this.scheduleWordCount();
    const c = this.caretRect();
    const page = (c?.page ?? 0) + 1;
    const out = [t("Pagina {0} di {1}", page, this.layout.pages.length), t("{0} parole", this.wordsCache.words.toLocaleString(localeTag()))];
    if (!this.collapsed) {
      const n = this.selectedText().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
      out[1] = t("{0} di {1} parole", n, this.wordsCache.words.toLocaleString(localeTag()));
    }
    out.push("Italiano (Italia)");
    return out;
  }

  setZoom(zoom: number): void {
    const s = this.scroller;
    const ratio = zoom / this.zoom;
    this.zoom = zoom;
    this.updateSpacer();
    s.scrollTop *= ratio;
    this.drawRuler();
    this.draw();
  }

  fitWidthZoom(): number {
    return Math.max(0.25, (this.scroller.clientWidth - 2 * GAP) / (this.doc.page.width * PX));
  }

  handle(_id: string, _anchor?: HTMLElement): boolean {
    return false; // sostituito dai comandi (vedi commands.ts)
  }

  shown(): void {
    this.ruler.hidden = !this.state.isOn("ruler");
    this.resize();
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  markSaved(): void {
    this.dirty = false;
  }

  /** Pagine disegnabili (per la stampa). */
  get pages(): PageBox[] {
    return this.layout.pages;
  }

  dispose(): void {
    clearInterval(this.blink);
  }
}

function tri(ctx: CanvasRenderingContext2D, x: number, y: number, up: boolean): void {
  ctx.beginPath();
  if (up) { ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.lineTo(x, y - 5); }
  else { ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 5); }
  ctx.fill();
}
