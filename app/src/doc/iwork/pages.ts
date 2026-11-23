// Importazione di un documento Pages (formato .iwa, 2013 e successivi) nel modello dell'editor.
// Si usano solo i campi di cui conosciamo il significato; il resto viene ignorato.
import { all, first, float32, fields, num, str, type Field } from "./iwa";
import { Pkg } from "./pkg";
import { newDocument } from "../styles";
import type { Align, Block, DocumentModel, ImageRun, NumberingDef, NumFormat, NumLevel, ParaProps, Run, RunProps, StyleDef, Table } from "../model";
import { readTableInfo } from "./tables";

const NONE = 4294967295;

// ---------- stili ----------

interface CharP { bold?: boolean; italic?: boolean; size?: number; font?: string; color?: string; underline?: boolean; strike?: boolean }
interface ParaP { align?: Align; outline?: number }
interface Own { name: string; ident: string; parent?: number; char: CharP; para: ParaP }

const ALIGN: Record<number, Align> = { 0: "left", 1: "right", 2: "center", 3: "justify", 4: "left" };

function hex(v: number): string {
  return Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
}

function readChar(fs: Field[]): CharP {
  const c: CharP = {};
  const b = first(fs, 1); if (b) c.bold = b.num !== 0;
  const i = first(fs, 2); if (i) c.italic = i.num !== 0;
  const s = float32(first(fs, 3)); if (s !== undefined && s > 0) c.size = s;
  const f = str(first(fs, 5)); if (f) c.font = f;
  const col = first(fs, 7);
  if (col?.bytes) {
    const cf = fields(col.bytes);
    const r = float32(first(cf, 3)), g = float32(first(cf, 4)), bl = float32(first(cf, 5)), a = float32(first(cf, 6));
    if (r !== undefined && g !== undefined && bl !== undefined && (a === undefined || a > 0)) c.color = `#${hex(r)}${hex(g)}${hex(bl)}`;
  }
  const u = first(fs, 11); if (u) c.underline = u.num !== 0;
  const st = first(fs, 12); if (st) c.strike = st.num !== 0;
  return c;
}

function readOwn(pkg: Pkg, id: number): Own {
  const fs = pkg.f(id);
  const head = first(fs, 1)?.bytes ? fields(first(fs, 1)!.bytes!) : [];
  const own: Own = { name: str(first(head, 1)), ident: str(first(head, 2)), parent: pkg.refId(first(head, 3)), char: {}, para: {} };
  const cp = first(fs, 11);
  if (cp?.bytes) own.char = readChar(fields(cp.bytes));
  const pp = first(fs, 12);
  if (pp?.bytes && pkg.type(id) === 2022) {
    const pf = fields(pp.bytes);
    const al = first(pf, 1); if (al && ALIGN[al.num] !== undefined) own.para.align = ALIGN[al.num];
    const ol = first(pf, 27); if (ol && ol.num !== NONE && ol.num < 9) own.para.outline = ol.num;
  }
  return own;
}

/** Stile con le proprietà ereditate dalla catena dei genitori (fino a `stopAt` escluso). */
function chain(pkg: Pkg, id: number, stopAt?: number): { char: CharP; para: ParaP; named?: Own & { id: number } } {
  const list: (Own & { id: number })[] = [];
  const seen = new Set<number>();
  for (let cur: number | undefined = id; cur !== undefined && pkg.has(cur) && !seen.has(cur) && cur !== stopAt; ) {
    seen.add(cur);
    list.push({ ...readOwn(pkg, cur), id: cur });
    cur = list[list.length - 1].parent;
  }
  const char: CharP = {};
  const para: ParaP = {};
  for (const o of list.reverse()) { Object.assign(char, o.char); Object.assign(para, o.para); }
  return { char, para };
}

function namedAncestor(pkg: Pkg, id: number): number {
  const seen = new Set<number>();
  for (let cur: number | undefined = id; cur !== undefined && pkg.has(cur) && !seen.has(cur); ) {
    seen.add(cur);
    const o = readOwn(pkg, cur);
    if (o.name) return cur;
    cur = o.parent;
  }
  return id;
}

// ---------- font ----------

export function fontOf(ps: string): { family: string; bold?: boolean; italic?: boolean } {
  const [rawFamily, ...rest] = ps.split("-");
  const styleTokens = rest.join("-");
  let family = rawFamily.replace(/(PS|MT)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (/^Helvetica/i.test(family) || /^Arial/i.test(family) || /^SF Pro/i.test(family) || /^San Francisco/i.test(family)) family = "Arial";
  else if (/^Times/i.test(family)) family = "Times New Roman";
  else if (/^(Courier|Menlo|Monaco|SF Mono)/i.test(family)) family = "Courier New";
  const out: { family: string; bold?: boolean; italic?: boolean } = { family };
  if (/bold|black|heavy|semibold/i.test(styleTokens)) out.bold = true;
  if (/italic|oblique/i.test(styleTokens)) out.italic = true;
  return out;
}

function runProps(c: CharP): RunProps {
  const p: RunProps = {};
  if (c.font) {
    const f = fontOf(c.font);
    p.font = f.family;
    if (f.bold && c.bold === undefined) p.bold = true;
    if (f.italic && c.italic === undefined) p.italic = true;
  }
  if (c.bold !== undefined) p.bold = c.bold;
  if (c.italic !== undefined) p.italic = c.italic;
  if (c.size) p.size = Math.round(c.size * 10) / 10;
  if (c.color && c.color !== "#000000") p.color = c.color;
  if (c.underline !== undefined) p.underline = c.underline;
  if (c.strike !== undefined) p.strike = c.strike;
  return p;
}

// ---------- tabelle attributi del testo ----------

interface Entry { at: number; ref?: number; first?: number; second?: number }

/** Legge una tabella di attributi: voci {indice del carattere, riferimento o interi}. */
function readTable_(pkg: Pkg, f: Field | undefined): Entry[] {
  if (!f?.bytes) return [];
  const out: Entry[] = [];
  for (const e of all(fields(f.bytes), 1)) {
    if (!e.bytes) continue;
    const ef = fields(e.bytes);
    const at = num(ef, 1);
    const r = first(ef, 2);
    out.push({ at, ref: r?.bytes ? pkg.refId(r) : undefined, first: r && r.wire === 0 ? r.num : undefined, second: first(ef, 3)?.num });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Voce in vigore all'indice dato (l'ultima che comincia prima o alla stessa posizione). */
function entryAt(list: Entry[], idx: number): Entry | undefined {
  let lo = 0, hi = list.length - 1, best: Entry | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].at <= idx) { best = list[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** Ultima voce con un riferimento, in vigore all'indice (per stili che continuano da un paragrafo al successivo). */
function refAt(list: Entry[], idx: number): number | undefined {
  let best: number | undefined;
  for (const e of list) {
    if (e.at > idx) break;
    if (e.ref !== undefined) best = e.ref;
  }
  return best;
}

// ---------- elenchi ----------

function numFormat(code: number): { format: NumFormat; wrap: string } {
  const group = Math.floor(code / 3);
  const wrap = ["%.", "(%)", "%)"][code % 3] ?? "%.";
  const format: NumFormat = (["decimal", "upperRoman", "lowerRoman", "upperLetter", "lowerLetter"] as NumFormat[])[group] ?? "decimal";
  return { format, wrap };
}

function listLevels(pkg: Pkg, listStyle: number): NumLevel[] | null {
  const fs = pkg.f(listStyle);
  const kinds = all(fs, 11).map((f) => f.num);
  if (!kinds.length || kinds.every((k) => k === 0)) return null;
  const indents = all(fs, 13).map((f) => float32(f));
  const bullets = all(fs, 16).map(str);
  const formats = all(fs, 15).map((f) => f.num);
  const levels: NumLevel[] = [];
  for (let i = 0; i < 9; i++) {
    const kind = kinds[i] ?? kinds[kinds.length - 1];
    const left = (indents[i] ?? 18 * i) + 18;
    if (kind === 3) {
      const { format, wrap } = numFormat(formats[i] ?? 0);
      levels.push({ format, text: wrap.replace("%", `%${i + 1}`), start: 1, indentLeft: left, hanging: 18 });
    } else if (kind === 0) {
      levels.push({ format: "none", text: "", start: 1, indentLeft: left, hanging: 0 });
    } else {
      levels.push({ format: "bullet", text: bullets[i] || "•", start: 1, indentLeft: left, hanging: 18 });
    }
  }
  return levels;
}

// ---------- immagini e tabelle incorporate ----------

const IMAGE = 3005;
const TABLE_INFO = 6000;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Cerca, a partire da un oggetto, il primo oggetto di uno dei tipi indicati seguendo i riferimenti. */
export function findDrawable(pkg: Pkg, start: number, types: number[], depth = 4): number | undefined {
  const seen = new Set<number>();
  let frontier = [start];
  for (let d = 0; d <= depth && frontier.length; d++) {
    const next: number[] = [];
    for (const id of frontier) {
      if (seen.has(id) || !pkg.has(id)) continue;
      seen.add(id);
      if (types.includes(pkg.type(id))) return id;
      collectRefs(pkg, pkg.f(id), next, 3);
    }
    frontier = next;
  }
  return undefined;
}

function collectRefs(pkg: Pkg, fs: Field[], out: number[], depth: number): void {
  for (const f of fs) {
    if (!f.bytes || f.wire !== 2) continue;
    let inner: Field[];
    try { inner = fields(f.bytes); } catch { continue; }
    if (inner.length === 1 && inner[0].n === 1 && inner[0].wire === 0 && pkg.has(inner[0].num)) out.push(inner[0].num);
    else if (depth > 0 && inner.length && inner.every((x) => x.n > 0 && x.n < 100)) collectRefs(pkg, inner, out, depth - 1);
  }
}

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml" };

function readImage(pkg: Pkg, id: number): ImageRun | null {
  const fs = pkg.f(id);
  const geo = first(fs, 1)?.bytes ? first(fields(first(fs, 1)!.bytes!), 1) : undefined;
  let width = 0, height = 0;
  if (geo?.bytes) {
    const size = first(fields(geo.bytes), 2);
    if (size?.bytes) { width = float32(first(fields(size.bytes), 1)) ?? 0; height = float32(first(fields(size.bytes), 2)) ?? 0; }
  }
  for (const n of [11, 12]) {
    const ref = first(fs, n);
    const ident = ref?.bytes ? num(fields(ref.bytes), 1, -1) : -1;
    if (ident < 0) continue;
    const file = pkg.dataFile(ident);
    if (!file) continue;
    const ext = file.name.split(".").pop()!.toLowerCase();
    const mime = MIME[ext];
    if (!mime) continue;
    if (!width || !height) { width = width || 200; height = height || 150; }
    return { type: "image", src: `data:${mime};base64,${toBase64(file.bytes)}`, mime, width, height, alt: "", props: {} };
  }
  return null;
}

// ---------- importazione ----------

export interface Ctx {
  pkg: Pkg;
  doc: DocumentModel;
  styleIds: Map<number, string>;
  nextNum: number;
}

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "Stile";
}

function styleFor(ctx: Ctx, paraStyle: number): string {
  const { pkg, doc } = ctx;
  const named = namedAncestor(pkg, paraStyle);
  const hit = ctx.styleIds.get(named);
  if (hit) return hit;
  const { char, para } = chain(pkg, named);
  const name = readOwn(pkg, named).name || "Stile";
  const heading = /^Heading (\d)$/.exec(name);
  const builtin = name === "Body" ? "Normal" : ["Title", "Subtitle", "Caption"].includes(name) ? name : undefined;
  const id = heading ? `Heading${heading[1]}` : builtin ?? `IW_${slug(name)}`;
  const def: StyleDef = {
    id, name: heading || builtin ? doc.styles[id]?.name ?? name : name,
    type: "paragraph", basedOn: id === "Normal" ? undefined : "Normal", quick: true,
    para: { ...(id === "Normal" ? doc.styles.Normal.para : { spaceBefore: 0, spaceAfter: 6 }) },
    run: runProps(char),
  };
  if (para.align) def.para!.align = para.align;
  if (para.outline !== undefined) { def.para!.outlineLevel = para.outline; def.para!.keepNext = true; }
  if (id !== "Normal") def.next = "Normal";
  doc.styles[id] = def;
  ctx.styleIds.set(named, id);
  if (id === "Normal") doc.defaultRun = { ...doc.defaultRun, ...runProps(char) };
  return id;
}

/** Converte un deposito di testo (TSWP.StorageArchive) in paragrafi; le tabelle e le immagini incorporate vanno in `extra`. */
export function storageToBlocks(ctx: Ctx, storage: number, allowObjects: boolean): Block[] {
  const { pkg, doc } = ctx;
  const st = pkg.f(storage);
  const text = all(st, 3).map(str).join("");
  let paraTable: Entry[] = [], listTable: Entry[] = [], charTable: Entry[] = [], attachTable: Entry[] = [];
  const dataTable = readTable_(pkg, first(st, 6));
  for (const f of st) {
    if (f.n < 5 || f.n === 6 || !f.bytes) continue;
    const list = readTable_(pkg, f);
    const target = list.find((e) => e.ref !== undefined)?.ref;
    const t = target !== undefined ? pkg.type(target) : -1;
    if (t === 2022) paraTable = list;
    else if (t === 2023) listTable = list;
    else if (t === 2021) charTable = list;
    else if (target !== undefined && t > 0) attachTable = attachTable.concat(list);
  }
  attachTable = attachTable.filter((e) => text[e.at] === "\uFFFC").sort((a, b) => a.at - b.at);

  const paragraphs: { start: number; end: number }[] = [];
  for (let s = 0; s <= text.length;) {
    const e = text.indexOf("\n", s);
    if (e < 0) { if (s < text.length || paragraphs.length === 0) paragraphs.push({ start: s, end: text.length }); break; }
    paragraphs.push({ start: s, end: e });
    s = e + 1;
  }

  const blocks: Block[] = [];
  let currentNum: { list: number; numId: number } | null = null;
  for (const { start, end } of paragraphs) {
    const paraStyle = refAt(paraTable, start);
    const props: ParaProps = {};
    let overrideChar: CharP = {};
    if (paraStyle !== undefined) {
      const named = namedAncestor(pkg, paraStyle);
      props.style = styleFor(ctx, paraStyle);
      if (named !== paraStyle) {
        const own = chain(pkg, paraStyle, named);
        overrideChar = own.char;
        if (own.para.align) props.align = own.para.align;
      }
    }

    // Elenco
    const list = refAt(listTable, start);
    const level = entryAt(dataTable, start)?.first ?? 0;
    const levels = list !== undefined ? listLevels(pkg, list) : null;
    if (list !== undefined && levels && levels[Math.min(level, 8)].format !== "none") {
      if (!currentNum || currentNum.list !== list) {
        const def: NumberingDef = { id: ctx.nextNum++, levels };
        doc.numbering[def.id] = def;
        currentNum = { list, numId: def.id };
      }
      props.numId = currentNum.numId;
      props.numLevel = Math.min(level, 8);
    } else {
      currentNum = null;
    }

    // Corse di testo
    const runs: Run[] = [];
    const before: Block[] = [];
    const cuts = new Set<number>([start, end]);
    for (const e of charTable) if (e.at > start && e.at < end) cuts.add(e.at);
    if (allowObjects) for (const e of attachTable) if (e.at >= start && e.at < end) { cuts.add(e.at); cuts.add(e.at + 1); }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i], b = points[i + 1];
      const piece = text.slice(a, b);
      const cs = entryAt(charTable, a)?.ref;
      const chars = cs !== undefined ? chain(pkg, cs).char : {};
      const rp = runProps({ ...overrideChar, ...chars });
      if (piece === "\uFFFC") {
        const att = attachTable.find((e) => e.at === a)?.ref;
        const obj = att !== undefined && allowObjects ? attachmentBlock(ctx, att) : null;
        if (obj && "src" in obj) runs.push({ ...obj, props: rp });
        else if (obj) before.push(obj);
        continue;
      }
      const clean = piece.replace(/\u2028|\u000b/g, "\n").replace(/[\u0000-\u0008\u000e-\u001f\u007f\uFFFC]/g, "");
      if (clean) runs.push({ text: clean, props: rp });
    }
    blocks.push(...before);
    blocks.push({ type: "p", id: doc.nextId++, props, runs });
  }
  return blocks;
}

function attachmentBlock(ctx: Ctx, attachment: number): ImageRun | Table | null {
  const found = findDrawable(ctx.pkg, attachment, [IMAGE, TABLE_INFO]);
  if (found === undefined) return null;
  if (ctx.pkg.type(found) === IMAGE) return readImage(ctx.pkg, found);
  return readTableInfo(ctx, found);
}

export function importPages(pkg: Pkg): DocumentModel {
  const doc = newDocument();
  doc.blocks = [];
  const ctx: Ctx = { pkg, doc, styleIds: new Map(), nextNum: 1 };

  const docId = pkg.firstOfType(10000);
  const docFs = docId !== undefined ? pkg.f(docId) : [];

  // Pagina
  const w = float32(first(docFs, 30)), hgt = float32(first(docFs, 31));
  if (w && hgt && w > 100 && hgt > 100) { doc.page.width = w; doc.page.height = hgt; }
  const margins = [32, 33, 34, 35, 36, 37].map((n) => float32(first(docFs, n)));
  if (margins.slice(0, 4).every((m) => m !== undefined && m >= 0 && m < 300)) {
    // Stesso ordine degli attributi dei vecchi file XML: alto, sinistra, basso, destra, intestazione, piè di pagina.
    [doc.page.marginTop, doc.page.marginLeft, doc.page.marginBottom, doc.page.marginRight] = margins.slice(0, 4) as number[];
  }
  if (margins[4] !== undefined && margins[4] >= 0) doc.page.headerDistance = margins[4];
  if (margins[5] !== undefined && margins[5] >= 0) doc.page.footerDistance = margins[5];

  // Corpo del testo
  let body = docId !== undefined ? pkg.refId(first(docFs, 4)) : undefined;
  if (body === undefined || pkg.type(body) !== 2001) {
    body = undefined;
    let best = -1;
    for (const id of pkg.allOfType(2001)) {
      const fs = pkg.f(id);
      if (num(fs, 1, 0) !== 0) continue;
      const len = all(fs, 3).map(str).join("").length;
      if (len > best) { best = len; body = id; }
    }
  }
  if (body === undefined) throw new Error("Il documento Pages non contiene testo riconoscibile");

  doc.blocks = storageToBlocks(ctx, body, true);
  if (!doc.blocks.some((b) => b.type === "p")) doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  return doc;
}
