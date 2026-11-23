// Tabelle di iWork (TST.*): le celle stanno in "tile" di righe, con numeri, date e testi codificati a mano.
import { all, first, float32, fields, num, str, type Field } from "./iwa";
import type { Paragraph, Table, TableCell, TableRow } from "../model";
import { findDrawable, storageToBlocks, type Ctx } from "./pages";
import type { Pkg } from "./pkg";

/** Elenco di dati (TST.DataList): chiave → stringa o riferimento a testo formattato. */
function dataList(pkg: Pkg, f: Field | undefined): { strings: Map<number, string>; rich: Map<number, number> } {
  const strings = new Map<number, string>();
  const rich = new Map<number, number>();
  const id = pkg.refId(f);
  if (id === undefined) return { strings, rich };
  for (const e of all(pkg.f(id), 3)) {
    if (!e.bytes) continue;
    const ef = fields(e.bytes);
    const key = num(ef, 1, -1);
    if (key < 0) continue;
    const s = first(ef, 3);
    if (s?.bytes) strings.set(key, str(s));
    const r = pkg.refId(first(ef, 9));
    if (r !== undefined) rich.set(key, r);
  }
  return { strings, rich };
}

/** Decimal128 in formato BID (little endian) → numero. */
export function decimal128(b: Uint8Array): number {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  const negative = (v >> 127n) === 1n;
  if (((v >> 125n) & 3n) === 3n) return NaN;
  const exponent = Number((v >> 113n) & 0x3fffn) - 6176;
  const coefficient = v & ((1n << 113n) - 1n);
  const value = Number(`${coefficient}e${exponent}`);
  return negative ? -value : value;
}

export type CellValue = { type: number; text?: string; rich?: number; number?: number; seconds?: number };

/** Legge una cella dal buffer di una riga (formato versione 5). */
export function readCell(buf: Uint8Array, at: number): CellValue | null {
  if (at + 12 > buf.length) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = buf[at + 1];
  const flags = view.getUint32(at + 8, true);
  let p = at + 12;
  const out: CellValue = { type };
  const stringId = { v: -1 }, richId = { v: -1 };
  for (let bit = 0; bit < 20; bit++) {
    const mask = 1 << bit;
    if (!(flags & mask)) continue;
    if (mask === 0x1) { if (p + 16 > buf.length) return null; out.number = decimal128(buf.subarray(p, p + 16)); p += 16; }
    else if (mask === 0x2) { out.number = view.getFloat64(p, true); p += 8; }
    else if (mask === 0x4) { out.seconds = view.getFloat64(p, true); p += 8; }
    else {
      if (p + 4 > buf.length) return null;
      const v = view.getUint32(p, true);
      if (mask === 0x8) stringId.v = v;
      if (mask === 0x10) richId.v = v;
      p += 4;
    }
  }
  out.text = stringId.v >= 0 ? String(stringId.v) : undefined;
  out.rich = richId.v >= 0 ? richId.v : undefined;
  return out;
}

const EPOCH = Date.UTC(2001, 0, 1);

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n * 1e9) / 1e9).replace(".", ",");
}

export function formatDate(sec: number): string {
  const d = new Date(EPOCH + sec * 1000);
  const p2 = (x: number) => String(x).padStart(2, "0");
  const base = `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  return d.getUTCHours() || d.getUTCMinutes() ? `${base} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` : base;
}

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export interface TableScan {
  name: string;
  rows: number;
  cols: number;
  /** Larghezza della tabella nel documento (pt), se nota. */
  width: number;
  cells: (CellValue | null)[][];
  strings: Map<number, string>;
  rich: Map<number, number>;
}

/** Legge la struttura di una tabella (TST.TableInfoArchive): dimensioni e celle grezze. */
export function scanTable(pkg: Pkg, infoId: number): TableScan | null {
  const info = pkg.f(infoId);
  const modelId = pkg.refId(first(info, 2));
  if (modelId === undefined || !pkg.has(modelId)) return null;
  const model = pkg.f(modelId);
  const rows = num(model, 6), cols = num(model, 7);
  if (!rows || !cols || rows > 100000 || cols > 1000) return null;
  const store = first(model, 4)?.bytes ? fields(first(model, 4)!.bytes!) : [];

  let width = 0;
  const geo = first(info, 1)?.bytes ? first(fields(first(info, 1)!.bytes!), 1) : undefined;
  const size = geo?.bytes ? first(fields(geo.bytes), 2) : undefined;
  if (size?.bytes) width = float32(first(fields(size.bytes), 1)) ?? 0;

  const strings = dataList(pkg, first(store, 4));
  const rich = dataList(pkg, first(store, 17));

  const cells: (CellValue | null)[][] = Array.from({ length: rows }, () => Array<CellValue | null>(cols).fill(null));
  const tilesMsg = first(store, 3)?.bytes ? fields(first(store, 3)!.bytes!) : [];
  const tileSize = num(tilesMsg, 2, 256) || 256;
  for (const t of all(tilesMsg, 1)) {
    if (!t.bytes) continue;
    const tf = fields(t.bytes);
    const tileId = num(tf, 1);
    const tileObj = pkg.refId(first(tf, 2));
    if (tileObj === undefined || !pkg.has(tileObj)) continue;
    for (const ri of all(pkg.f(tileObj), 5)) {
      if (!ri.bytes) continue;
      const rf = fields(ri.bytes);
      const row = tileId * tileSize + num(rf, 1);
      if (row >= rows) continue;
      const version = num(rf, 5, 5);
      const buf = first(rf, version >= 5 ? 6 : 3)?.bytes;
      const offs = first(rf, version >= 5 ? 7 : 4)?.bytes;
      if (!buf || !offs) continue;
      for (let c = 0; c < Math.min(cols, offs.length >> 1); c++) {
        const off = offs[c * 2] | (offs[c * 2 + 1] << 8);
        if (off === 0xffff) continue;
        cells[row][c] = readCell(buf, off);
      }
    }
  }
  return { name: str(first(model, 8)), rows, cols, width, cells, strings: strings.strings, rich: rich.rich };
}

/** Testo semplice di una cella (per i fogli di calcolo): numeri con la virgola, date come gg/mm/aaaa. */
export function cellPlain(pkg: Pkg, scan: TableScan, cell: CellValue | null): { kind: "number" | "text" | "empty"; text: string } {
  if (!cell) return { kind: "empty", text: "" };
  if (cell.type === 9 && cell.rich !== undefined) {
    const payload = scan.rich.get(cell.rich);
    const storage = payload !== undefined ? findStorage(pkg, payload) : undefined;
    const text = storage !== undefined ? all(pkg.f(storage), 3).map(str).join("").replace(/\uFFFC/g, "") : "";
    return { kind: "text", text };
  }
  if (cell.type === 3 && cell.text !== undefined) return { kind: "text", text: scan.strings.get(Number(cell.text)) ?? "" };
  if (cell.type === 5 && cell.seconds !== undefined) return { kind: "text", text: formatDate(cell.seconds) };
  if (cell.type === 7 && cell.seconds !== undefined) return { kind: "text", text: formatDuration(cell.seconds) };
  if (cell.type === 6 && cell.number !== undefined) return { kind: "text", text: cell.number ? "VERO" : "FALSO" };
  if ((cell.type === 2 || cell.type === 10) && cell.number !== undefined) return { kind: "number", text: formatNumber(cell.number) };
  if (cell.type === 8) return { kind: "text", text: "#ERRORE" };
  return { kind: "empty", text: "" };
}

function findStorage(pkg: Pkg, payload: number): number | undefined {
  return pkg.type(payload) === 2001 ? payload : findDrawable(pkg, payload, [2001], 3);
}

/** Tabella incorporata (TST.TableInfoArchive) nel modello del documento. */
export function readTableInfo(ctx: Ctx, infoId: number): Table | null {
  const { pkg, doc } = ctx;
  const scan = scanTable(pkg, infoId);
  if (!scan || scan.rows > 5000 || scan.cols > 200) return null;
  const usable = doc.page.width - doc.page.marginLeft - doc.page.marginRight;
  const totalWidth = Math.min(scan.width > 20 ? scan.width : usable, usable);

  const paragraphOf = (text: string): Paragraph => ({
    type: "p", id: doc.nextId++, props: {}, runs: text ? [{ text, props: {} }] : [],
  });

  const tableRows: TableRow[] = scan.cells.map((row) => ({
    cells: row.map((cell): TableCell => {
      let paragraphs: Paragraph[] = [];
      if (cell?.type === 9 && cell.rich !== undefined) {
        const payload = scan.rich.get(cell.rich);
        const storage = payload !== undefined ? findStorage(pkg, payload) : undefined;
        if (storage !== undefined) paragraphs = storageToBlocks(ctx, storage, false).filter((b): b is Paragraph => b.type === "p");
      } else {
        const plain = cellPlain(pkg, scan, cell);
        if (plain.text) paragraphs = plain.text.split("\n").map(paragraphOf);
      }
      if (!paragraphs.length) paragraphs = [paragraphOf("")];
      return { paragraphs, span: 1 };
    }),
  }));

  return {
    type: "table", id: doc.nextId++,
    grid: Array(scan.cols).fill(Math.floor((totalWidth / scan.cols) * 10) / 10),
    rows: tableRows,
    borders: { width: 0.5, color: "#b2b2b2" },
  };
}
