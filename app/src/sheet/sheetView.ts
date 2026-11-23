// Foglio di calcolo: griglia su canvas collegata al motore IronCalc.
import { h, toast } from "../dom";
import { icon } from "../icons";
import { onThemeChange, resolvedTheme } from "../theme";
import { prompt as promptDialog } from "../ui/dialog";
import { openMenu, type MenuItem } from "../ui/menu";
import type { CommandState, DocumentView } from "../views/view";
import { FormulaAssist } from "./assist";
import { ChartLayer, type ChartSpec, type ChartType } from "./charts";
import {
  CELL_STYLE_PRESETS, evalCondFormat, formatRangeAsTable, removeDuplicateRows, splitTextToColumns,
  type CondRule, type ValidationRule,
} from "./enterprise";
import { createPivotSheet, PIVOT_AGG_LABELS, type PivotAgg } from "./pivot";
import { FindBar, matches, replaceText, type FindOptions } from "./find";
import { BLANK, openFilterPopup } from "./filterPopup";
import { Axis } from "./axis";
import type { Area, CellStyle, Clipboard, Color, MergedCell, Model } from "./engine";
import { changeDecimals, cssFontFamily, formatCode, formatLabel, parseDisplayedNumber, shiftFormulaRows } from "./format";

import { langInfo, localeTag, t } from "../i18n";
import { fn } from "./functions";
const MAX_ROW = 1_048_576; // gli stessi limiti di Excel
const MAX_COL = 16_384;
/** IronCalc usa colonne da 90px e righe da 25px: le riduciamo un po' per una griglia più compatta. */
const SCALE = 0.9;
const HEAD_H = 24;
const MIN_HEAD_W = 46;
const RESIZE_GRIP = 4;

interface Cell { r: number; c: number }
interface Rect { x: number; y: number; w: number; h: number }

/** Pulsanti "doppi": il clic esegue l'azione, la freccetta apre il menu. */
const SPLIT_DEFAULTS = new Set(["paste", "autoSum", "fmtCurrency"]);

/** Appunti interni: permettono di incollare formule e formati, non solo testo. */
let internalClipboard: { model: Model; sheet: number; clip: Clipboard; cut: boolean } | null = null;

export function colName(c: number): string {
  let s = "";
  for (let n = c; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function parseRef(ref: string): Cell | null {
  const m = /^\s*\$?([A-Za-z]{1,3})\$?(\d{1,7})\s*$/.exec(ref);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  const r = Number(m[2]);
  if (r < 1 || r > MAX_ROW || c < 1 || c > MAX_COL) return null;
  return { r, c };
}

/** Luminosità percepita di un colore #rrggbb (0 = nero, 1 = bianco). */
function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  if (Number.isNaN(n)) return 1;
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

export interface SheetHost {
  /** Il contenuto è cambiato: aggiornare titolo (modificato), barra di stato e ribbon. */
  changed(): void;
  /** Cambiata solo la selezione. */
  selectionChanged(): void;
}

export class SheetView implements DocumentView {
  readonly kind = "sheet" as const;
  readonly el: HTMLElement;
  dirty = false;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private editor: HTMLTextAreaElement;
  private nameBox: HTMLInputElement;
  private formulaInput: HTMLTextAreaElement;
  private formulaBar: HTMLElement;
  private tabsEl: HTMLElement;

  private sheet = 0;
  private active: Cell = { r: 1, c: 1 };
  private anchor: Cell = { r: 1, c: 1 };
  private rows!: Axis;
  private cols!: Axis;
  private extent = { rows: 1000, cols: 52 };
  private zoom = 1;
  private merged: MergedCell[] = [];
  private colors: Record<string, string> = {};
  private colorCache = new Map<string, string>();
  private raf = 0;

  private editing: { cell: Cell; viaBar: boolean } | null = null;
  /** Riferimento inserito cliccando una cella mentre si scrive una formula. */
  private pointing: { start: number; end: number; from: Cell } | null = null;
  private drag: null
    | { kind: "select" }
    | { kind: "point" }
    | { kind: "rows" | "cols"; from: number }
    | { kind: "resize-col" | "resize-row"; index: number; startPos: number; startSize: number }
    | { kind: "fill"; target: Cell } = null;
  private painter: CellStyle[][] | null = null;
  private assist = new FormulaAssist((field) => {
    (field === this.editor ? this.formulaInput : this.editor).value = field.value;
    this.placeEditor();
    this.updateAssist(field);
  });
  private findBar: FindBar<Cell>;
  /** Filtri automatici per foglio: intervallo (prima riga = intestazione) e valori mostrati per colonna. */
  private filters = new Map<number, { r0: number; r1: number; c0: number; c1: number; criteria: Map<number, Set<string>> }>();
  /** Colonna da cui è partita una serie di Tab: Invio ci torna (come in Excel). */
  private tabStart: number | null = null;
  /** Grafici interattivi, formattazione condizionale, note e convalida dati. */
  readonly chartLayer: ChartLayer;
  private condRules: CondRule[] = [];
  private cellNotes = new Map<string, string>();
  private validations = new Map<string, ValidationRule>();
  private definedNames = new Map<string, { sheet: number; r: number; c: number; ref: string }>();

  private noteKey(r: number, c: number, sheet = this.sheet): string { return `${sheet}:${r}:${c}`; }

  /** Serializza grafici, formattazione condizionale, note, convalide e nomi definiti per salvarli nel file .xlsx. */
  exportExtras(): string | null {
    if (!this.chartLayer.charts.length && !this.condRules.length && !this.cellNotes.size && !this.validations.size && !this.definedNames.size) return null;
    return JSON.stringify({
      charts: this.chartLayer.charts,
      condRules: this.condRules,
      cellNotes: [...this.cellNotes.entries()],
      validations: [...this.validations.entries()],
      definedNames: [...this.definedNames.entries()],
    });
  }

  /** Ripristina grafici, formattazione condizionale, note, convalide e nomi definiti caricati da un file .xlsx. */
  importExtras(json: string): void {
    try {
      const data = JSON.parse(json) as {
        charts?: ChartSpec[];
        condRules?: CondRule[];
        cellNotes?: [string, string][];
        validations?: [string, ValidationRule][];
        definedNames?: [string, { sheet: number; r: number; c: number; ref: string }][];
      };
      if (Array.isArray(data.charts)) {
        this.chartLayer.charts.splice(0, this.chartLayer.charts.length, ...data.charts);
      }
      if (Array.isArray(data.condRules)) this.condRules = data.condRules;
      if (Array.isArray(data.cellNotes)) this.cellNotes = new Map(data.cellNotes);
      if (Array.isArray(data.validations)) this.validations = new Map(data.validations);
      if (Array.isArray(data.definedNames)) this.definedNames = new Map(data.definedNames);
      this.draw();
    } catch { /* metadati non validi: ignora senza bloccare il file */ }
  }

  private validationButtonRect(): Rect | null {
    const rule = this.validations.get(this.noteKey(this.active.r, this.active.c));
    if (!rule || rule.kind !== "list" || !rule.options?.length) return null;
    const cell = this.cellRect(this.active.r, this.active.c);
    const size = Math.min(18 * this.zoom, cell.h - 2);
    return { x: cell.x + cell.w - size - 2, y: cell.y + (cell.h - size) / 2, w: size, h: size };
  }

  private openValidationPicker(): void {
    const rule = this.validations.get(this.noteKey(this.active.r, this.active.c));
    if (!rule || rule.kind !== "list" || !rule.options?.length) return;
    const rect = this.cellRect(this.active.r, this.active.c);
    const box = this.scroller.getBoundingClientRect();
    const cur = this.model.getFormattedCellValue(this.sheet, this.active.r, this.active.c).trim();
    openMenu({ x: box.left + rect.x, y: box.top + rect.y + rect.h }, rule.options.map((opt) => ({
      label: opt,
      checked: opt === cur,
      action: () => {
        this.apply(() => this.model.setUserInput(this.sheet, this.active.r, this.active.c, opt));
      },
    })));
  }

  constructor(readonly model: Model, private state: CommandState, private host: SheetHost) {
    this.nameBox = h("input", { class: "name-box", "aria-label": "Casella nome", spellcheck: "false" });
    this.formulaInput = h("textarea", { class: "formula-input", "aria-label": "Barra della formula", spellcheck: "false", rows: "1" });
    this.formulaBar = h("div", { class: "formula-bar" },
      this.nameBox, h("span", { class: "fx", title: t("Le formule si scrivono come in Excel nella lingua scelta: {0}…, separatore «{1}»", ["SOMMA", "SE", "CERCA.VERT"].map(fn).join(", "), langInfo().sheetLocale === "en" ? "," : ";") }, icon("SquareFunction", 16)), this.formulaInput);

    this.canvas = h("canvas", { class: "grid-canvas" });
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.spacer = h("div", { class: "grid-spacer" });
    this.scroller = h("div", { class: "grid-scroller", tabindex: "0", role: "grid", "aria-label": "Celle del foglio" }, this.spacer);
    this.editor = h("textarea", { class: "cell-editor", spellcheck: "false", hidden: true, rows: "1" });
    this.findBar = new FindBar<Cell>({
      search: (o) => this.search(o),
      startIndex: (res) => {
        const cur = this.active;
        const i = res.findIndex((p) => p.r > cur.r || (p.r === cur.r && p.c >= cur.c));
        return i < 0 ? 0 : i;
      },
      isCurrent: (p) => p.r === this.active.r && p.c === this.active.c,
      goTo: (cell) => { this.setSelection(cell); },
      replace: (cells, o, rep) => this.replaceCells(cells, o, rep),
      close: () => this.focus(),
    });
    this.chartLayer = new ChartLayer(this.model, () => this.sheet, () => { this.dirty = true; this.host.changed(); });
    const gridWrap = h("div", { class: "grid-wrap" }, this.canvas, this.scroller, this.chartLayer.el, this.editor, this.findBar.el);
    this.tabsEl = h("div", { class: "sheet-tabs" });
    this.el = h("div", { class: "sheet-view" }, this.formulaBar, gridWrap, this.tabsEl);

    document.body.append(this.assist.el);
    this.selectSheet(this.firstVisibleSheet());
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(gridWrap);
    onThemeChange(() => { this.colors = {}; this.draw(); });
  }

  // ---------- geometria ----------

  private get headW(): number {
    if (!this.state.isOn("headings")) return 0;
    return Math.round(Math.max(MIN_HEAD_W, String(this.extent.rows).length * 7.5 + 16) * this.zoom);
  }
  private get headH(): number {
    return this.state.isOn("headings") ? Math.round(HEAD_H * this.zoom) : 0;
  }
  // Riquadri bloccati: le prime righe/colonne restano ferme, le altre scorrono sotto.
  private get frozenCols(): number { return this.model.getFrozenColumnsCount(this.sheet); }
  private get frozenRows(): number { return this.model.getFrozenRowsCount(this.sheet); }
  private get frozenW(): number { return this.cols.start(this.frozenCols + 1) * this.zoom; }
  private get frozenH(): number { return this.rows.start(this.frozenRows + 1) * this.zoom; }
  private colX(c: number): number {
    return this.headW + this.cols.start(c) * this.zoom - (c > this.frozenCols ? this.scroller.scrollLeft : 0);
  }
  private rowY(r: number): number {
    return this.headH + this.rows.start(r) * this.zoom - (r > this.frozenRows ? this.scroller.scrollTop : 0);
  }
  /** Colonna sotto la coordinata x dello schermo. */
  private colAt(x: number): number {
    const rel = Math.max(x, this.headW) - this.headW;
    return Math.min(MAX_COL, this.cols.indexAt((rel < this.frozenW ? rel : rel + this.scroller.scrollLeft) / this.zoom));
  }
  private rowAt(y: number): number {
    const rel = Math.max(y, this.headH) - this.headH;
    return Math.min(MAX_ROW, this.rows.indexAt((rel < this.frozenH ? rel : rel + this.scroller.scrollTop) / this.zoom));
  }
  private colW(c: number): number { return this.cols.size(c) * this.zoom; }
  private rowH(r: number): number { return this.rows.size(r) * this.zoom; }

  private makeAxes(): void {
    const s = this.sheet;
    this.rows = new Axis(MAX_ROW, (r) => this.model.getRowHeight(s, r) * SCALE);
    this.cols = new Axis(MAX_COL, (c) => this.model.getColumnWidth(s, c) * SCALE);
  }

  private updateSpacer(): void {
    this.spacer.style.width = `${this.headW + this.cols.total(this.extent.cols) * this.zoom}px`;
    this.spacer.style.height = `${this.headH + this.rows.total(this.extent.rows) * this.zoom}px`;
  }

  /** Estende l'area scorrevole per includere i dati del foglio (come fa Excel). */
  private computeExtent(): void {
    let maxRow = 0, maxCol = 0;
    for (let c = 1; c <= 200; c++) {
      const rows = this.model.getRowsWithData(this.sheet, c);
      if (rows.length) { maxCol = c; maxRow = Math.max(maxRow, rows[rows.length - 1]); }
    }
    for (let r = 1; r <= Math.min(maxRow, 500); r++) {
      const cols = this.model.getColumnsWithData(this.sheet, r);
      if (cols.length) maxCol = Math.max(maxCol, cols[cols.length - 1]);
    }
    this.extent = { rows: Math.max(1000, maxRow + 200), cols: Math.max(52, maxCol + 26) };
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.scroller.clientWidth, hgt = this.scroller.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hgt * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hgt}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private mergeAt(r: number, c: number): MergedCell | undefined {
    return this.merged.find((m) => r >= m.row && r < m.row + m.height && c >= m.column && c < m.column + m.width);
  }

  /** Rettangolo a schermo di una cella (o dell'intera cella unita). */
  private cellRect(r: number, c: number): Rect {
    const m = this.mergeAt(r, c);
    if (m) {
      const x = this.colX(m.column), y = this.rowY(m.row);
      return { x, y, w: this.colX(m.column + m.width) - x, h: this.rowY(m.row + m.height) - y };
    }
    return { x: this.colX(c), y: this.rowY(r), w: this.colW(c), h: this.rowH(r) };
  }

  /** Cosa c'è sotto il puntatore: cella, intestazione, maniglia di ridimensionamento o di riempimento. */
  private hit(x: number, y: number):
    | { kind: "cell"; cell: Cell } | { kind: "corner" }
    | { kind: "col"; c: number; resize?: number } | { kind: "row"; r: number; resize?: number }
    | { kind: "fill" } | { kind: "filter"; c: number } {
    const hw = this.headW, hh = this.headH;
    const c = this.colAt(x);
    const r = this.rowAt(y);
    if (x < hw && y < hh) return { kind: "corner" };
    if (y < hh) {
      const right = this.colX(c) + this.colW(c), left = this.colX(c);
      if (Math.abs(x - right) <= RESIZE_GRIP) return { kind: "col", c, resize: c };
      if (Math.abs(x - left) <= RESIZE_GRIP && c > 1) return { kind: "col", c, resize: c - 1 };
      return { kind: "col", c };
    }
    if (x < hw) {
      const bottom = this.rowY(r) + this.rowH(r), top = this.rowY(r);
      if (Math.abs(y - bottom) <= RESIZE_GRIP) return { kind: "row", r, resize: r };
      if (Math.abs(y - top) <= RESIZE_GRIP && r > 1) return { kind: "row", r, resize: r - 1 };
      return { kind: "row", r };
    }
    const fbtn = this.filterButtonAt(x, y);
    if (fbtn) return { kind: "filter", c: fbtn };
    const vbtn = this.validationButtonRect();
    if (vbtn && x >= vbtn.x && x <= vbtn.x + vbtn.w && y >= vbtn.y && y <= vbtn.y + vbtn.h) return { kind: "validation" as never };
    const sel = this.selectionRect();
    if (sel && Math.abs(x - (sel.x + sel.w)) <= 5 && Math.abs(y - (sel.y + sel.h)) <= 5) return { kind: "fill" };
    return { kind: "cell", cell: { r: Math.min(r, MAX_ROW), c: Math.min(c, MAX_COL) } };
  }

  // ---------- fogli ----------

  private sheetsInfo() {
    return this.model.getWorksheetsProperties().map((p, index) => ({ ...p, index }));
  }

  private firstVisibleSheet(): number {
    return this.sheetsInfo().find((s) => s.state === "visible")?.index ?? 0;
  }

  private selectSheet(index: number): void {
    this.commitEdit();
    this.sheet = index;
    this.model.setSelectedSheet(index);
    this.makeAxes();
    this.merged = this.model.getMergedCells(index);
    this.computeExtent();
    this.active = this.anchor = { r: 1, c: 1 };
    this.renderTabs();
    this.updateSpacer();
    this.scroller.scrollTo(0, 0);
    this.selectionChanged();
  }

  private renderTabs(): void {
    const tabs = this.sheetsInfo().filter((s) => s.state === "visible").map((s) => {
      const tab = h("button", {
        class: "sheet-tab", "aria-selected": String(s.index === this.sheet),
        onclick: () => { if (s.index !== this.sheet) this.selectSheet(s.index); this.focus(); },
        ondblclick: () => this.renameSheetInline(tab, s.index),
        oncontextmenu: (e: MouseEvent) => { e.preventDefault(); this.sheetMenu(s.index, { x: e.clientX, y: e.clientY }); },
      }, s.name);
      if (s.color) tab.style.setProperty("--tab-color", this.resolveColor(s.color));
      return tab;
    });
    this.tabsEl.replaceChildren(...tabs,
      h("button", { class: "icon-btn", title: "Nuovo foglio (Maiusc+F11)", onclick: () => this.addSheet() }, icon("Plus", 14)));
  }

  private addSheet(): void {
    this.model.newSheet();
    this.changed();
    const sheets = this.sheetsInfo();
    this.selectSheet(sheets[sheets.length - 1].index);
  }

  private renameSheetInline(tab: HTMLElement, index: number): void {
    const name = this.sheetsInfo()[index].name;
    const input = h("input", { class: "sheet-rename", value: name, spellcheck: "false" });
    const finish = (save: boolean) => {
      if (!input.isConnected) return;
      const next = input.value.trim();
      if (save && next && next !== name) {
        try { this.model.renameSheet(index, next); this.changed(); } catch (e) { toast(t("Nome non valido: {0}", e)); }
      }
      this.renderTabs();
      this.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
    tab.replaceWith(input);
    input.select();
  }

  private sheetMenu(index: number, at: { x: number; y: number } | HTMLElement): void {
    const visible = this.sheetsInfo().filter((s) => s.state === "visible");
    openMenu(at, [
      { label: "Inserisci foglio", icon: "Plus", action: () => this.addSheet() },
      { label: "Rinomina", icon: "Pencil", action: () => {
        if (index !== this.sheet) this.selectSheet(index);
        const tab = this.tabsEl.querySelector<HTMLElement>('.sheet-tab[aria-selected="true"]');
        if (tab) this.renameSheetInline(tab, index);
      } },
      { label: "Duplica", icon: "CopyPlus", action: () => { this.model.duplicateSheet(index); this.changed(); this.renderTabs(); } },
      { separator: true },
      { label: "Sposta a sinistra", disabled: index === 0, action: () => { this.model.moveSheet(index, index - 1); this.changed(); this.selectSheet(index - 1); } },
      { label: "Sposta a destra", disabled: index >= this.sheetsInfo().length - 1, action: () => { this.model.moveSheet(index, index + 1); this.changed(); this.selectSheet(index + 1); } },
      { separator: true },
      { label: "Nascondi", icon: "EyeOff", disabled: visible.length < 2, action: () => { this.model.hideSheet(index); this.changed(); this.selectSheet(this.firstVisibleSheet()); } },
      ...this.sheetsInfo().filter((s) => s.state !== "visible").map((s): MenuItem => ({
        label: `Mostra «${s.name}»`, icon: "Eye", action: () => { this.model.unhideSheet(s.index); this.changed(); this.renderTabs(); },
      })),
      { label: "Elimina", icon: "Trash2", disabled: visible.length < 2, action: () => {
        this.model.deleteSheet(index); this.changed(); this.selectSheet(this.firstVisibleSheet());
      } },
    ]);
  }

  // ---------- selezione ----------

  private range() {
    const a = this.active, b = this.anchor;
    let r0 = Math.min(a.r, b.r), r1 = Math.max(a.r, b.r), c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c);
    // La selezione si allarga per includere per intero le celle unite che tocca.
    for (let changed = true; changed;) {
      changed = false;
      for (const m of this.merged) {
        const mr1 = m.row + m.height - 1, mc1 = m.column + m.width - 1;
        if (m.row <= r1 && mr1 >= r0 && m.column <= c1 && mc1 >= c0) {
          if (m.row < r0) { r0 = m.row; changed = true; }
          if (mr1 > r1) { r1 = mr1; changed = true; }
          if (m.column < c0) { c0 = m.column; changed = true; }
          if (mc1 > c1) { c1 = mc1; changed = true; }
        }
      }
    }
    return { r0, r1, c0, c1 };
  }

  private area(): Area {
    const { r0, r1, c0, c1 } = this.range();
    return { sheet: this.sheet, row: r0, column: c0, width: c1 - c0 + 1, height: r1 - r0 + 1 };
  }

  private isSingle(): boolean {
    const { r0, r1, c0, c1 } = this.range();
    const m = this.mergeAt(this.active.r, this.active.c);
    return (r0 === r1 && c0 === c1) || (!!m && m.row === r0 && m.column === c0 && m.height === r1 - r0 + 1 && m.width === c1 - c0 + 1);
  }

  private selectionRect(): Rect | null {
    const { r0, r1, c0, c1 } = this.range();
    const x = this.colX(c0), y = this.rowY(r0);
    return { x, y, w: this.colX(c1 + 1) - x, h: this.rowY(r1 + 1) - y };
  }

  private setSelection(active: Cell, anchor: Cell = active, scroll = true): void {
    const clamp = (p: Cell) => ({ r: Math.min(MAX_ROW, Math.max(1, p.r)), c: Math.min(MAX_COL, Math.max(1, p.c)) });
    this.active = clamp(active);
    this.anchor = clamp(anchor);
    // Una cella unita si seleziona sempre dall'angolo in alto a sinistra.
    const m = this.mergeAt(this.active.r, this.active.c);
    if (m && this.active.r === this.anchor.r && this.active.c === this.anchor.c) this.active = this.anchor = { r: m.row, c: m.column };
    if (scroll) this.scrollIntoView(this.active);
    this.selectionChanged();
  }

  private selectionChanged(): void {
    const { r0, r1, c0, c1 } = this.range();
    const a = this.active;
    // IronCalc usa la selezione per copia/incolla e formati.
    this.model.setSelectedSheet(this.sheet);
    this.model.setSelectedCell(a.r, a.c);
    this.model.setSelectedRange(r0, c0, r1, c1);
    if (this.isSingle()) this.nameBox.value = `${colName(a.c)}${a.r}`;
    else if (r0 === 1 && r1 === MAX_ROW) this.nameBox.value = `${colName(c0)}:${colName(c1)}`;
    else if (c0 === 1 && c1 === MAX_COL) this.nameBox.value = `${r0}:${r1}`;
    else this.nameBox.value = `${colName(c0)}${r0}:${colName(c1)}${r1}`;
    if (!this.editing) this.formulaInput.value = this.model.getCellContent(this.sheet, a.r, a.c);
    this.draw();
    this.host.selectionChanged();
  }

  private scrollIntoView(cell: Cell): void {
    if (cell.r + 50 > this.extent.rows) { this.extent.rows = Math.min(MAX_ROW, cell.r + 1000); this.updateSpacer(); }
    if (cell.c + 5 > this.extent.cols) { this.extent.cols = Math.min(MAX_COL, cell.c + 26); this.updateSpacer(); }
    const s = this.scroller;
    const fw = this.frozenW, fh = this.frozenH;
    const viewW = s.clientWidth - this.headW, viewH = s.clientHeight - this.headH;
    if (cell.c > this.frozenCols) {
      const x = this.cols.start(cell.c) * this.zoom, w = this.colW(cell.c);
      if (x - s.scrollLeft < fw) s.scrollLeft = x - fw;
      else if (x + w - s.scrollLeft > viewW) s.scrollLeft = Math.min(x - fw, x + w - viewW);
    }
    if (cell.r > this.frozenRows) {
      const y = this.rows.start(cell.r) * this.zoom, hh = this.rowH(cell.r);
      if (y - s.scrollTop < fh) s.scrollTop = y - fh;
      else if (y + hh - s.scrollTop > viewH) s.scrollTop = Math.min(y - fh, y + hh - viewH);
    }
  }

  private move(dr: number, dc: number, extend: boolean): void {
    // Saltiamo righe/colonne nascoste e l'interno delle celle unite.
    let { r, c } = this.active;
    const m = this.mergeAt(r, c);
    if (m && !extend) {
      if (dr > 0) r = m.row + m.height - 1;
      if (dc > 0) c = m.column + m.width - 1;
    }
    do { r += dr; } while (dr !== 0 && r > 1 && r < MAX_ROW && this.rows.size(r) === 0);
    do { c += dc; } while (dc !== 0 && c > 1 && c < MAX_COL && this.cols.size(c) === 0);
    const next = { r: Math.min(MAX_ROW, Math.max(1, r)), c: Math.min(MAX_COL, Math.max(1, c)) };
    this.setSelection(next, extend ? this.anchor : next);
  }

  /** Ctrl+freccia: salta al bordo del blocco di dati, come Excel. */
  private jump(dr: number, dc: number, extend: boolean): void {
    const { r, c } = this.active;
    const filled = (rr: number, cc: number) => rr >= 1 && cc >= 1 && rr <= MAX_ROW && cc <= MAX_COL && this.model.getCellContent(this.sheet, rr, cc) !== "";
    let target: Cell;
    if (dr !== 0) {
      const data = Array.from(this.model.getRowsWithData(this.sheet, c));
      target = { r: this.edgeIn(data, r, dr, MAX_ROW, (x) => filled(x, c)), c };
    } else {
      const data = Array.from(this.model.getColumnsWithData(this.sheet, r));
      target = { r, c: this.edgeIn(data, c, dc, MAX_COL, (x) => filled(r, x)) };
    }
    this.setSelection(target, extend ? this.anchor : target);
  }

  private edgeIn(withData: number[], pos: number, dir: number, max: number, filled: (x: number) => boolean): number {
    if (filled(pos) && filled(pos + dir)) {
      let p = pos;
      while (filled(p + dir)) p += dir;
      return p;
    }
    const next = dir > 0 ? withData.find((x) => x > pos) : [...withData].reverse().find((x) => x < pos);
    return next ?? (dir > 0 ? max : 1);
  }

  // ---------- modifica delle celle ----------

  private beginEdit(initial?: string, viaBar = false): void {
    if (this.editing) return;
    const cell = { ...this.active };
    this.editing = { cell, viaBar };
    const value = initial ?? this.model.getCellContent(this.sheet, cell.r, cell.c);
    this.editor.value = value;
    this.formulaInput.value = value;
    this.pointing = null;
    if (!viaBar) {
      this.editor.hidden = false;
      this.placeEditor();
      this.editor.focus();
      this.editor.setSelectionRange(value.length, value.length);
    }
    this.draw();
  }

  private placeEditor(): void {
    if (!this.editing || this.editor.hidden) return;
    const { r, c } = this.editing.cell;
    const rect = this.cellRect(r, c);
    const style = this.model.getCellStyle(this.sheet, r, c).style;
    Object.assign(this.editor.style, {
      left: `${rect.x}px`, top: `${rect.y}px`,
      minWidth: `${rect.w + 1}px`, height: `${rect.h + 1}px`,
      width: `${Math.max(rect.w + 1, Math.min(600, (this.editor.value.length + 2) * 8 * this.zoom))}px`,
      font: `${style.font.i ? "italic " : ""}${style.font.b ? "bold " : ""}${style.font.sz * (4 / 3) * SCALE * this.zoom}px ${cssFontFamily(style.font.name)}`,
    });
  }

  private activeInput(): HTMLTextAreaElement {
    return this.editing?.viaBar ? this.formulaInput : this.editor;
  }

  /** Scrive il valore nella cella. Restituisce false se l'utente deve correggerlo. */
  private commitEdit(): boolean {
    if (!this.editing) return true;
    const { r, c } = this.editing.cell;
    const value = this.activeInput().value;
    const before = this.model.getCellContent(this.sheet, r, c);
    this.endEdit();
    if (value !== before) {
      const vRule = this.validations.get(this.noteKey(r, c));
      if (vRule && value.trim() !== "") {
        if (vRule.kind === "list" && vRule.options && !vRule.options.includes(value.trim())) {
          toast(t("Valore non ammesso. Valori consentiti: {0}", vRule.options.join(", ")));
          return false;
        }
        if (vRule.kind === "number") {
          const n = Number(value.replace(",", "."));
          if (Number.isNaN(n) || (vRule.min !== undefined && n < vRule.min) || (vRule.max !== undefined && n > vRule.max)) {
            toast(t("Inserisci un numero tra {0} e {1}", vRule.min ?? "-∞", vRule.max ?? "+∞"));
            return false;
          }
        }
      }
      try {
        this.model.setUserInput(this.sheet, r, c, value);
      } catch (e) {
        toast(t("Valore non valido: {0}", e));
        return false;
      }
      if (value.includes("\n") && !this.styleAt(r, c).alignment?.wrap_text) {
        this.model.updateRangeStyle({ sheet: this.sheet, row: r, column: c, width: 1, height: 1 }, "alignment.wrap_text", "true");
      }
      const wraps = !!this.styleAt(r, c).alignment?.wrap_text;
      if (wraps) this.fitWrappedRows(r, r);
      this.changed(wraps);
    }
    return true;
  }

  private cancelEdit(): void {
    this.endEdit();
    this.selectionChanged();
  }

  private endEdit(): void {
    this.assist.hide();
    this.editing = null;
    this.pointing = null;
    this.editor.hidden = true;
  }

  /** Mentre si scrive una formula, cliccare una cella ne inserisce il riferimento. */
  private canPoint(): boolean {
    if (!this.editing) return false;
    const input = this.activeInput();
    if (!input.value.startsWith("=")) return false;
    const caret = input.selectionStart ?? input.value.length;
    if (this.pointing && this.pointing.end === caret) return true;
    return /[=(;+\-*/^&<>:,]\s*$/.test(input.value.slice(0, caret));
  }

  private pointTo(from: Cell, to: Cell): void {
    const input = this.activeInput();
    const caret = input.selectionStart ?? input.value.length;
    const start = this.pointing && this.pointing.end === caret ? this.pointing.start : caret;
    const end = this.pointing && this.pointing.end === caret ? this.pointing.end : caret;
    const a = `${colName(Math.min(from.c, to.c))}${Math.min(from.r, to.r)}`;
    const b = `${colName(Math.max(from.c, to.c))}${Math.max(from.r, to.r)}`;
    const ref = a === b ? a : `${a}:${b}`;
    input.value = input.value.slice(0, start) + ref + input.value.slice(end);
    this.pointing = { start, end: start + ref.length, from };
    input.setSelectionRange(start + ref.length, start + ref.length);
    (input === this.editor ? this.formulaInput : this.editor).value = input.value;
    this.placeEditor();
    this.draw();
  }

  /** Dopo ogni modifica al modello. */
  private changed(structure = false): void {
    if (structure) { this.makeAxes(); this.updateSpacer(); }
    this.merged = this.model.getMergedCells(this.sheet);
    this.dirty = true;
    this.selectionChanged();
    this.host.changed();
  }

  /** Esegue un'operazione sul modello mostrando gli errori invece di bloccarsi. */
  private apply(fn: () => void, structure = false): void {
    if (!this.commitEdit()) return;
    try {
      fn();
    } catch (e) {
      toast(String(e).replace(/^Error:\s*/, ""));
      return;
    }
    this.changed(structure);
  }

  private styleAt(r = this.active.r, c = this.active.c): CellStyle {
    return this.model.getCellStyle(this.sheet, r, c).style;
  }

  private setStyle(path: string, value: string): void {
    this.apply(() => this.model.updateRangeStyle(this.area(), path, value));
  }

  /** Per le proprietà che IronCalc non modifica direttamente (es. nome del font). */
  private transformStyles(fn: (s: CellStyle) => void): void {
    const { r0, r1, c0, c1 } = this.range();
    const big = (r1 - r0 + 1) * (c1 - c0 + 1) > 20_000;
    const styles: CellStyle[][] = [];
    for (let r = r0; r <= (big ? r0 : r1); r++) {
      const row: CellStyle[] = [];
      for (let c = c0; c <= (big ? c0 : c1); c++) { const s = this.styleAt(r, c); fn(s); row.push(s); }
      styles.push(row);
    }
    this.apply(() => this.model.onPasteStyles(styles));
  }

  // ---------- eventi ----------

  private bindEvents(): void {
    const s = this.scroller;

    s.addEventListener("scroll", () => {
      if (s.scrollTop + s.clientHeight > s.scrollHeight - 200 && this.extent.rows < MAX_ROW) {
        this.extent.rows = Math.min(MAX_ROW, this.extent.rows + 1000);
        this.updateSpacer();
      }
      if (s.scrollLeft + s.clientWidth > s.scrollWidth - 200 && this.extent.cols < MAX_COL) {
        this.extent.cols = Math.min(MAX_COL, this.extent.cols + 26);
        this.updateSpacer();
      }
      this.placeEditor();
      this.draw();
    });

    const local = (e: MouseEvent) => {
      const rect = s.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    s.addEventListener("pointermove", (e) => {
      const { x, y } = local(e);
      if (!this.drag) {
        const t = this.hit(x, y);
        s.style.cursor = t.kind === "col" && t.resize ? "col-resize"
          : t.kind === "row" && t.resize ? "row-resize"
          : t.kind === "fill" ? "crosshair" : t.kind === "cell" ? "cell" : t.kind === "filter" ? "pointer" : "default";
        return;
      }
      const t = this.hit(Math.max(this.headW + 1, x), Math.max(this.headH + 1, y));
      const cell = t.kind === "cell" ? t.cell : null;
      switch (this.drag.kind) {
        case "select":
          if (cell && (cell.r !== this.active.r || cell.c !== this.active.c)) this.setSelection(cell, this.anchor, false);
          break;
        case "point":
          if (cell && this.pointing) this.pointTo(this.pointing.from, cell);
          break;
        case "cols": {
          const c = this.colAt(x);
          this.setSelection({ r: MAX_ROW, c }, { r: 1, c: this.drag.from }, false);
          break;
        }
        case "rows": {
          const r = this.rowAt(y);
          this.setSelection({ r, c: MAX_COL }, { r: this.drag.from, c: 1 }, false);
          break;
        }
        case "resize-col":
        case "resize-row": {
          const pos = this.drag.kind === "resize-col" ? x : y;
          const size = Math.max(0, this.drag.startSize + (pos - this.drag.startPos) / this.zoom);
          this.drawResizeGuide(this.drag.kind, pos, size);
          break;
        }
        case "fill":
          if (cell) { this.drag.target = cell; this.draw(); }
          break;
      }
    });

    s.addEventListener("pointerdown", (e) => {
      const { x, y } = local(e);
      if (x >= s.clientWidth || y >= s.clientHeight) return; // barre di scorrimento
      if (e.button === 2) return; // gestito dal menu contestuale
      const t = this.hit(x, y);

      // Mentre si scrive una formula, il clic inserisce un riferimento invece di spostarsi.
      if (t.kind === "cell" && this.canPoint()) {
        e.preventDefault();
        this.pointTo(t.cell, t.cell);
        this.drag = { kind: "point" };
        s.setPointerCapture(e.pointerId);
        return;
      }

      e.preventDefault();
      if (!this.commitEdit()) return;
      this.tabStart = null;
      s.focus();
      s.setPointerCapture(e.pointerId);
      switch (t.kind) {
        case "corner":
          this.setSelection({ r: MAX_ROW, c: MAX_COL }, { r: 1, c: 1 }, false);
          break;
        case "col":
          if (t.resize) {
            this.drag = { kind: "resize-col", index: t.resize, startPos: x, startSize: this.cols.size(t.resize) };
          } else {
            const from = e.shiftKey ? this.anchor.c : t.c;
            this.setSelection({ r: MAX_ROW, c: t.c }, { r: 1, c: from }, false);
            this.drag = { kind: "cols", from };
          }
          break;
        case "row":
          if (t.resize) {
            this.drag = { kind: "resize-row", index: t.resize, startPos: y, startSize: this.rows.size(t.resize) };
          } else {
            const from = e.shiftKey ? this.anchor.r : t.r;
            this.setSelection({ r: t.r, c: MAX_COL }, { r: from, c: 1 }, false);
            this.drag = { kind: "rows", from };
          }
          break;
        case "fill":
          this.drag = { kind: "fill", target: { ...this.active } };
          break;
        case "filter":
          s.releasePointerCapture(e.pointerId);
          this.openFilter(t.c);
          break;
        case "validation" as never:
          s.releasePointerCapture(e.pointerId);
          this.openValidationPicker();
          break;
        case "cell":
          if (e.shiftKey) this.setSelection(t.cell, this.anchor, false);
          else this.setSelection(t.cell, t.cell, false);
          this.drag = { kind: "select" };
          break;
      }
    });

    s.addEventListener("pointerup", (e) => {
      const drag = this.drag;
      this.drag = null;
      if (!drag) return;
      const { x, y } = local(e);
      if (drag.kind === "resize-col" || drag.kind === "resize-row") {
        const col = drag.kind === "resize-col";
        const size = Math.max(0, drag.startSize + ((col ? x : y) - drag.startPos) / this.zoom) / SCALE;
        const { r0, r1, c0, c1 } = this.range();
        // Se si ridimensiona una colonna dentro una selezione di colonne intere, cambiano tutte.
        const whole = col ? r0 === 1 && r1 === MAX_ROW && drag.index >= c0 && drag.index <= c1
          : c0 === 1 && c1 === MAX_COL && drag.index >= r0 && drag.index <= r1;
        const [from, to] = whole ? (col ? [c0, c1] : [r0, r1]) : [drag.index, drag.index];
        this.apply(() => col ? this.model.setColumnsWidth(this.sheet, from, to, size) : this.model.setRowsHeight(this.sheet, from, to, size), true);
      } else if (drag.kind === "fill") {
        this.autoFill(drag.target);
      } else if (drag.kind === "select" && this.painter) {
        this.applyPainter();
      }
      this.draw();
    });

    s.addEventListener("dblclick", (e) => {
      const { x, y } = local(e);
      const t = this.hit(x, y);
      if (t.kind === "col" && t.resize) this.autoFitColumns(t.resize);
      else if (t.kind === "cell") this.beginEdit();
    });

    s.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const { x, y } = local(e);
      const t = this.hit(x, y);
      if (!this.commitEdit()) return;
      // Il tasto destro fuori dalla selezione la sposta, come in Excel.
      const { r0, r1, c0, c1 } = this.range();
      if (t.kind === "cell" && (t.cell.r < r0 || t.cell.r > r1 || t.cell.c < c0 || t.cell.c > c1)) this.setSelection(t.cell);
      if (t.kind === "col" && (t.c < c0 || t.c > c1 || r0 !== 1 || r1 !== MAX_ROW)) this.setSelection({ r: MAX_ROW, c: t.c }, { r: 1, c: t.c });
      if (t.kind === "row" && (t.r < r0 || t.r > r1 || c0 !== 1 || c1 !== MAX_COL)) this.setSelection({ r: t.r, c: MAX_COL }, { r: t.r, c: 1 });
      openMenu({ x: e.clientX, y: e.clientY }, this.contextMenu());
    });

    s.addEventListener("keydown", (e) => this.onGridKey(e));

    // Editor nella cella
    this.editor.addEventListener("keydown", (e) => this.onEditorKey(e, this.editor));
    this.editor.addEventListener("input", () => {
      this.pointing = null;
      this.formulaInput.value = this.editor.value;
      this.placeEditor();
      this.updateAssist(this.editor);
    });
    for (const field of [this.editor, this.formulaInput]) {
      field.addEventListener("keyup", (e) => { if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") this.updateAssist(field); });
      field.addEventListener("click", () => this.updateAssist(field));
    }

    // Barra della formula
    this.formulaInput.addEventListener("focus", () => {
      if (!this.editing) this.beginEdit(undefined, true);
    });
    this.formulaInput.addEventListener("input", () => {
      this.pointing = null;
      this.editor.value = this.formulaInput.value;
      this.updateAssist(this.formulaInput);
    });
    this.formulaInput.addEventListener("keydown", (e) => this.onEditorKey(e, this.formulaInput));
    this.formulaInput.addEventListener("blur", () => {
      // Se il focus va altrove (non sulla griglia per puntare un riferimento), conferma.
      setTimeout(() => {
        if (this.editing?.viaBar && document.activeElement !== this.formulaInput && !this.drag) {
          this.commitEdit();
        }
      });
    });

    // Casella nome: digitare un riferimento (es. B12 o A1:C5) per spostarsi.
    this.nameBox.addEventListener("focus", () => this.nameBox.select());
    this.nameBox.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { this.selectionChanged(); this.focus(); return; }
      if (e.key !== "Enter") return;
      e.preventDefault();
      const [a, b] = this.nameBox.value.split(":");
      const from = parseRef(a), to = b ? parseRef(b) : from;
      if (from && to) this.setSelection(to, from);
      else toast("Riferimento non valido: scrivi ad esempio B12 oppure A1:C5");
      this.focus();
    });

    // Appunti di sistema: Ctrl+C / Ctrl+X / Ctrl+V
    document.addEventListener("copy", (e) => this.onCopy(e, false));
    document.addEventListener("cut", (e) => this.onCopy(e, true));
    document.addEventListener("paste", (e) => this.onPaste(e));
  }

  private updateAssist(field: HTMLTextAreaElement): void {
    if (!this.editing) { this.assist.hide(); return; }
    this.assist.update(field, field.getBoundingClientRect());
  }

  private onSuggestKey(e: KeyboardEvent): boolean {
    return this.assist.key(e);
  }

  /** Tab e Invio dopo aver confermato una cella. */
  private advance(key: "Enter" | "Tab", back: boolean): void {
    if (key === "Tab") {
      const start = this.tabStart ?? this.active.c;
      this.move(0, back ? -1 : 1, false);
      this.tabStart = start;
    } else if (this.tabStart !== null && !back) {
      const target = { r: Math.min(MAX_ROW, this.active.r + 1), c: this.tabStart };
      this.tabStart = null;
      this.setSelection(target);
    } else {
      this.tabStart = null;
      this.move(back ? -1 : 1, 0, false);
    }
  }

  private onEditorKey(e: KeyboardEvent, input: HTMLTextAreaElement): void {
    if (this.onSuggestKey(e)) return;
    const back = e.shiftKey;
    if (e.key === "Enter" && e.altKey) {
      // Alt+Invio: a capo dentro la cella
      e.preventDefault();
      const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
      input.value = input.value.slice(0, start) + "\n" + input.value.slice(end);
      input.setSelectionRange(start + 1, start + 1);
      (input === this.editor ? this.formulaInput : this.editor).value = input.value;
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (this.commitEdit()) { this.advance("Enter", back); this.focus(); }
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (this.commitEdit()) { this.advance("Tab", back); this.focus(); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.cancelEdit();
      this.focus();
    } else if (e.key === "F4" && input.value.startsWith("=")) {
      // F4 alterna riferimenti relativi e assoluti (A1 → $A$1 → A$1 → $A1).
      e.preventDefault();
      const caret = input.selectionStart ?? 0;
      try {
        const [text, start, end] = this.model.cycleReference(input.value, caret, input.selectionEnd ?? caret);
        input.value = text;
        input.setSelectionRange(start, end);
        (input === this.editor ? this.formulaInput : this.editor).value = text;
      } catch { /* nessun riferimento sotto il cursore */ }
    }
    e.stopPropagation();
  }

  private onGridKey(e: KeyboardEvent): void {
    const ctrl = e.ctrlKey || e.metaKey;
    const ext = e.shiftKey;
    const page = Math.max(1, Math.floor((this.scroller.clientHeight - this.headH) / (this.rowH(this.active.r) || 20)) - 1);
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

    if (arrows[e.key]) {
      e.preventDefault();
      this.tabStart = null;
      const [dr, dc] = arrows[e.key];
      if (ctrl) this.jump(dr, dc, ext); else this.move(dr, dc, ext);
      return;
    }
    switch (e.key) {
      case "PageDown": case "PageUp":
        e.preventDefault();
        if (ctrl) { this.switchSheetBy(e.key === "PageDown" ? 1 : -1); return; }
        this.move(e.key === "PageDown" ? page : -page, 0, ext);
        return;
      case "Home":
        e.preventDefault();
        this.setSelection({ r: ctrl ? 1 : this.active.r, c: 1 }, ext ? this.anchor : undefined);
        return;
      case "Enter": case "Tab": {
        e.preventDefault();
        this.advance(e.key, ext);
        return;
      }
      case "F2": e.preventDefault(); this.beginEdit(); return;
      case "F11": if (e.shiftKey) { e.preventDefault(); this.addSheet(); } return;
      case "Escape": internalClipboard = null; this.painter = null; this.draw(); return;
      case "Delete": e.preventDefault(); this.clear("contents"); return;
      case "Backspace": e.preventDefault(); this.clear("contents"); this.beginEdit(""); return;
    }
    if (ctrl && e.key.toLowerCase() === "a") { e.preventDefault(); this.setSelection({ r: MAX_ROW, c: MAX_COL }, { r: 1, c: 1 }, false); return; }
    if (ctrl && e.key === " ") { e.preventDefault(); this.setSelection({ r: MAX_ROW, c: this.active.c }, { r: 1, c: this.active.c }, false); return; }
    if (ext && e.key === " ") { e.preventDefault(); this.setSelection({ r: this.active.r, c: MAX_COL }, { r: this.active.r, c: 1 }, false); return; }
    if (ctrl && e.key === ";") { e.preventDefault(); this.beginEdit(new Date().toLocaleDateString(localeTag(), { day: "2-digit", month: "2-digit", year: "numeric" })); return; }
    if (e.altKey && e.key === "=") { e.preventDefault(); this.autoSum(); return; }
    if (e.key.length === 1 && !ctrl && !e.altKey) {
      e.preventDefault();
      this.beginEdit(e.key);
    }
  }

  private switchSheetBy(dir: number): void {
    const visible = this.sheetsInfo().filter((s) => s.state === "visible").map((s) => s.index);
    const i = visible.indexOf(this.sheet);
    const next = visible[i + dir];
    if (next !== undefined) this.selectSheet(next);
  }

  // ---------- appunti ----------

  private owns(target: EventTarget | null): boolean {
    return target === this.scroller && !this.el.hidden;
  }

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (!this.owns(document.activeElement) || this.editing) return;
    e.preventDefault();
    const clip = this.model.copyToClipboard();
    e.clipboardData?.setData("text/plain", clip.csv);
    internalClipboard = { model: this.model, sheet: this.sheet, clip, cut };
    this.draw();
  }

  private onPaste(e: ClipboardEvent): void {
    if (!this.owns(document.activeElement) || this.editing) return;
    e.preventDefault();
    this.pasteText(e.clipboardData?.getData("text/plain") ?? "");
  }

  private pasteText(text: string): void {
    const ic = internalClipboard;
    if (ic && ic.model === this.model && (text === "" || text === ic.clip.csv)) {
      const { range } = ic.clip;
      this.apply(() => this.model.pasteFromClipboard(ic.sheet, range, ic.clip.data, ic.cut));
      // Seleziona l'area incollata.
      const hgt = range[2] - range[0], wid = range[3] - range[1];
      this.setSelection({ r: this.active.r + hgt, c: this.active.c + wid }, { ...this.active }, false);
      if (ic.cut) internalClipboard = null;
      return;
    }
    if (!text) return;
    const a = this.active;
    this.apply(() => this.model.pasteCsvText({ sheet: this.sheet, row: a.r, column: a.c, width: 1, height: 1 }, text.replace(/\r\n/g, "\n").replace(/\n$/, "")));
  }

  /** Valori della selezione, separati da tabulazioni, per l'assistente. */
  aiText(): string {
    const { r0, r1, c0, c1 } = this.range();
    const lines: string[] = [];
    for (let r = r0; r <= Math.min(r1, r0 + 4999); r++) {
      const cells: string[] = [];
      for (let c = c0; c <= Math.min(c1, c0 + 199); c++) cells.push(this.model.getFormattedCellValue(this.sheet, r, c));
      lines.push(cells.join("\t"));
    }
    return lines.join("\n").replace(/[\t\n]+$/, "");
  }

  /** Scrive un testo (righe e tabulazioni) a partire dalla cella attiva. */
  aiInsert(text: string): void {
    this.pasteText(text);
  }

  private async pasteFromMenu(): Promise<void> {
    if (internalClipboard?.model === this.model) { this.pasteText(""); return; }
    try {
      this.pasteText(await navigator.clipboard.readText());
    } catch {
      toast("Per incollare da un'altra applicazione usa Ctrl+V");
    }
  }

  // ---------- operazioni ----------

  private clear(what: "contents" | "formatting" | "all"): void {
    const { r0, r1, c0, c1 } = this.range();
    this.apply(() => {
      if (what === "contents") this.model.rangeClearContents(this.sheet, r0, c0, r1, c1);
      else if (what === "formatting") this.model.rangeClearFormatting(this.sheet, r0, c0, r1, c1);
      else this.model.rangeClearAll(this.sheet, r0, c0, r1, c1);
    });
  }

  private autoFill(target: Cell): void {
    const area = this.area();
    const { r0, r1, c0, c1 } = this.range();
    if (target.r > r1 || target.r < r0) {
      this.apply(() => this.model.autoFillRows(area, target.r));
      this.setSelection({ r: Math.max(r1, target.r), c: c1 }, { r: Math.min(r0, target.r), c: c0 }, false);
    } else if (target.c > c1 || target.c < c0) {
      this.apply(() => this.model.autoFillColumns(area, target.c));
      this.setSelection({ r: r1, c: Math.max(c1, target.c) }, { r: r0, c: Math.min(c0, target.c) }, false);
    }
  }

  /** Somma automatica (Alt+=): propone =SOMMA() dei numeri sopra o a sinistra. */
  private autoSum(): void {
    if (!this.commitEdit()) return;
    const isNum = (r: number, c: number) => this.model.getCellType(this.sheet, r, c) === 1 && this.model.getCellContent(this.sheet, r, c) !== "";
    const { r0, r1, c0, c1 } = this.range();
    if (!this.isSingle()) {
      // Con un intervallo selezionato: somma di ogni colonna nella riga sotto.
      this.apply(() => {
        for (let c = c0; c <= c1; c++) this.model.setUserInput(this.sheet, r1 + 1, c, `=${fn("SOMMA")}(${colName(c)}${r0}:${colName(c)}${r1})`);
      });
      return;
    }
    const { r, c } = this.active;
    let top = r - 1;
    while (top >= 1 && isNum(top, c)) top--;
    if (top < r - 1) { this.beginEdit(`=${fn("SOMMA")}(${colName(c)}${top + 1}:${colName(c)}${r - 1})`); return; }
    let left = c - 1;
    while (left >= 1 && isNum(r, left)) left--;
    if (left < c - 1) { this.beginEdit(`=${fn("SOMMA")}(${colName(left + 1)}${r}:${colName(c - 1)}${r})`); return; }
    this.beginEdit(`=${fn("SOMMA")}()`);
    const caret = this.editor.value.length - 1;
    this.editor.setSelectionRange(caret, caret);
  }

  private autoFitColumns(c: number): void {
    const { r0, r1, c0, c1 } = this.range();
    const cols = r0 === 1 && r1 === MAX_ROW && c >= c0 && c <= c1 ? [c0, c1] : [c, c];
    this.apply(() => {
      for (let col = cols[0]; col <= cols[1]; col++) {
        let width = 0;
        for (const row of Array.from(this.model.getRowsWithData(this.sheet, col)).slice(0, 5000)) {
          if (this.mergeAt(row, col)) continue;
          const st = this.styleAt(row, col);
          this.ctx.font = `${st.font.i ? "italic " : ""}${st.font.b ? "bold " : ""}${st.font.sz * (4 / 3)}px ${cssFontFamily(st.font.name)}`;
          width = Math.max(width, this.ctx.measureText(this.model.getFormattedCellValue(this.sheet, row, col)).width);
        }
        if (width > 0) this.model.setColumnsWidth(this.sheet, col, col, width + 14);
      }
    }, true);
  }

  private insertOrDelete(what: "insertRows" | "insertCols" | "deleteRows" | "deleteCols"): void {
    const { r0, r1, c0, c1 } = this.range();
    const s = this.sheet;
    this.apply(() => {
      if (what === "insertRows") this.model.insertRows(s, r0, r1 - r0 + 1);
      else if (what === "insertCols") this.model.insertColumns(s, c0, c1 - c0 + 1);
      else if (what === "deleteRows") this.model.deleteRows(s, r0, r1 - r0 + 1);
      else this.model.deleteColumns(s, c0, c1 - c0 + 1);
    }, true);
  }

  private setHidden(kind: "rows" | "cols", hidden: boolean): void {
    const { r0, r1, c0, c1 } = this.range();
    this.apply(() => {
      if (kind === "rows") this.model.setRowsHidden(this.sheet, r0, r1, hidden);
      else this.model.setColumnsHidden(this.sheet, c0, c1, hidden);
    }, true);
  }

  /**
   * Ordina le righe della selezione (o del blocco di dati attorno alla cella attiva)
   * in base alla colonna attiva. È un unico passo da annullare con Ctrl+Z.
   */
  private sort(descending: boolean): void {
    if (!this.commitEdit()) return;
    let { r0, r1, c0, c1 } = this.range();
    if (this.isSingle()) ({ r0, r1, c0, c1 } = this.currentRegion(this.active));
    if (r1 === MAX_ROW) r1 = Math.max(r0, ...Array.from({ length: c1 - c0 + 1 }, (_, i) => {
      const rows = this.model.getRowsWithData(this.sheet, c0 + i);
      return rows.length ? rows[rows.length - 1] : r0;
    }));
    if (r1 <= r0) return;
    if (this.merged.some((m) => m.row <= r1 && m.row + m.height - 1 >= r0 && m.column <= c1 && m.column + m.width - 1 >= c0)) {
      toast("Non si possono ordinare intervalli con celle unite");
      return;
    }
    this.sortRange(r0, r1, c0, c1, Math.min(Math.max(this.active.c, c0), c1), descending);
  }

  /** Ordina le righe r0..r1 (colonne c0..c1) in base alla colonna `key`. */
  private sortRange(r0: number, r1: number, c0: number, c1: number, key: number, descending: boolean, header?: boolean): void {
    // Intestazione: prima riga tutta di testo e seconda riga con almeno un numero.
    const typeAt = (r: number, c: number) => this.model.getCellContent(this.sheet, r, c) === "" ? 0 : this.model.getCellType(this.sheet, r, c);
    let hasHeader = header ?? false;
    if (header === undefined && r1 > r0 + 1) {
      const first = Array.from({ length: c1 - c0 + 1 }, (_, i) => typeAt(r0, c0 + i));
      const second = Array.from({ length: c1 - c0 + 1 }, (_, i) => typeAt(r0 + 1, c0 + i));
      hasHeader = first.every((t) => t === 2 || t === 0) && first.some((t) => t === 2) && second.some((t) => t === 1);
    }
    const start = hasHeader ? r0 + 1 : r0;

    const sortKey = (r: number): [number, number | string] => {
      const content = this.model.getCellContent(this.sheet, r, key);
      if (content === "") return [9, 0]; // le celle vuote vanno sempre in fondo
      const type = this.model.getCellType(this.sheet, r, key);
      const shown = this.model.getFormattedCellValue(this.sheet, r, key);
      if (type === 1) {
        const n = parseDisplayedNumber(content.startsWith("=") ? shown : content) ?? parseDisplayedNumber(shown) ?? dateSerial(shown) ?? dateSerial(content);
        return [1, n ?? 0];
      }
      return type === 2 ? [2, shown] : type === 4 ? [3, shown] : [4, shown];
    };
    const coll = new Intl.Collator("it", { sensitivity: "base", numeric: true });
    const order = Array.from({ length: r1 - start + 1 }, (_, i) => start + i)
      .map((r) => ({ r, k: sortKey(r) }))
      .sort((a, b) => {
        if (a.k[0] !== b.k[0]) return a.k[0] === 9 ? 1 : b.k[0] === 9 ? -1 : (descending ? b.k[0] - a.k[0] : a.k[0] - b.k[0]);
        const d = typeof a.k[1] === "number" && typeof b.k[1] === "number" ? a.k[1] - b.k[1] : coll.compare(String(a.k[1]), String(b.k[1]));
        return descending ? -d : d;
      })
      .map((x) => x.r);

    // Copia il blocco e lo reincolla con le righe permutate: formule e formati viaggiano con la riga.
    this.model.setSelectedSheet(this.sheet);
    this.model.setSelectedCell(start, c0);
    this.model.setSelectedRange(start, c0, r1, c1);
    const clip = this.model.copyToClipboard();
    // Le formule si spostano con la loro riga: =B3*C3 portata in riga 2 diventa =B2*C2.
    type ClipCell = { text: string };
    const data = new Map<number, Map<number, ClipCell>>();
    order.forEach((src, i) => {
      const row = clip.data.get(src) as Map<number, ClipCell> | undefined;
      if (!row) return;
      const dest = start + i;
      data.set(dest, new Map([...row].map(([c, cell]) =>
        [c, cell.text.startsWith("=") ? { ...cell, text: shiftFormulaRows(cell.text, dest - src) } : cell])));
    });
    this.apply(() => this.model.pasteFromClipboard(this.sheet, clip.range, data as Clipboard["data"], false));
    this.setSelection({ r: r1, c: c1 }, { r: r0, c: c0 }, false);
    this.active = { r: r0, c: key };
    this.selectionChanged();
  }

  /** Il blocco di celle piene contiguo alla cella (come Ctrl+A in Excel su una tabella). */
  private currentRegion(cell: Cell) {
    let r0 = cell.r, r1 = cell.r, c0 = cell.c, c1 = cell.c;
    const filled = (r: number, c: number) => r >= 1 && c >= 1 && this.model.getCellContent(this.sheet, r, c) !== "";
    const rowHas = (r: number) => { for (let c = c0 - 1; c <= c1 + 1; c++) if (filled(r, c)) return true; return false; };
    const colHas = (c: number) => { for (let r = r0 - 1; r <= r1 + 1; r++) if (filled(r, c)) return true; return false; };
    for (let grew = true, guard = 0; grew && guard < 10_000; guard++) {
      grew = false;
      if (r0 > 1 && rowHas(r0 - 1)) { r0--; grew = true; }
      if (r1 < MAX_ROW && rowHas(r1 + 1)) { r1++; grew = true; }
      if (c0 > 1 && colHas(c0 - 1)) { c0--; grew = true; }
      if (c1 < MAX_COL && colHas(c1 + 1)) { c1++; grew = true; }
    }
    return { r0, r1, c0, c1 };
  }

  private startPainter(): void {
    const { r0, r1, c0, c1 } = this.range();
    const styles: CellStyle[][] = [];
    for (let r = r0; r <= Math.min(r1, r0 + 50); r++) {
      const row: CellStyle[] = [];
      for (let c = c0; c <= Math.min(c1, c0 + 50); c++) row.push(this.styleAt(r, c));
      styles.push(row);
    }
    this.painter = styles;
    toast("Seleziona le celle a cui applicare il formato (Esc per annullare)");
    this.draw();
  }

  private applyPainter(): void {
    const styles = this.painter;
    this.painter = null;
    if (styles) this.apply(() => this.model.onPasteStyles(styles));
  }

  private setBorder(type: string, style = "thin"): void {
    this.apply(() => this.model.setAreaWithBorder(this.area(), { item: { style, color: "#000000" } as never, type } as never));
  }

  // ---------- menu ----------

  private contextMenu(): MenuItem[] {
    const { r0, r1, c0, c1 } = this.range();
    const nr = r1 - r0 + 1, nc = c1 - c0 + 1;
    const exec = (cmd: "copy" | "cut") => () => { this.focus(); document.execCommand(cmd); };
    return [
      { label: "Taglia", icon: "Scissors", shortcut: "Ctrl+X", action: exec("cut") },
      { label: "Copia", icon: "Copy", shortcut: "Ctrl+C", action: exec("copy") },
      { label: "Incolla", icon: "ClipboardPaste", shortcut: "Ctrl+V", action: () => void this.pasteFromMenu() },
      { separator: true },
      { label: nr === 1 ? "Inserisci riga sopra" : t("Inserisci {0} righe sopra", nr), icon: "BetweenHorizontalStart", action: () => this.insertOrDelete("insertRows") },
      { label: nc === 1 ? "Inserisci colonna a sinistra" : t("Inserisci {0} colonne a sinistra", nc), icon: "BetweenVerticalStart", action: () => this.insertOrDelete("insertCols") },
      { label: nr === 1 ? "Elimina riga" : t("Elimina {0} righe", nr), icon: "Trash2", action: () => this.insertOrDelete("deleteRows") },
      { label: nc === 1 ? "Elimina colonna" : t("Elimina {0} colonne", nc), icon: "Trash2", action: () => this.insertOrDelete("deleteCols") },
      { separator: true },
      { label: "Cancella contenuto", icon: "Eraser", shortcut: "Canc", action: () => this.clear("contents") },
      { label: "Ordina dalla A alla Z", icon: "ArrowDownAZ", action: () => this.sort(false) },
      { label: "Ordina dalla Z alla A", icon: "ArrowDownZA", action: () => this.sort(true) },
      { separator: true },
      { label: this.mergeAt(this.active.r, this.active.c) ? "Dividi celle" : "Unisci e centra", icon: "TableCellsMerge", disabled: this.isSingle() && !this.mergeAt(this.active.r, this.active.c), action: () => this.handle("mergeCells") },
      { label: "Adatta larghezza colonne", icon: "MoveHorizontal", action: () => this.autoFitColumns(this.active.c) },
    ];
  }

  private ribbonMenu(id: string): MenuItem[] | null {
    switch (id) {
      case "fontColor":
        return [{ colors: (c) => this.setStyle("font.color", c ?? ""), noneLabel: "Automatico" }];
      case "fillColor":
        return [{ colors: (c) => this.setStyle("fill.color", c ?? ""), noneLabel: "Nessun riempimento" }];
      case "cellBorders":
        return [
          { label: "Tutti i bordi", icon: "Grid3x3", action: () => this.setBorder("All") },
          { label: "Bordi esterni", icon: "Square", action: () => this.setBorder("Outer") },
          { label: "Bordo esterno spesso", icon: "Frame", action: () => this.setBorder("Outer", "medium") },
          { label: "Bordi interni", icon: "Grid2x2", action: () => this.setBorder("Inner") },
          { separator: true },
          { label: "Bordo inferiore", action: () => this.setBorder("Bottom") },
          { label: "Bordo superiore", action: () => this.setBorder("Top") },
          { label: "Bordo sinistro", action: () => this.setBorder("Left") },
          { label: "Bordo destro", action: () => this.setBorder("Right") },
          { label: "Doppio bordo inferiore", action: () => this.setBorder("Bottom", "double") },
          { separator: true },
          { label: "Nessun bordo", icon: "SquareX", action: () => this.setBorder("None") },
        ];
      case "insertCells":
        return [
          { label: "Inserisci righe sopra", icon: "BetweenHorizontalStart", action: () => this.insertOrDelete("insertRows") },
          { label: "Inserisci colonne a sinistra", icon: "BetweenVerticalStart", action: () => this.insertOrDelete("insertCols") },
          { label: "Inserisci foglio", icon: "Plus", action: () => this.addSheet() },
        ];
      case "deleteCells":
        return [
          { label: "Elimina righe", icon: "Trash2", action: () => this.insertOrDelete("deleteRows") },
          { label: "Elimina colonne", icon: "Trash2", action: () => this.insertOrDelete("deleteCols") },
          { label: "Elimina foglio", icon: "Trash2", disabled: this.sheetsInfo().filter((s) => s.state === "visible").length < 2, action: () => { this.model.deleteSheet(this.sheet); this.changed(); this.selectSheet(this.firstVisibleSheet()); } },
        ];
      case "formatCells":
        return [
          { label: "Adatta larghezza colonne", icon: "MoveHorizontal", action: () => this.autoFitColumns(this.active.c) },
          { separator: true },
          { label: "Nascondi righe", icon: "EyeOff", action: () => this.setHidden("rows", true) },
          { label: "Nascondi colonne", icon: "EyeOff", action: () => this.setHidden("cols", true) },
          { label: "Scopri righe", icon: "Eye", action: () => this.setHidden("rows", false) },
          { label: "Scopri colonne", icon: "Eye", action: () => this.setHidden("cols", false) },
          { separator: true },
          { label: "Rinomina foglio", icon: "Pencil", action: () => this.sheetMenu(this.sheet, this.tabsEl) },
        ];
      case "freezePanes": {
        const frozen = this.frozenRows > 0 || this.frozenCols > 0;
        const freeze = (rows: number, cols: number) => {
          this.scroller.scrollTo(0, 0);
          this.apply(() => { this.model.setFrozenRowsCount(this.sheet, rows); this.model.setFrozenColumnsCount(this.sheet, cols); });
        };
        return [
          { label: "Blocca riquadri", icon: "Snowflake", action: () => freeze(this.active.r - 1, this.active.c - 1) },
          { label: "Blocca riga superiore", action: () => freeze(1, 0) },
          { label: "Blocca prima colonna", action: () => freeze(0, 1) },
          { separator: true },
          { label: "Sblocca riquadri", disabled: !frozen, action: () => freeze(0, 0) },
        ];
      }
      case "sortFilter":
        return [
          { label: "Ordina dalla A alla Z", icon: "ArrowDownAZ", action: () => this.sort(false) },
          { label: "Ordina dalla Z alla A", icon: "ArrowDownZA", action: () => this.sort(true) },
          { separator: true },
          { label: "Filtro", icon: "Funnel", shortcut: "Ctrl+Maiusc+L", checked: this.filters.has(this.sheet), action: () => this.toggleFilter() },
        ];
      case "autoSum":
        return [
          { label: "Somma", icon: "Sigma", action: () => this.autoSum() },
          { label: "Media", action: () => this.insertFunction("MEDIA") },
          { label: "Conteggio numeri", action: () => this.insertFunction("CONTA.NUMERI") },
          { label: "Max", action: () => this.insertFunction("MAX") },
          { label: "Min", action: () => this.insertFunction("MIN") },
        ];
      case "clearMenu":
        return [
          { label: "Cancella tutto", icon: "Eraser", action: () => this.clear("all") },
          { label: "Cancella formati", action: () => this.clear("formatting") },
          { label: "Cancella contenuto", shortcut: "Canc", action: () => this.clear("contents") },
        ];
      case "fmtCurrency":
        return [
          { label: "€ Euro", action: () => this.setStyle("num_fmt", '#,##0.00 "€"') },
          { label: "$ Dollaro", action: () => this.setStyle("num_fmt", '"$"#,##0.00') },
          { label: "£ Sterlina", action: () => this.setStyle("num_fmt", '"£"#,##0.00') },
          { label: "CHF Franco svizzero", action: () => this.setStyle("num_fmt", '"CHF" #,##0.00') },
        ];
      case "paste":
        return [
          { label: "Incolla", icon: "ClipboardPaste", shortcut: "Ctrl+V", action: () => void this.pasteFromMenu() },
          { label: "Incolla solo i valori", icon: "ClipboardType", action: () => void this.pasteValues() },
        ];
      case "conditionalFormat": {
        const addRule = async (kind: CondRule["kind"], ask?: string) => {
          let value: string | undefined;
          if (ask) {
            const v = await promptDialog("Formattazione condizionale", ask);
            if (v === null) return;
            value = v;
          }
          this.condRules.push({ sheet: this.sheet, range: this.range(), kind, value });
          this.draw();
          toast("Regola di formattazione condizionale applicata");
        };
        return [
          { label: "Maggiore di…", action: () => void addRule("gt", "Evidenzia in verde le celle maggiori di:") },
          { label: "Minore di…", action: () => void addRule("lt", "Evidenzia in rosso le celle minori di:") },
          { label: "Uguale a…", action: () => void addRule("eq", "Evidenzia in giallo le celle uguali a:") },
          { label: "Contiene testo…", action: () => void addRule("contains", "Evidenzia in blu le celle che contengono:") },
          { label: "Valori duplicati", action: () => void addRule("duplicates") },
          { separator: true },
          { label: "Barre dei dati", icon: "ChartColumn", action: () => void addRule("databar") },
          { label: "Scala di colori (rosso → verde)", action: () => void addRule("colorscale") },
          { separator: true },
          { label: "Cancella regole del foglio", icon: "Trash2", action: () => { this.condRules = this.condRules.filter((r) => r.sheet !== this.sheet); this.draw(); toast("Regole rimosse"); } },
        ];
      }
      case "formatAsTable":
        return [
          { label: "Blu aziendale", action: () => this.applyTable("#1F4E79", "#EDF2F8") },
          { label: "Verde smeraldo", action: () => this.applyTable("#166534", "#ECFDF5") },
          { label: "Grigio professionale", action: () => this.applyTable("#334155", "#F1F5F9") },
        ];
      case "cellStyles":
        return Object.entries(CELL_STYLE_PRESETS).map(([, p]) => ({
          label: p.label,
          action: () => this.apply(() => {
            const area = this.area();
            if (p.bg) this.model.updateRangeStyle(area, "fill.color", p.bg);
            if (p.fg) this.model.updateRangeStyle(area, "font.color", p.fg);
            if (p.bold !== undefined) this.model.updateRangeStyle(area, "font.b", String(p.bold));
            if (p.italic !== undefined) this.model.updateRangeStyle(area, "font.i", String(p.italic));
          }),
        }));
      case "validation":
        return [
          {
            label: "Elenco a discesa…",
            action: async () => {
              const v = await promptDialog("Convalida dati (Elenco)", "Valori ammessi separati da virgola:", "Pagato, In corso, Annullato");
              if (!v) return;
              const options = v.split(",").map((s) => s.trim()).filter(Boolean);
              if (!options.length) return;
              const { r0, c0, r1, c1 } = this.range();
              for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.validations.set(this.noteKey(r, c), { kind: "list", options });
              this.draw();
              toast(`Convalida elenco applicata (${options.length} voci)`);
            },
          },
          {
            label: "Intervallo numerico…",
            action: async () => {
              const v = await promptDialog("Convalida dati (Numeri)", "Intervallo min;max (es. 0;100):", "0;100");
              if (!v) return;
              const [a, b] = v.split(/[;,]/).map((x) => Number(x.trim().replace(",", ".")));
              if (Number.isNaN(a) || Number.isNaN(b)) { toast("Intervallo non valido"); return; }
              const { r0, c0, r1, c1 } = this.range();
              for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.validations.set(this.noteKey(r, c), { kind: "number", min: Math.min(a, b), max: Math.max(a, b) });
              toast(`Convalida numerica (${Math.min(a, b)} – ${Math.max(a, b)}) applicata`);
            },
          },
          { separator: true },
          {
            label: "Rimuovi convalida",
            icon: "Trash2",
            action: () => {
              const { r0, c0, r1, c1 } = this.range();
              for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.validations.delete(this.noteKey(r, c));
              toast("Convalida rimossa");
            },
          },
        ];
      case "chartColumn": case "chartLine": case "chartPie": {
        const type: ChartType = id === "chartColumn" ? "column" : id === "chartLine" ? "line" : "pie";
        return [
          { label: "Crea grafico dalla selezione", icon: "ChartColumn", action: () => this.createChart(type) },
        ];
      }
      case "fnFinancial":
        return ["RATA", "VA", "VF", "TASSO", "VAN", "TIR.COST"].map((f) => ({ label: fn(f), action: () => this.beginEdit(`=${fn(f)}(`) }));
      case "fnLogical":
        return ["SE", "E", "O", "NON", "SE.ERRORE", "PIÙ.SE"].map((f) => ({ label: fn(f), action: () => this.beginEdit(`=${fn(f)}(`) }));
      case "fnText":
        return ["CONCATENA", "SINISTRA", "DESTRA", "STRINGA.ESTRAI", "LUNGHEZZA", "MAIUSC", "MINUSC", "ANNULLA.SPAZI"].map((f) => ({ label: fn(f), action: () => this.beginEdit(`=${fn(f)}(`) }));
      case "fnDate":
        return ["OGGI", "ADESSO", "DATA", "ANNO", "MESE", "GIORNO", "GIORNI.LAVORATIVI.TOT"].map((f) => ({ label: fn(f), action: () => this.beginEdit(`=${fn(f)}(`) }));
      case "fnLookup":
        return ["CERCA.VERT", "CERCA.ORIZZ", "INDICE", "CONFRONTA", "CERCA.X"].map((f) => ({ label: fn(f), action: () => this.beginEdit(`=${fn(f)}(`) }));
      case "fnRecent":
        return ["SOMMA", "MEDIA", "SE", "CONTA.SE", "SOMMA.SE", "CERCA.VERT"].map((f) => ({ label: fn(f), action: () => this.beginEdit(`=${fn(f)}(`) }));
      case "nameManager":
        return this.definedNames.size
          ? [
              ...[...this.definedNames.entries()].map(([name, target]): MenuItem => ({
                label: `${name}  →  ${target.ref}`,
                action: () => {
                  if (target.sheet !== this.sheet) this.selectSheet(target.sheet);
                  this.setSelection({ r: target.r, c: target.c });
                },
              })),
              { separator: true },
              { label: "Elimina tutti i nomi", icon: "Trash2", action: () => { this.definedNames.clear(); this.dirty = true; toast("Nomi definiti eliminati"); } },
            ]
          : [{ heading: "Nessun nome definito" }];
    }
    return null;
  }

  private applyTable(accent: string, stripe: string): void {
    const rng = this.range();
    this.apply(() => {
      formatRangeAsTable(this.model, this.sheet, rng, accent, stripe);
      this.setBorder("All");
    });
    if (!this.filters.has(this.sheet)) this.toggleFilter();
    toast("Tabella formattata con filtro");
  }

  private createChart(type: ChartType): void {
    const rng = this.range();
    this.chartLayer.add(type, rng);
    toast("Grafico inserito (trascina il titolo per spostarlo, doppio clic per rinominarlo)");
  }

  private async pasteValues(): Promise<void> {
    let text = internalClipboard?.clip.csv ?? "";
    if (!text) { try { text = await navigator.clipboard.readText(); } catch { /* niente */ } }
    if (!text) { toast("Gli appunti sono vuoti"); return; }
    const a = this.active;
    this.apply(() => this.model.pasteCsvText({ sheet: this.sheet, row: a.r, column: a.c, width: 1, height: 1 }, text));
  }

  // ---------- filtri ----------

  private filterButtonRect(c: number): Rect | null {
    const f = this.filters.get(this.sheet);
    if (!f || c < f.c0 || c > f.c1) return null;
    const cell = this.cellRect(f.r0, c);
    const size = Math.min(18 * this.zoom, cell.h - 4);
    return { x: cell.x + cell.w - size - 3, y: cell.y + (cell.h - size) / 2, w: size, h: size };
  }

  private filterButtonAt(x: number, y: number): number | null {
    const f = this.filters.get(this.sheet);
    if (!f) return null;
    for (let c = f.c0; c <= f.c1; c++) {
      const b = this.filterButtonRect(c);
      if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return c;
    }
    return null;
  }

  private paintFilterButtons(): void {
    const f = this.filters.get(this.sheet);
    if (!f) return;
    const ctx = this.ctx, col = this.colors;
    for (let c = f.c0; c <= f.c1; c++) {
      const b = this.filterButtonRect(c);
      if (!b || b.x < this.headW || b.y < this.headH) continue;
      const active = f.criteria.has(c);
      ctx.fillStyle = active ? col["accent"] : col["grid-head"];
      ctx.strokeStyle = col["grid-line"];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = active ? col["grid-bg"] : col["grid-head-text"];
      ctx.beginPath();
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      if (active) { // imbuto
        ctx.moveTo(cx - 5, cy - 4); ctx.lineTo(cx + 5, cy - 4); ctx.lineTo(cx + 1, cy + 1); ctx.lineTo(cx + 1, cy + 5); ctx.lineTo(cx - 1, cy + 5); ctx.lineTo(cx - 1, cy + 1);
      } else { // freccia
        ctx.moveTo(cx - 4, cy - 2); ctx.lineTo(cx + 4, cy - 2); ctx.lineTo(cx, cy + 3);
      }
      ctx.fill();
    }
  }

  private toggleFilter(): void {
    if (!this.commitEdit()) return;
    const existing = this.filters.get(this.sheet);
    if (existing) {
      this.filters.delete(this.sheet);
      if (existing.criteria.size) this.apply(() => this.model.setRowsHidden(this.sheet, existing.r0 + 1, existing.r1, false), true);
      this.draw();
      this.host.selectionChanged();
      return;
    }
    let { r0, r1, c0, c1 } = this.range();
    if (this.isSingle() || r1 === MAX_ROW) ({ r0, r1, c0, c1 } = this.currentRegion(this.active));
    if (c1 === MAX_COL) c1 = c0;
    if (r1 <= r0 && this.model.getCellContent(this.sheet, r0, c0) === "") {
      toast("Seleziona una tabella con un'intestazione per applicare il filtro");
      return;
    }
    this.filters.set(this.sheet, { r0, r1: Math.max(r1, r0 + 1), c0, c1, criteria: new Map() });
    this.draw();
    this.host.selectionChanged();
  }

  /** Ultima riga della tabella filtrata: si estende alle righe aggiunte subito sotto, fino alla prima riga vuota. */
  private filterLastRow(f: { r0: number; r1: number; c0: number; c1: number }): number {
    const rowHasData = (r: number) => {
      for (let c = f.c0; c <= f.c1; c++) if (this.model.getCellContent(this.sheet, r, c) !== "") return true;
      return false;
    };
    let last = f.r1;
    while (last < MAX_ROW && rowHasData(last + 1)) last++;
    return last;
  }

  private filterValue(r: number, c: number): string {
    const v = this.model.getFormattedCellValue(this.sheet, r, c);
    return v === "" ? BLANK : v;
  }

  private openFilter(c: number): void {
    const f = this.filters.get(this.sheet);
    if (!f) return;
    f.r1 = this.filterLastRow(f);
    // I valori proposti sono quelli delle righe visibili per gli altri filtri, come in Excel.
    const values = new Map<string, number>();
    for (let r = f.r0 + 1; r <= Math.min(f.r1, f.r0 + 100_000); r++) {
      let visible = true;
      for (const [k, set] of f.criteria) if (k !== c && !set.has(this.filterValue(r, k))) { visible = false; break; }
      if (!visible) continue;
      const v = this.filterValue(r, c);
      values.set(v, (values.get(v) ?? 0) + 1);
    }
    const b = this.filterButtonRect(c)!;
    const rect = this.scroller.getBoundingClientRect();
    openFilterPopup({ x: rect.left + b.x, y: rect.top + b.y + b.h + 2 }, {
      values,
      selected: f.criteria.get(c) ?? null,
      onSort: (desc) => {
        if (!this.commitEdit()) return;
        this.sortRange(f.r0, f.r1, f.c0, f.c1, c, desc, true);
        this.applyFilter();
      },
      onApply: (selected) => {
        if (selected) f.criteria.set(c, selected); else f.criteria.delete(c);
        this.applyFilter();
      },
    });
  }

  /** Nasconde le righe che non corrispondono ai filtri (raggruppando le righe consecutive). */
  private applyFilter(): void {
    const f = this.filters.get(this.sheet);
    if (!f) return;
    f.r1 = this.filterLastRow(f);
    const runs: [number, number, boolean][] = [];
    for (let r = f.r0 + 1; r <= f.r1; r++) {
      let show = true;
      for (const [c, set] of f.criteria) if (!set.has(this.filterValue(r, c))) { show = false; break; }
      const last = runs[runs.length - 1];
      if (last && last[2] === !show && last[1] === r - 1) last[1] = r;
      else runs.push([r, r, !show]);
    }
    this.apply(() => { for (const [a, b, hide] of runs) this.model.setRowsHidden(this.sheet, a, b, hide); }, true);
    this.draw();
  }

  // ---------- trova e sostituisci ----------

  private search(opts: FindOptions): Cell[] {
    const found: Cell[] = [];
    for (let c = 1; c <= this.extent.cols; c++) {
      for (const r of this.model.getRowsWithData(this.sheet, c)) {
        const content = this.model.getCellContent(this.sheet, r, c);
        if (matches(content, opts) || matches(this.model.getFormattedCellValue(this.sheet, r, c), opts)) found.push({ r, c });
      }
    }
    return found.sort((a, b) => a.r - b.r || a.c - b.c);
  }

  /** Sostituisce nel contenuto delle celle con un solo passo di Annulla. */
  private replaceCells(cells: Cell[], opts: FindOptions, replacement: string): number {
    if (!this.commitEdit()) return 0;
    const changes = cells
      .map((p) => ({ ...p, before: this.model.getCellContent(this.sheet, p.r, p.c) }))
      .map((p) => ({ ...p, after: replaceText(p.before, opts, replacement) }))
      .filter((p) => p.after !== p.before);
    if (!changes.length) return 0;
    const r0 = Math.min(...changes.map((p) => p.r)), r1 = Math.max(...changes.map((p) => p.r));
    const c0 = Math.min(...changes.map((p) => p.c)), c1 = Math.max(...changes.map((p) => p.c));
    this.apply(() => {
      if ((r1 - r0 + 1) * (c1 - c0 + 1) > 2_000_000) {
        for (const p of changes) this.model.setUserInput(this.sheet, p.r, p.c, p.after);
        return;
      }
      this.model.setSelectedCell(r0, c0);
      this.model.setSelectedRange(r0, c0, r1, c1);
      const clip = this.model.copyToClipboard();
      for (const p of changes) {
        const cell = clip.data.get(p.r)?.get(p.c) as { text: string } | undefined;
        if (cell) cell.text = p.after;
      }
      this.model.pasteFromClipboard(this.sheet, clip.range, clip.data, false);
    });
    this.selectionChanged();
    return changes.length;
  }

  private insertFunction(name: string): void {
    const { r, c } = this.active;
    let top = r - 1;
    while (top >= 1 && this.model.getCellType(this.sheet, top, c) === 1 && this.model.getCellContent(this.sheet, top, c) !== "") top--;
    const f = fn(name);
    this.beginEdit(top < r - 1 ? `=${f}(${colName(c)}${top + 1}:${colName(c)}${r - 1})` : `=${f}()`);
  }

  // ---------- comandi dal ribbon (DocumentView) ----------

  handle(id: string, anchor?: HTMLElement): boolean {
    const menu = this.ribbonMenu(id);
    if (menu && anchor) { openMenu(anchor, menu); return true; }
    // Comandi che sono solo un menu (es. dalla ricerca comandi): lo apriamo sulla griglia.
    if (menu && !SPLIT_DEFAULTS.has(id)) {
      const r = this.scroller.getBoundingClientRect();
      openMenu({ x: r.left + r.width / 3, y: r.top + 40 }, menu);
      return true;
    }

    const st = this.styleAt();
    const align = st.alignment;
    switch (id) {
      case "bold": this.setStyle("font.b", String(!st.font.b)); return true;
      case "italic": this.setStyle("font.i", String(!st.font.i)); return true;
      case "underline": this.setStyle("font.u", String(!st.font.u)); return true;
      case "strike": this.setStyle("font.strike", String(!st.font.strike)); return true;
      case "growFont": this.setStyle("font.size_delta", "1"); return true;
      case "shrinkFont": this.setStyle("font.size_delta", "-1"); return true;
      case "alignLeft": case "alignCenter": case "alignRight": {
        const v = id === "alignLeft" ? "left" : id === "alignCenter" ? "center" : "right";
        this.setStyle("alignment.horizontal", align?.horizontal === v ? "general" : v);
        return true;
      }
      case "vAlignTop": this.setStyle("alignment.vertical", "top"); return true;
      case "vAlignMiddle": this.setStyle("alignment.vertical", "center"); return true;
      case "vAlignBottom": this.setStyle("alignment.vertical", "bottom"); return true;
      case "wrap": {
        const on = !align?.wrap_text;
        const { r0, r1 } = this.range();
        this.apply(() => {
          this.model.updateRangeStyle(this.area(), "alignment.wrap_text", String(on));
          if (on) this.fitWrappedRows(r0, r1);
        }, true);
        return true;
      }
      case "mergeCells": {
        const m = this.mergeAt(this.active.r, this.active.c);
        if (m) this.apply(() => this.model.unmergeCells({ sheet: this.sheet, row: m.row, column: m.column, width: m.width, height: m.height }));
        else if (!this.isSingle()) this.apply(() => this.model.mergeCellsCenter(this.area()));
        return true;
      }
      case "fmtCurrency": this.setStyle("num_fmt", '#,##0.00 "€"'); return true;
      case "fmtPercent": this.setStyle("num_fmt", "0%"); return true;
      case "fmtThousands": this.setStyle("num_fmt", "#,##0.00"); return true;
      case "decimalsMore": this.setStyle("num_fmt", changeDecimals(st.num_fmt, 1)); return true;
      case "decimalsLess": this.setStyle("num_fmt", changeDecimals(st.num_fmt, -1)); return true;
      case "clearFormatting": this.clear("formatting"); return true;
      case "autoSum": this.autoSum(); return true;
      case "sort": this.sort(false); return true;
      case "filter": this.toggleFilter(); return true;
      case "sortDesc": this.sort(true); return true;
      case "formatPainter": this.startPainter(); return true;
      case "cut": case "copy": this.focus(); document.execCommand(id); return true;
      case "paste": void this.pasteFromMenu(); return true;
      case "undo": case "redo":
        if (!this.commitEdit()) return true;
        try {
          if (id === "undo") this.model.undo(); else this.model.redo();
        } catch { /* niente da annullare */ }
        this.renderTabs();
        if (this.sheet >= this.sheetsInfo().length) this.sheet = this.firstVisibleSheet();
        this.changed(true);
        return true;
      case "calcNow": this.model.evaluate(); this.draw(); return true;
      case "find": case "replace": {
        if (!this.commitEdit()) return true;
        const text = this.model.getFormattedCellValue(this.sheet, this.active.r, this.active.c);
        this.findBar.show(id === "replace", text.length < 40 ? text : undefined);
        return true;
      }
      case "insertFunction": this.beginEdit("="); return true;
      case "gridlines":
        this.apply(() => this.model.setShowGridLines(this.sheet, !this.model.getShowGridLines(this.sheet)));
        return true;
      case "headings": this.updateSpacer(); this.draw(); return true;
      case "formulaBar": this.formulaBar.hidden = !this.state.isOn("formulaBar"); return true;
      case "insertTable": this.applyTable("#1F4E79", "#EDF2F8"); return true;
      case "chartColumn": this.createChart("column"); return true;
      case "chartLine": this.createChart("line"); return true;
      case "chartPie": this.createChart("pie"); return true;
      case "removeDuplicates": {
        const n = removeDuplicateRows(this.model, this.sheet, this.range());
        this.changed(true);
        toast(n ? t("Rimosse {0} righe duplicate", n) : "Nessun duplicato trovato nella selezione");
        return true;
      }
      case "textToColumns": {
        void promptDialog("Testo in colonne", "Carattere separatore (es. ; oppure , oppure spazio):", ";").then((delim) => {
          if (!delim) return;
          const n = splitTextToColumns(this.model, this.sheet, this.range(), delim);
          this.changed(true);
          toast(n ? t("Divise {0} righe in colonne", n) : "Nessuna riga contenente il separatore");
        });
        return true;
      }
      case "subtotal": {
        this.autoSum();
        return true;
      }
      case "newComment": {
        const k = this.noteKey(this.active.r, this.active.c);
        void promptDialog(t("Nota cella {0}", this.nameBox.value), "Testo della nota:", this.cellNotes.get(k) ?? "").then((txt) => {
          if (txt === null) return;
          if (txt.trim()) this.cellNotes.set(k, txt.trim());
          else this.cellNotes.delete(k);
          this.draw();
        });
        return true;
      }
      case "deleteComment": {
        const k = this.noteKey(this.active.r, this.active.c);
        if (this.cellNotes.delete(k)) { this.draw(); toast("Nota eliminata"); }
        return true;
      }
      case "insertLink": {
        void promptDialog("Inserisci collegamento", "Indirizzo web (URL):", "https://").then((url) => {
          if (!url || url === "https://") return;
          this.apply(() => this.model.setUserInput(this.sheet, this.active.r, this.active.c, url.trim()));
        });
        return true;
      }
      case "defineName": {
        const ref = this.nameBox.value || `R${this.active.r}C${this.active.c}`;
        void promptDialog("Definisci nome", t("Nome per la cella {0} (es. IVA, Totale):", ref)).then((name) => {
          const clean = name?.trim().replace(/\s+/g, "_");
          if (!clean) return;
          this.definedNames.set(clean, { sheet: this.sheet, r: this.active.r, c: this.active.c, ref });
          this.dirty = true;
          toast(t("Nome «{0}» assegnato a {1}", clean, ref));
        });
        return true;
      }
      case "pivot": {
        const rng = this.range();
        const colCount = rng.c1 - rng.c0 + 1;
        if (rng.r1 <= rng.r0 || colCount < 2) {
          toast("Seleziona una tabella con almeno 2 colonne e 2 righe (intestazione + dati)");
          return true;
        }
        const headers = Array.from({ length: colCount }, (_, i) => this.model.getFormattedCellValue(this.sheet, rng.r0, rng.c0 + i).trim() || t("Colonna {0}", i + 1));
        const groupSel = h("select", { class: "find-input", style: "width:100%" }, ...headers.map((t, i) => h("option", { value: String(i) }, t)));
        const valSel = h("select", { class: "find-input", style: "width:100%" }, ...headers.map((t, i) => h("option", { value: String(i), ...(i === colCount - 1 ? { selected: "true" } : {}) }, t)));
        const aggSel = h("select", { class: "find-input", style: "width:100%" }, ...(Object.entries(PIVOT_AGG_LABELS) as [PivotAgg, string][]).map(([k, lbl]) => h("option", { value: k }, lbl)));
        const overlay = h("div", { class: "dlg-overlay", onmousedown: (e: Event) => { if (e.target === overlay) overlay.remove(); } },
          h("div", { class: "dlg-box", style: "width:360px;display:flex;flex-direction:column;gap:10px" },
            h("h3", { style: "margin:0" }, "Crea Tabella Pivot"),
            h("label", { style: "font-size:12px" }, "Raggruppa per (Righe):", groupSel),
            h("label", { style: "font-size:12px" }, "Colonna valori:", valSel),
            h("label", { style: "font-size:12px" }, "Aggregazione:", aggSel),
            h("div", { class: "dlg-actions" },
              h("button", { class: "dlg-btn", onclick: () => overlay.remove() }, "Annulla"),
              h("button", {
                class: "dlg-btn primary",
                onclick: () => {
                  const g = Number(groupSel.value), v = Number(valSel.value), agg = aggSel.value as PivotAgg;
                  overlay.remove();
                  const newIdx = createPivotSheet(this.model, this.sheet, rng, g, v, agg);
                  this.dirty = true;
                  this.renderTabs();
                  this.selectSheet(newIdx);
                  this.host.changed();
                  toast("Tabella Pivot creata in un nuovo foglio");
                },
              }, "Crea Pivot"))));
        document.body.append(overlay);
        return true;
      }
    }
    return false;
  }

  isActive(id: string): boolean | undefined {
    const st = this.styleAt();
    const h = st.alignment?.horizontal ?? "general", v = st.alignment?.vertical ?? "bottom";
    switch (id) {
      case "bold": return !!st.font.b;
      case "italic": return !!st.font.i;
      case "underline": return !!st.font.u;
      case "strike": return !!st.font.strike;
      case "alignLeft": return h === "left";
      case "alignCenter": return h === "center" || h === "centerContinuous";
      case "alignRight": return h === "right";
      case "vAlignTop": return v === "top";
      case "vAlignMiddle": return v === "center";
      case "vAlignBottom": return v === "bottom";
      case "wrap": return !!st.alignment?.wrap_text;
      case "mergeCells": return !!this.mergeAt(this.active.r, this.active.c);
      case "formatPainter": return !!this.painter;
      case "gridlines": return this.model.getShowGridLines(this.sheet);
      case "filter": return this.filters.has(this.sheet);
    }
    return undefined;
  }

  selectValue(id: string): string | undefined {
    const st = this.styleAt();
    if (id === "fontName") return st.font.name;
    if (id === "fontSize") return String(st.font.sz);
    if (id === "numberFormat") return formatLabel(st.num_fmt);
    return undefined;
  }

  setSelect(id: string, value: string): boolean {
    if (id === "fontSize") {
      const size = Number(value.replace(",", "."));
      if (size > 0 && size < 410) this.setStyle("font.size", String(size));
    } else if (id === "fontName") {
      this.transformStyles((s) => { s.font.name = value; });
    } else if (id === "numberFormat") {
      const code = formatCode(value);
      if (code) this.setStyle("num_fmt", code);
    } else return false;
    this.focus();
    return true;
  }

  // ---------- disegno ----------

  private draw(): void {
    this.chartLayer.render();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }

  private readColors(): void {
    const cs = getComputedStyle(this.el);
    for (const name of ["grid-bg", "grid-line", "grid-head", "grid-head-text", "grid-head-sel", "grid-text", "accent", "accent-soft", "accent-strong"]) {
      this.colors[name] = cs.getPropertyValue(`--${name}`).trim();
    }
    this.colorCache.clear();
  }

  private resolveColor(color: Color): string {
    const key = JSON.stringify(color);
    let v = this.colorCache.get(key);
    if (v === undefined) { v = this.model.resolveColor(color) || ""; this.colorCache.set(key, v); }
    return v;
  }

  private drawResizeGuide(kind: "resize-col" | "resize-row", pos: number, size: number): void {
    this.paint();
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = this.colors["accent"];
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    if (kind === "resize-col") { ctx.moveTo(pos + 0.5, 0); ctx.lineTo(pos + 0.5, this.scroller.clientHeight); }
    else { ctx.moveTo(0, pos + 0.5); ctx.lineTo(this.scroller.clientWidth, pos + 0.5); }
    ctx.stroke();
    ctx.restore();
    const px = Math.round(size / SCALE);
    this.nameBox.value = kind === "resize-col" ? `Larghezza: ${px}` : `Altezza: ${px}`;
  }

  private paint(): void {
    if (!this.colors["grid-bg"]) this.readColors();
    const ctx = this.ctx, col = this.colors, z = this.zoom;
    const W = this.scroller.clientWidth, H = this.scroller.clientHeight;
    if (!W || !H) return;
    const hw = this.headW, hh = this.headH;
    const fc = this.frozenCols, fr = this.frozenRows, fw = this.frozenW, fh = this.frozenH;

    // Colonne e righe visibili: prima quelle bloccate, poi quelle che scorrono.
    const colsFrom = (first: number, last: number) => {
      const out: { c: number; x: number; w: number }[] = [];
      for (let c = first, x = this.colX(c); c <= last && x < W; c++) { const w = this.colW(c); if (w > 0) out.push({ c, x, w }); x += w; }
      return out;
    };
    const rowsFrom = (first: number, last: number) => {
      const out: { r: number; y: number; h: number }[] = [];
      for (let r = first, y = this.rowY(r); r <= last && y < H; r++) { const h = this.rowH(r); if (h > 0) out.push({ r, y, h }); y += h; }
      return out;
    };
    const frozenColsList = fc ? colsFrom(1, fc) : [];
    const frozenRowsList = fr ? rowsFrom(1, fr) : [];
    const scrollCols = colsFrom(this.cols.indexAt((fw + this.scroller.scrollLeft) / z), MAX_COL);
    const scrollRows = rowsFrom(this.rows.indexAt((fh + this.scroller.scrollTop) / z), MAX_ROW);

    ctx.fillStyle = col["grid-bg"];
    ctx.fillRect(0, 0, W, H);
    const styles = new Map<string, CellStyle>();
    const quadrant = (cols: typeof scrollCols, rows: typeof scrollRows, x: number, y: number, w: number, h: number) => {
      if (!cols.length || !rows.length || w <= 0 || h <= 0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      this.paintCells(cols, rows, styles, W, H);
      ctx.restore();
    };
    quadrant(scrollCols, scrollRows, hw + fw, hh + fh, W - hw - fw, H - hh - fh);
    quadrant(frozenColsList, scrollRows, hw, hh + fh, fw, H - hh - fh);
    quadrant(scrollCols, frozenRowsList, hw + fw, hh, W - hw - fw, fh);
    quadrant(frozenColsList, frozenRowsList, hw, hh, fw, fh);

    // Linee dei riquadri bloccati
    if (fc || fr) {
      ctx.fillStyle = col["grid-head-text"];
      if (fc) ctx.fillRect(hw + fw - 1, hh, 1.5, H - hh);
      if (fr) ctx.fillRect(hw, hh + fh - 1, W - hw, 1.5);
    }

    this.paintFilterButtons();
    this.paintSelection(W, H);
    // Freccetta elenco a discesa per convalida dati sulla cella attiva
    const vbtn = this.validationButtonRect();
    if (vbtn && vbtn.x >= this.headW && vbtn.y >= this.headH) {
      const ctx = this.ctx, col = this.colors;
      ctx.fillStyle = col["grid-head"];
      ctx.fillRect(vbtn.x, vbtn.y, vbtn.w, vbtn.h);
      ctx.strokeStyle = col["accent"];
      ctx.lineWidth = 1;
      ctx.strokeRect(vbtn.x + 0.5, vbtn.y + 0.5, vbtn.w - 1, vbtn.h - 1);
      ctx.fillStyle = col["grid-text"];
      ctx.beginPath();
      const cx = vbtn.x + vbtn.w / 2, cy = vbtn.y + vbtn.h / 2;
      ctx.moveTo(cx - 3.5, cy - 1.5); ctx.lineTo(cx + 3.5, cy - 1.5); ctx.lineTo(cx, cy + 2.5);
      ctx.closePath();
      ctx.fill();
    }
    this.paintHeaders(scrollCols, scrollRows, frozenColsList, frozenRowsList, W, H);
  }

  /** Disegna le celle di un riquadro: griglia, sfondi, testo e bordi. */
  private paintCells(
    cols: { c: number; x: number; w: number }[], rows: { r: number; y: number; h: number }[],
    styles: Map<string, CellStyle>, W: number, H: number,
  ): void {
    const ctx = this.ctx, col = this.colors, model = this.model, sheet = this.sheet, z = this.zoom;
    const hw = this.headW, hh = this.headH;
    const dark = resolvedTheme() === "dark";

    // Griglia
    if (model.getShowGridLines(sheet)) {
      ctx.strokeStyle = col["grid-line"];
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const { x, w } of cols) { const lx = Math.round(x + w) - 0.5; ctx.moveTo(lx, hh); ctx.lineTo(lx, H); }
      for (const { y, h: rh } of rows) { const ly = Math.round(y + rh) - 0.5; ctx.moveTo(hw, ly); ctx.lineTo(W, ly); }
      ctx.stroke();
    }

    // Stili delle celle visibili (una sola lettura per cella e per disegno)
    const styleOf = (r: number, c: number) => {
      const k = `${r},${c}`;
      let s = styles.get(k);
      if (!s) { s = model.getCellStyle(sheet, r, c).style; styles.set(k, s); }
      return s;
    };
    const fillOf = (s: CellStyle) => (s.fill?.color ? this.resolveColor(s.fill.color) : "");

    // Celle unite visibili: le disegniamo come un'unica cella.
    const visibleMerges = this.merged.filter((m) =>
      m.row <= rows[rows.length - 1]?.r && m.row + m.height - 1 >= (rows[0]?.r ?? 1) &&
      m.column <= cols[cols.length - 1]?.c && m.column + m.width - 1 >= (cols[0]?.c ?? 1));
    const inMerge = (r: number, c: number) => visibleMerges.some((m) => r >= m.row && r < m.row + m.height && c >= m.column && c < m.column + m.width);

    // Sfondi (inclusa formattazione condizionale e indicatori note)
    for (const { r, y, h: rh } of rows) {
      for (const { c, x, w } of cols) {
        if (inMerge(r, c)) continue;
        const fill = fillOf(styleOf(r, c));
        const cf = this.condRules.length ? evalCondFormat(model, this.condRules, sheet, r, c) : null;
        const bg = cf?.bg || fill;
        if (bg) { ctx.fillStyle = bg; ctx.fillRect(x, y, w, rh); }
        if (cf?.bar) {
          ctx.fillStyle = cf.bar.color;
          ctx.fillRect(x + 2, y + 3, Math.max(2, (w - 4) * cf.bar.pct), Math.max(2, rh - 6));
        }
        if (this.cellNotes.has(this.noteKey(r, c, sheet))) {
          ctx.fillStyle = "#dc2626";
          ctx.beginPath();
          ctx.moveTo(x + w - 7, y);
          ctx.lineTo(x + w, y);
          ctx.lineTo(x + w, y + 7);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    for (const m of visibleMerges) {
      const rect = this.cellRect(m.row, m.column);
      ctx.fillStyle = fillOf(styleOf(m.row, m.column)) || col["grid-bg"];
      ctx.fillRect(rect.x, rect.y, rect.w - 1, rect.h - 1);
    }

    // Testo
    const editingCell = this.editing && !this.editing.viaBar ? this.editing.cell : null;
    const lastVisibleCol = cols[cols.length - 1]?.c ?? 1;
    for (const { r, y, h: rh } of rows) {
      for (let i = 0; i < cols.length; i++) {
        const { c, x, w } = cols[i];
        if (editingCell && editingCell.r === r && editingCell.c === c) continue;
        if (inMerge(r, c)) continue;
        const text = model.getFormattedCellValue(sheet, r, c);
        if (text === "") continue;
        const st = styleOf(r, c);
        // Il testo lungo "sborda" nelle celle vuote a destra, come in Excel.
        let clipW = w;
        const type = model.getCellType(sheet, r, c);
        const hAlign = st.alignment?.horizontal ?? "general";
        if (type === 2 && !st.alignment?.wrap_text && (hAlign === "general" || hAlign === "left")) {
          for (let k = c + 1; k <= Math.min(lastVisibleCol + 20, MAX_COL); k++) {
            if (model.getCellContent(sheet, r, k) !== "" || this.mergeAt(r, k)) break;
            const kw = this.colW(k);
            if (kw > 0 && fillOf(styleOf(r, k)) === "" && k <= lastVisibleCol) {
              // copre la griglia sotto il testo che sborda
              ctx.fillStyle = col["grid-bg"];
              ctx.fillRect(x + clipW, y, kw - 1, rh - 1);
            }
            clipW += kw;
            ctx.font = this.cssFont(st);
            if (ctx.measureText(text).width + 8 * z <= clipW) break;
          }
        }
        this.drawText(text, st, type, { x, y, w, h: rh }, clipW, dark);
      }
    }
    for (const m of visibleMerges) {
      if (editingCell && editingCell.r === m.row && editingCell.c === m.column) continue;
      const text = model.getFormattedCellValue(sheet, m.row, m.column);
      if (text === "") continue;
      const rect = this.cellRect(m.row, m.column);
      this.drawText(text, styleOf(m.row, m.column), model.getCellType(sheet, m.row, m.column), rect, rect.w, dark);
    }

    // Bordi
    for (const { r, y, h: rh } of rows) {
      for (const { c, x, w } of cols) {
        const b = styleOf(r, c).border;
        if (!b || (!b.left && !b.right && !b.top && !b.bottom)) continue;
        if (b.top) this.drawBorder(b.top, x, y, x + w, y, dark);
        if (b.bottom) this.drawBorder(b.bottom, x, y + rh, x + w, y + rh, dark);
        if (b.left) this.drawBorder(b.left, x, y, x, y + rh, dark);
        if (b.right) this.drawBorder(b.right, x + w, y, x + w, y + rh, dark);
      }
    }

  }

  private cssFont(st: CellStyle, zoom = this.zoom): string {
    const px = st.font.sz * (4 / 3) * SCALE * zoom;
    return `${st.font.i ? "italic " : ""}${st.font.b ? "bold " : ""}${px}px ${cssFontFamily(st.font.name)}`;
  }

  /** Spezza il testo in righe che stanno nella larghezza data (con il font già impostato su ctx). */
  private wrapLines(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    for (const para of text.split("\n")) {
      let line = "";
      for (const word of para.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (this.ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = word; }
        else line = next;
      }
      lines.push(line);
    }
    return lines;
  }

  /** Alza le righe che contengono testo a capo, come fa Excel. */
  private fitWrappedRows(r0: number, r1: number): void {
    for (let r = r0; r <= Math.min(r1, r0 + 1000); r++) {
      let need = 0;
      for (const c of this.model.getColumnsWithData(this.sheet, r)) {
        const st = this.styleAt(r, c);
        if (!st.alignment?.wrap_text || this.mergeAt(r, c)) continue;
        this.ctx.font = this.cssFont(st, 1);
        const lines = this.wrapLines(this.model.getFormattedCellValue(this.sheet, r, c), this.model.getColumnWidth(this.sheet, c) * SCALE - 8);
        need = Math.max(need, (lines.length * st.font.sz * (4 / 3) * SCALE * 1.2 + 6) / SCALE);
      }
      if (need > this.model.getRowHeight(this.sheet, r) + 0.5) this.model.setRowsHeight(this.sheet, r, r, need);
    }
  }

  private drawText(text: string, st: CellStyle, type: number, cell: Rect, clipW: number, dark: boolean): void {
    const ctx = this.ctx, z = this.zoom, pad = 4 * z;
    ctx.save();
    ctx.font = this.cssFont(st);
    let color = st.font.color ? this.resolveColor(st.font.color) : "";
    // In tema scuro, il testo nero su celle senza sfondo diventerebbe invisibile.
    if (!color || (dark && !st.fill?.color && luminance(color) < 0.35)) color = this.colors["grid-text"];
    ctx.fillStyle = color;

    let hAlign = st.alignment?.horizontal ?? "general";
    if (hAlign === "general") hAlign = type === 1 ? "right" : type === 4 || type === 16 ? "center" : "left";
    if (hAlign === "centerContinuous") hAlign = "center";
    const vAlign = st.alignment?.vertical ?? "bottom";
    const sizePx = st.font.sz * (4 / 3) * SCALE * z;
    const lineH = sizePx * 1.2;

    // Testo a capo
    let lines = [text];
    if (st.alignment?.wrap_text) {
      lines = this.wrapLines(text, cell.w - 2 * pad);
    } else if (type === 1 && ctx.measureText(text).width > cell.w - 2 * pad) {
      // Numero troppo largo per la colonna: Excel mostra ###
      lines = ["#".repeat(Math.max(1, Math.floor((cell.w - 2 * pad) / ctx.measureText("#").width)))];
    }

    const blockH = lines.length * lineH;
    let top = vAlign === "top" ? cell.y + 2 * z
      : vAlign === "center" ? cell.y + (cell.h - blockH) / 2
      : cell.y + cell.h - blockH - 2 * z;
    if (lines.length > 1 && top < cell.y) top = cell.y + 2 * z;

    ctx.beginPath();
    const clipX = hAlign === "right" ? cell.x + cell.w - clipW : cell.x;
    ctx.rect(clipX, cell.y, clipW, cell.h);
    ctx.clip();
    ctx.textBaseline = "middle";
    ctx.textAlign = hAlign === "right" ? "right" : hAlign === "center" ? "center" : "left";
    const tx = hAlign === "right" ? cell.x + cell.w - pad : hAlign === "center" ? cell.x + cell.w / 2 : cell.x + pad;
    lines.forEach((line, i) => {
      const ty = top + i * lineH + lineH / 2;
      ctx.fillText(line, tx, ty);
      if (st.font.u || st.font.strike) {
        const lw = ctx.measureText(line).width;
        const lx = ctx.textAlign === "right" ? tx - lw : ctx.textAlign === "center" ? tx - lw / 2 : tx;
        ctx.fillRect(lx, st.font.u ? ty + sizePx * 0.45 : ty, lw, Math.max(1, z));
      }
    });
    ctx.restore();
  }

  private drawBorder(b: { style: string; color?: Color }, x1: number, y1: number, x2: number, y2: number, dark: boolean): void {
    const ctx = this.ctx;
    let color = b.color ? this.resolveColor(b.color) : "#000000";
    if (dark && luminance(color || "#000000") < 0.35) color = this.colors["grid-text"];
    const width = b.style === "medium" || b.style.startsWith("medium") ? 2 : b.style === "thick" ? 3 : 1;
    ctx.save();
    ctx.strokeStyle = color || "#000000";
    ctx.lineWidth = width;
    if (b.style === "dotted") ctx.setLineDash([1, 2]);
    else if (b.style.includes("dash")) ctx.setLineDash([4, 2]);
    const off = width % 2 ? 0.5 : 0;
    const draw = (dx: number, dy: number) => {
      ctx.beginPath();
      ctx.moveTo(Math.round(x1) - off + dx, Math.round(y1) - off + dy);
      ctx.lineTo(Math.round(x2) - off + dx, Math.round(y2) - off + dy);
      ctx.stroke();
    };
    if (b.style === "double") {
      const vertical = x1 === x2;
      draw(vertical ? -1 : 0, vertical ? 0 : -1);
      draw(vertical ? 1 : 0, vertical ? 0 : 1);
    } else draw(0, 0);
    ctx.restore();
  }

  private paintSelection(W: number, H: number): void {
    const ctx = this.ctx, col = this.colors;
    const sel = this.selectionRect()!;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.headW, this.headH, W, H);
    ctx.clip();
    if (!this.isSingle()) {
      // Velo colorato sulla selezione, tranne sulla cella attiva (come in Excel).
      const a = this.cellRect(this.active.r, this.active.c);
      ctx.fillStyle = col["accent-soft"];
      ctx.beginPath();
      ctx.rect(sel.x, sel.y, sel.w, sel.h);
      ctx.rect(a.x, a.y, a.w, a.h);
      ctx.fill("evenodd");
    }
    ctx.strokeStyle = col["accent"];
    ctx.lineWidth = 2;
    ctx.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w - 1, sel.h - 1);
    // Maniglia di riempimento
    if (!this.editing) {
      ctx.fillStyle = col["accent"];
      ctx.fillRect(sel.x + sel.w - 4, sel.y + sel.h - 4, 7, 7);
      ctx.strokeStyle = col["grid-bg"];
      ctx.lineWidth = 1;
      ctx.strokeRect(sel.x + sel.w - 4.5, sel.y + sel.h - 4.5, 8, 8);
    }
    // Anteprima del riempimento trascinato
    if (this.drag?.kind === "fill") {
      const t = this.drag.target;
      const { r0, r1, c0, c1 } = this.range();
      const vertical = t.r > r1 || t.r < r0;
      const fr0 = vertical ? Math.min(r0, t.r) : r0, fr1 = vertical ? Math.max(r1, t.r) : r1;
      const fc0 = vertical ? c0 : Math.min(c0, t.c), fc1 = vertical ? c1 : Math.max(c1, t.c);
      const x = this.colX(fc0), y = this.rowY(fr0);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = col["accent"];
      ctx.strokeRect(x + 0.5, y + 0.5, this.colX(fc1 + 1) - x - 1, this.rowY(fr1 + 1) - y - 1);
      ctx.setLineDash([]);
    }
    // Riferimento puntato mentre si scrive una formula
    if (this.pointing && this.editing) {
      const input = this.activeInput();
      const ref = input.value.slice(this.pointing.start, this.pointing.end).split(":");
      const a = parseRef(ref[0]), b = parseRef(ref[1] ?? ref[0]);
      if (a && b) {
        const x = this.colX(Math.min(a.c, b.c)), y = this.rowY(Math.min(a.r, b.r));
        const w = this.colX(Math.max(a.c, b.c) + 1) - x, hgt = this.rowY(Math.max(a.r, b.r) + 1) - y;
        ctx.fillStyle = "rgba(230, 120, 30, 0.12)";
        ctx.fillRect(x, y, w, hgt);
        ctx.setLineDash([5, 3]);
        ctx.strokeStyle = "#e6781e";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, hgt - 2);
        ctx.setLineDash([]);
      }
    }
    // Area copiata (bordo tratteggiato finché non si preme Esc)
    const ic = internalClipboard;
    if (ic && ic.model === this.model && ic.sheet === this.sheet) {
      const [r0, c0, r1, c1] = ic.clip.range;
      const x = this.colX(c0), y = this.rowY(r0);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = col["accent"];
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, this.colX(c1 + 1) - x - 2, this.rowY(r1 + 1) - y - 2);
    }
    ctx.restore();
  }

  private paintHeaders(
    scrollCols: { c: number; x: number; w: number }[], scrollRows: { r: number; y: number; h: number }[],
    frozenCols: { c: number; x: number; w: number }[], frozenRows: { r: number; y: number; h: number }[],
    W: number, H: number,
  ): void {
    if (!this.state.isOn("headings")) return;
    const ctx = this.ctx, col = this.colors, hw = this.headW, hh = this.headH, z = this.zoom;
    const fw = this.frozenW, fh = this.frozenH;
    const { r0, r1, c0, c1 } = this.range();
    const fullCols = r0 === 1 && r1 === MAX_ROW, fullRows = c0 === 1 && c1 === MAX_COL;
    ctx.fillStyle = col["grid-head"];
    ctx.fillRect(0, 0, W, hh);
    ctx.fillRect(0, 0, hw, H);
    ctx.font = `${12 * z}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const drawCols = (cols: typeof scrollCols, clipX: number) => {
      ctx.save();
      ctx.beginPath(); ctx.rect(clipX, 0, W - clipX, hh); ctx.clip();
      for (const { c, x, w } of cols) {
        const on = c >= c0 && c <= c1;
        ctx.fillStyle = on ? (fullCols ? col["accent"] : col["grid-head-sel"]) : col["grid-head"];
        ctx.fillRect(x, 0, w, hh);
        if (on && !fullCols) { ctx.fillStyle = col["accent"]; ctx.fillRect(x, hh - 2, w, 2); }
        ctx.fillStyle = on ? (fullCols ? col["grid-bg"] : col["accent"]) : col["grid-head-text"];
        ctx.fillText(colName(c), x + w / 2, hh / 2 + 1);
      }
      ctx.restore();
    };
    const drawRows = (rows: typeof scrollRows, clipY: number) => {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, clipY, hw, H - clipY); ctx.clip();
      for (const { r, y, h: rh } of rows) {
        const on = r >= r0 && r <= r1;
        ctx.fillStyle = on ? (fullRows ? col["accent"] : col["grid-head-sel"]) : col["grid-head"];
        ctx.fillRect(0, y, hw, rh);
        if (on && !fullRows) { ctx.fillStyle = col["accent"]; ctx.fillRect(hw - 2, y, 2, rh); }
        ctx.fillStyle = on ? (fullRows ? col["grid-bg"] : col["accent"]) : col["grid-head-text"];
        ctx.fillText(String(r), hw / 2, y + rh / 2 + 1);
      }
      ctx.restore();
    };
    drawCols(scrollCols, hw + fw);
    drawCols(frozenCols, hw);
    drawRows(scrollRows, hh + fh);
    drawRows(frozenRows, hh);

    ctx.fillStyle = col["grid-head"];
    ctx.fillRect(0, 0, hw, hh);
    // Triangolino "seleziona tutto" nell'angolo
    ctx.fillStyle = col["grid-line"];
    ctx.beginPath();
    ctx.moveTo(hw - 4, hh - 4); ctx.lineTo(hw - 4, hh - 14 * z); ctx.lineTo(hw - 14 * z, hh - 4);
    ctx.fill();
    const cols = [...frozenCols, ...scrollCols.filter((c) => c.x >= hw + fw - 1)];
    const rows = [...frozenRows, ...scrollRows.filter((r) => r.y >= hh + fh - 1)];
    ctx.strokeStyle = col["grid-line"];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, hh - 0.5); ctx.lineTo(W, hh - 0.5);
    ctx.moveTo(hw - 0.5, 0); ctx.lineTo(hw - 0.5, H);
    for (const { x, w } of cols) { const lx = Math.round(x + w) - 0.5; if (lx > hw) { ctx.moveTo(lx, 0); ctx.lineTo(lx, hh); } }
    for (const { y, h: rh } of rows) { const ly = Math.round(y + rh) - 0.5; if (ly > hh) { ctx.moveTo(0, ly); ctx.lineTo(hw, ly); } }
    ctx.stroke();
    // Le righe/colonne nascoste si vedono come una linea colorata nell'intestazione.
    ctx.strokeStyle = col["accent"];
    for (let i = 1; i < cols.length; i++) {
      if (cols[i].c !== cols[i - 1].c + 1 && cols[i - 1].c !== this.frozenCols) { const lx = Math.round(cols[i].x) - 1.5; ctx.beginPath(); ctx.moveTo(lx, 2); ctx.lineTo(lx, hh - 2); ctx.stroke(); }
    }
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].r !== rows[i - 1].r + 1 && rows[i - 1].r !== this.frozenRows) { const ly = Math.round(rows[i].y) - 1.5; ctx.beginPath(); ctx.moveTo(2, ly); ctx.lineTo(hw - 2, ly); ctx.stroke(); }
    }
  }

  // ---------- interfaccia DocumentView ----------

  status(): string[] {
    const { r0, r1, c0, c1 } = this.range();
    const f = this.filters.get(this.sheet);
    if (f?.criteria.size) {
      let shown = 0;
      for (let r = f.r0 + 1; r <= f.r1; r++) if (this.rows.size(r) > 0) shown++;
      if (this.isSingle()) return ["Pronto", t("Filtro: {0} di {1} righe", shown, f.r1 - f.r0)];
    }
    if (this.isSingle()) return [this.editing ? "Modifica" : "Pronto"];
    let sum = 0, count = 0, nums = 0;
    for (let c = c0; c <= Math.min(c1, c0 + 500); c++) {
      for (const r of this.model.getRowsWithData(this.sheet, c)) {
        if (r < r0 || r > r1) continue;
        count++;
        if (this.model.getCellType(this.sheet, r, c) !== 1) continue;
        const n = parseDisplayedNumber(this.model.getFormattedCellValue(this.sheet, r, c));
        if (n !== null) { sum += n; nums++; }
      }
    }
    const fmt = new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 4 });
    const out = ["Pronto"];
    if (nums > 0) out.push(`Media: ${fmt.format(sum / nums)}`);
    if (count > 0) out.push(`Conteggio: ${count}`);
    if (nums > 0) out.push(`Somma: ${fmt.format(sum)}`);
    return out;
  }

  setZoom(zoom: number): void {
    const s = this.scroller;
    const ratio = zoom / this.zoom;
    this.zoom = zoom;
    this.updateSpacer();
    s.scrollLeft *= ratio;
    s.scrollTop *= ratio;
    this.placeEditor();
    this.draw();
  }

  shown(): void {
    this.resize();
  }

  focus(): void {
    if (this.editing && !this.editor.hidden) this.editor.focus();
    else this.scroller.focus({ preventScroll: true });
  }

  /** Indice del foglio visualizzato (per salvare in CSV). */
  get currentSheet(): number {
    return this.sheet;
  }

  /** Il documento è stato salvato. */
  markSaved(): void {
    this.dirty = false;
  }

  toBytes(): Uint8Array {
    this.commitEdit();
    return this.model.toBytes();
  }
}

/** "20/11/2026" → numero di serie della data (per ordinare le date). */
function dateSerial(text: string): number | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(text.trim());
  if (!m) return null;
  const y = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
  return Date.UTC(y, Number(m[2]) - 1, Number(m[1])) / 86_400_000;
}
