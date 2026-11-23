// Editor delle presentazioni: miniature a sinistra, diapositiva al centro, note sotto.
import { h, toast } from "../dom";
import { inTauri, readBinary } from "../files";
import { t, tr } from "../i18n";
import { openMenu, type MenuItem } from "../ui/menu";
import { prompt as promptDialog } from "../ui/dialog";
import type { DocumentView } from "../views/view";
import { CommandState } from "../views/view";
import {
  cloneSlide, deepCopy, itemText, newId, newSlide, paraText, slideTitle,
  type Align, type Anchor, type Frame, type Geometry, type ImageItem, type LayoutId, type Para, type Presentation,
  type ShapeItem, type Slide, type SlideItem, type TableItem, type TextRun,
} from "./model";
import { placeItems, type Placed } from "./layout";
import { fitText, renderSlide, shapeStyle } from "./render";
import { readText, fillText, isTextEmpty } from "./text";
import { getOffsets, normalize, parasInRange, runAt, runsInRange, setOffsets, totalLen, wordAround } from "./edit";
import { themeById } from "./themes";
import { mimeOf } from "./pptxImport";
import { startSlideshow } from "./show";

interface Hooks { changed(): void; selectionChanged(): void }

interface Snapshot { slides: Slide[]; theme: Presentation["theme"]; width: number; height: number; current: number; decor: Presentation["decor"] }

interface Editing {
  id: number;
  box: HTMLElement;
  /** Cella della tabella in modifica. */
  cell?: [number, number];
  before: Snapshot;
  changed: boolean;
}

type Drag =
  | { kind: "move"; x0: number; y0: number; frames: Map<number, Frame>; moved: boolean; before: Snapshot; clickEdit: boolean; clientX: number; clientY: number }
  | { kind: "resize"; x0: number; y0: number; frame: Frame; handle: string; id: number; before: Snapshot; moved: boolean };

export const LAYOUT_LABELS: [LayoutId, string][] = [
  ["title", "Diapositiva titolo"], ["content", "Titolo e contenuto"], ["two", "Due contenuti"],
  ["section", "Intestazione sezione"], ["titleOnly", "Solo titolo"], ["blank", "Vuota"],
];

const SHAPES: [Geometry, string, Parameters<typeof import("../icons").icon>[0]][] = [
  ["rect", "Rettangolo", "RectangleHorizontal"], ["roundRect", "Rettangolo arrotondato", "Square"], ["ellipse", "Ellisse", "Circle"],
  ["triangle", "Triangolo", "Triangle"], ["diamond", "Rombo", "Diamond"], ["rightArrow", "Freccia", "ArrowRight"],
  ["chevron", "Gallone", "ChevronUp"], ["star5", "Stella", "Star"], ["line", "Linea", "Slash"],
];

let clipboard: { items: SlideItem[]; slides?: Slide[]; stamp: string } | null = null;

export class SlideView implements DocumentView {
  readonly kind = "slides" as const;
  readonly el: HTMLElement;
  dirty = false;
  current = 0;
  private selected: number[] = [];
  private editing: Editing | null = null;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private zoom = 1;
  private scale = 1;
  private drag: Drag | null = null;
  private showNotes = true;
  private showThumbs = true;
  private thumbTimer = 0;

  private thumbs = h("div", { class: "sv-thumbs", tabindex: "0", "aria-label": "Diapositive" });
  private stage = h("div", { class: "sv-stage", tabindex: "-1" });
  private wrap = h("div", { class: "sv-wrap" });
  private host = h("div", { class: "sv-host" });
  private overlay = h("div", { class: "sv-overlay" });
  private notes = h("textarea", { class: "sv-notes", placeholder: "Fai clic per aggiungere le note del relatore", spellcheck: "true" });
  private slideEl: HTMLElement | null = null;
  private placed: Placed[] = [];

  constructor(public p: Presentation, readonly state: CommandState, private hooks: Hooks) {
    this.wrap.append(this.host, this.overlay);
    this.stage.append(this.wrap);
    const center = h("div", { class: "sv-center" }, this.stage, this.notes);
    this.el = h("div", { class: "slides-view" }, this.thumbs, center);
    this.bind();
    this.render();
  }

  // ---------- stato e storia ----------

  get slide(): Slide { return this.p.slides[this.current]; }

  private snapshot(): Snapshot {
    return { slides: deepCopy(this.p.slides), theme: { ...this.p.theme }, width: this.p.width, height: this.p.height, current: this.current, decor: this.p.decor };
  }

  private restore(s: Snapshot): void {
    this.p.slides = deepCopy(s.slides);
    this.p.theme = { ...s.theme };
    this.p.width = s.width;
    this.p.height = s.height;
    this.p.decor = s.decor;
    this.current = Math.min(s.current, this.p.slides.length - 1);
    this.selected = [];
  }

  private pushUndo(s: Snapshot): void {
    this.undoStack.push(s);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Modifica con annulla: `fn` cambia il modello, poi si ridisegna. */
  edit(fn: () => void, opts: { thumbsAll?: boolean } = {}): void {
    this.finishEdit();
    const before = this.snapshot();
    fn();
    this.pushUndo(before);
    this.touched(opts.thumbsAll ?? true);
  }

  private touched(all: boolean): void {
    this.dirty = true;
    this.current = Math.max(0, Math.min(this.current, this.p.slides.length - 1));
    this.selected = this.selected.filter((id) => this.slide.items.some((i) => i.id === id));
    if (all) this.render(); else { this.renderStage(); this.updateThumb(this.current); }
    this.hooks.changed();
  }

  markSaved(): void { this.dirty = false; this.hooks.changed(); }

  undo(): void {
    if (this.editing?.changed) this.finishEdit();
    else this.cancelEdit();
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
    this.touched(true);
  }

  redo(): void {
    this.finishEdit();
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
    this.touched(true);
  }

  // ---------- disegno ----------

  private render(): void {
    this.renderThumbs();
    this.renderStage();
    this.notes.value = this.slide.notes;
    this.notes.hidden = !this.showNotes;
    this.thumbs.hidden = !this.showThumbs;
  }

  private thumbScale(): number { return 168 / this.p.width; }

  private thumbFor(i: number): HTMLElement {
    const s = this.p.slides[i];
    const slideEl = renderSlide(this.p, s, "thumb");
    const sc = this.thumbScale();
    slideEl.style.transform = `scale(${sc})`;
    const frame = h("div", { class: "sv-thumb-frame", style: `width:${Math.round(this.p.width * sc)}px;height:${Math.round(this.p.height * sc)}px` }, slideEl);
    const el = h("div", {
      class: `sv-thumb${i === this.current ? " current" : ""}${s.hidden ? " hidden-slide" : ""}`, draggable: "true",
      "data-index": String(i), title: slideTitle(s) || t("Diapositiva {0}", i + 1),
    }, h("span", { class: "sv-thumb-num" }, String(i + 1)), frame);
    return el;
  }

  private renderThumbs(): void {
    this.thumbs.replaceChildren(...this.p.slides.map((_, i) => this.thumbFor(i)));
    requestAnimationFrame(() => {
      this.thumbs.querySelectorAll<HTMLElement>(".sv-thumb").forEach((el, i) => {
        const s = this.p.slides[i];
        const se = el.querySelector<HTMLElement>(".st-slide");
        if (s && se) fitText(se, s);
      });
      this.thumbs.querySelector(".sv-thumb.current")?.scrollIntoView({ block: "nearest" });
    });
  }

  private updateThumb(i: number): void {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => {
      const old = this.thumbs.querySelector(`.sv-thumb[data-index="${i}"]`);
      if (!old || !this.p.slides[i]) { this.renderThumbs(); return; }
      const el = this.thumbFor(i);
      old.replaceWith(el);
      const se = el.querySelector<HTMLElement>(".st-slide");
      if (se) fitText(se, this.p.slides[i]);
    }, 120);
  }

  private computeScale(): void {
    const w = this.stage.clientWidth - 48, hh = this.stage.clientHeight - 48;
    const fit = w > 0 && hh > 0 ? Math.min(w / this.p.width, hh / this.p.height) : 0.6;
    this.scale = Math.max(0.05, fit * this.zoom);
  }

  private renderStage(): void {
    this.computeScale();
    const slideEl = renderSlide(this.p, this.slide, "edit");
    slideEl.style.transform = `scale(${this.scale})`;
    this.wrap.style.width = `${this.p.width * this.scale}px`;
    this.wrap.style.height = `${this.p.height * this.scale}px`;
    this.host.replaceChildren(slideEl);
    this.slideEl = slideEl;
    this.placed = placeItems(this.p, this.slide);
    if (this.slideEl.isConnected) fitText(this.slideEl, this.slide);
    this.drawOverlay();
  }

  private frameOf(id: number): Frame | undefined {
    return this.placed.find((pl) => pl.item.id === id)?.frame;
  }

  private drawOverlay(): void {
    const s = this.scale;
    const boxes: HTMLElement[] = [];
    for (const id of this.selected) {
      const f = this.liveFrame(id) ?? this.frameOf(id);
      if (!f) continue;
      const editing = this.editing?.id === id;
      const box = h("div", { class: `sv-sel${editing ? " editing" : ""}`, style: `left:${f.x * s}px;top:${f.y * s}px;width:${f.w * s}px;height:${f.h * s}px` });
      if (this.selected.length === 1 && !editing) {
        for (const hd of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) box.append(h("span", { class: `sv-handle h-${hd}`, "data-handle": hd }));
      }
      boxes.push(box);
    }
    this.overlay.replaceChildren(...boxes);
  }

  /** Durante il trascinamento la posizione corrente è nello stile dell'elemento. */
  private liveFrame(id: number): Frame | undefined {
    if (!this.drag) return undefined;
    const el = this.itemEl(id);
    if (!el) return undefined;
    return { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) };
  }

  private itemEl(id: number): HTMLElement | null {
    return this.slideEl?.querySelector<HTMLElement>(`.st-item[data-id="${id}"]`) ?? null;
  }

  item(id: number): SlideItem | undefined {
    return this.slide.items.find((i) => i.id === id);
  }

  goTo(i: number): void {
    this.finishEdit();
    if (i < 0 || i >= this.p.slides.length) return;
    this.current = i;
    this.selected = [];
    this.thumbs.querySelectorAll(".sv-thumb").forEach((el, k) => el.classList.toggle("current", k === i));
    this.thumbs.querySelector(".sv-thumb.current")?.scrollIntoView({ block: "nearest" });
    this.notes.value = this.slide.notes;
    this.renderStage();
    this.hooks.selectionChanged();
  }

  // ---------- eventi ----------

  private bind(): void {
    new ResizeObserver(() => { if (this.el.isConnected && !this.editing) this.renderStage(); }).observe(this.stage);
    this.wrap.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.wrap.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.wrap.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.wrap.addEventListener("dblclick", (e) => {
      const id = this.hitId(e.target as HTMLElement);
      if (id !== null && this.editing?.id !== id) this.beginEdit(id, { x: e.clientX, y: e.clientY }, e.target as HTMLElement);
    });
    this.wrap.addEventListener("contextmenu", (e) => this.itemMenu(e));
    this.stage.addEventListener("pointerdown", (e) => {
      if (e.target === this.stage) { this.finishEdit(); this.select([]); this.stage.focus(); }
    });
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    this.el.addEventListener("paste", (e) => this.onPaste(e));
    this.el.addEventListener("copy", (e) => { if (!this.editing && this.selected.length) { e.preventDefault(); this.copy(e.clipboardData); } });
    this.el.addEventListener("cut", (e) => { if (!this.editing && this.selected.length) { e.preventDefault(); this.copy(e.clipboardData); this.deleteSelected(); } });

    // Clic sulle miniature o sulle note: si chiude la modifica del testo.
    this.thumbs.addEventListener("pointerdown", () => this.finishEdit());
    this.notes.addEventListener("focus", () => this.finishEdit());
    this.notes.addEventListener("input", () => {
      this.slide.notes = this.notes.value;
      this.dirty = true;
      this.hooks.changed();
    });

    // Miniature: clic, menu, trascinamento per riordinare.
    this.thumbs.addEventListener("click", (e) => {
      const th = (e.target as HTMLElement).closest<HTMLElement>(".sv-thumb");
      if (th) this.goTo(Number(th.dataset.index));
    });
    this.thumbs.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const th = (e.target as HTMLElement).closest<HTMLElement>(".sv-thumb");
      if (th) this.goTo(Number(th.dataset.index));
      openMenu({ x: e.clientX, y: e.clientY }, this.slideMenuItems());
    });
    this.thumbs.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); this.goTo(this.current + 1); }
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); this.goTo(this.current - 1); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); this.deleteSlide(); }
      else if (e.key === "Enter") { e.preventDefault(); this.addSlide(); }
    });
    let dragFrom = -1;
    this.thumbs.addEventListener("dragstart", (e) => {
      const th = (e.target as HTMLElement).closest<HTMLElement>(".sv-thumb");
      if (!th) return;
      dragFrom = Number(th.dataset.index);
      e.dataTransfer?.setData("text/plain", "");
    });
    const dropIndex = (e: DragEvent) => {
      const list = [...this.thumbs.querySelectorAll<HTMLElement>(".sv-thumb")];
      let idx = list.length;
      for (let i = 0; i < list.length; i++) {
        const r = list[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { idx = i; break; }
      }
      return idx;
    };
    this.thumbs.addEventListener("dragover", (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const idx = dropIndex(e);
      this.thumbs.querySelectorAll(".sv-thumb").forEach((el, i) => {
        el.classList.toggle("drop-before", i === idx);
        el.classList.toggle("drop-after", idx === this.p.slides.length && i === idx - 1);
      });
    });
    this.thumbs.addEventListener("dragend", () => {
      dragFrom = -1;
      this.thumbs.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
    });
    this.thumbs.addEventListener("drop", (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const to = dropIndex(e);
      const from = dragFrom;
      dragFrom = -1;
      if (to === from || to === from + 1) { this.renderThumbs(); return; }
      this.edit(() => {
        const [s] = this.p.slides.splice(from, 1);
        const dest = to > from ? to - 1 : to;
        this.p.slides.splice(dest, 0, s);
        this.current = dest;
      });
    });
  }

  private toSlide(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.wrap.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
  }

  private hitId(target: HTMLElement): number | null {
    const el = target.closest<HTMLElement>(".st-item[data-id]");
    return el && !el.classList.contains("st-decor") ? Number(el.dataset.id) : null;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (this.editing && this.editing.box.contains(target)) return; // clic nel testo in modifica
    const handle = target.closest<HTMLElement>(".sv-handle");
    if (handle && this.selected.length === 1) {
      const id = this.selected[0];
      const f = this.frameOf(id);
      if (!f) return;
      e.preventDefault();
      const pt = this.toSlide(e);
      this.drag = { kind: "resize", x0: pt.x, y0: pt.y, frame: { ...f }, handle: handle.dataset.handle!, id, before: this.snapshot(), moved: false };
      this.wrap.setPointerCapture(e.pointerId);
      return;
    }
    // Il riquadro di selezione sta sopra: si cerca l'elemento sotto il puntatore.
    const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el instanceof HTMLElement && el.closest(".st-item[data-id]:not(.st-decor)")) as HTMLElement | undefined;
    const id = under ? this.hitId(under) : null;
    this.finishEdit();
    if (id === null) { this.select([]); this.stage.focus(); return; }
    e.preventDefault();
    const wasSelected = this.selected.length === 1 && this.selected[0] === id;
    if (e.shiftKey || e.ctrlKey) this.select(this.selected.includes(id) ? this.selected.filter((x) => x !== id) : [...this.selected, id]);
    else if (!this.selected.includes(id)) this.select([id]);
    const item = this.item(id);
    const emptyPh = item?.kind === "shape" && item.role !== "text" && isTextEmpty(item.paras);
    const pt = this.toSlide(e);
    const frames = new Map<number, Frame>();
    for (const sid of this.selected) { const f = this.frameOf(sid); if (f) frames.set(sid, { ...f }); }
    this.drag = { kind: "move", x0: pt.x, y0: pt.y, frames, moved: false, before: this.snapshot(), clickEdit: wasSelected || emptyPh, clientX: e.clientX, clientY: e.clientY };
    this.wrap.setPointerCapture(e.pointerId);
    this.stage.focus({ preventScroll: true });
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const pt = this.toSlide(e);
    let dx = pt.x - d.x0, dy = pt.y - d.y0;
    if (!d.moved && Math.hypot(dx * this.scale, dy * this.scale) < 4) return;
    d.moved = true;
    if (d.kind === "move") {
      // Aggancio: centro della diapositiva e bordi o centri degli altri elementi.
      const guides: { x?: number; y?: number }[] = [];
      const first = [...d.frames.values()][0];
      if (first && !e.altKey) {
        const tol = 5 / this.scale;
        const xs = [this.p.width / 2], ys = [this.p.height / 2];
        for (const pl of this.placed) {
          if (d.frames.has(pl.item.id)) continue;
          xs.push(pl.frame.x, pl.frame.x + pl.frame.w / 2, pl.frame.x + pl.frame.w);
          ys.push(pl.frame.y, pl.frame.y + pl.frame.h / 2, pl.frame.y + pl.frame.h);
        }
        const nx = first.x + dx, ny = first.y + dy;
        const cand = (v: number, w: number, list: number[]) => {
          let best: { delta: number; at: number } | null = null;
          for (const g of list) for (const off of [0, w / 2, w]) {
            const delta = g - (v + off);
            if (Math.abs(delta) < tol && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at: g };
          }
          return best;
        };
        const bx = cand(nx, first.w, xs), by = cand(ny, first.h, ys);
        if (bx) { dx += bx.delta; guides.push({ x: bx.at }); }
        if (by) { dy += by.delta; guides.push({ y: by.at }); }
      }
      for (const [id, f] of d.frames) {
        const el = this.itemEl(id);
        if (!el) continue;
        el.style.left = `${f.x + dx}px`;
        el.style.top = `${f.y + dy}px`;
      }
      this.drawOverlay();
      for (const g of guides) {
        this.overlay.append(h("div", { class: "sv-guide", style: g.x !== undefined ? `left:${g.x * this.scale}px;top:0;bottom:0;width:0` : `top:${g.y! * this.scale}px;left:0;right:0;height:0` }));
      }
    } else {
      const f = { ...d.frame };
      const hd = d.handle;
      const item = this.item(d.id);
      if (hd.includes("e")) f.w = Math.max(8, d.frame.w + dx);
      if (hd.includes("s")) f.h = Math.max(8, d.frame.h + dy);
      if (hd.includes("w")) { f.w = Math.max(8, d.frame.w - dx); f.x = d.frame.x + d.frame.w - f.w; }
      if (hd.includes("n")) { f.h = Math.max(8, d.frame.h - dy); f.y = d.frame.y + d.frame.h - f.h; }
      // Le immagini mantengono le proporzioni dagli angoli (Maiusc per deformarle).
      if (item?.kind === "image" && hd.length === 2 && !e.shiftKey) {
        const ar = d.frame.w / d.frame.h;
        if (f.w / f.h > ar) f.w = f.h * ar; else f.h = f.w / ar;
        if (hd.includes("w")) f.x = d.frame.x + d.frame.w - f.w;
        if (hd.includes("n")) f.y = d.frame.y + d.frame.h - f.h;
      }
      const el = this.itemEl(d.id);
      if (el) Object.assign(el.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
      this.drawOverlay();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { this.wrap.releasePointerCapture(e.pointerId); } catch { /* già rilasciato */ }
    if (!d.moved) {
      if (d.kind === "move" && d.clickEdit && this.selected.length === 1) this.beginEdit(this.selected[0], { x: d.clientX, y: d.clientY });
      else this.drawOverlay();
      return;
    }
    const ids = d.kind === "move" ? [...d.frames.keys()] : [d.id];
    for (const id of ids) {
      const el = this.itemEl(id);
      const item = this.item(id);
      if (!el || !item) continue;
      item.frame = { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height), ...(item.frame?.rot ? { rot: item.frame.rot } : {}) };
    }
    this.pushUndo(d.before);
    this.touched(false);
  }

  select(ids: number[]): void {
    this.selected = ids;
    this.drawOverlay();
    this.hooks.selectionChanged();
  }

  // ---------- modifica del testo ----------

  private beginEdit(id: number, at?: { x: number; y: number }, target?: HTMLElement): void {
    const item = this.item(id);
    const el = this.itemEl(id);
    if (!item || !el) return;
    let box: HTMLElement | null = null;
    let cell: [number, number] | undefined;
    if (item.kind === "shape" && item.geom !== "line") box = el.querySelector<HTMLElement>(".st-text");
    else if (item.kind === "table") {
      const hit = (target ?? (at ? document.elementFromPoint(at.x, at.y) as HTMLElement : null))?.closest("td");
      const td = hit && el.contains(hit) ? hit : el.querySelector("td");
      if (td) {
        const tr = td.parentElement as HTMLTableRowElement;
        cell = [tr.rowIndex, (td as HTMLTableCellElement).cellIndex];
        box = td.querySelector<HTMLElement>(".st-cell");
      }
    }
    if (!box) return;
    this.finishEdit();
    this.selected = [id];
    this.editing = { id, box, cell, before: this.snapshot(), changed: false };
    box.contentEditable = "true";
    box.spellcheck = true;
    box.classList.remove("empty");
    box.focus({ preventScroll: true });
    const caret = at ? (document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }).caretRangeFromPoint?.(at.x, at.y) : null;
    const sel = window.getSelection();
    if (caret && box.contains(caret.startContainer) && !isTextEmpty(this.editParas())) {
      sel?.removeAllRanges();
      sel?.addRange(caret);
    } else setOffsets(box, totalLen(this.editParas()));
    box.addEventListener("input", this.onInput);
    this.drawOverlay();
    this.hooks.selectionChanged();
  }

  private onInput = () => {
    const ed = this.editing;
    if (!ed) return;
    this.setEditParas(readText(ed.box));
    ed.changed = true;
    this.afterTextChange();
  };

  private afterTextChange(): void {
    if (this.slideEl) fitText(this.slideEl, this.slide);
    this.dirty = true;
    this.placed = placeItems(this.p, this.slide);
    this.drawOverlay();
    this.updateThumb(this.current);
    this.hooks.changed();
  }

  private editParas(): Para[] {
    const ed = this.editing!;
    const item = this.item(ed.id)!;
    if (item.kind === "table" && ed.cell) return item.rows[ed.cell[0]]?.[ed.cell[1]]?.paras ?? [];
    return item.kind === "shape" ? item.paras : [];
  }

  private setEditParas(paras: Para[]): void {
    const ed = this.editing!;
    const item = this.item(ed.id)!;
    if (item.kind === "table" && ed.cell) { const c = item.rows[ed.cell[0]]?.[ed.cell[1]]; if (c) c.paras = paras; }
    else if (item.kind === "shape") item.paras = paras;
  }

  finishEdit(): void {
    const ed = this.editing;
    if (!ed) return;
    ed.box.removeEventListener("input", this.onInput);
    this.setEditParas(readText(ed.box));
    this.editing = null;
    ed.box.contentEditable = "false";
    if (ed.changed) this.pushUndo(ed.before);
    this.renderStage();
    if (ed.changed) this.updateThumb(this.current);
  }

  private cancelEdit(): void {
    const ed = this.editing;
    if (!ed) return;
    ed.box.removeEventListener("input", this.onInput);
    this.editing = null;
    this.renderStage();
  }

  /** Ridisegna il testo in modifica dopo un cambio di formato, mantenendo la selezione. */
  private refreshEditing(range: { start: number; end: number }): void {
    const ed = this.editing!;
    const item = this.item(ed.id)!;
    const paras = this.editParas();
    normalize(paras);
    if (item.kind === "shape") fillText(ed.box, paras, item.role, shapeStyle(this.p, this.slide, item));
    else fillText(ed.box, paras, "text", { size: Math.round(this.p.theme.bodySize * 0.72), color: "#222", font: this.p.theme.bodyFont, bold: false, align: "l", anchor: "t", bullets: false });
    ed.changed = true;
    setOffsets(ed.box, range.start, range.end);
    this.afterTextChange();
  }

  /** Testo su cui agiscono i comandi di formato: la selezione nel riquadro, o tutti i riquadri selezionati. */
  private textTargets(): { paras: Para[]; start: number; end: number; item: SlideItem }[] {
    if (this.editing) {
      const paras = this.editParas();
      const r = getOffsets(this.editing.box) ?? { start: 0, end: 0 };
      return [{ paras, ...r, item: this.item(this.editing.id)! }];
    }
    const out: { paras: Para[]; start: number; end: number; item: SlideItem }[] = [];
    for (const id of this.selected) {
      const it = this.item(id);
      if (it?.kind === "shape") out.push({ paras: it.paras, start: 0, end: totalLen(it.paras), item: it });
      if (it?.kind === "table") for (const row of it.rows) for (const c of row) out.push({ paras: c.paras, start: 0, end: totalLen(c.paras), item: it });
    }
    return out;
  }

  private formatRuns(fn: (runs: TextRun[], item: SlideItem) => void): void {
    const targets = this.textTargets();
    if (!targets.length) { toast("Seleziona un riquadro o del testo"); return; }
    if (this.editing) {
      const tg = targets[0];
      let { start, end } = tg;
      const range = { start, end };
      if (start === end) [start, end] = wordAround(tg.paras, start);
      fn(runsInRange(tg.paras, start, end), tg.item);
      this.refreshEditing(range);
      return;
    }
    this.edit(() => {
      for (const tg of targets) { fn(runsInRange(tg.paras, tg.start, tg.end), tg.item); normalize(tg.paras); }
    }, { thumbsAll: false });
  }

  private formatParas(fn: (paras: Para[], item: SlideItem) => void): void {
    const targets = this.textTargets();
    if (!targets.length) { toast("Seleziona un riquadro o del testo"); return; }
    if (this.editing) {
      const tg = targets[0];
      fn(parasInRange(tg.paras, tg.start, tg.end), tg.item);
      this.refreshEditing({ start: tg.start, end: tg.end });
      return;
    }
    this.edit(() => { for (const tg of targets) fn(tg.paras, tg.item); }, { thumbsAll: false });
  }

  /** Grassetto effettivo di un run (quello del titolo è grassetto per tema). */
  private isBold(r: TextRun, item: SlideItem): boolean {
    if (r.b !== undefined) return r.b;
    return item.kind === "shape" ? shapeStyle(this.p, this.slide, item).bold : false;
  }

  private toggleRun(key: "b" | "i" | "u" | "strike"): void {
    this.formatRuns((runs, item) => {
      const on = runs.length > 0 && runs.every((r) => (key === "b" ? this.isBold(r, item) : !!r[key]));
      for (const r of runs) {
        if (on) { if (key === "b") r.b = false; else delete r[key]; }
        else r[key] = true;
      }
    });
  }

  private runSize(r: TextRun, item: SlideItem, level: number): number {
    if (r.size) return r.size;
    if (item.kind !== "shape") return Math.round(this.p.theme.bodySize * 0.72);
    const st = shapeStyle(this.p, this.slide, item);
    return item.role === "body" ? Math.max(10, Math.round(st.size * [1, 0.88, 0.78, 0.72, 0.72][Math.min(level, 4)])) : st.size;
  }

  private currentRun(): { run?: TextRun; item?: SlideItem; para?: Para } {
    if (this.editing) {
      const paras = this.editParas();
      const r = getOffsets(this.editing.box);
      const off = r?.start ?? 0;
      return { run: runAt(paras, r && r.end > r.start ? off + 1 : off), item: this.item(this.editing.id), para: parasInRange(paras, off, off)[0] };
    }
    const it = this.selected.length ? this.item(this.selected[0]) : undefined;
    if (it?.kind === "shape") return { run: it.paras.flatMap((p) => p.runs)[0], item: it, para: it.paras[0] };
    return { item: it };
  }

  // ---------- comandi ----------

  handle(id: string, anchor?: HTMLElement): boolean {
    if (id.startsWith("theme.")) {
      const th = themeById(id.slice(6));
      if (th) this.edit(() => { this.p.theme = { ...th }; this.p.imported = false; });
      return true;
    }
    switch (id) {
      case "undo": this.undo(); return true;
      case "redo": this.redo(); return true;
      case "bold": this.toggleRun("b"); return true;
      case "italic": this.toggleRun("i"); return true;
      case "underline": this.toggleRun("u"); return true;
      case "strike": this.toggleRun("strike"); return true;
      case "growFont": case "shrinkFont": {
        const steps = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96];
        this.formatRuns((runs, item) => {
          for (const r of runs) {
            const cur = this.runSize(r, item, 0);
            r.size = id === "growFont" ? steps.find((s) => s > cur) ?? cur + 8 : [...steps].reverse().find((s) => s < cur) ?? Math.max(6, cur - 1);
          }
        });
        return true;
      }
      case "clearFormatting":
        this.formatRuns((runs) => { for (const r of runs) for (const k of ["b", "i", "u", "strike", "color", "size", "font"] as const) delete r[k]; });
        return true;
      case "fontColor":
        openMenu(anchor ?? this.stage, [{ colors: (c) => this.formatRuns((runs) => { for (const r of runs) { if (c) r.color = c; else delete r.color; } }), noneLabel: "Automatico" }]);
        return true;
      case "bullets": case "numbering": {
        const kind = id === "bullets" ? "bullet" : "number";
        this.formatParas((paras, item) => {
          const st = item.kind === "shape" ? shapeStyle(this.p, this.slide, item) : null;
          const cur = (p: Para) => p.bullet ?? (st?.bullets && item.kind === "shape" && item.role === "body" ? "bullet" : "none");
          const on = paras.every((p) => cur(p) === kind);
          for (const p of paras) p.bullet = on ? "none" : kind;
        });
        return true;
      }
      case "indent": case "outdent":
        this.formatParas((paras) => { for (const p of paras) p.level = Math.max(0, Math.min(4, p.level + (id === "indent" ? 1 : -1))); });
        return true;
      case "alignLeft": case "alignCenter": case "alignRight": case "justify": {
        const a: Align = id === "alignLeft" ? "l" : id === "alignCenter" ? "ctr" : id === "alignRight" ? "r" : "just";
        this.formatParas((paras) => { for (const p of paras) p.align = a; });
        return true;
      }
      case "textAnchor":
        openMenu(anchor ?? this.stage, ([["t", "In alto", "AlignVerticalJustifyStart"], ["ctr", "Al centro", "AlignVerticalJustifyCenter"], ["b", "In basso", "AlignVerticalJustifyEnd"]] as const).map(([v, label, ic]) => ({
          label, icon: ic, action: () => this.editSelectedShapes((s) => { s.anchor = v as Anchor; }),
        })));
        return true;
      case "shapeFill":
        openMenu(anchor ?? this.stage, [{ colors: (c) => this.editSelectedShapes((s) => { s.fill = c; }), noneLabel: "Nessun riempimento" }]);
        return true;
      case "shapeLine":
        openMenu(anchor ?? this.stage, [
          { colors: (c) => this.editSelectedShapes((s) => { s.line = c ? { color: c, width: s.line?.width ?? 1.5 } : null; }), noneLabel: "Nessun contorno" },
          { separator: true },
          ...[0.75, 1.5, 3, 6].map((w): MenuItem => ({ label: t("Spessore {0} pt", String(w).replace(".", ",")), action: () => this.editSelectedShapes((s) => { s.line = { color: s.line?.color ?? this.p.theme.accent, width: w }; }) })),
        ]);
        return true;
      case "arrange": openMenu(anchor ?? this.stage, this.arrangeItems()); return true;
      case "newSlide":
        if (anchor) openMenu(anchor, LAYOUT_LABELS.map(([l, label]) => ({ label, icon: "LayoutTemplate", action: () => this.addSlide(l) })));
        else this.addSlide();
        return true;
      case "slideLayout":
        openMenu(anchor ?? this.stage, LAYOUT_LABELS.map(([l, label]) => ({ label, checked: this.slide.layout === l, action: () => this.setLayout(l) })));
        return true;
      case "autoLayout": this.autoLayout(); return true;
      case "duplicateSlide": this.duplicateSlide(); return true;
      case "deleteSlide": this.deleteSlide(); return true;
      case "hideSlide": this.edit(() => { this.slide.hidden = !this.slide.hidden; }); return true;
      case "selectAll":
        if (this.editing) { setOffsets(this.editing.box, 0, totalLen(this.editParas())); return true; }
        this.select(this.slide.items.map((i) => i.id));
        return true;
      case "copy": this.copy(null); return true;
      case "cut": this.copy(null); this.deleteSelected(); return true;
      case "paste": void this.pasteFromSystem(); return true;
      case "formatPainter": return false;
      case "find": void this.find(); return true;
      case "replace": void this.replace(); return true;
      case "insertImage": void this.insertImageDialog(); return true;
      case "textBox": this.insertText(); return true;
      case "insertShape":
        openMenu(anchor ?? this.stage, SHAPES.map(([g, label, ic]) => ({ label, icon: ic, action: () => this.insertShape(g) })));
        return true;
      case "insertTable": openMenu(anchor ?? this.stage, [{ element: this.tablePicker() }]); return true;
      case "insertLink": void this.insertLink(); return true;
      case "slideBackground":
        openMenu(anchor ?? this.stage, [
          { colors: (c) => this.edit(() => { if (c) this.slide.background = c; else delete this.slide.background; }, { thumbsAll: false }), noneLabel: "Sfondo del tema" },
          { separator: true },
          { label: "Applica a tutte le diapositive", icon: "Palette", action: () => this.edit(() => { const bg = this.slide.background; for (const s of this.p.slides) { if (bg) s.background = bg; else delete s.background; } }) },
          { label: "Rimuovi immagine di sfondo", icon: "X", disabled: !this.slide.backgroundImage, action: () => this.edit(() => { delete this.slide.backgroundImage; }) },
        ]);
        return true;
      case "slideSize":
        openMenu(anchor ?? this.stage, [
          { label: "Widescreen (16:9)", checked: Math.abs(this.p.width / this.p.height - 16 / 9) < 0.01, action: () => this.setSize(960, 540) },
          { label: "Standard (4:3)", checked: Math.abs(this.p.width / this.p.height - 4 / 3) < 0.01, action: () => this.setSize(720, 540) },
        ]);
        return true;
      case "slideshowStart": this.slideshow(0); return true;
      case "slideshowCurrent": this.slideshow(this.current); return true;
      case "notesPane": this.showNotes = !this.showNotes; this.notes.hidden = !this.showNotes; this.renderStage(); return true;
      case "thumbsPane": this.showThumbs = !this.showThumbs; this.thumbs.hidden = !this.showThumbs; this.renderStage(); return true;
    }
    return false;
  }

  isActive(id: string): boolean | undefined {
    if (id.startsWith("theme.")) return this.p.theme.id === id.slice(6);
    switch (id) {
      case "hideSlide": return !!this.slide.hidden;
      case "notesPane": return this.showNotes;
      case "thumbsPane": return this.showThumbs;
      case "bold": case "italic": case "underline": case "strike": {
        const { run, item } = this.currentRun();
        if (!run || !item) return false;
        return id === "bold" ? this.isBold(run, item) : !!run[id === "italic" ? "i" : id === "underline" ? "u" : "strike"];
      }
      case "bullets": case "numbering": {
        const { para, item } = this.currentRun();
        if (!para || item?.kind !== "shape") return false;
        const b = para.bullet ?? (item.role === "body" ? "bullet" : "none");
        return b === (id === "bullets" ? "bullet" : "number");
      }
      case "alignLeft": case "alignCenter": case "alignRight": case "justify": {
        const { para, item } = this.currentRun();
        if (!para || item?.kind !== "shape") return false;
        const a = para.align ?? shapeStyle(this.p, this.slide, item).align;
        return a === ({ alignLeft: "l", alignCenter: "ctr", alignRight: "r", justify: "just" } as const)[id];
      }
    }
    return undefined;
  }

  selectValue(id: string): string | undefined {
    const { run, item, para } = this.currentRun();
    if (!item) return undefined;
    if (id === "fontName") return run?.font ?? (item.kind === "shape" ? shapeStyle(this.p, this.slide, item).font : this.p.theme.bodyFont);
    if (id === "fontSize") return String(Math.round(run ? this.runSize(run, item, para?.level ?? 0) : item.kind === "shape" ? shapeStyle(this.p, this.slide, item).size : 18));
    return undefined;
  }

  setSelect(id: string, value: string): boolean {
    if (id === "fontName") { this.formatRuns((runs) => { for (const r of runs) r.font = value; }); this.focus(); return true; }
    if (id === "fontSize") {
      const n = Number(value.replace(",", "."));
      if (n > 0 && n < 400) this.formatRuns((runs) => { for (const r of runs) r.size = n; });
      this.focus();
      return true;
    }
    return false;
  }

  private editSelectedShapes(fn: (s: ShapeItem) => void): void {
    const shapes = this.selected.map((id) => this.item(id)).filter((i): i is ShapeItem => i?.kind === "shape");
    if (!shapes.length) { toast("Seleziona prima una forma o un riquadro"); return; }
    this.edit(() => shapes.forEach(fn), { thumbsAll: false });
  }

  private arrangeItems(): MenuItem[] {
    const move = (fn: (items: SlideItem[], sel: Set<number>) => SlideItem[]) => () => {
      if (!this.selected.length) { toast("Seleziona prima un elemento"); return; }
      const sel = new Set(this.selected);
      this.edit(() => { this.slide.items = fn(this.slide.items, sel); }, { thumbsAll: false });
    };
    const align = (how: string) => () => {
      if (!this.selected.length) { toast("Seleziona prima un elemento"); return; }
      this.edit(() => {
        for (const id of this.selected) {
          const it = this.item(id), f = this.frameOf(id);
          if (!it || !f) continue;
          const nf = { ...f };
          if (how === "l") nf.x = 0; if (how === "c") nf.x = (this.p.width - f.w) / 2; if (how === "r") nf.x = this.p.width - f.w;
          if (how === "t") nf.y = 0; if (how === "m") nf.y = (this.p.height - f.h) / 2; if (how === "b") nf.y = this.p.height - f.h;
          it.frame = nf;
        }
      }, { thumbsAll: false });
    };
    return [
      { label: "Porta in primo piano", icon: "BringToFront", action: move((items, sel) => [...items.filter((i) => !sel.has(i.id)), ...items.filter((i) => sel.has(i.id))]) },
      { label: "Porta avanti", icon: "ArrowUp", action: move((items, sel) => { const a = [...items]; for (let i = a.length - 2; i >= 0; i--) if (sel.has(a[i].id) && !sel.has(a[i + 1].id)) [a[i], a[i + 1]] = [a[i + 1], a[i]]; return a; }) },
      { label: "Porta indietro", icon: "ArrowDown", action: move((items, sel) => { const a = [...items]; for (let i = 1; i < a.length; i++) if (sel.has(a[i].id) && !sel.has(a[i - 1].id)) [a[i], a[i - 1]] = [a[i - 1], a[i]]; return a; }) },
      { label: "Porta in secondo piano", icon: "SendToBack", action: move((items, sel) => [...items.filter((i) => sel.has(i.id)), ...items.filter((i) => !sel.has(i.id))]) },
      { separator: true },
      { heading: "Allinea alla diapositiva" },
      { label: "A sinistra", icon: "AlignVerticalJustifyStart", action: align("l") },
      { label: "Al centro orizzontale", icon: "AlignVerticalJustifyCenter", action: align("c") },
      { label: "A destra", icon: "AlignVerticalJustifyEnd", action: align("r") },
      { label: "In alto", icon: "ArrowUp", action: align("t") },
      { label: "Al centro verticale", icon: "Minus", action: align("m") },
      { label: "In basso", icon: "ArrowDown", action: align("b") },
      { separator: true },
      { label: "Posizione automatica", icon: "WandSparkles", disabled: !this.selected.some((id) => this.item(id)?.frame), action: () => this.edit(() => { for (const id of this.selected) { const it = this.item(id); if (it && it.kind !== "raw") delete it.frame; } }, { thumbsAll: false }) },
    ];
  }

  // ---------- diapositive ----------

  addSlide(layout?: LayoutId): void {
    const cur = this.slide?.layout;
    const l = layout ?? (cur === "title" || cur === "section" || !cur ? "content" : cur);
    this.edit(() => {
      const s = newSlide(this.p, l);
      if (this.slide?.decor && !layout) s.decor = this.slide.decor;
      this.p.slides.splice(this.current + 1, 0, s);
      this.current++;
      this.selected = [];
    });
  }

  duplicateSlide(): void {
    this.edit(() => {
      this.p.slides.splice(this.current + 1, 0, cloneSlide(this.p, this.slide));
      this.current++;
    });
  }

  deleteSlide(): void {
    if (this.p.slides.length === 1) {
      // Resta sempre almeno una diapositiva: l'ultima si svuota.
      this.edit(() => { this.p.slides = [newSlide(this.p, "title")]; this.current = 0; });
      return;
    }
    this.edit(() => {
      this.p.slides.splice(this.current, 1);
      this.current = Math.min(this.current, this.p.slides.length - 1);
    });
  }

  private setLayout(l: LayoutId): void {
    this.edit(() => {
      const s = this.slide;
      s.layout = l;
      // Si aggiungono i riquadri che il nuovo layout prevede e mancano; quelli vuoti di troppo si tolgono.
      const want = newSlide(this.p, l).items as ShapeItem[];
      const has = (role: string) => s.items.filter((i) => i.kind === "shape" && i.role === role).length;
      for (const role of ["title", "subtitle", "body"] as const) {
        const need = want.filter((w) => w.role === role).length;
        for (let k = has(role); k < need; k++) s.items.push({ kind: "shape", id: newId(this.p), role, geom: "rect", paras: [{ runs: [], level: 0 }] });
        if (has(role) > need) {
          let extra = has(role) - need;
          s.items = s.items.filter((i) => !(extra > 0 && i.kind === "shape" && i.role === role && isTextEmpty(i.paras) && extra-- > 0));
        }
      }
      // Un sottotitolo in una diapositiva normale diventa testo del corpo.
      if (l !== "title" && l !== "section") for (const i of s.items) if (i.kind === "shape" && i.role === "subtitle") i.role = "body";
    });
  }

  private autoLayout(): void {
    this.edit(() => {
      for (const it of this.slide.items) {
        if (it.kind === "raw") continue;
        // Le forme decorative restano dove sono; testi, immagini e tabelle tornano nei posti automatici.
        if (it.kind === "shape" && it.role === "text" && (it.fill || it.geom !== "rect")) continue;
        delete it.frame;
        if (it.kind === "shape") { delete it.fit; delete it.inset; delete it.anchor; }
      }
    }, { thumbsAll: false });
    toast("Elementi ridisposti nello spazio della diapositiva");
  }

  private setSize(w: number, hh: number): void {
    const sx = w / this.p.width, sy = hh / this.p.height;
    this.edit(() => {
      this.p.width = w;
      this.p.height = hh;
      // Le posizioni fissate a mano si scalano; quelle automatiche si ricalcolano da sole.
      const scaleFrames = (items: SlideItem[]) => { for (const it of items) if (it.frame) it.frame = { ...it.frame, x: it.frame.x * sx, y: it.frame.y * sy, w: it.frame.w * sx, h: it.frame.h * sy }; };
      for (const s of this.p.slides) scaleFrames(s.items);
      for (const list of Object.values(this.p.decor)) scaleFrames(list);
    });
  }

  private slideMenuItems(): MenuItem[] {
    return [
      { label: "Nuova diapositiva", icon: "Presentation", shortcut: "Ctrl+M", action: () => this.addSlide() },
      { label: "Duplica diapositiva", icon: "CopyPlus", shortcut: "Ctrl+D", action: () => this.duplicateSlide() },
      { label: "Elimina diapositiva", icon: "Trash2", action: () => this.deleteSlide() },
      { separator: true },
      { label: this.slide.hidden ? "Mostra diapositiva" : "Nascondi diapositiva", icon: "EyeOff", action: () => this.handle("hideSlide") },
      { label: "Copia diapositiva", icon: "Copy", action: () => { clipboard = { items: [], slides: [deepCopy(this.slide)], stamp: crypto.randomUUID() }; void navigator.clipboard?.writeText?.(`zikoffice:${clipboard.stamp}`).catch(() => undefined); } },
      { label: "Incolla diapositiva", icon: "ClipboardPaste", disabled: !clipboard?.slides?.length, action: () => this.pasteSlides() },
      { separator: true },
      ...LAYOUT_LABELS.map(([l, label]): MenuItem => ({ label, checked: this.slide.layout === l, action: () => this.setLayout(l) })),
    ];
  }

  private pasteSlides(): void {
    const list = clipboard?.slides;
    if (!list?.length) return;
    this.edit(() => {
      const copies = list.map((s) => cloneSlide(this.p, s));
      this.p.slides.splice(this.current + 1, 0, ...copies);
      this.current += copies.length;
    });
  }

  private itemMenu(e: MouseEvent): void {
    e.preventDefault();
    if (this.editing && this.editing.box.contains(e.target as Node)) {
      openMenu({ x: e.clientX, y: e.clientY }, [
        { label: "Taglia", icon: "Scissors", shortcut: "Ctrl+X", action: () => document.execCommand("cut") },
        { label: "Copia", icon: "Copy", shortcut: "Ctrl+C", action: () => document.execCommand("copy") },
        { label: "Incolla", icon: "ClipboardPaste", shortcut: "Ctrl+V", action: () => void this.pasteFromSystem() },
      ]);
      return;
    }
    const id = this.hitId(e.target as HTMLElement);
    if (id !== null && !this.selected.includes(id)) this.select([id]);
    const it = id !== null ? this.item(id) : undefined;
    const items: MenuItem[] = it ? [
      { label: "Taglia", icon: "Scissors", shortcut: "Ctrl+X", action: () => this.handle("cut") },
      { label: "Copia", icon: "Copy", shortcut: "Ctrl+C", action: () => this.handle("copy") },
      { label: "Incolla", icon: "ClipboardPaste", shortcut: "Ctrl+V", action: () => void this.pasteFromSystem() },
      { label: "Elimina", icon: "Trash2", shortcut: "Canc", action: () => this.deleteSelected() },
      { separator: true },
      ...this.arrangeItems(),
    ] : [
      { label: "Incolla", icon: "ClipboardPaste", shortcut: "Ctrl+V", action: () => void this.pasteFromSystem() },
      { separator: true },
      ...this.slideMenuItems(),
    ];
    if (it?.kind === "table") {
      const cell = this.tableCellAt(e);
      items.unshift(
        { label: "Inserisci riga sotto", icon: "BetweenHorizontalStart", action: () => this.tableEdit(it.id, (tb) => { const r = cell?.[0] ?? tb.rows.length - 1; tb.rows.splice(r + 1, 0, tb.rows[r].map(() => ({ paras: [{ runs: [], level: 0 }] }))); }) },
        { label: "Inserisci colonna a destra", icon: "BetweenVerticalStart", action: () => this.tableEdit(it.id, (tb) => { const c = cell?.[1] ?? tb.rows[0].length - 1; for (const row of tb.rows) row.splice(c + 1, 0, { paras: [{ runs: [], level: 0 }] }); if (tb.cols) tb.cols.splice(c + 1, 0, tb.cols[c] ?? 1); }) },
        { label: "Elimina riga", icon: "Minus", disabled: it.rows.length < 2, action: () => this.tableEdit(it.id, (tb) => { tb.rows.splice(cell?.[0] ?? tb.rows.length - 1, 1); }) },
        { label: "Elimina colonna", icon: "Minus", disabled: (it.rows[0]?.length ?? 0) < 2, action: () => this.tableEdit(it.id, (tb) => { const c = cell?.[1] ?? tb.rows[0].length - 1; for (const row of tb.rows) row.splice(c, 1); tb.cols?.splice(c, 1); }) },
        { label: "Prima riga come intestazione", checked: it.header, action: () => this.tableEdit(it.id, (tb) => { tb.header = !tb.header; }) },
        { separator: true },
      );
    }
    openMenu({ x: e.clientX, y: e.clientY }, items);
  }

  private tableCellAt(e: MouseEvent): [number, number] | null {
    const td = (e.target as HTMLElement).closest("td");
    if (!td) return null;
    return [(td.parentElement as HTMLTableRowElement).rowIndex, (td as HTMLTableCellElement).cellIndex];
  }

  private tableEdit(id: number, fn: (t: TableItem) => void): void {
    const it = this.item(id);
    if (it?.kind === "table") this.edit(() => fn(it), { thumbsAll: false });
  }

  // ---------- inserimento ----------

  private addItem(item: SlideItem): void {
    this.edit(() => { this.slide.items.push(item); }, { thumbsAll: false });
    this.select([item.id]);
  }

  private insertText(): void {
    const item: ShapeItem = { kind: "shape", id: newId(this.p), role: "text", geom: "rect", paras: [{ runs: [], level: 0 }] };
    this.addItem(item);
    requestAnimationFrame(() => this.beginEdit(item.id));
  }

  private insertShape(geom: Geometry): void {
    const W = this.p.width, H = this.p.height;
    const w = geom === "line" ? W * 0.3 : W * 0.22, hh = geom === "line" ? 0 : geom === "rightArrow" || geom === "chevron" ? H * 0.18 : H * 0.28;
    const item: ShapeItem = {
      kind: "shape", id: newId(this.p), role: "text", geom, frame: { x: (W - w) / 2, y: (H - hh) / 2, w, h: hh },
      fill: geom === "line" ? null : this.p.theme.accent, line: geom === "line" ? { color: this.p.theme.accent, width: 2.25 } : null,
      paras: [{ runs: [], level: 0, align: "ctr" }], anchor: "ctr",
    };
    this.addItem(item);
  }

  private tablePicker(): HTMLElement {
    const N = 8, M = 6;
    const label = h("div", { class: "menu-heading" }, "Inserisci tabella");
    const grid = h("div", { class: "table-picker", style: `grid-template-columns:repeat(${N},16px)` });
    for (let r = 0; r < M; r++) for (let c = 0; c < N; c++) {
      const cell = h("span", { "data-r": String(r), "data-c": String(c) });
      cell.addEventListener("mouseenter", () => {
        label.textContent = t("Tabella {0} × {1}", c + 1, r + 1);
        grid.querySelectorAll<HTMLElement>("span").forEach((s) => s.classList.toggle("on", Number(s.dataset.r) <= r && Number(s.dataset.c) <= c));
      });
      cell.addEventListener("click", () => {
        document.querySelector(".menu")?.remove();
        this.insertTable(r + 1, c + 1);
      });
      grid.append(cell);
    }
    return h("div", { style: "padding:4px 8px" }, label, grid);
  }

  private insertTable(rows: number, cols: number): void {
    const item: TableItem = {
      kind: "table", id: newId(this.p), header: true,
      rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ paras: [{ runs: [], level: 0 }] }))),
    };
    this.addItem(item);
  }

  async insertImageBytes(bytes: Uint8Array, mime: string, name = ""): Promise<void> {
    let natW = 0, natH = 0;
    try {
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
      natW = bmp.width; natH = bmp.height;
      bmp.close();
    } catch {
      toast("Formato d'immagine non supportato");
      return;
    }
    const item: ImageItem = { kind: "image", id: newId(this.p), bytes, mime, natW, natH, alt: name.replace(/\.[^.]+$/, "") };
    this.addItem(item);
  }

  async insertImagePath(path: string): Promise<void> {
    try {
      await this.insertImageBytes(await readBinary(path), mimeOf(path), path.split(/[\\/]/).pop());
    } catch (e) { toast(String(e)); }
  }

  private async insertImageDialog(): Promise<void> {
    if (!inTauri) {
      const input = h("input", { type: "file", accept: "image/*" });
      input.addEventListener("change", async () => {
        const f = input.files?.[0];
        if (f) await this.insertImageBytes(new Uint8Array(await f.arrayBuffer()), f.type || mimeOf(f.name), f.name);
      });
      input.click();
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: true, directory: false, filters: [{ name: tr("Immagini"), extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }] });
    const list = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    for (const path of list) await this.insertImagePath(path);
  }

  private async insertLink(): Promise<void> {
    const url = await promptDialog("Collegamento", "Indirizzo (URL):", "https://");
    if (!url?.trim()) return;
    this.formatRuns((runs) => { for (const r of runs) { r.link = url.trim(); r.u = true; } });
  }

  // ---------- appunti ----------

  private copy(data: DataTransfer | null): void {
    const items = this.selected.map((id) => this.item(id)).filter((i): i is SlideItem => !!i);
    if (!items.length) return;
    clipboard = { items: items.map((i) => deepCopy(i)), stamp: crypto.randomUUID() };
    const text = items.map(itemText).filter(Boolean).join("\n");
    const marker = `zikoffice:${clipboard.stamp}`;
    if (data) { data.setData("text/plain", text || marker); data.setData("application/x-zikoffice", marker); }
    else void navigator.clipboard?.writeText?.(text || marker).catch(() => undefined);
    clipboard.stamp = text || marker;
  }

  private pasteItems(items: SlideItem[]): void {
    const copies = items.map((i) => {
      const c = deepCopy(i);
      c.id = newId(this.p);
      if (c.frame) c.frame = { ...c.frame, x: c.frame.x + 12, y: c.frame.y + 12 };
      return c;
    });
    this.edit(() => { this.slide.items.push(...copies); }, { thumbsAll: false });
    this.select(copies.map((c) => c.id));
  }

  private onPaste(e: ClipboardEvent): void {
    if ((e.target as HTMLElement) === this.notes) return;
    const data = e.clipboardData;
    if (!data) return;
    const file = [...data.files].find((f) => f.type.startsWith("image/"));
    if (file && !this.editing) {
      e.preventDefault();
      void file.arrayBuffer().then((b) => this.insertImageBytes(new Uint8Array(b), file.type, file.name));
      return;
    }
    const text = data.getData("text/plain");
    if (this.editing) {
      // Solo testo semplice: la formattazione del riquadro resta quella del tema.
      e.preventDefault();
      document.execCommand("insertText", false, text.replace(/\r\n?/g, "\n"));
      return;
    }
    e.preventDefault();
    if (clipboard && (data.getData("application/x-zikoffice") || text) && (text === clipboard.stamp || data.getData("application/x-zikoffice") === `zikoffice:${clipboard.stamp}`)) {
      if (clipboard.slides?.length) this.pasteSlides(); else this.pasteItems(clipboard.items);
      return;
    }
    if (text.trim()) this.pasteText(text);
  }

  private pasteText(text: string): void {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const item: ShapeItem = { kind: "shape", id: newId(this.p), role: "text", geom: "rect", paras: lines.map((l) => ({ runs: l ? [{ text: l }] : [], level: 0 })) };
    // Se c'è un riquadro del corpo vuoto, il testo va lì.
    const body = this.slide.items.find((i): i is ShapeItem => i.kind === "shape" && i.role === "body" && isTextEmpty(i.paras));
    if (body) { this.edit(() => { body.paras = item.paras; }, { thumbsAll: false }); this.select([body.id]); return; }
    this.addItem(item);
  }

  private async pasteFromSystem(): Promise<void> {
    if (this.editing) {
      const text = await navigator.clipboard?.readText?.().catch(() => "") ?? "";
      if (text) document.execCommand("insertText", false, text);
      return;
    }
    try {
      const items = await navigator.clipboard?.read?.();
      for (const ci of items ?? []) {
        const type = ci.types.find((tp) => tp.startsWith("image/"));
        if (type) { await this.insertImageBytes(new Uint8Array(await (await ci.getType(type)).arrayBuffer()), type); return; }
      }
    } catch { /* lettura immagini non permessa: si prova col testo */ }
    const text = await navigator.clipboard?.readText?.().catch(() => "") ?? "";
    if (clipboard && text === clipboard.stamp) { if (clipboard.slides?.length) this.pasteSlides(); else this.pasteItems(clipboard.items); return; }
    if (clipboard && !text) { this.pasteItems(clipboard.items); return; }
    if (text.trim()) this.pasteText(text);
    else toast("Gli appunti sono vuoti");
  }

  private deleteSelected(): void {
    if (!this.selected.length) return;
    const sel = new Set(this.selected);
    this.edit(() => { this.slide.items = this.slide.items.filter((i) => !sel.has(i.id)); this.selected = []; }, { thumbsAll: false });
  }

  // ---------- trova ----------

  private async find(): Promise<void> {
    const q = await promptDialog("Trova", "Testo da cercare nelle diapositive:", "");
    if (!q?.trim()) return;
    const needle = q.toLocaleLowerCase();
    const n = this.p.slides.length;
    for (let k = 1; k <= n; k++) {
      const si = (this.current + k) % n;
      const s = this.p.slides[si];
      for (const it of s.items) {
        if (it.kind !== "shape") continue;
        const text = it.paras.map(paraText).join("\n").toLocaleLowerCase();
        const at = text.indexOf(needle);
        if (at >= 0) {
          this.goTo(si);
          this.beginEdit(it.id);
          if (this.editing) setOffsets(this.editing.box, at, at + needle.length);
          return;
        }
      }
    }
    toast(t("«{0}» non trovato", q));
  }

  private async replace(): Promise<void> {
    const q = await promptDialog("Sostituisci", "Testo da cercare:", "");
    if (!q) return;
    const w = await promptDialog("Sostituisci", t("Sostituisci «{0}» con:", q), "");
    if (w === null) return;
    let count = 0;
    this.edit(() => {
      for (const s of this.p.slides) for (const it of s.items) {
        const paraLists = it.kind === "shape" ? [it.paras] : it.kind === "table" ? it.rows.flat().map((c) => c.paras) : [];
        for (const paras of paraLists) for (const p of paras) for (const r of p.runs) {
          const parts = r.text.split(q);
          if (parts.length > 1) { count += parts.length - 1; r.text = parts.join(w); }
        }
      }
    });
    toast(count ? t("Sostituzioni: {0}", count) : t("«{0}» non trovato", q));
  }

  // ---------- tastiera ----------

  private onKey(e: KeyboardEvent): void {
    if (e.target === this.notes) return;
    if (e.key === "F5") { e.preventDefault(); this.slideshow(e.shiftKey ? this.current : 0); return; }
    const ed = this.editing;
    if (ed) {
      if (e.key === "Escape") { e.preventDefault(); this.finishEdit(); this.stage.focus(); this.drawOverlay(); return; }
      if (e.key === "Tab") {
        e.preventDefault();
        const it = this.item(ed.id);
        if (it?.kind === "table" && ed.cell) {
          // Tab passa alla cella successiva; dall'ultima aggiunge una riga.
          let [r, c] = ed.cell;
          const cols = it.rows[0].length;
          c += e.shiftKey ? -1 : 1;
          if (c >= cols) { c = 0; r++; }
          if (c < 0) { c = cols - 1; r = Math.max(0, r - 1); }
          if (r >= it.rows.length) {
            this.finishEdit();
            this.tableEdit(it.id, (tb) => tb.rows.push(tb.rows[0].map(() => ({ paras: [{ runs: [], level: 0 }] }))));
          } else this.finishEdit();
          const el = this.itemEl(it.id)?.querySelectorAll("tr")[r]?.querySelectorAll("td")[c];
          if (el) this.beginEdit(it.id, undefined, el as HTMLElement);
          return;
        }
        this.handle(e.shiftKey ? "outdent" : "indent");
        return;
      }
      return;
    }
    if ((e.target as HTMLElement).closest?.(".sv-thumbs")) return;
    const sel = this.selected;
    if (sel.length) {
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.deleteSelected(); return; }
      if (e.key === "Escape") { e.preventDefault(); this.select([]); return; }
      if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); this.beginEdit(sel[0]); return; }
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        this.edit(() => {
          for (const id of sel) {
            const it = this.item(id), f = this.frameOf(id);
            if (it && f) it.frame = { ...f, x: f.x + dx, y: f.y + dy };
          }
        }, { thumbsAll: false });
        return;
      }
      // Scrivendo con un riquadro selezionato si entra nel testo.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const it = this.item(sel[0]);
        if (it?.kind === "shape" && it.geom !== "line") this.beginEdit(sel[0]);
        return;
      }
      return;
    }
    if (e.key === "PageDown" || e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); this.goTo(this.current + 1); }
    else if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); this.goTo(this.current - 1); }
    else if (e.key === "Home") { e.preventDefault(); this.goTo(0); }
    else if (e.key === "End") { e.preventDefault(); this.goTo(this.p.slides.length - 1); }
  }

  private slideshow(from: number): void {
    this.finishEdit();
    startSlideshow(this.p, from, (last) => { this.goTo(last); this.focus(); });
  }

  // ---------- DocumentView ----------

  status(): string[] {
    const n = this.p.slides.length;
    return [t("Diapositiva {0} di {1}", this.current + 1, n), tr(this.p.theme.name)];
  }

  setZoom(z: number): void {
    this.zoom = z;
    this.renderStage();
  }

  shown(): void {
    this.renderStage();
    this.renderThumbs();
  }

  focus(): void {
    if (this.editing) this.editing.box.focus({ preventScroll: true });
    else this.stage.focus({ preventScroll: true });
  }

  /** Testo per l'assistente: la diapositiva corrente o tutta la presentazione. */
  aiText(whole: boolean): string {
    const slideText = (s: Slide, i: number) => [`# ${t("Diapositiva {0}", i + 1)}`, ...s.items.map(itemText).filter(Boolean), s.notes ? `${tr("Note")}: ${s.notes}` : ""].filter(Boolean).join("\n");
    return whole ? this.p.slides.map(slideText).join("\n\n") : slideText(this.slide, this.current);
  }

  /** Per l'esportazione: ricalcola la riduzione del testo di ogni diapositiva prima di salvare. */
  prepareExport(): void {
    this.finishEdit();
    const probe = h("div", { style: "position:fixed;left:-10000px;top:0;visibility:hidden" });
    document.body.append(probe);
    for (const s of this.p.slides) {
      const el = renderSlide(this.p, s, "show");
      probe.replaceChildren(el);
      fitText(el, s);
    }
    probe.remove();
  }

  /** Diapositive per la stampa e il PDF: una pagina per diapositiva (quelle nascoste no). */
  printHtml(): { html: string; width: number; height: number } {
    this.prepareExport();
    const W = this.p.width, H = this.p.height;
    const pages = this.p.slides.filter((s) => !s.hidden).map((s) => {
      const el = renderSlide(this.p, s, "print");
      return `<div class="print-slide" style="width:${W}pt;height:${H}pt;overflow:hidden;position:relative;page-break-after:always;break-after:page"><div style="position:absolute;left:0;top:0;transform:scale(${96 / 72});transform-origin:0 0">${el.outerHTML}</div></div>`;
    });
    return { html: pages.join(""), width: W, height: H };
  }

  dispose(): void {
    clearTimeout(this.thumbTimer);
  }
}
