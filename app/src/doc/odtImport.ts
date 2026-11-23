// Lettura dei documenti .odt (OpenDocument Text — LibreOffice Writer) nel modello dell'editor.
import { strFromU8, unzipSync } from "fflate";
import {
  type Align, type Block, type CellBorder, type DocumentModel, type Paragraph, type ParaProps,
  type Run, type RunProps, type Table, type TableCell,
} from "./model";
import { ensureListNumbering, newDocument } from "./styles";

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml.replace(/^\uFEFF/, ""), "application/xml");
}

const kids = (el: Element | null | undefined, name?: string): Element[] =>
  el ? [...el.children].filter((c) => !name || c.localName === name) : [];
const kid = (el: Element | null | undefined, name: string): Element | undefined => kids(el, name)[0];

function getAttr(el: Element | null | undefined, localName: string): string | null {
  if (!el) return null;
  for (const a of [...el.attributes]) {
    if (a.localName === localName) return a.value;
  }
  return null;
}

function parseLenPt(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(-?[0-9.]+)\s*(pt|cm|mm|in|px)$/i.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (Number.isNaN(n)) return undefined;
  switch (m[2].toLowerCase()) {
    case "pt": return n;
    case "cm": return n * 28.3465;
    case "mm": return n * 2.83465;
    case "in": return n * 72;
    case "px": return n * 0.75;
    default: return undefined;
  }
}

function parseColor(v: string | null | undefined): string | undefined {
  if (!v || v === "transparent" || v === "none") return undefined;
  if (/^#[0-9a-fA-F]{6}$/.test(v.trim())) return v.trim().toLowerCase();
  return undefined;
}

function parseBorder(v: string | null | undefined): CellBorder | null | undefined {
  if (!v) return undefined;
  if (v.trim() === "none") return null;
  const parts = v.trim().split(/\s+/);
  const w = parseLenPt(parts[0]) ?? 0.5;
  const style = parts[1] === "dashed" ? "dashed" : parts[1] === "dotted" ? "dotted" : parts[1] === "double" ? "double" : "single";
  const color = parseColor(parts[2]) ?? "#000000";
  return { width: Math.max(0.25, w), color, style };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

interface OdtStyle {
  parent?: string;
  para: ParaProps;
  run: RunProps;
  colWidth?: number;
  cellBorder?: Partial<Record<"top" | "bottom" | "left" | "right", CellBorder | null>>;
  cellBg?: string;
  vAlign?: TableCell["vAlign"];
}

interface OdtCtx {
  doc: DocumentModel;
  files: Record<string, Uint8Array>;
  styles: Map<string, OdtStyle>;
  listKinds: Map<string, "bullet" | "number">;
}

function readStyleElement(el: Element): OdtStyle {
  const st: OdtStyle = { parent: getAttr(el, "parent-style-name") ?? undefined, para: {}, run: {} };
  const tp = kid(el, "text-properties");
  if (tp) {
    const font = getAttr(tp, "font-name") ?? getAttr(tp, "font-family")?.replace(/^['"]|['"]$/g, "");
    if (font) st.run.font = font;
    const sz = parseLenPt(getAttr(tp, "font-size"));
    if (sz && sz > 0) st.run.size = sz;
    const fw = getAttr(tp, "font-weight");
    if (fw === "bold" || (fw && Number(fw) >= 600)) st.run.bold = true;
    else if (fw === "normal") st.run.bold = false;
    const fs = getAttr(tp, "font-style");
    if (fs === "italic" || fs === "oblique") st.run.italic = true;
    else if (fs === "normal") st.run.italic = false;
    const ul = getAttr(tp, "text-underline-style");
    if (ul && ul !== "none") st.run.underline = true;
    else if (ul === "none") st.run.underline = false;
    const lt = getAttr(tp, "text-line-through-style");
    if (lt && lt !== "none") st.run.strike = true;
    else if (lt === "none") st.run.strike = false;
    const col = parseColor(getAttr(tp, "color"));
    if (col) st.run.color = col;
    const bg = parseColor(getAttr(tp, "background-color"));
    if (bg && bg !== "#ffffff") st.run.highlight = bg;
    const pos = getAttr(tp, "text-position");
    if (pos) {
      if (pos.startsWith("super") || /^[1-9]/.test(pos)) st.run.vertAlign = "superscript";
      else if (pos.startsWith("sub") || /^-/.test(pos)) st.run.vertAlign = "subscript";
    }
  }
  const pp = kid(el, "paragraph-properties");
  if (pp) {
    const ta = getAttr(pp, "text-align");
    const alignMap: Record<string, Align> = { start: "left", left: "left", center: "center", end: "right", right: "right", justify: "justify" };
    if (ta && alignMap[ta]) st.para.align = alignMap[ta];
    const ml = parseLenPt(getAttr(pp, "margin-left")); if (ml !== undefined) st.para.indentLeft = Math.max(0, ml);
    const mr = parseLenPt(getAttr(pp, "margin-right")); if (mr !== undefined) st.para.indentRight = Math.max(0, mr);
    const ti = parseLenPt(getAttr(pp, "text-indent")); if (ti !== undefined) st.para.firstLine = ti;
    const mt = parseLenPt(getAttr(pp, "margin-top")); if (mt !== undefined) st.para.spaceBefore = Math.max(0, mt);
    const mb = parseLenPt(getAttr(pp, "margin-bottom")); if (mb !== undefined) st.para.spaceAfter = Math.max(0, mb);
    const lh = getAttr(pp, "line-height");
    if (lh) {
      if (lh.endsWith("%")) { const pct = Number(lh.slice(0, -1)); if (pct > 0) { st.para.line = pct / 100; st.para.lineRule = "auto"; } }
      else { const pt = parseLenPt(lh); if (pt && pt > 0) { st.para.line = pt; st.para.lineRule = "atLeast"; } }
    }
    const bg = parseColor(getAttr(pp, "background-color"));
    if (bg && bg !== "#ffffff") st.para.shading = bg;
    if (getAttr(pp, "break-before") === "page") st.para.pageBreakBefore = true;
    if (getAttr(pp, "keep-with-next") === "always") st.para.keepNext = true;
  }
  const cp = kid(el, "table-column-properties");
  if (cp) {
    const cw = parseLenPt(getAttr(cp, "column-width"));
    if (cw && cw > 0) st.colWidth = cw;
  }
  const tcp = kid(el, "table-cell-properties");
  if (tcp) {
    const all = parseBorder(getAttr(tcp, "border"));
    const borders: Partial<Record<"top" | "bottom" | "left" | "right", CellBorder | null>> = {};
    if (all !== undefined) { borders.top = all; borders.bottom = all; borders.left = all; borders.right = all; }
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const b = parseBorder(getAttr(tcp, `border-${side}`));
      if (b !== undefined) borders[side] = b;
    }
    if (Object.keys(borders).length) st.cellBorder = borders;
    const bg = parseColor(getAttr(tcp, "background-color"));
    if (bg && bg !== "#ffffff") st.cellBg = bg;
    const va = getAttr(tcp, "vertical-align");
    if (va === "middle") st.vAlign = "center";
    else if (va === "bottom") st.vAlign = "bottom";
    else if (va === "top") st.vAlign = "top";
  }
  return st;
}

function collectStyles(ctx: OdtCtx, xml: Document): void {
  for (const el of xml.getElementsByTagName("*")) {
    if (el.localName === "style") {
      const name = getAttr(el, "name");
      if (name) ctx.styles.set(name, readStyleElement(el));
    } else if (el.localName === "list-style") {
      const name = getAttr(el, "name");
      if (name) {
        const first = kids(el)[0];
        ctx.listKinds.set(name, first?.localName === "list-level-style-number" ? "number" : "bullet");
      }
    } else if (el.localName === "page-layout-properties") {
      const w = parseLenPt(getAttr(el, "page-width"));
      const h = parseLenPt(getAttr(el, "page-height"));
      if (w && h) { ctx.doc.page.width = w; ctx.doc.page.height = h; }
      const mt = parseLenPt(getAttr(el, "margin-top")); if (mt !== undefined) ctx.doc.page.marginTop = Math.max(0, mt);
      const mb = parseLenPt(getAttr(el, "margin-bottom")); if (mb !== undefined) ctx.doc.page.marginBottom = Math.max(0, mb);
      const ml = parseLenPt(getAttr(el, "margin-left")); if (ml !== undefined) ctx.doc.page.marginLeft = Math.max(0, ml);
      const mr = parseLenPt(getAttr(el, "margin-right")); if (mr !== undefined) ctx.doc.page.marginRight = Math.max(0, mr);
    }
  }
}

function resolveStyle(ctx: OdtCtx, name: string | null): { para: ParaProps; run: RunProps } {
  const chain: OdtStyle[] = [];
  const seen = new Set<string>();
  let cur = name ?? undefined;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const st = ctx.styles.get(cur);
    if (!st) break;
    chain.unshift(st);
    cur = st.parent;
  }
  const para: ParaProps = {}, run: RunProps = {};
  for (const s of chain) {
    Object.assign(para, s.para);
    Object.assign(run, s.run);
  }
  return { para, run };
}

function readInline(ctx: OdtCtx, node: Node, inherited: RunProps, out: Run[]): void {
  const push = (text: string, props: RunProps) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type !== "image" && last.type !== "field" && JSON.stringify(last.props) === JSON.stringify(props)) last.text += text;
    else out.push({ text, props: { ...props } });
  };
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) {
      push(child.textContent ?? "", inherited);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    switch (el.localName) {
      case "span": {
        const st = resolveStyle(ctx, getAttr(el, "style-name"));
        readInline(ctx, el, { ...inherited, ...st.run }, out);
        break;
      }
      case "a": {
        const href = getAttr(el, "href") ?? undefined;
        readInline(ctx, el, href ? { ...inherited, link: href } : inherited, out);
        break;
      }
      case "s": {
        const count = Number(getAttr(el, "c") ?? "1") || 1;
        push(" ".repeat(count), inherited);
        break;
      }
      case "tab": push("\t", inherited); break;
      case "line-break": push("\u000b", inherited); break;
      case "page-number": out.push({ type: "field", field: "PAGE", props: { ...inherited } }); break;
      case "page-count": out.push({ type: "field", field: "NUMPAGES", props: { ...inherited } }); break;
      case "frame": {
        const imgEl = kid(el, "image");
        const href = getAttr(imgEl, "href");
        if (href && ctx.files[href]) {
          const ext = (href.split(".").pop() ?? "png").toLowerCase();
          const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : ext === "webp" ? "image/webp" : "image/png";
          const width = parseLenPt(getAttr(el, "width")) ?? 144;
          const height = parseLenPt(getAttr(el, "height")) ?? 108;
          out.push({ type: "image", src: `data:${mime};base64,${toBase64(ctx.files[href])}`, mime, width, height, alt: getAttr(el, "name") ?? "", props: {} });
        } else {
          // Casella di testo (draw:text-box)
          const tb = kid(el, "text-box");
          if (tb) {
            kids(tb, "p").forEach((tp, idx) => {
              if (idx > 0) push("\u000b", inherited);
              readInline(ctx, tp, inherited, out);
            });
          }
        }
        break;
      }
      case "note": {
        // Nota a piè di pagina inline: la riportiamo tra parentesi per non perdere testo.
        const body = kid(el, "note-body");
        if (body?.textContent?.trim()) push(` (${body.textContent.trim()})`, { ...inherited, size: Math.max(8, (inherited.size ?? 11) - 2) });
        break;
      }
      default:
        readInline(ctx, el, inherited, out);
        break;
    }
  }
}

function readParagraph(ctx: OdtCtx, el: Element, list?: { numId: number; level: number }): Paragraph {
  const st = resolveStyle(ctx, getAttr(el, "style-name"));
  const props: ParaProps = { ...st.para };
  if (el.localName === "h") {
    const lvl = Math.min(6, Math.max(1, Number(getAttr(el, "outline-level") ?? "1") || 1));
    props.style = `Heading${lvl}`;
    props.outlineLevel = lvl - 1;
  }
  if (list) {
    props.numId = list.numId;
    props.numLevel = Math.min(8, list.level);
  }
  const runs: Run[] = [];
  readInline(ctx, el, st.run, runs);
  return { type: "p", id: ctx.doc.nextId++, props, runs };
}

function readTable(ctx: OdtCtx, el: Element): Table {
  const grid: number[] = [];
  for (const col of kids(el, "table-column")) {
    const rep = Math.max(1, Number(getAttr(col, "number-columns-repeated") ?? "1") || 1);
    const st = ctx.styles.get(getAttr(col, "style-name") ?? "");
    const w = st?.colWidth ?? 0;
    for (let i = 0; i < Math.min(rep, 64); i++) grid.push(w);
  }
  const rows: Table["rows"] = [];
  const collectRows = (container: Element) => {
    for (const c of kids(container)) {
      if (c.localName === "table-header-rows") {
        for (const tr of kids(c, "table-row")) rows.push(readRow(ctx, tr, true));
      } else if (c.localName === "table-row") {
        rows.push(readRow(ctx, c, false));
      }
    }
  };
  collectRows(el);
  const cols = Math.max(1, ...rows.map((r) => r.cells.reduce((n, c) => n + c.span, 0)));
  const avail = Math.max(200, ctx.doc.page.width - ctx.doc.page.marginLeft - ctx.doc.page.marginRight);
  const fallback = Math.max(36, avail / cols);
  const finalGrid = Array.from({ length: cols }, (_, i) => (grid[i] && grid[i] > 0 ? grid[i] : fallback));
  return { type: "table", id: ctx.doc.nextId++, grid: finalGrid, rows, borders: { width: 0.5, color: "#000000", style: "single" }, align: "left" };
}

function readRow(ctx: OdtCtx, tr: Element, header: boolean): Table["rows"][number] {
  const cells: TableCell[] = [];
  for (const c of kids(tr)) {
    if (c.localName === "covered-table-cell") {
      // Cella coperta da unione verticale/orizzontale
      continue;
    }
    if (c.localName !== "table-cell") continue;
    const span = Math.max(1, Number(getAttr(c, "number-columns-spanned") ?? "1") || 1);
    const st = ctx.styles.get(getAttr(c, "style-name") ?? "");
    const paragraphs: Paragraph[] = [];
    for (const child of kids(c)) {
      if (child.localName === "p" || child.localName === "h") paragraphs.push(readParagraph(ctx, child));
      else if (child.localName === "list") readList(ctx, child, 0, paragraphs);
    }
    if (!paragraphs.length) paragraphs.push({ type: "p", id: ctx.doc.nextId++, props: {}, runs: [] });
    cells.push({
      span,
      shading: st?.cellBg,
      vAlign: st?.vAlign,
      borders: st?.cellBorder,
      paragraphs,
    });
  }
  return { cells, header };
}

function readList(ctx: OdtCtx, listEl: Element, level: number, out: Block[], inheritedNumId?: number): void {
  const styleName = getAttr(listEl, "style-name");
  const kind = (styleName ? ctx.listKinds.get(styleName) : undefined) ?? "bullet";
  const numId = inheritedNumId ?? ensureListNumbering(ctx.doc, kind);
  for (const item of kids(listEl, "list-item")) {
    for (const c of kids(item)) {
      if (c.localName === "p" || c.localName === "h") out.push(readParagraph(ctx, c, { numId, level }));
      else if (c.localName === "list") readList(ctx, c, level + 1, out, numId);
    }
  }
}

function readBlocks(ctx: OdtCtx, container: Element, out: Block[]): void {
  for (const c of kids(container)) {
    if (c.localName === "p" || c.localName === "h") out.push(readParagraph(ctx, c));
    else if (c.localName === "list") readList(ctx, c, 0, out);
    else if (c.localName === "table") out.push(readTable(ctx, c));
    else if (c.localName === "section") readBlocks(ctx, c, out);
  }
}

/** Legge un file .odt (OpenDocument Text) nel modello dell'editor. */
export function importOdt(bytes: Uint8Array): DocumentModel {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error("Il file non è un documento .odt valido (archivio danneggiato)"); }
  const contentBytes = files["content.xml"];
  if (!contentBytes) throw new Error("Il file .odt non contiene content.xml");

  const doc = newDocument();
  doc.blocks = [];
  const ctx: OdtCtx = { doc, files, styles: new Map(), listKinds: new Map() };

  if (files["styles.xml"]) {
    const stylesXml = parse(strFromU8(files["styles.xml"]));
    collectStyles(ctx, stylesXml);
    const hdr = [...stylesXml.getElementsByTagName("*")].find((e) => e.localName === "header");
    const ftr = [...stylesXml.getElementsByTagName("*")].find((e) => e.localName === "footer");
    if (hdr) {
      const b: Block[] = [];
      readBlocks(ctx, hdr, b);
      doc.header = b.filter((x): x is Paragraph => x.type === "p");
    }
    if (ftr) {
      const b: Block[] = [];
      readBlocks(ctx, ftr, b);
      doc.footer = b.filter((x): x is Paragraph => x.type === "p");
    }
  }

  const contentXml = parse(strFromU8(contentBytes));
  if (contentXml.getElementsByTagName("parsererror").length) throw new Error("Il file .odt contiene XML non valido");
  collectStyles(ctx, contentXml);
  const textEl = [...contentXml.getElementsByTagName("*")].find((e) => e.localName === "text");
  if (!textEl) throw new Error("Il documento .odt è vuoto o non valido");
  readBlocks(ctx, textEl, doc.blocks);

  // Adattamento immagini più larghe della pagina
  const maxImgW = Math.max(100, doc.page.width - doc.page.marginLeft - doc.page.marginRight);
  for (const b of doc.blocks) {
    if (b.type === "p") {
      for (const r of b.runs) if (r.type === "image" && r.width > maxImgW) { const s = maxImgW / r.width; r.width *= s; r.height *= s; }
    }
  }
  if (!doc.blocks.some((b) => b.type === "p")) doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  if (doc.blocks[doc.blocks.length - 1].type !== "p") doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  return doc;
}
