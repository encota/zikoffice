// Operazioni di modifica del documento. Lavorano sul modello, senza grafica (testabili a parte).
import {
  allParagraphs, isAtomic, normalizeRuns, paragraphLength, paragraphText, runLength,
  type Block, type DocumentModel, type Paragraph, type ParaProps, type Run, type RunProps, type Table,
} from "./model";
import { ensureListNumbering, isBulletList } from "./styles";

/** Posizione nel documento: paragrafo e carattere. */
export interface Pos { pid: number; off: number }
export interface Range { anchor: Pos; focus: Pos }

export type StoryName = "body" | "header" | "footer";

interface Located {
  para: Paragraph;
  /** Lista che contiene il paragrafo (blocchi del corpo, celle, intestazione…). */
  list: (Block | Paragraph)[];
  index: number;
  story: StoryName;
  /** Tabella e cella, se il paragrafo è dentro una tabella. */
  table?: { table: Table; row: number; cell: number };
}

// ---------- ricerca ----------

export function locate(doc: DocumentModel, pid: number): Located | null {
  const inList = (list: (Block | Paragraph)[], story: StoryName): Located | null => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.type === "p" && b.id === pid) return { para: b, list, index: i, story };
      if (b.type === "table") {
        for (let r = 0; r < b.rows.length; r++) {
          for (let c = 0; c < b.rows[r].cells.length; c++) {
            const found = inList(b.rows[r].cells[c].paragraphs, story);
            if (found) return { ...found, table: found.table ?? { table: b, row: r, cell: c } };
          }
        }
      }
    }
    return null;
  };
  return inList(doc.blocks, "body") ?? inList(doc.header, "header") ?? inList(doc.footer, "footer");
}

/** Paragrafi di una "storia" (corpo, intestazione, piè di pagina) in ordine di lettura. */
export function storyParagraphs(doc: DocumentModel, story: StoryName): Paragraph[] {
  if (story === "header") return doc.header;
  if (story === "footer") return doc.footer;
  return [...allParagraphs(doc.blocks)];
}

export function storyOf(doc: DocumentModel, pid: number): StoryName {
  return locate(doc, pid)?.story ?? "body";
}

/** Confronto tra posizioni nello stesso racconto: negativo se a viene prima di b. */
export function comparePos(order: Map<number, number>, a: Pos, b: Pos): number {
  const ia = order.get(a.pid) ?? 0, ib = order.get(b.pid) ?? 0;
  return ia !== ib ? ia - ib : a.off - b.off;
}

export function orderMap(paras: Paragraph[]): Map<number, number> {
  return new Map(paras.map((p, i) => [p.id, i]));
}

export function ordered(order: Map<number, number>, r: Range): [Pos, Pos] {
  return comparePos(order, r.anchor, r.focus) <= 0 ? [r.anchor, r.focus] : [r.focus, r.anchor];
}

export const isCollapsed = (r: Range) => r.anchor.pid === r.focus.pid && r.anchor.off === r.focus.off;

// ---------- run ----------

/** Divide i run in modo che uno inizi esattamente a `off`; restituisce il suo indice. */
export function splitAt(p: Paragraph, off: number): number {
  let pos = 0;
  for (let i = 0; i < p.runs.length; i++) {
    const r = p.runs[i];
    const len = runLength(r);
    if (off === pos) return i;
    if (off < pos + len && !isAtomic(r)) {
      const k = off - pos;
      p.runs.splice(i, 1, { text: r.text.slice(0, k), props: { ...r.props } }, { text: r.text.slice(k), props: { ...r.props } });
      return i + 1;
    }
    pos += len;
  }
  return p.runs.length;
}

/** Proprietà dirette del testo alla posizione (del carattere precedente, come Word). */
export function runPropsAt(p: Paragraph, off: number): RunProps {
  let pos = 0;
  let prev: Run | undefined;
  for (const r of p.runs) {
    const len = runLength(r);
    if (off > pos && off <= pos + len) return { ...r.props };
    if (off === 0 && pos === 0) return { ...r.props };
    pos += len;
    prev = r;
  }
  return { ...(prev?.props ?? p.markProps ?? {}) };
}

/** Testo tra due posizioni nello stesso paragrafo. */
export function sliceText(p: Paragraph, from: number, to: number): string {
  return paragraphText(p).slice(from, to);
}

// ---------- inserimento ----------

/** Inserisce testo (anche con a capo "\n" tra paragrafi). Restituisce la posizione dopo il testo. */
export function insertText(doc: DocumentModel, pos: Pos, text: string, props?: RunProps): Pos {
  const parts = text.replace(/\r\n?/g, "\n").split("\n");
  let at = pos;
  parts.forEach((part, i) => {
    if (i > 0) at = splitParagraph(doc, at);
    if (part) at = insertInline(doc, at, part, props);
  });
  return at;
}

function insertInline(doc: DocumentModel, pos: Pos, text: string, props?: RunProps): Pos {
  const loc = locate(doc, pos.pid);
  if (!loc) return pos;
  const p = loc.para;
  const runProps = props ?? runPropsAt(p, pos.off);
  // Un link non si "allunga" scrivendo dopo di esso.
  const inherited = { ...runProps };
  const idx = splitAt(p, pos.off);
  p.runs.splice(idx, 0, { text, props: inherited });
  normalizeRuns(p);
  return { pid: p.id, off: pos.off + text.length };
}

export function insertRun(doc: DocumentModel, pos: Pos, run: Run): Pos {
  const loc = locate(doc, pos.pid);
  if (!loc) return pos;
  const idx = splitAt(loc.para, pos.off);
  loc.para.runs.splice(idx, 0, run);
  normalizeRuns(loc.para);
  return { pid: pos.pid, off: pos.off + runLength(run) };
}

/** A capo: divide il paragrafo. Restituisce l'inizio del nuovo paragrafo. */
export function splitParagraph(doc: DocumentModel, pos: Pos): Pos {
  const loc = locate(doc, pos.pid);
  if (!loc) return pos;
  const p = loc.para;
  const len = paragraphLength(p);
  // Invio su una voce di elenco vuota: termina l'elenco (come Word).
  if (len === 0 && p.props.numId !== undefined) {
    if ((p.props.numLevel ?? 0) > 0) p.props.numLevel = (p.props.numLevel ?? 0) - 1;
    else { delete p.props.numId; delete p.props.numLevel; if (p.props.style === "ListParagraph") delete p.props.style; }
    return pos;
  }
  const idx = splitAt(p, pos.off);
  const tail = p.runs.splice(idx);
  const markProps = runPropsAt(p, pos.off);
  const props: ParaProps = { ...p.props };
  delete props.pageBreakBefore;
  // A fine titolo il paragrafo successivo usa lo stile "successivo" (di solito Normale).
  if (pos.off >= len) {
    const next = doc.styles[p.props.style ?? "Normal"]?.next;
    if (next) { props.style = next === "Normal" ? undefined : next; delete props.outlineLevel; }
  }
  const np: Paragraph = { type: "p", id: doc.nextId++, props, runs: tail, markProps: { ...markProps } };
  if (!tail.length) np.runs = [];
  p.markProps = { ...markProps };
  normalizeRuns(p);
  normalizeRuns(np);
  loc.list.splice(loc.index + 1, 0, np);
  return { pid: np.id, off: 0 };
}

// ---------- cancellazione ----------

/** Cancella il testo tra due posizioni (in ordine). Restituisce la posizione risultante. */
export function deleteRange(doc: DocumentModel, from: Pos, to: Pos): Pos {
  if (from.pid === to.pid) {
    const loc = locate(doc, from.pid);
    if (!loc) return from;
    removeChars(loc.para, from.off, to.off);
    return from;
  }
  const story = storyOf(doc, from.pid);
  const paras = storyParagraphs(doc, story);
  const order = orderMap(paras);
  const i0 = order.get(from.pid)!, i1 = order.get(to.pid)!;
  const first = locate(doc, from.pid)!, last = locate(doc, to.pid)!;
  removeChars(first.para, from.off, paragraphLength(first.para));
  removeChars(last.para, 0, to.off);
  // I paragrafi in mezzo: si eliminano se stanno nella stessa lista, altrimenti si svuotano.
  for (let i = i1 - 1; i > i0; i--) {
    const loc = locate(doc, paras[i].id)!;
    if (loc.list === first.list) loc.list.splice(loc.index, 1);
    else removeChars(loc.para, 0, paragraphLength(loc.para));
  }
  // Tabelle interamente comprese nella selezione
  if (!first.table && !last.table) {
    const a = doc.blocks.findIndex((b) => b.type === "p" && b.id === from.pid);
    const b = doc.blocks.findIndex((x) => x.type === "p" && x.id === to.pid);
    if (a >= 0 && b > a) for (let k = b - 1; k > a; k--) if (doc.blocks[k].type !== "p") doc.blocks.splice(k, 1);
  }
  // Unisce l'ultimo paragrafo al primo se sono nella stessa lista
  const lastLoc = locate(doc, to.pid);
  if (lastLoc && lastLoc.list === first.list) {
    first.para.runs.push(...lastLoc.para.runs);
    lastLoc.list.splice(lastLoc.index, 1);
    normalizeRuns(first.para);
  }
  return from;
}

function removeChars(p: Paragraph, from: number, to: number): void {
  if (to <= from) return;
  const a = splitAt(p, from);
  const b = splitAt(p, to);
  p.runs.splice(a, b - a);
  normalizeRuns(p);
}

/** Backspace all'inizio di un paragrafo: unisce al precedente (o toglie l'elenco). */
export function joinWithPrevious(doc: DocumentModel, pos: Pos): Pos {
  const loc = locate(doc, pos.pid);
  if (!loc) return pos;
  const p = loc.para;
  if (p.props.numId !== undefined) {
    delete p.props.numId; delete p.props.numLevel;
    if (p.props.style === "ListParagraph") delete p.props.style;
    return pos;
  }
  if (p.props.indentLeft && p.props.indentLeft > 0 && !paragraphLength(p)) { delete p.props.indentLeft; return pos; }
  let prevIndex = loc.index - 1;
  while (prevIndex >= 0 && loc.list[prevIndex].type !== "p") {
    // Prima c'è una tabella o un sommario: il paragrafo vuoto si elimina, altrimenti niente.
    if (!paragraphLength(p) && loc.list.length > 1) {
      loc.list.splice(loc.index, 1);
      return endOfBlock(loc.list[prevIndex] as Block) ?? pos;
    }
    return pos;
  }
  if (prevIndex < 0) return pos;
  const prev = loc.list[prevIndex] as Paragraph;
  const off = paragraphLength(prev);
  prev.runs.push(...p.runs);
  normalizeRuns(prev);
  loc.list.splice(loc.index, 1);
  return { pid: prev.id, off };
}

function endOfBlock(b: Block): Pos | null {
  if (b.type === "p") return { pid: b.id, off: paragraphLength(b) };
  if (b.type === "table") {
    const row = b.rows[b.rows.length - 1];
    const cell = row.cells[row.cells.length - 1];
    const p = cell.paragraphs[cell.paragraphs.length - 1];
    return { pid: p.id, off: paragraphLength(p) };
  }
  return null;
}

/** Canc alla fine di un paragrafo: unisce il successivo. */
export function joinWithNext(doc: DocumentModel, pos: Pos): Pos {
  const loc = locate(doc, pos.pid);
  if (!loc) return pos;
  const next = loc.list[loc.index + 1];
  if (!next) return pos;
  if (next.type !== "p") {
    if (!paragraphLength(loc.para)) loc.list.splice(loc.index, 1);
    return pos;
  }
  loc.para.runs.push(...next.runs);
  normalizeRuns(loc.para);
  loc.list.splice(loc.index + 1, 1);
  return pos;
}

// ---------- formattazione ----------

/** Paragrafi toccati da un intervallo (in ordine). */
export function paragraphsIn(doc: DocumentModel, r: Range): Paragraph[] {
  const story = storyOf(doc, r.anchor.pid);
  const paras = storyParagraphs(doc, story);
  const order = orderMap(paras);
  const [a, b] = ordered(order, r);
  return paras.slice(order.get(a.pid), (order.get(b.pid) ?? 0) + 1);
}

/** Applica proprietà di testo all'intervallo. */
export function applyRunProps(doc: DocumentModel, r: Range, patch: RunProps): void {
  const story = storyOf(doc, r.anchor.pid);
  const order = orderMap(storyParagraphs(doc, story));
  const [a, b] = ordered(order, r);
  for (const p of paragraphsIn(doc, r)) {
    const from = p.id === a.pid ? a.off : 0;
    const to = p.id === b.pid ? b.off : paragraphLength(p);
    if (to <= from) {
      if (from === 0 && to === 0 && !paragraphLength(p)) p.markProps = clean({ ...(p.markProps ?? {}), ...patch });
      continue;
    }
    const i0 = splitAt(p, from), i1 = splitAt(p, to);
    for (let i = i0; i < i1; i++) p.runs[i].props = clean({ ...p.runs[i].props, ...patch });
    normalizeRuns(p);
  }
}

function clean(props: RunProps): RunProps {
  const out: RunProps = {};
  for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== false && v !== "") (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Vero se tutto il testo dell'intervallo ha la proprietà (per i pulsanti come Grassetto). */
export function rangeHas(doc: DocumentModel, r: Range, test: (p: RunProps) => boolean, effective: (p: Paragraph, rp: RunProps) => RunProps): boolean {
  const order = orderMap(storyParagraphs(doc, storyOf(doc, r.anchor.pid)));
  const [a, b] = ordered(order, r);
  let any = false;
  for (const p of paragraphsIn(doc, r)) {
    const from = p.id === a.pid ? a.off : 0;
    const to = p.id === b.pid ? b.off : paragraphLength(p);
    let pos = 0;
    for (const run of p.runs) {
      const len = runLength(run);
      if (pos < to && pos + len > from) {
        any = true;
        if (!test(effective(p, run.props))) return false;
      }
      pos += len;
    }
  }
  return any;
}

/** Rimuove la formattazione diretta del testo (Ctrl+Spazio in Word). */
export function clearRunProps(doc: DocumentModel, r: Range): void {
  const order = orderMap(storyParagraphs(doc, storyOf(doc, r.anchor.pid)));
  const [a, b] = ordered(order, r);
  for (const p of paragraphsIn(doc, r)) {
    const from = p.id === a.pid ? a.off : 0;
    const to = p.id === b.pid ? b.off : paragraphLength(p);
    const i0 = splitAt(p, from), i1 = splitAt(p, to);
    for (let i = i0; i < i1; i++) p.runs[i].props = p.runs[i].props.link ? { link: p.runs[i].props.link } : {};
    normalizeRuns(p);
  }
}

export function applyParaProps(doc: DocumentModel, r: Range, patch: ParaProps): void {
  for (const p of paragraphsIn(doc, r)) {
    p.props = { ...p.props, ...patch };
    for (const k of Object.keys(p.props) as (keyof ParaProps)[]) if (p.props[k] === undefined) delete p.props[k];
  }
}

export function setStyle(doc: DocumentModel, r: Range, style: string): void {
  for (const p of paragraphsIn(doc, r)) {
    if (style === "Normal") delete p.props.style; else p.props.style = style;
    // Lo stile del titolo decide il livello: togliamo quello impostato a mano.
    delete p.props.outlineLevel;
  }
}

/** Attiva/disattiva un elenco puntato o numerato sui paragrafi. */
export function toggleList(doc: DocumentModel, r: Range, kind: "bullet" | "number"): void {
  const paras = paragraphsIn(doc, r);
  const already = paras.every((p) => p.props.numId !== undefined && isBulletList(doc, p.props.numId) === (kind === "bullet"));
  if (already) {
    for (const p of paras) { delete p.props.numId; delete p.props.numLevel; if (p.props.style === "ListParagraph") delete p.props.style; }
    return;
  }
  // Continua l'elenco del paragrafo precedente se è dello stesso tipo.
  const all = storyParagraphs(doc, storyOf(doc, paras[0].id));
  const before = all[all.indexOf(paras[0]) - 1];
  const numId = before?.props.numId !== undefined && isBulletList(doc, before.props.numId) === (kind === "bullet")
    ? before.props.numId : ensureListNumbering(doc, kind);
  for (const p of paras) {
    p.props.numId = numId;
    p.props.numLevel = p.props.numLevel ?? 0;
    delete p.props.indentLeft;
    delete p.props.firstLine;
    if (!p.props.style) p.props.style = "ListParagraph";
  }
}

/** Aumenta/riduce il rientro (o il livello dell'elenco). */
export function changeIndent(doc: DocumentModel, r: Range, dir: 1 | -1): void {
  for (const p of paragraphsIn(doc, r)) {
    if (p.props.numId !== undefined) {
      p.props.numLevel = Math.max(0, Math.min(8, (p.props.numLevel ?? 0) + dir));
      continue;
    }
    const next = Math.max(0, (p.props.indentLeft ?? 0) + dir * 35.4);
    if (next) p.props.indentLeft = next; else delete p.props.indentLeft;
  }
}

// ---------- tabelle ----------

export function newTable(doc: DocumentModel, rows: number, cols: number, width: number): Table {
  const w = width / cols;
  return {
    type: "table", id: doc.nextId++, grid: Array.from({ length: cols }, () => w),
    rows: Array.from({ length: rows }, () => ({
      cells: Array.from({ length: cols }, () => ({ span: 1, paragraphs: [{ type: "p" as const, id: doc.nextId++, props: { style: "NoSpacing" }, runs: [] }] })),
    })),
  };
}

/** Inserisce un blocco (tabella, sommario) dopo il paragrafo della posizione. */
export function insertBlockAfter(doc: DocumentModel, pos: Pos, block: Block): Pos {
  const loc = locate(doc, pos.pid);
  if (!loc || loc.story !== "body" || loc.table) return pos;
  const p = loc.para;
  // Se il cursore è a metà paragrafo, lo divide.
  let index = loc.index;
  if (pos.off > 0 && pos.off < paragraphLength(p)) { splitParagraph(doc, pos); }
  // All'inizio di un paragrafo (anche vuoto) il blocco va prima di esso, come in Word.
  else if (pos.off === 0) index--;
  doc.blocks.splice(index + 1, 0, block);
  // Dopo il blocco serve sempre un paragrafo dove continuare a scrivere.
  const after = doc.blocks[index + 2];
  if (!after || after.type !== "p") {
    const np: Paragraph = { type: "p", id: doc.nextId++, props: {}, runs: [] };
    doc.blocks.splice(index + 2, 0, np);
    return { pid: np.id, off: 0 };
  }
  return { pid: after.id, off: 0 };
}

export function tableAt(doc: DocumentModel, pid: number) {
  return locate(doc, pid)?.table ?? null;
}

export function addTableRow(doc: DocumentModel, pid: number, below: boolean): Pos | null {
  const t = tableAt(doc, pid);
  if (!t) return null;
  const src = t.table.rows[t.row];
  const row = { cells: src.cells.map((c) => ({ span: c.span, paragraphs: [{ type: "p" as const, id: doc.nextId++, props: { ...(c.paragraphs[0]?.props ?? {}) }, runs: [] }], shading: c.shading })) };
  t.table.rows.splice(t.row + (below ? 1 : 0), 0, row);
  return { pid: row.cells[Math.min(t.cell, row.cells.length - 1)].paragraphs[0].id, off: 0 };
}

export function addTableColumn(doc: DocumentModel, pid: number, right: boolean): void {
  const t = tableAt(doc, pid);
  if (!t) return;
  const at = t.cell + (right ? 1 : 0);
  const w = t.table.grid[Math.min(t.cell, t.table.grid.length - 1)];
  // Mantiene la larghezza totale della tabella.
  const total = t.table.grid.reduce((a, b) => a + b, 0);
  t.table.grid.splice(at, 0, w);
  const scale = total / (total + w);
  t.table.grid = t.table.grid.map((x) => x * scale);
  for (const row of t.table.rows) row.cells.splice(Math.min(at, row.cells.length), 0, { span: 1, paragraphs: [{ type: "p", id: doc.nextId++, props: { style: "NoSpacing" }, runs: [] }] });
}

export function deleteTableRow(doc: DocumentModel, pid: number): Pos | null {
  const t = tableAt(doc, pid);
  if (!t) return null;
  if (t.table.rows.length === 1) return deleteTable(doc, pid);
  t.table.rows.splice(t.row, 1);
  const row = t.table.rows[Math.min(t.row, t.table.rows.length - 1)];
  return { pid: row.cells[Math.min(t.cell, row.cells.length - 1)].paragraphs[0].id, off: 0 };
}

export function deleteTableColumn(doc: DocumentModel, pid: number): Pos | null {
  const t = tableAt(doc, pid);
  if (!t) return null;
  if (t.table.grid.length === 1) return deleteTable(doc, pid);
  t.table.grid.splice(t.cell, 1);
  for (const row of t.table.rows) if (row.cells.length > t.cell) row.cells.splice(t.cell, 1);
  const row = t.table.rows[t.row];
  return { pid: row.cells[Math.min(t.cell, row.cells.length - 1)].paragraphs[0].id, off: 0 };
}

export function deleteTable(doc: DocumentModel, pid: number): Pos | null {
  const t = tableAt(doc, pid);
  if (!t) return null;
  const i = doc.blocks.indexOf(t.table);
  doc.blocks.splice(i, 1);
  const after = doc.blocks[i] ?? doc.blocks[i - 1];
  if (after?.type === "p") return { pid: after.id, off: 0 };
  const np: Paragraph = { type: "p", id: doc.nextId++, props: {}, runs: [] };
  doc.blocks.splice(i, 0, np);
  return { pid: np.id, off: 0 };
}

/** Cella successiva/precedente (Tab nelle tabelle). */
export function adjacentCell(doc: DocumentModel, pid: number, dir: 1 | -1): Pos | null {
  const t = tableAt(doc, pid);
  if (!t) return null;
  const cells: Paragraph[] = [];
  for (const row of t.table.rows) for (const cell of row.cells) if (cell.vMerge !== "continue") cells.push(cell.paragraphs[0]);
  const current = t.table.rows[t.row].cells[t.cell].paragraphs[0];
  const i = cells.indexOf(current) + dir;
  if (i < 0 || i >= cells.length) return null;
  const target = cells[i];
  return { pid: target.id, off: 0 };
}

// ---------- utilità ----------

export function documentText(doc: DocumentModel): string {
  return [...allParagraphs(doc.blocks)].map(paragraphText).join("\n");
}

export function wordCount(doc: DocumentModel): number {
  return documentText(doc).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Confini della parola intorno a una posizione (doppio clic). */
export function wordAt(p: Paragraph, off: number): [number, number] {
  const text = paragraphText(p);
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_'’]/u.test(ch);
  let a = off, b = off;
  if (!isWord(text[a]) && isWord(text[a - 1])) a--;
  if (!isWord(text[a])) return [off, Math.min(text.length, off + 1)];
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  // Word include lo spazio dopo la parola
  while (b < text.length && text[b] === " ") b++;
  return [a, b];
}

/** Posizione della parola successiva/precedente (Ctrl+frecce). */
export function wordBoundary(p: Paragraph, off: number, dir: 1 | -1): number {
  const text = paragraphText(p);
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);
  let i = off;
  if (dir > 0) {
    while (i < text.length && isWord(text[i])) i++;
    while (i < text.length && !isWord(text[i])) i++;
  } else {
    while (i > 0 && !isWord(text[i - 1])) i--;
    while (i > 0 && isWord(text[i - 1])) i--;
  }
  return i;
}

// ---------- appunti ----------

/** Copia dei paragrafi (anche parziali) tra due posizioni ordinate. */
export function extractRange(doc: DocumentModel, a: Pos, b: Pos): Paragraph[] {
  const out: Paragraph[] = [];
  for (const p of paragraphsIn(doc, { anchor: a, focus: b })) {
    const copy: Paragraph = structuredClone(p);
    const from = p.id === a.pid ? a.off : 0;
    const to = p.id === b.pid ? b.off : paragraphLength(p);
    const end = splitAt(copy, to);
    copy.runs.splice(end);
    const start = splitAt(copy, from);
    copy.runs.splice(0, start);
    out.push(copy);
  }
  return out;
}

/** Inserisce paragrafi formattati alla posizione (incolla con formattazione). */
export function insertFragment(doc: DocumentModel, pos: Pos, frag: Paragraph[]): Pos {
  if (!frag.length) return pos;
  const loc = locate(doc, pos.pid);
  if (!loc) return pos;
  const fresh = (p: Paragraph): Paragraph => ({ ...structuredClone(p), id: doc.nextId++ });
  if (frag.length === 1) {
    const idx = splitAt(loc.para, pos.off);
    const runs = structuredClone(frag[0].runs);
    loc.para.runs.splice(idx, 0, ...runs);
    normalizeRuns(loc.para);
    return { pid: pos.pid, off: pos.off + runs.reduce((n, r) => n + runLength(r), 0) };
  }
  // Più paragrafi: il primo si unisce al testo prima del cursore, l'ultimo a quello dopo.
  const after = splitParagraph(doc, pos);
  const head = loc.para;
  const tail = locate(doc, after.pid)!.para;
  head.runs.push(...structuredClone(frag[0].runs));
  if (paragraphLength(head) === frag[0].runs.reduce((n, r) => n + runLength(r), 0)) head.props = { ...frag[0].props };
  normalizeRuns(head);
  const middle = frag.slice(1, -1).map(fresh);
  const tailLoc = locate(doc, tail.id)!;
  tailLoc.list.splice(tailLoc.index, 0, ...middle);
  const lastFrag = frag[frag.length - 1];
  const lastLen = lastFrag.runs.reduce((n, r) => n + runLength(r), 0);
  tail.runs.unshift(...structuredClone(lastFrag.runs));
  tail.props = { ...lastFrag.props };
  normalizeRuns(tail);
  return { pid: tail.id, off: lastLen };
}
