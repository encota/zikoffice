// Impaginazione: dal modello a righe e pagine. Tutte le misure sono in punti (pt).
// Il testo si misura con lo stesso canvas che lo disegna, così righe e pagine coincidono.
import { cssFontFamily } from "../sheet/format";
import {
  allParagraphs, paragraphLength, paragraphText,
  type Block, type DocumentModel, type ImageRun, type Paragraph, type ParaProps, type RunProps, type TabStop, type Table, type Toc,
} from "./model";
import { effectivePara, effectiveRun, formatNumber } from "./styles";

export type Story = "body" | "header" | "footer";

export interface Fragment {
  x: number;
  width: number;
  text: string;
  /** Font CSS con la dimensione in pt (1 unità = 1 pt). */
  font: string;
  props: RunProps;
  /** Posizione nel paragrafo del primo carattere. */
  start: number;
  end: number;
  /** Spostamento verticale per apice/pedice. */
  shift: number;
  image?: ImageRun;
  tab?: { leader?: TabStop["leader"] };
  /** Etichetta dell'elenco (numero o punto): non fa parte del testo. */
  label?: boolean;
  /** Spazio extra per carattere-spazio nelle righe giustificate. */
  justify?: number;
}

export interface Line {
  pid: number;
  story: Story;
  /** Coordinate sulla pagina (pt): angolo in alto a sinistra della riga. */
  x: number;
  y: number;
  /** Larghezza disponibile. */
  width: number;
  height: number;
  /** Distanza dalla cima della riga alla linea di base. */
  baseline: number;
  fragments: Fragment[];
  start: number;
  end: number;
  /** Ultima riga del paragrafo (per il segno ¶). */
  last: boolean;
  /** Fine riga dovuta a un'interruzione di pagina (\f). */
  pageBreak?: boolean;
  /** Dove inizia il testo (rispetto a x): serve per il cursore nelle righe vuote. */
  textX: number;
}

export interface Rect { x: number; y: number; w: number; h: number; color: string }
export interface Border { x1: number; y1: number; x2: number; y2: number; width: number; color: string; style?: string }

export interface PageBox {
  index: number;
  lines: Line[];
  /** Sfondi (celle, paragrafi) e bordi (tabelle). */
  fills: Rect[];
  borders: Border[];
}

export interface Layout {
  pages: PageBox[];
  /** Dove si trovano le righe di ogni paragrafo. */
  lines: Map<number, { page: number; line: Line }[]>;
  /** Titoli con il numero di pagina (per sommario e navigazione). */
  headings: { pid: number; level: number; text: string; page: number }[];
}

// ---------- misura del testo ----------

const measureCanvas = document.createElement("canvas").getContext("2d")!;
const widthCache = new Map<string, number>();
const metricsCache = new Map<string, { ascent: number; descent: number }>();

export function fontFor(props: RunProps): string {
  const size = (props.size ?? 11) * (props.vertAlign ? 0.65 : 1);
  return `${props.italic ? "italic " : ""}${props.bold ? "bold " : ""}${size}px ${cssFontFamily(props.font)}`;
}

export function measure(font: string, text: string): number {
  const key = `${font}|${text}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    measureCanvas.font = font;
    w = measureCanvas.measureText(text).width;
    if (widthCache.size > 50_000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

function fontMetrics(props: RunProps): { ascent: number; descent: number } {
  const base = { ...props, vertAlign: undefined };
  const font = fontFor(base);
  let m = metricsCache.get(font);
  if (!m) {
    measureCanvas.font = font;
    const t = measureCanvas.measureText("Hgjà");
    const size = base.size ?? 11;
    // fontBoundingBox corrisponde ad ascent/descent del font, come usa Word per l'interlinea.
    m = { ascent: t.fontBoundingBoxAscent || size * 0.9, descent: t.fontBoundingBoxDescent || size * 0.25 };
    metricsCache.set(font, m);
  }
  return m;
}

// ---------- impaginazione di un paragrafo ----------

interface Token {
  kind: "word" | "space" | "tab" | "newline" | "pagebreak" | "image" | "field";
  text: string;
  props: RunProps;
  font: string;
  width: number;
  start: number;
  end: number;
  image?: ImageRun;
}

interface ParaLayout {
  lines: Omit<Line, "x" | "y" | "story">[];
  props: ParaProps;
}

const DEFAULT_TAB = 35.4; // 1,25 cm

function tokenize(doc: DocumentModel, p: Paragraph, fields: Record<string, string>): Token[] {
  const out: Token[] = [];
  let pos = 0;
  for (const run of p.runs) {
    const props = effectiveRun(doc, p, run);
    const font = fontFor(props);
    if (run.type === "image") {
      out.push({ kind: "image", text: "", props, font, width: run.width, start: pos, end: pos + 1, image: run });
      pos++;
      continue;
    }
    if (run.type === "field") {
      const text = fields[run.field] ?? "1";
      out.push({ kind: "field", text, props, font, width: measure(font, text), start: pos, end: pos + 1 });
      pos++;
      continue;
    }
    const re = /(\t)|([\n\u000b])|(\f)|( +)|([^\t\n\u000b\f ]+)/g;
    for (let m; (m = re.exec(run.text));) {
      const text = m[0];
      const start = pos + m.index;
      const kind: Token["kind"] = m[1] ? "tab" : m[2] ? "newline" : m[3] ? "pagebreak" : m[4] ? "space" : "word";
      out.push({ kind, text, props, font, width: kind === "word" || kind === "space" ? measure(font, text) : 0, start, end: start + text.length });
    }
    pos += run.text.length;
  }
  return out;
}

function lineHeightFor(props: ParaProps, ascent: number, descent: number): { height: number; baseline: number } {
  const natural = ascent + descent;
  const line = props.line ?? 1;
  if (props.lineRule === "exact") return { height: line, baseline: Math.min(line, ascent + (line - natural) / 2) };
  if (props.lineRule === "atLeast") { const h = Math.max(line, natural); return { height: h, baseline: ascent + (h - natural) }; }
  const h = natural * line;
  return { height: h, baseline: ascent + (h - natural) };
}

// ---------- cache dell'impaginazione dei paragrafi ----------
// Scrivendo cambia un solo paragrafo: gli altri riusano le righe già calcolate.
// La chiave contiene tutto ciò che influenza il risultato (testo, proprietà, larghezza, stili).

const paraCache = new Map<string, { key: string; result: ParaLayout }>();
let stylesKey = "";

function runKey(p: Paragraph): string {
  return JSON.stringify([p.props, p.markProps, p.runs.map((r) => r.type === "image"
    ? ["i", r.src.length, r.src.slice(-48), r.width, r.height, r.props]
    : r.type === "field" ? ["f", r.field, r.props] : [r.text, r.props])]);
}

function layoutParagraph(doc: DocumentModel, p: Paragraph, width: number, label: string | null, fields: Record<string, string>): ParaLayout {
  const hasField = p.runs.some((r) => r.type === "field");
  const key = `${stylesKey}|${width}|${label}|${hasField ? JSON.stringify(fields) : ""}|${runKey(p)}`;
  const slot = `${p.id}|${width}`;
  const hit = paraCache.get(slot);
  if (hit && hit.key === key) return hit.result;
  const result = layoutParagraphUncached(doc, p, width, label, fields);
  if (paraCache.size > 20_000) paraCache.clear();
  paraCache.set(slot, { key, result });
  return result;
}

function layoutParagraphUncached(doc: DocumentModel, p: Paragraph, width: number, label: string | null, fields: Record<string, string>): ParaLayout {
  const props = effectivePara(doc, p);
  const tokens = tokenize(doc, p, fields);
  const left = props.indentLeft ?? 0, right = props.indentRight ?? 0, first = props.firstLine ?? 0;
  const avail = Math.max(20, width - left - right);
  const markProps = effectiveRun(doc, p, { props: p.markProps ?? p.runs[0]?.props ?? {} });
  const lines: ParaLayout["lines"] = [];

  let frags: Fragment[] = [];
  let x = first; // posizione rispetto al rientro sinistro
  let lineStart = 0;
  let maxAscent = 0, maxDescent = 0;

  const addLabel = () => {
    if (label === null) return;
    const lp = { ...markProps };
    const font = fontFor(lp);
    const w = measure(font, label);
    frags.push({ x, width: w, text: label, font, props: lp, start: 0, end: 0, shift: 0, label: true });
    // Dopo l'etichetta il testo parte dal rientro sinistro (sporgenza) o dalla tabulazione successiva.
    x = x + w + 4 < 0 ? 0 : Math.ceil((x + w + 4) / DEFAULT_TAB) * DEFAULT_TAB;
    const m = fontMetrics(lp);
    maxAscent = Math.max(maxAscent, m.ascent); maxDescent = Math.max(maxDescent, m.descent);
  };
  addLabel();

  const finish = (end: number, last: boolean, pageBreak = false) => {
    const penX = x;
    if (!maxAscent) { const m = fontMetrics(markProps); maxAscent = m.ascent; maxDescent = m.descent; }
    const { height, baseline } = lineHeightFor(props, maxAscent, maxDescent);
    // Gli spazi in fondo alla riga non contano per l'allineamento.
    let content = 0;
    for (const f of frags) if (f.text.trim() !== "" || f.image || f.tab || f.label) content = Math.max(content, f.x + f.width);
    const align = props.align ?? "left";
    const free = avail - content;
    let dx = 0;
    if (align === "center") dx = free / 2;
    else if (align === "right") dx = free;
    else if (align === "justify" && !last && !pageBreak && free > 0) {
      const spaces = frags.filter((f, i) => f.text.trim() === "" && !f.tab && !f.image && i < frags.length - 1 && frags.slice(i + 1).some((g) => g.text.trim() !== ""));
      const count = spaces.reduce((n, f) => n + f.text.length, 0);
      if (count) {
        const per = free / count;
        let shift = 0;
        for (const f of frags) {
          f.x += shift;
          if (spaces.includes(f)) { f.justify = per; f.width += per * f.text.length; shift += per * f.text.length; }
        }
      }
    }
    if (dx > 0) for (const f of frags) f.x += dx;
    for (const f of frags) f.x += left;
    const textStart = frags.find((f) => !f.label)?.x ?? penX + Math.max(0, dx) + left;
    lines.push({ pid: p.id, width, height, baseline, fragments: frags, start: lineStart, end, last, pageBreak, textX: textStart });
    frags = [];
    x = 0;
    lineStart = end;
    maxAscent = 0; maxDescent = 0;
  };

  const push = (t: Token, width: number, text = t.text, extra: Partial<Fragment> = {}) => {
    const m = t.image ? { ascent: t.image.height, descent: 0 } : fontMetrics(t.props);
    maxAscent = Math.max(maxAscent, m.ascent); maxDescent = Math.max(maxDescent, m.descent);
    const size = t.props.size ?? 11;
    const shift = t.props.vertAlign === "superscript" ? -size * 0.33 : t.props.vertAlign === "subscript" ? size * 0.14 : 0;
    frags.push({ x, width, text, font: t.font, props: t.props, start: t.start, end: t.start + (t.image || t.kind === "field" ? 1 : text.length), shift, image: t.image, ...extra });
    x += width;
  };

  const tabs = [...(props.tabs ?? [])].sort((a, b) => a.pos - b.pos);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "newline") { push(t, 0, ""); finish(t.end, false); continue; }
    if (t.kind === "pagebreak") { push(t, 0, ""); finish(t.end, false, true); continue; }
    if (t.kind === "tab") {
      // Tabulazione personalizzata (es. sommario allineato a destra con puntini) o predefinita.
      const absX = x + left;
      const stop = tabs.find((s) => s.pos > absX + 0.5);
      if (stop && (stop.align === "right" || stop.align === "center")) {
        let segW = 0;
        for (let j = i + 1; j < tokens.length && tokens[j].kind !== "tab" && tokens[j].kind !== "newline"; j++) segW += tokens[j].width;
        const target = Math.min(stop.pos, avail + left) - left - (stop.align === "right" ? segW : segW / 2);
        push(t, Math.max(0, target - x), "\t", { tab: { leader: stop.leader } });
      } else {
        const next = stop ? stop.pos - left : Math.floor((x + left) / DEFAULT_TAB + 1) * DEFAULT_TAB - left;
        if (next > avail && frags.length) { finish(t.start, false); }
        push(t, Math.max(0, Math.min(next, avail) - x), "\t", { tab: { leader: stop?.leader } });
      }
      continue;
    }
    if (t.kind === "space") { push(t, t.width); continue; }
    if (x + t.width <= avail + 0.01 || !frags.some((f) => !f.label)) {
      if (t.width > avail && !t.image && t.kind === "word") {
        // Parola più lunga della riga: si spezza per caratteri.
        let piece = "", pieceStart = t.start;
        for (const ch of t.text) {
          const w = measure(t.font, piece + ch);
          if (x + w > avail && piece) {
            push({ ...t, start: pieceStart }, measure(t.font, piece), piece);
            finish(pieceStart + piece.length, false);
            pieceStart += piece.length;
            piece = "";
          }
          piece += ch;
        }
        push({ ...t, start: pieceStart }, measure(t.font, piece), piece);
      } else push(t, t.width);
      continue;
    }
    finish(t.start, false);
    i--; // la stessa parola va sulla riga successiva
  }
  finish(paragraphLength(p), true);
  return { lines, props };
}

// ---------- tabelle ----------

const CELL_PAD_X = 5.4;
const CELL_PAD_Y = 1;

interface PlacedLine { line: Line; page: number }

// ---------- impaginazione del documento ----------

export interface LayoutOptions {
  /** Paragrafi del sommario generati al passaggio precedente (per i numeri di pagina). */
  headingPages?: Map<number, number>;
}

export function layoutDocument(doc: DocumentModel): Layout {
  // Se cambiano stili, numerazioni o impostazioni predefinite, la cache non vale più.
  stylesKey = String(hashString(JSON.stringify([doc.styles, doc.numbering, doc.defaultRun, doc.defaultPara])));
  // Due passaggi: il primo trova le pagine dei titoli, il secondo scrive i numeri nel sommario.
  const first = runLayout(doc, new Map());
  const pages = new Map(first.headings.map((h) => [h.pid, h.page]));
  if (!doc.blocks.some((b) => b.type === "toc")) return first;
  return runLayout(doc, pages);
}

function runLayout(doc: DocumentModel, headingPages: Map<number, number>): Layout {
  const page = doc.page;
  const contentW = page.width - page.marginLeft - page.marginRight;
  const top = page.marginTop, bottom = page.height - page.marginBottom;
  const pages: PageBox[] = [];
  const lineMap: Layout["lines"] = new Map();
  const headings: Layout["headings"] = [];
  let cur: PageBox = { index: 0, lines: [], fills: [], borders: [] };
  pages.push(cur);
  let y = top;
  const atTop = () => y <= top + 0.01;
  const newPage = () => {
    cur = { index: pages.length, lines: [], fills: [], borders: [] };
    pages.push(cur);
    y = top;
  };
  const record = (line: Line, pageIndex: number) => {
    let arr = lineMap.get(line.pid);
    if (!arr) lineMap.set(line.pid, (arr = []));
    arr.push({ page: pageIndex, line });
  };

  // Contatori degli elenchi numerati
  const counters = new Map<number, number[]>();
  const labelFor = (p: Paragraph): string | null => {
    if (p.props.numId === undefined) return null;
    const def = doc.numbering[p.props.numId];
    if (!def) return null;
    const lvl = Math.min(p.props.numLevel ?? 0, def.levels.length - 1);
    const level = def.levels[lvl];
    let c = counters.get(def.id);
    if (!c) counters.set(def.id, (c = def.levels.map((l) => l.start - 1)));
    c[lvl]++;
    for (let k = lvl + 1; k < c.length; k++) c[k] = def.levels[k].start - 1;
    if (level.format === "bullet") return level.text;
    if (level.format === "none") return "";
    return level.text.replace(/%(\d)/g, (_m, d) => {
      const k = Number(d) - 1;
      return formatNumber(Math.max(1, c![k] ?? 1), def.levels[k]?.format ?? "decimal");
    });
  };

  const fields = { PAGE: "1", NUMPAGES: "1" };

  const placeParagraph = (p: Paragraph, x0: number, width: number, opts: { inCell?: boolean; nextFirstLine?: number } = {}): void => {
    const label = labelFor(p);
    const pl = layoutParagraph(doc, p, width, label, fields);
    const props = pl.props;
    if (!opts.inCell && props.pageBreakBefore && !atTop()) newPage();
    const before = atTop() && !opts.inCell ? 0 : props.spaceBefore ?? 0;
    // "Mantieni con il successivo": il titolo non resta da solo in fondo alla pagina.
    if (!opts.inCell && props.keepNext && !atTop()) {
      const need = before + pl.lines.reduce((s, l) => s + l.height, 0) + (props.spaceAfter ?? 0) + (opts.nextFirstLine ?? 0);
      if (y + need > bottom) newPage();
    }
    y += before;
    if (props.outlineLevel !== undefined && props.outlineLevel < 9 && !opts.inCell) {
      headings.push({ pid: p.id, level: props.outlineLevel + 1, text: paragraphText(p).replace(/[\t\n\f￼]/g, " ").trim(), page: pages.length });
    }
    const shadeTop = y;
    for (const l of pl.lines) {
      if (!opts.inCell && y + l.height > bottom && !atTop()) newPage();
      const line: Line = { ...l, story: "body", x: x0, y };
      cur.lines.push(line);
      record(line, cur.index);
      y += l.height;
      if (l.pageBreak && !opts.inCell) newPage();
    }
    if (props.shading && !opts.inCell) cur.fills.push({ x: x0 + (props.indentLeft ?? 0), y: shadeTop, w: width - (props.indentLeft ?? 0) - (props.indentRight ?? 0), h: y - shadeTop, color: props.shading });
    y += props.spaceAfter ?? 0;
  };

  const placeTable = (t: Table, x0: number, width: number) => {
    const total = t.grid.reduce((a, b) => a + b, 0) || width;
    const scale = total > width * 1.05 ? width / total : 1;
    const grid = t.grid.map((w) => w * scale);
    const tableW = grid.reduce((a, b) => a + b, 0);
    const tx = x0 + (t.align === "center" ? (width - tableW) / 2 : t.align === "right" ? width - tableW : 0);
    const colX = (k: number) => tx + grid.slice(0, k).reduce((a, b) => a + b, 0);
    const defBorder = t.borders === undefined ? { width: 0.5, color: "#000000" } : t.borders;

    for (const row of t.rows) {
      // Prima misuriamo la riga (senza piazzarla) per sapere se sta nella pagina.
      let col = 0;
      const cells = row.cells.map((cell) => {
        const k = col;
        col += cell.span || 1;
        const w = grid.slice(k, k + (cell.span || 1)).reduce((a, b) => a + b, 0);
        const inner = Math.max(10, w - 2 * CELL_PAD_X);
        const layouts = cell.vMerge === "continue" ? [] : cell.paragraphs.map((p) => ({ p, pl: layoutParagraph(doc, p, inner, null, fields) }));
        const h = layouts.reduce((s, { pl }, i) => s + (i ? pl.props.spaceBefore ?? 0 : 0) + pl.lines.reduce((a, l) => a + l.height, 0) + (i < layouts.length - 1 ? pl.props.spaceAfter ?? 0 : 0), 0);
        return { cell, x: colX(k), w, h: h + 2 * CELL_PAD_Y };
      });
      const rowH = Math.max(row.height ?? 0, ...cells.map((c) => c.h), 12);
      if (y + rowH > bottom && !atTop()) newPage();
      const rowTop = y;
      for (const c of cells) {
        if (c.cell.shading) cur.fills.push({ x: c.x, y: rowTop, w: c.w, h: rowH, color: c.cell.shading });
        if (c.cell.vMerge !== "continue") {
          const contentH = c.h - 2 * CELL_PAD_Y;
          const offset = c.cell.vAlign === "center" ? (rowH - c.h) / 2 : c.cell.vAlign === "bottom" ? rowH - c.h : 0;
          y = rowTop + CELL_PAD_Y + offset;
          const saved = cur;
          c.cell.paragraphs.forEach((p, i) => {
            const pl = layoutParagraph(doc, p, c.w - 2 * CELL_PAD_X, labelFor(p), fields);
            if (i) y += pl.props.spaceBefore ?? 0;
            for (const l of pl.lines) {
              const line: Line = { ...l, story: "body", x: c.x + CELL_PAD_X, y };
              saved.lines.push(line);
              record(line, saved.index);
              y += l.height;
            }
            if (i < c.cell.paragraphs.length - 1) y += pl.props.spaceAfter ?? 0;
          });
          void contentH;
        }
        // Bordi della cella
        const b = c.cell.borders ?? {};
        const side = (s: "top" | "bottom" | "left" | "right") => (b[s] === undefined ? defBorder : b[s]);
        const top = c.cell.vMerge === "continue" ? null : side("top");
        const edges: [ReturnType<typeof side>, number, number, number, number][] = [
          [top, c.x, rowTop, c.x + c.w, rowTop],
          [side("bottom"), c.x, rowTop + rowH, c.x + c.w, rowTop + rowH],
          [side("left"), c.x, rowTop, c.x, rowTop + rowH],
          [side("right"), c.x + c.w, rowTop, c.x + c.w, rowTop + rowH],
        ];
        for (const [bd, x1, y1, x2, y2] of edges) if (bd && bd.width > 0) cur.borders.push({ x1, y1, x2, y2, width: bd.width, color: bd.color, style: bd.style });
      }
      y = rowTop + rowH;
    }
    y += 6;
  };

  const placeToc = (toc: Toc) => {
    // Il sommario si rigenera dai titoli; i paragrafi hanno id negativi (non modificabili).
    const entries = [...allParagraphs(doc.blocks)]
      .map((p) => ({ p, props: effectivePara(doc, p) }))
      .filter(({ props }) => props.outlineLevel !== undefined && props.outlineLevel < toc.maxLevel);
    const tocPara = (text: string, style: string, id: number, tabs?: TabStop[]): Paragraph =>
      ({ type: "p", id, props: { style, tabs }, runs: text ? [{ text, props: {} }] : [] });
    placeParagraph(tocPara(toc.title ?? "Sommario", "TOCHeading", -toc.id * 1000), page.marginLeft, contentW);
    if (!entries.length) {
      placeParagraph(tocPara("Nessuna voce di sommario: usa gli stili Titolo 1, Titolo 2… nel documento.", "Normal", -toc.id * 1000 - 1), page.marginLeft, contentW);
      return;
    }
    entries.forEach(({ p, props }, i) => {
      const text = paragraphText(p).replace(/[\t\n\f￼]/g, " ").trim();
      const pg = headingPages.get(p.id) ?? 0;
      const tp = tocPara(`${text}\t${pg || "?"}`, `TOC${Math.min(3, props.outlineLevel! + 1)}`, -toc.id * 1000 - 2 - i, [{ pos: contentW, align: "right", leader: "dot" }]);
      placeParagraph(tp, page.marginLeft, contentW);
    });
  };

  const blocks: Block[] = doc.blocks;
  blocks.forEach((b, i) => {
    if (b.type === "p") {
      const next = blocks[i + 1];
      const nextFirst = next?.type === "p" ? 16 : 0;
      placeParagraph(b, page.marginLeft, contentW, { nextFirstLine: nextFirst });
    } else if (b.type === "table") placeTable(b, page.marginLeft, contentW);
    else placeToc(b);
  });

  // Intestazione e piè di pagina, ripetuti su ogni pagina con il numero corretto.
  const numPages = pages.length;
  for (const pg of pages) {
    fields.PAGE = String(pg.index + 1);
    fields.NUMPAGES = String(numPages);
    const story = (paras: Paragraph[], kind: Story) => {
      const laid = paras.map((p) => layoutParagraph(doc, p, contentW, labelFor(p), fields));
      const h = laid.reduce((s, pl) => s + pl.lines.reduce((a, l) => a + l.height, 0) + (pl.props.spaceAfter ?? 0), 0);
      let yy = kind === "header" ? page.headerDistance : page.height - page.footerDistance - h;
      for (const pl of laid) {
        yy += pl.props.spaceBefore ?? 0;
        for (const l of pl.lines) {
          const line: Line = { ...l, story: kind, x: page.marginLeft, y: yy };
          pg.lines.push(line);
          if (pg.index === 0) record(line, pg.index);
          yy += l.height;
        }
        yy += pl.props.spaceAfter ?? 0;
      }
    };
    story(doc.header, "header");
    story(doc.footer, "footer");
  }

  return { pages, lines: lineMap, headings };
}

/** Linee piazzate (utile per i test). */
export type { PlacedLine };

// ---------- da posizione a coordinate e viceversa ----------

/** Larghezza del testo del frammento fino al carattere `offset` (nel paragrafo). */
export function fragmentOffsetX(f: Fragment, offset: number): number {
  if (f.image || f.tab || f.label) return offset <= f.start ? 0 : f.width;
  const n = Math.max(0, Math.min(f.text.length, offset - f.start));
  const spaces = f.justify ? f.text.slice(0, n).split(" ").length - 1 : 0;
  return measure(f.font, f.text.slice(0, n)) + spaces * (f.justify ?? 0);
}

/** Coordinata x (pt sulla pagina) di una posizione dentro una riga. */
export function caretX(line: Line, offset: number): number {
  const frags = line.fragments.filter((f) => !f.label);
  for (const f of frags) {
    if (offset >= f.start && offset < f.end) return line.x + f.x + fragmentOffsetX(f, offset);
  }
  const last = frags[frags.length - 1];
  if (!last) return line.x + line.textX;
  // Fine riga: dopo l'ultimo frammento (gli spazi finali contano).
  return line.x + last.x + fragmentOffsetX(last, offset);
}

/** Posizione nel paragrafo più vicina alla coordinata x (pt sulla pagina) in una riga. */
export function offsetAtX(line: Line, x: number): number {
  const frags = line.fragments.filter((f) => !f.label && f.end > f.start);
  if (!frags.length) return line.start;
  const rel = x - line.x;
  for (const f of frags) {
    if (rel < f.x + f.width) {
      if (f.image || f.tab) return rel < f.x + f.width / 2 ? f.start : f.end;
      // Ricerca del carattere più vicino
      let best = f.start, bestD = Infinity;
      for (let i = 0; i <= f.text.length; i++) {
        const d = Math.abs(f.x + fragmentOffsetX(f, f.start + i) - rel);
        if (d < bestD) { bestD = d; best = f.start + i; }
        else if (d > bestD) break;
      }
      return best;
    }
  }
  // Oltre la fine della riga
  if (line.last) return line.end;
  const tail = line.fragments[line.fragments.length - 1];
  // Riga chiusa da "a capo" o interruzione di pagina: prima di quel carattere.
  if (tail && tail.text === "" && !tail.image && !tail.tab && !tail.label) return tail.start;
  // Riga spezzata dopo uno spazio: prima dello spazio finale (il cursore resta su questa riga).
  if (tail?.text.endsWith(" ")) return line.end - 1;
  return line.end;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
