// Markdown (CommonMark + GFM) ⇄ modello del documento.
// La lettura usa il parser `marked` (solo per ottenere i token); la conversione da e verso il modello è qui.
// Ciò che il Markdown non sa esprimere (colori, font, dimensioni, allineamento, intestazioni di pagina…)
// non si salva: `markdownLosses` lo elenca così l'utente viene avvisato prima.
import { marked } from "marked";
import {
  allParagraphs, isAtomic, normalizeRuns, type DocumentModel, type ImageRun, type NumberingDef, type Paragraph, type ParaProps,
  type Run, type RunProps, type StyleDef, type Table, type TableCell,
} from "./model";
import { effectivePara, ensureListNumbering, ensureMarkdownStyles, newDocument, paragraphRunProps } from "./styles";
import { extFromMime, fromBase64, imageSize, mimeFromName, toBase64 } from "./imageSize";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type T = { type: string; [k: string]: any };

const MONO = "Consolas";
const MONO_RE = /^(consolas|courier|monaco|menlo|liberation mono|dejavu sans mono|monospace|fira (code|mono)|source code pro|jetbrains mono|ubuntu mono|cascadia)/i;
const CODE_BG = "#f0f0f0";
const QUOTE_STEP = 18;

// ---------- utilità ----------

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  laquo: "«", raquo: "»", euro: "€", rarr: "→", larr: "←", middot: "·", bull: "•", deg: "°", times: "×", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m; } catch { return m; }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const textWidth = (doc: DocumentModel) => doc.page.width - doc.page.marginLeft - doc.page.marginRight;

function newNumbering(doc: DocumentModel, kind: "bullet" | "number", start: number): number {
  const base = ensureListNumbering(doc, kind === "number" ? "number" : "bullet");
  if (kind === "bullet") return base;
  const id = Math.max(0, ...Object.keys(doc.numbering).map(Number)) + 1;
  const def: NumberingDef = structuredClone(doc.numbering[base]);
  def.id = id;
  delete (def as NumberingDef & { builtin?: boolean }).builtin;
  def.levels[0].start = Math.max(0, start);
  doc.numbering[id] = def;
  return id;
}

// ---------- stile in HTML (colori, font, allineamento…) ----------
// Il Markdown non ha sintassi per colori o allineamenti: si usano i frammenti HTML che quasi tutti i programmi capiscono
// (<span style>, <div align>), e qui si rileggono.

const COLOR_NAMES: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", navy: "#000080", teal: "#008080", maroon: "#800000", lime: "#00ff00", aqua: "#00ffff", fuchsia: "#ff00ff", pink: "#ffc0cb",
};

function cssMap(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (style ?? "").split(";")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

function tagAttr(tag: string, name: string): string | undefined {
  const m = new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? "") : undefined;
}

function cssColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  v = v.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(v);
  if (short) return "#" + [...short[1]].map((c) => c + c).join("");
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (rgb) return "#" + [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
  return COLOR_NAMES[v];
}

/** Lunghezza CSS → punti. */
function cssPt(v: string | undefined): number | undefined {
  const m = /^(-?[\d.]+)\s*(pt|px|cm|mm|in|em|rem)?$/i.exec((v ?? "").trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "px").toLowerCase();
  return n * ({ pt: 1, px: 0.75, cm: 28.3465, mm: 2.83465, in: 72, em: 12, rem: 12 } as Record<string, number>)[unit];
}

function runPropsFromCss(css: Record<string, string>): RunProps {
  const p: RunProps = {};
  const color = cssColor(css.color); if (color) p.color = color;
  const size = cssPt(css["font-size"]); if (size) p.size = Math.round(size * 2) / 2;
  const fam = css["font-family"]?.split(",")[0].replace(/["']/g, "").trim();
  if (fam) p.font = /^monospace$/i.test(fam) ? MONO : fam;
  const bg = cssColor(css["background-color"] ?? css.background); if (bg) p.highlight = bg;
  if (/^(bold|[6-9]00)$/.test(css["font-weight"] ?? "")) p.bold = true;
  if (/italic/.test(css["font-style"] ?? "")) p.italic = true;
  if (/underline/.test(css["text-decoration"] ?? "")) p.underline = true;
  if (/line-through/.test(css["text-decoration"] ?? "")) p.strike = true;
  return p;
}

/** Proprietà di paragrafo da un <div>/<p>: attributo align, style e data-style (nome dello stile). */
function paraPropsFromTag(tag: string): ParaProps {
  const css = cssMap(tagAttr(tag, "style"));
  const out: ParaProps = {};
  const align = (css["text-align"] ?? tagAttr(tag, "align") ?? "").toLowerCase();
  if (align === "left" || align === "center" || align === "right" || align === "justify") out.align = align;
  const set = <K extends keyof ParaProps>(k: K, v: ParaProps[K] | undefined) => { if (v !== undefined) out[k] = v; };
  set("indentLeft", cssPt(css["margin-left"]));
  set("indentRight", cssPt(css["margin-right"]));
  set("firstLine", cssPt(css["text-indent"]));
  set("spaceBefore", cssPt(css["margin-top"]));
  set("spaceAfter", cssPt(css["margin-bottom"]));
  const lh = css["line-height"];
  if (lh && /^[\d.]+$/.test(lh)) { out.line = parseFloat(lh); out.lineRule = "auto"; }
  set("shading", cssColor(css["background-color"] ?? css.background));
  const style = tagAttr(tag, "data-style");
  if (style) out.style = style;
  if (/^<\s*center\b/i.test(tag)) out.align = "center";
  return out;
}

// ---------- immagini ----------

const placeholder = (label: string) => "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="64"><rect width="160" height="64" fill="#f3f4f6" stroke="#9ca3af"/>` +
  `<text x="80" y="37" font-size="12" text-anchor="middle" fill="#6b7280" font-family="sans-serif">${label}</text></svg>`);
const PLACEHOLDER = placeholder("immagine non trovata");
const PLACEHOLDER_REMOTE = placeholder("immagine online");

function fit(doc: DocumentModel, wPx: number, hPx: number): { width: number; height: number } {
  let w = wPx * 0.75, h = hPx * 0.75;
  const max = textWidth(doc);
  if (w > max) { h = (h * max) / w; w = max; }
  return { width: Math.max(8, w), height: Math.max(8, h) };
}

function makeImage(doc: DocumentModel, href: string, alt: string, props: RunProps): Run {
  // Le immagini online non si scaricano (niente rete, niente tracciamento): restano un riquadro e si riscrive il riferimento com'era.
  if (/^(https?:|ftp:|\/\/)/i.test(href)) return { type: "image", src: PLACEHOLDER_REMOTE, mime: "image/svg+xml", width: 120, height: 48, alt, srcPath: href, missing: true, props };
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(href);
  if (m) {
    let bytes: Uint8Array | null = null;
    try { bytes = m[2] ? fromBase64(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])); } catch { bytes = null; }
    const mime = m[1] || "image/png";
    const size = bytes ? imageSize(bytes) : null;
    return { type: "image", src: href, mime, ...(size ? fit(doc, size.w, size.h) : { width: 150, height: 112 }), alt, props };
  }
  // File accanto al documento: lo legge `loadMarkdownImages` dopo l'apertura.
  return { type: "image", src: href, mime: mimeFromName(href), width: 96, height: 96, alt, srcPath: href, props };
}

function htmlImage(doc: DocumentModel, tag: string, props: RunProps): Run | null {
  const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  if (!src) return null;
  const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const run = makeImage(doc, decodeEntities(src[1] ?? src[2] ?? ""), decodeEntities(alt?.[1] ?? alt?.[2] ?? ""), props);
  const w = /\bwidth\s*=\s*["']?(\d+)/i.exec(tag);
  const hh = /\bheight\s*=\s*["']?(\d+)/i.exec(tag);
  if (w && run.type === "image") {
    const ratio = hh ? (parseInt(hh[1], 10) / parseInt(w[1], 10)) : run.height / run.width;
    run.width = Math.min(textWidth(doc), parseInt(w[1], 10) * 0.75);
    run.height = run.width * ratio;
  }
  return run;
}

// ---------- lettura ----------

interface Ctx { doc: DocumentModel; wrap: ParaProps[] }
const wrapProps = (ctx: Ctx): ParaProps => Object.assign({}, ...ctx.wrap);

const HTML_FORMAT: Record<string, Partial<RunProps>> = {
  u: { underline: true }, ins: { underline: true }, sup: { vertAlign: "superscript" }, sub: { vertAlign: "subscript" },
  b: { bold: true }, strong: { bold: true }, i: { italic: true }, em: { italic: true }, s: { strike: true }, del: { strike: true }, strike: { strike: true },
  mark: { highlight: "#fff59d" }, kbd: { font: MONO, highlight: CODE_BG }, code: { font: MONO, highlight: CODE_BG },
};

function inline(ctx: Ctx, tokens: T[] | undefined, base: RunProps, out: Run[]): void {
  let cur: RunProps = base;
  const stack: { tag: string; prev: RunProps }[] = []; // tag HTML aperti (<span style>, <u>…): alla chiusura si torna alle proprietà di prima
  let lineStart = false; // subito dopo un a capo forzato: gli spazi iniziali della riga non contano
  const push = (text: string, props: RunProps) => {
    if (lineStart) text = text.replace(/^[ \t]+/, "");
    if (!text) return;
    lineStart = false;
    out.push({ text, props: { ...props } });
  };
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text":
      case "escape":
        if (t.tokens?.length) inline(ctx, t.tokens, cur, out);
        else push(t.type === "escape" ? t.text : decodeEntities(String(t.text)).replace(/[ \t]*\n[ \t]*/g, " "), cur);
        break;
      case "strong": inline(ctx, t.tokens, { ...cur, bold: true }, out); break;
      case "em": inline(ctx, t.tokens, { ...cur, italic: true }, out); break;
      case "del": inline(ctx, t.tokens, { ...cur, strike: true }, out); break;
      case "codespan": push(String(t.text), { ...cur, font: MONO, highlight: CODE_BG }); break;
      case "br": push("\n", cur); lineStart = true; break;
      case "link": {
        const href = decodeEntities(String(t.href ?? ""));
        const before = out.length;
        inline(ctx, t.tokens, href ? { ...cur, link: href } : cur, out);
        if (out.length === before && t.text) push(decodeEntities(String(t.text)), href ? { ...cur, link: href } : cur);
        break;
      }
      case "image": out.push(makeImage(ctx.doc, decodeEntities(String(t.href ?? "")), decodeEntities(String(t.text ?? "")), cur)); lineStart = false; break;
      case "html": {
        const tag = String(t.text);
        const name = /^<\s*(\/?)\s*([a-z][a-z0-9]*)/i.exec(tag);
        if (/^<!--/.test(tag) || !name) break;
        const tagName = name[2].toLowerCase();
        if (tagName === "br") { push("\n", cur); lineStart = true; }
        else if (tagName === "img") { const im = htmlImage(ctx.doc, tag, cur); if (im) { out.push(im); lineStart = false; } }
        else if (name[1]) {
          const at = stack.map((x) => x.tag).lastIndexOf(tagName);
          if (at >= 0) { cur = stack[at].prev; stack.length = at; }
        } else if (tagName === "span" || HTML_FORMAT[tagName]) {
          if (!/\/\s*>$/.test(tag)) stack.push({ tag: tagName, prev: cur });
          cur = { ...cur, ...(tagName === "span" ? runPropsFromCss(cssMap(tagAttr(tag, "style"))) : HTML_FORMAT[tagName]) };
        }
        break;
      }
      default:
        if (t.tokens?.length) inline(ctx, t.tokens, cur, out);
        else if (t.text) push(decodeEntities(String(t.text)), cur);
    }
  }
}

function runsOf(ctx: Ctx, tokens: T[] | undefined, base: RunProps = {}): Run[] {
  const out: Run[] = [];
  inline(ctx, tokens, base, out);
  return out;
}

function para(ctx: Ctx, props: ParaProps, runs: Run[], trim = true): Paragraph {
  const p: Paragraph = { type: "p", id: ctx.doc.nextId++, props, runs };
  normalizeRuns(p);
  if (trim) {
    // Come fa CommonMark: spazi e a capo a inizio/fine paragrafo non contano.
    const first = p.runs[0], last = p.runs[p.runs.length - 1];
    if (first && !isAtomic(first)) first.text = first.text.replace(/^\s+/, "");
    if (last && !isAtomic(last)) last.text = last.text.replace(/\s+$/, "");
    normalizeRuns(p);
  }
  return p;
}

function addTable(ctx: Ctx, t: T): void {
  const { doc } = ctx;
  const cols = (t.header as T[]).length;
  const alignOf = (a: string | null | undefined): ParaProps => (a === "center" || a === "right" ? { align: a } : {});
  const cell = (c: T, header: boolean): TableCell => {
    let runs = runsOf(ctx, c.tokens);
    if (header) runs = runs.map((r) => (isAtomic(r) ? r : { ...r, props: { ...r.props, bold: true } }));
    return { span: 1, ...(header ? { shading: "#f3f4f6" } : {}), paragraphs: [para(ctx, alignOf(c.align), runs)] };
  };
  const rows: Table["rows"] = [{ header: true, cells: (t.header as T[]).map((c) => cell(c, true)) }];
  for (const r of t.rows as T[][]) {
    const cells = r.slice(0, cols).map((c) => cell(c, false));
    while (cells.length < cols) cells.push({ span: 1, paragraphs: [para(ctx, {}, [])] });
    rows.push({ cells });
  }
  const w = textWidth(doc);
  doc.blocks.push({
    type: "table", id: doc.nextId++, grid: Array.from({ length: cols }, () => Math.max(40, w / cols)), rows,
    borders: { width: 0.5, color: "#9ca3af", style: "single" }, align: "left",
  });
}

function addList(ctx: Ctx, list: T, level: number, parentNumId: number | undefined, parentOrdered: boolean): void {
  const { doc } = ctx;
  const ordered = !!list.ordered;
  const numId = ordered
    ? (level > 0 && parentOrdered && parentNumId !== undefined ? parentNumId : newNumbering(doc, "number", typeof list.start === "number" ? list.start : 1))
    : newNumbering(doc, "bullet", 1);
  const lvl = Math.min(8, level);
  for (const item of list.items as T[]) {
    let pushed = false;
    const prefix = item.task ? (item.checked ? "☑ " : "☐ ") : "";
    const itemPara = (runs: Run[]) => {
      pushed = true;
      if (prefix) runs.unshift({ text: prefix, props: {} });
      doc.blocks.push(para(ctx, { numId, numLevel: lvl }, runs));
    };
    for (const tk of item.tokens as T[]) {
      if (tk.type === "space" || tk.type === "checkbox") continue;
      if ((tk.type === "text" || tk.type === "paragraph") && !pushed) {
        itemPara(runsOf(ctx, tk.tokens ?? [{ type: "text", text: tk.text }]));
      } else if (tk.type === "list") {
        if (!pushed) itemPara([]);
        addList(ctx, tk, level + 1, numId, ordered);
      } else if (tk.type === "text" || tk.type === "paragraph") {
        doc.blocks.push(para(ctx, { indentLeft: doc.numbering[numId]?.levels[lvl]?.indentLeft ?? 36 }, runsOf(ctx, tk.tokens ?? [{ type: "text", text: tk.text }])));
      } else {
        if (!pushed) itemPara([]);
        addBlocks(ctx, [tk], 0);
        // Un blocco di codice dentro la voce resta agganciato all'elenco: ha lo stesso rientro del testo della voce.
        const last = doc.blocks[doc.blocks.length - 1];
        if (tk.type === "code" && last?.type === "p" && last.props.style === "CodeBlock") last.props.indentLeft = doc.numbering[numId]?.levels[lvl]?.indentLeft ?? 36;
      }
    }
    if (!pushed) itemPara([]);
  }
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
}

function addBlocks(ctx: Ctx, tokens: T[], quote: number): void {
  const { doc } = ctx;
  const pprops = (): ParaProps => (quote ? { style: "BlockQuote", ...(quote > 1 ? { indentLeft: QUOTE_STEP * quote } : {}) } : {});
  for (const t of tokens) {
    switch (t.type) {
      case "space": break;
      case "heading": doc.blocks.push(para(ctx, { style: `Heading${Math.min(6, t.depth)}`, ...wrapProps(ctx) }, runsOf(ctx, t.tokens))); break;
      case "paragraph":
      case "text": doc.blocks.push(para(ctx, { ...pprops(), ...wrapProps(ctx) }, runsOf(ctx, t.tokens ?? [{ type: "text", text: t.text }]))); break;
      case "code": {
        const text = String(t.text).replace(/\n+$/, "");
        doc.blocks.push(para(ctx, { style: "CodeBlock", ...(t.lang ? { codeLang: String(t.lang).split(/\s+/)[0] } : {}) }, text ? [{ text, props: {} }] : [], false));
        break;
      }
      case "blockquote": addBlocks(ctx, t.tokens ?? [], quote + 1); break;
      case "hr": { const p = para(ctx, { style: "Rule" }, []); p.markProps = { size: 1 }; doc.blocks.push(p); break; }
      case "list": addList(ctx, t, 0, undefined, false); break;
      case "table": addTable(ctx, t); break;
      case "html": {
        const html = String(t.text);
        if (/^\s*<!--[\s\S]*-->\s*$/.test(html)) break;
        // <div align="center"> … </div> con righe vuote dentro: il contenuto è Markdown normale che eredita l'allineamento ecc.
        if (/^\s*<(div|p|section|center)\b[^>]*>\s*$/i.test(html)) { ctx.wrap.push(paraPropsFromTag(html.trim())); break; }
        if (/^\s*<\/(div|p|section|center)\s*>\s*$/i.test(html)) { ctx.wrap.pop(); break; }
        let props: ParaProps = { ...pprops(), ...wrapProps(ctx) };
        let inner = html;
        const h = /^\s*<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1\s*>\s*$/i.exec(html);
        const box = /^\s*<(div|p|center)\b([^>]*)>([\s\S]*)<\/\1\s*>\s*$/i.exec(html);
        if (h) { props = { ...props, style: `Heading${h[1]}`, ...paraPropsFromTag(`<h ${h[2]}>`) }; inner = h[3]; }
        else if (box) { props = { ...props, ...paraPropsFromTag(`<${box[1]} ${box[2]}>`) }; inner = box[3]; }
        const runs: Run[] = [];
        for (const piece of inner.replace(/<br\s*\/?>/gi, "\n").split(/(<img\b[^>]*>)/i)) {
          if (/^<img\b/i.test(piece)) { const im = htmlImage(doc, piece, {}); if (im) runs.push(im); }
          else { const txt = stripHtml(piece); if (txt) runs.push({ text: txt.replace(/\n+/g, " "), props: {} }); }
        }
        if (runs.length) doc.blocks.push(para(ctx, props, runs));
        break;
      }
      default: break;
    }
  }
}

const FRONT = /^\uFEFF?---[ \t]*\n((?:[^\n]*\n)*?)(?:---|\.\.\.)[ \t]*(?:\n|$)/;

export function importMarkdown(bytes: Uint8Array): DocumentModel {
  const doc = newDocument();
  doc.blocks = [];
  ensureMarkdownStyles(doc);
  let src = decodeBytes(bytes).replace(/\r\n?/g, "\n");
  const fm = FRONT.exec(src);
  if (fm && /^[\w.\-"']+\s*:(\s|$)/m.test(fm[1].trimStart().split("\n")[0] ?? "")) {
    doc.frontMatter = fm[0].replace(/^\uFEFF/, "").trimEnd();
    src = src.slice(fm[0].length);
  }
  const meta = readMeta(src);
  if (meta) src = src.replace(META_RE, "\n");
  addBlocks({ doc, wrap: [] }, marked.lexer(src, { gfm: true }) as T[], 0);
  if (!doc.blocks.length || doc.blocks[doc.blocks.length - 1].type !== "p") doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  if (meta) applyMeta(doc, meta);
  return doc;
}

function decodeBytes(bytes: Uint8Array): string {
  const clean = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(clean); } catch { return new TextDecoder("windows-1252").decode(clean); }
}

/** Percorso di un'immagine relativo alla cartella del file .md → percorso assoluto. */
export function resolveRelative(dir: string, href: string): string {
  const clean = (() => { try { return decodeURIComponent(href.split(/[?#]/)[0]); } catch { return href.split(/[?#]/)[0]; } })();
  if (/^([a-z]:[\\/]|\/)/i.test(clean)) return clean;
  const parts = dir.split(/[\\/]/);
  for (const seg of clean.split(/[\\/]/)) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") { if (parts.length > 1) parts.pop(); } else parts.push(seg);
  }
  return parts.join("/");
}

/** Carica le immagini indicate con percorso relativo (`![](immagini/a.png)`). Restituisce quante non sono state trovate. */
export async function loadMarkdownImages(doc: DocumentModel, dir: string, read: (path: string) => Promise<Uint8Array>): Promise<number> {
  let missing = 0;
  const runs: ImageRun[] = [];
  for (const p of allParagraphs(doc.blocks)) for (const r of p.runs) if (r.type === "image" && r.srcPath && !r.src.startsWith("data:")) runs.push(r);
  await Promise.all(runs.map(async (r) => {
    try {
      const bytes = await read(resolveRelative(dir, r.srcPath!));
      const mime = mimeFromName(r.srcPath!);
      const size = imageSize(bytes);
      r.src = `data:${mime};base64,${toBase64(bytes)}`;
      r.mime = mime;
      if (size) Object.assign(r, fit(doc, size.w, size.h));
    } catch {
      missing++;
      r.src = PLACEHOLDER; r.mime = "image/svg+xml"; r.missing = true; r.width = 120; r.height = 48;
    }
  }));
  return missing;
}

// ---------- metadati di ZikOffice (commento nascosto in fondo al file) ----------
// Stili del documento, pagina, intestazioni e piè di pagina, proprietà delle tabelle: il Markdown non li ha, ma un commento HTML
// è ignorato da ogni altro programma e ZikOffice lo rilegge, così il documento si riapre identico.

const META_RE = /\n?<!--\s*zikoffice:([\s\S]*?)-->\s*$/;

/** Una cella che si discosta dalla lettura di serie (intestazione grigia, nessun bordo proprio): r = riga, c = colonna. */
interface CellMeta { r: number; c: number; s?: string | null; v?: "top" | "center" | "bottom"; b?: number }
/** `bd`: bordi di cella distinti; ogni cella rimanda a uno per posizione (`b`). */
interface TableMeta { rows: number; cols: number; grid: number[]; borders: Table["borders"] | null; align?: Table["align"]; cells?: CellMeta[]; bd?: NonNullable<TableCell["borders"]>[] }
const HEADER_SHADING = "#f3f4f6";
interface Meta {
  v: 1;
  styles?: Record<string, StyleDef>;
  page?: DocumentModel["page"];
  header?: Paragraph[];
  footer?: Paragraph[];
  defaultRun?: RunProps;
  defaultPara?: ParaProps;
  watermark?: string;
  tables?: TableMeta[];
}

const sj = (o: unknown) => JSON.stringify(o, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

function readMeta(src: string): Meta | null {
  const m = META_RE.exec(src);
  if (!m) return null;
  try {
    const meta = JSON.parse(m[1]) as Meta;
    return meta && meta.v === 1 ? meta : null;
  } catch { return null; }
}

function applyMeta(doc: DocumentModel, meta: Meta): void {
  for (const [id, st] of Object.entries(meta.styles ?? {})) doc.styles[id] = st;
  if (meta.page) Object.assign(doc.page, meta.page);
  const fresh = (list: Paragraph[] | undefined) => (list ?? []).map((p) => ({ ...p, id: doc.nextId++ }));
  if (meta.header) doc.header = fresh(meta.header);
  if (meta.footer) doc.footer = fresh(meta.footer);
  if (meta.defaultRun) doc.defaultRun = meta.defaultRun;
  if (meta.defaultPara) doc.defaultPara = meta.defaultPara;
  if (meta.watermark) doc.watermark = meta.watermark;
  const tables = doc.blocks.filter((b): b is Table => b.type === "table");
  (meta.tables ?? []).forEach((tm, i) => {
    const t = tables[i];
    // Solo se la tabella ha ancora la stessa forma (il file può essere stato modificato altrove).
    if (!t || !tm || t.rows.length !== tm.rows || t.grid.length !== tm.cols) return;
    if (tm.grid?.length === t.grid.length) t.grid = tm.grid;
    t.borders = tm.borders ?? null;
    if (tm.align) t.align = tm.align;
    for (const cm of tm.cells ?? []) {
      const cell = t.rows[cm.r]?.cells[cm.c];
      if (!cell) continue;
      if ("s" in cm) cell.shading = cm.s ?? undefined;
      if (cm.v) cell.vAlign = cm.v;
      if (cm.b !== undefined && tm.bd?.[cm.b]) cell.borders = tm.bd[cm.b];
    }
  });
}

function buildMeta(doc: DocumentModel): string | null {
  const base = newDocument();
  ensureMarkdownStyles(base);
  const meta: Meta = { v: 1 };

  // Solo gli stili usati (e quelli da cui derivano) che non sono già quelli di serie.
  const used = new Set<string>(["Normal"]);
  const note = (p: Paragraph) => { if (p.props.style) used.add(p.props.style); };
  for (const p of allParagraphs(doc.blocks)) note(p);
  [...doc.header, ...doc.footer].forEach(note);
  for (const id of [...used]) for (let st = doc.styles[id]; st?.basedOn && !used.has(st.basedOn); st = doc.styles[st.basedOn]) used.add(st.basedOn);
  const styles: Record<string, StyleDef> = {};
  for (const id of used) if (doc.styles[id] && sj(doc.styles[id]) !== sj(base.styles[id])) styles[id] = doc.styles[id];
  if (Object.keys(styles).length) meta.styles = styles;

  if (sj(doc.page) !== sj(base.page)) meta.page = doc.page;
  const noId = (list: Paragraph[]) => list.map((p) => ({ ...p, id: 0 })); // gli id non servono: si riassegnano alla lettura
  if (doc.header.length) meta.header = noId(doc.header);
  if (doc.footer.length) meta.footer = noId(doc.footer);
  if (sj(doc.defaultRun) !== sj(base.defaultRun)) meta.defaultRun = doc.defaultRun;
  if (sj(doc.defaultPara) !== sj(base.defaultPara)) meta.defaultPara = doc.defaultPara;
  if (doc.watermark) meta.watermark = doc.watermark;

  const tables: TableMeta[] = [];
  let anyTable = false;
  for (const b of doc.blocks) {
    if (b.type !== "table") continue;
    const cells: CellMeta[] = [];
    const bd: NonNullable<TableCell["borders"]>[] = [];
    const bdKeys: string[] = [];
    b.rows.forEach((row, r) => row.cells.forEach((c, ci) => {
      const def = r === 0 && row.header ? HEADER_SHADING : null;
      const cm: CellMeta = { r, c: ci };
      if ((c.shading ?? null) !== def) cm.s = c.shading ?? null;
      if (c.vAlign) cm.v = c.vAlign;
      if (c.borders) {
        const key = sj(c.borders);
        let at = bdKeys.indexOf(key);
        if (at < 0) { at = bdKeys.push(key) - 1; bd.push(c.borders); }
        cm.b = at;
      }
      if (Object.keys(cm).length > 2) cells.push(cm);
    }));
    const standard = sj(b.borders ?? null) === sj({ width: 0.5, color: "#9ca3af", style: "single" }) && new Set(b.grid.map((g) => Math.round(g))).size === 1 && (b.align ?? "left") === "left";
    if (!standard || cells.length) anyTable = true;
    tables.push({ rows: b.rows.length, cols: b.grid.length, grid: b.grid.map((g) => Math.round(g * 100) / 100), borders: b.borders ?? null, align: b.align, ...(cells.length ? { cells, bd } : {}) });
  }
  if (anyTable) meta.tables = tables; // una tabella di serie non serve ricordarla, ma l'ordine conta: si scrivono tutte o nessuna

  if (Object.keys(meta).length === 1) return null;
  // Dentro un commento HTML non può comparire "--": si scrive come escape JSON.
  return `<!-- zikoffice:${JSON.stringify(meta).replace(/--/g, "-\\u002d")} -->`;
}

// ---------- scrittura ----------

interface Refs {
  ref(run: ImageRun): string;
  /** `<img width height>` se l'immagine è stata ridimensionata rispetto all'originale; altrimenti null. */
  sized(run: ImageRun, ref: string): string | null;
}

const LETTERNUM = "\\p{L}\\p{N}";
const UNDERSCORE = new RegExp(`(?<![${LETTERNUM}])_|_(?![${LETTERNUM}])`, "gu");

function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\*/g, "\\*")
    .replace(UNDERSCORE, "\\_").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
    .replace(/<(?=[A-Za-z/!?])/g, "\\<").replace(/~~/g, "\\~\\~").replace(/&(?=#?\w+;)/g, "\\&");
}

function guardLineStart(line: string): string {
  line = line.replace(/^[ \t]+/, ""); // gli spazi a inizio riga non contano in Markdown (e quattro farebbero un blocco di codice)
  if (/^ {0,3}(#{1,6})(\s|$)/.test(line) || /^ {0,3}>/.test(line) || /^ {0,3}[-+](\s|$)/.test(line) || /^ {0,3}(-{3,}|={3,})\s*$/.test(line)) return line.replace(/^( {0,3})/, "$1\\");
  return line.replace(/^( {0,3}\d+)([.)])(\s|$)/, "$1\\$2$3");
}

function linkDest(url: string): string {
  return /[\s()]/.test(url) ? `<${url.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : url;
}

const isMono = (p: RunProps) => !!p.font && MONO_RE.test(p.font);
const fmtKey = (p: RunProps, noBold: boolean) =>
  isMono(p) ? "c" : `${p.color ?? ""}|${p.size ?? ""}|${p.font ?? ""}|${p.highlight ?? ""}|${!noBold && p.bold ? "b" : ""}${p.italic ? "i" : ""}${p.strike ? "s" : ""}${p.underline && !p.link ? "u" : ""}${p.vertAlign ?? ""}`;

const isPunct = (c: string | undefined) => !!c && /[\p{P}\p{S}]/u.test(c);
const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

function wrapText(text: string, p: RunProps, noBold: boolean, before = "", after = ""): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  if (!m[2]) return text;
  // CommonMark non riconosce **…** se dentro inizia/finisce con punteggiatura attaccata a una lettera di fuori: si usano i tag HTML.
  const css: string[] = [];
  if (!isMono(p)) {
    if (p.color) css.push(`color:${p.color}`);
    if (p.size) css.push(`font-size:${Math.round(p.size * 100) / 100}pt`);
    if (p.font) css.push(`font-family:'${p.font.replace(/['"<>&;]/g, "")}'`);
    if (p.highlight) css.push(`background-color:${p.highlight}`);
  }
  const needsTags = !css.length && !isMono(p) && (!!p.strike || (!noBold && !!p.bold) || !!p.italic) &&
    ((!m[1] && isWord(before) && isPunct(m[2][0])) || (!m[3] && isWord(after) && isPunct(m[2][m[2].length - 1])));
  let inner: string;
  if (isMono(p)) {
    const longest = Math.max(0, ...(m[2].match(/`+/g) ?? []).map((x) => x.length));
    const fence = "`".repeat(longest + 1);
    inner = `${fence}${/^`|`$/.test(m[2]) ? ` ${m[2]} ` : m[2]}${fence}`;
  } else {
    inner = esc(m[2]);
    const b = !noBold && p.bold;
    if (needsTags) {
      if (p.strike) inner = `<del>${inner}</del>`;
      if (p.italic) inner = `<em>${inner}</em>`;
      if (b) inner = `<strong>${inner}</strong>`;
    } else {
      if (p.strike) inner = `~~${inner}~~`;
      if (b && p.italic) inner = `***${inner}***`;
      else if (b) inner = `**${inner}**`;
      else if (p.italic) inner = `*${inner}*`;
    }
  }
  if (p.underline && !p.link) inner = `<u>${inner}</u>`;
  if (p.vertAlign === "superscript") inner = `<sup>${inner}</sup>`;
  else if (p.vertAlign === "subscript") inner = `<sub>${inner}</sub>`;
  // Gli spazi ai bordi restano dentro lo <span> (hanno lo stesso colore e la stessa dimensione); fuori dai simboli del Markdown.
  if (css.length) return `<span style="${css.join(";")}">${m[1]}${inner}${m[3]}</span>`;
  return m[1] + inner + m[3];
}

const altText = (s: string | undefined) => (s ?? "").replace(/[\r\n]+/g, " ").replace(/([\\[\]])/g, "\\$1");

const SAME = (a: string | number | undefined, b: string | number | undefined) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b);

function renderRuns(runs: Run[], refs: Refs, o: { noBold?: boolean; br?: string; base?: RunProps } = {}): string {
  const br = o.br ?? "\\\n";
  const noBold = !!o.noBold;
  const formatted = (list: Run[]): string => {
    type Seg = { key: string; props: RunProps; text: string; image?: ImageRun };
    const segs: Seg[] = [];
    for (const r of list) {
      if (r.type === "field") continue;
      if (r.type === "image") { segs.push({ key: "", props: r.props, text: "", image: r }); continue; }
      const text = r.text.replace(/\t/g, " ").replace(/\f/g, "");
      if (!text) continue;
      // Colore, dimensione, font ed evidenziazione si scrivono solo se diversi da quelli dello stile del paragrafo.
      const props: RunProps = { ...r.props };
      for (const k of ["color", "size", "font", "highlight"] as const) if (props[k] !== undefined && SAME(props[k], o.base?.[k])) delete props[k];
      if (props.link && SAME(props.color, "#0563C1")) delete props.color;
      const key = fmtKey(props, noBold);
      const last = segs[segs.length - 1];
      if (last && !last.image && last.key === key) last.text += text;
      else segs.push({ key, props, text });
    }
    return segs.map((s, k) => {
      if (s.image) {
        const ref = refs.ref(s.image);
        if (!ref) return "";
        return refs.sized(s.image, ref) ?? `![${altText(s.image.alt)}](${linkDest(ref)})`;
      }
      const before = segs[k - 1]?.image ? "" : segs[k - 1]?.text.slice(-1) ?? "";
      const after = segs[k + 1]?.image ? "" : segs[k + 1]?.text[0] ?? "";
      const lines = s.text.split("\n");
      return lines.map((line, n) => wrapText(line, s.props, noBold, n === 0 ? before : "", n === lines.length - 1 ? after : "")).join(br);
    }).join("");
  };
  let out = "";
  for (let i = 0; i < runs.length;) {
    const link = runs[i].props.link;
    let j = i;
    while (j < runs.length && runs[j].props.link === link) j++;
    const seg = formatted(runs.slice(i, j));
    out += link && seg.trim() ? `[${seg}](${linkDest(link)})` : seg;
    i = j;
  }
  return out;
}

function plainOf(p: Paragraph): string {
  return p.runs.map((r) => (r.type === "image" || r.type === "field" ? "" : r.text.replace(/\f/g, ""))).join("");
}

const NATIVE_STYLES = /^(Normal|Heading[1-6]|ListParagraph|CodeBlock|BlockQuote|Quote|Rule)?$/;

/** `<div …>` che porta ciò che il Markdown non sa dire di un paragrafo (allineamento, rientri, spazi, sfondo, nome dello stile). */
function paraWrapper(doc: DocumentModel, p: Paragraph): string | null {
  const d = p.props;
  const base = effectivePara(doc, { ...p, props: { style: d.style } });
  const pt = (v: number) => `${Math.round(v * 100) / 100}pt`;
  const differs = <K extends keyof ParaProps>(k: K) => d[k] !== undefined && d[k] !== base[k];
  const css: string[] = [];
  let align: string | undefined = d.align !== undefined && d.align !== base.align && !(d.align === "left" && !base.align) ? d.align : undefined;
  if (differs("indentLeft")) css.push(`margin-left:${pt(d.indentLeft!)}`);
  if (differs("indentRight")) css.push(`margin-right:${pt(d.indentRight!)}`);
  if (differs("firstLine")) css.push(`text-indent:${pt(d.firstLine!)}`);
  if (differs("spaceBefore")) css.push(`margin-top:${pt(d.spaceBefore!)}`);
  if (differs("spaceAfter")) css.push(`margin-bottom:${pt(d.spaceAfter!)}`);
  if (differs("line") && (d.lineRule ?? "auto") === "auto") css.push(`line-height:${Math.round(d.line! * 100) / 100}`);
  if (differs("shading")) css.push(`background-color:${d.shading}`);
  const dataStyle = d.style && !NATIVE_STYLES.test(d.style) ? d.style : undefined;
  if (align && !css.length) { /* basta l'attributo align */ } else if (align) { css.unshift(`text-align:${align}`); align = undefined; }
  if (!align && !css.length && !dataStyle) return null;
  const attrs = [
    dataStyle ? ` data-style="${dataStyle.replace(/[&"<>]/g, "")}"` : "",
    align ? ` align="${align}"` : "",
    css.length ? ` style="${css.join(";")}"` : "",
  ].join("");
  return `<div${attrs}>`;
}

export interface MarkdownOptions {
  /** Cartella (relativa al file .md) dove mettere le immagini; senza, le immagini restano incorporate (data URI). */
  assetDir?: string;
  /** Salvando nella stessa posizione da cui è stato aperto, le immagini con percorso originale lo mantengono. */
  keepPaths?: boolean;
}

export interface MarkdownExport {
  bytes: Uint8Array;
  /** File da scrivere accanto al documento: percorso relativo alla cartella del .md. */
  assets: { path: string; bytes: Uint8Array }[];
  /** Riferimento scritto nel testo → immagine del documento (serve a rileggere il sorgente modificato). */
  refs: Map<string, ImageRun>;
}

function fnv(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export function exportMarkdownFull(doc: DocumentModel, opts: MarkdownOptions = {}): MarkdownExport {
  const assets = new Map<string, Uint8Array>();
  const byRef = new Map<string, ImageRun>();
  const refs: Refs = {
    sized: () => null,
    ref(run) {
      if (run.missing && run.srcPath) { byRef.set(run.srcPath, run); return run.srcPath; }
      if (run.srcPath && (opts.keepPaths || !run.src.startsWith("data:"))) { byRef.set(run.srcPath, run); return run.srcPath; }
      const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(run.src);
      if (!m) return /^https?:/i.test(run.src) ? run.src : "";
      if (!opts.assetDir) return run.src;
      let bytes: Uint8Array;
      try { bytes = m[2] ? fromBase64(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])); } catch { return ""; }
      const name = `img-${fnv(bytes)}-${bytes.length.toString(36)}.${extFromMime(m[1] || run.mime)}`;
      assets.set(`${opts.assetDir}/${name}`, bytes);
      const written = `${opts.assetDir.split("/").map(encodeURIComponent).join("/")}/${name}`;
      byRef.set(written, run);
      return written;
    },
  };

  refs.sized = (run, ref) => {
    if (run.missing) return null;
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(run.src);
    if (!m) return null;
    let size: { w: number; h: number } | null = null;
    try { size = imageSize(m[2] ? fromBase64(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]))); } catch { size = null; }
    if (!size) return null;
    const exp = fit(doc, size.w, size.h);
    if (Math.abs(exp.width - run.width) < 1.5 && Math.abs(exp.height - run.height) < 1.5) return null;
    const alt = (run.alt ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/[\r\n]+/g, " ");
    return `<img src="${ref}" alt="${alt}" width="${Math.round(run.width / 0.75)}" height="${Math.round(run.height / 0.75)}">`;
  };
  const out: string[] = [];
  if (doc.frontMatter) out.push(doc.frontMatter);
  let prev: string | null = out.length ? "front" : null;
  let prevQuote = 0;
  const gap = (kind: string, quote = 0) => {
    if (prev === null) return;
    if (kind === "list" && prev === "list") return;
    if (kind === "quote" && prev === "quote") { out.push("> ".repeat(Math.min(prevQuote, quote)).trimEnd()); return; }
    out.push("");
  };
  const done = (kind: string, quote = 0) => { prev = kind; prevQuote = quote; };

  let afterCont = false; // l'ultimo blocco era un secondo paragrafo di una voce
  let list: { top: number; counters: Map<number, number[]>; widths: number[]; flip: number } | null = null;

  for (let i = 0; i < doc.blocks.length; i++) {
    const b = doc.blocks[i];
    if (b.type === "toc") continue;
    if (b.type === "table") {
      if (!b.rows.length) continue;
      list = null;
      gap("table");
      const cellText = (c: TableCell, header: boolean) => c.paragraphs.map((p) => renderRuns(p.runs, refs, { br: "<br>", noBold: header, base: paragraphRunProps(doc, p) })).filter(Boolean).join("<br>").replace(/\|/g, "\\|");
      const cols = Math.max(...b.rows.map((r) => r.cells.reduce((n, c) => n + Math.max(1, c.span), 0)));
      const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
      const rowCells = (r: Table["rows"][number], header: boolean) => {
        const cells: string[] = [];
        for (const c of r.cells) {
          cells.push(c.vMerge === "continue" ? "" : cellText(c, header));
          for (let k = 1; k < c.span; k++) cells.push("");
        }
        while (cells.length < cols) cells.push("");
        return cells;
      };
      out.push(line(rowCells(b.rows[0], true)));
      const first = b.rows[0].cells;
      out.push(line(Array.from({ length: cols }, (_, k) => {
        const a = first[k]?.paragraphs[0]?.props.align;
        return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
      })));
      for (const r of b.rows.slice(1)) out.push(line(rowCells(r, false)));
      done("table");
      continue;
    }

    const p = b;
    const eff = effectivePara(doc, p);
    const style = p.props.style;
    if (!(p.props.numId !== undefined || (list && prev === "list" && p.props.indentLeft))) afterCont = false;

    if (style === "CodeBlock") {
      let text = plainOf(p);
      const lang = p.props.codeLang ?? "";
      const inItem = !!list && !!p.props.indentLeft && prev === "list";
      while (i + 1 < doc.blocks.length) {
        const nx = doc.blocks[i + 1];
        if (nx.type !== "p" || nx.props.style !== "CodeBlock" || !!nx.props.indentLeft !== !!p.props.indentLeft) break;
        text += `\n${plainOf(nx)}`;
        i++;
      }
      const longest = Math.max(2, ...(text.match(/`{3,}/g) ?? []).map((x) => x.length));
      const fence = "`".repeat(longest + 1);
      if (inItem) {
        // Dentro una voce di elenco: rientrato come il testo della voce, e l'elenco continua dopo.
        const pad = " ".repeat(list!.widths.reduce((n, w) => n + w, 0));
        for (const l of [`${fence}${lang}`, ...text.split("\n"), fence]) out.push(l ? pad + l : "");
        done("list");
        continue;
      }
      list = null;
      gap("code");
      out.push(`${fence}${lang}`, text, fence);
      done("code");
      continue;
    }
    if (style === "Rule") { list = null; gap("hr"); out.push("---"); done("hr"); continue; }

    const isEmpty = !p.runs.some((r) => isAtomic(r) ? r.type === "image" : r.text.replace(/[\s\f]/g, "") !== "");
    // Una voce di elenco vuota che fa da contenitore (`- - testo`) si tiene: senza, i figli perderebbero il livello.
    const next = doc.blocks[i + 1];
    const holdsChildren = p.props.numId !== undefined && next?.type === "p" && next.props.numId !== undefined && (next.props.numLevel ?? 0) > (p.props.numLevel ?? 0);
    if (isEmpty && !holdsChildren) continue;

    if (style === "BlockQuote" || style === "Quote") {
      const depth = style === "BlockQuote" ? Math.max(1, Math.round((p.props.indentLeft ?? QUOTE_STEP) / QUOTE_STEP)) : 1;
      list = null;
      gap("quote", depth);
      const text = renderRuns(p.runs, refs, { base: paragraphRunProps(doc, p) }).split("\n").map(guardLineStart);
      for (const l of text) out.push(`${"> ".repeat(depth)}${l}`.trimEnd());
      done("quote", depth);
      continue;
    }

    const base = paragraphRunProps(doc, p);
    const level = eff.outlineLevel !== undefined && eff.outlineLevel < 6 ? eff.outlineLevel + 1 : 0;
    if (level) {
      list = null;
      gap("h");
      const wrap = paraWrapper(doc, p);
      if (wrap) out.push(wrap, "");
      out.push(`${"#".repeat(level)} ${renderRuns(p.runs, refs, { noBold: true, br: " ", base })}`.trimEnd());
      if (wrap) out.push("", "</div>");
      done("h");
      continue;
    }

    if (p.props.numId !== undefined) {
      const numId = p.props.numId;
      const def = doc.numbering[numId];
      const lv = Math.min(p.props.numLevel ?? 0, 8);
      const spec = def?.levels[Math.min(lv, (def?.levels.length ?? 1) - 1)];
      const bullet = !spec || spec.format === "bullet" || spec.format === "none";
      let separate = false;
      if (!list) list = { top: numId, counters: new Map(), widths: [], flip: 0 };
      else if (lv === 0 && list.top !== numId) {
        // Un nuovo elenco subito dopo un altro va tenuto distinto: si cambia simbolo ("-"/"*", "."/")") e si lascia una riga vuota.
        separate = prev === "list";
        list.top = numId;
        list.flip = separate ? 1 - list.flip : 0;
        list.widths = [];
      }
      const flip = lv === 0 ? list.flip : 0;
      const counts = list.counters.get(numId) ?? [];
      list.counters.set(numId, counts);
      let marker = flip ? "* " : "- ";
      if (!bullet) {
        const n = (counts[lv] ?? (spec!.start - 1)) + 1;
        counts[lv] = n;
        marker = `${Math.max(0, n)}${flip ? ")" : "."} `;
      }
      // Cambiando livello ripartono i contatori dei livelli più profondi (di tutte le numerazioni).
      for (const arr of list.counters.values()) if (arr.length > lv + (arr === counts ? 1 : 0)) arr.length = lv + (arr === counts ? 1 : 0);
      const indent = " ".repeat(Array.from({ length: lv }, (_, k) => list!.widths[k] ?? 2).reduce((a, c) => a + c, 0));
      list.widths[lv] = marker.length;
      list.widths.length = lv + 1;
      let runs = p.runs;
      let task = "";
      const f = runs[0];
      if (f && !isAtomic(f) && /^[☐☑] /.test(f.text)) {
        task = f.text[0] === "☑" ? "[x] " : "[ ] ";
        runs = [{ ...f, text: f.text.slice(2) }, ...runs.slice(1)];
      }
      const lines = renderRuns(runs, refs, { base: paragraphRunProps(doc, p) }).split("\n").map((l) => l.replace(/^[ \t]+/, ""));
      if (separate || afterCont) out.push("");
      afterCont = false;
      gap("list");
      out.push(`${indent}${marker}${task}${lines[0]}`.trimEnd());
      for (const l of lines.slice(1)) out.push(`${indent}${" ".repeat(marker.length)}${l}`);
      done("list");
      continue;
    }

    if (list && prev === "list" && p.props.indentLeft) {
      // Secondo paragrafo di una voce di elenco: rientrato come il testo della voce, e l'elenco continua dopo.
      const pad = " ".repeat(list.widths.reduce((n, w) => n + w, 0));
      out.push("");
      for (const l of renderRuns(p.runs, refs, { base: paragraphRunProps(doc, p) }).split("\n").map(guardLineStart)) out.push(l ? pad + l : "");
      done("list");
      afterCont = true;
      continue;
    }
    list = null;
    gap("p");
    const text = renderRuns(p.runs, refs, { base }).split("\n").map(guardLineStart).join("\n");
    const wrap = paraWrapper(doc, p);
    if (wrap) out.push(wrap, "", text, "", "</div>");
    else out.push(text);
    done("p");
  }

  const metaComment = buildMeta(doc);
  if (metaComment) out.push("", metaComment);
  const bytes = new TextEncoder().encode(out.join("\n").replace(/\n+$/, "") + "\n");
  return { bytes, assets: [...assets].map(([path, data]) => ({ path, bytes: data })), refs: byRef };
}

// ---------- vista «Sorgente» ----------

export interface MarkdownSource {
  text: string;
  /** Per rileggere il testo modificato: riferimento scritto → immagine originale. */
  images: Map<string, ImageRun>;
}

/** Il Markdown da mostrare accanto al documento: immagini come `immagini/img-….png` (non base64) e senza il commento nascosto. */
export function markdownSource(doc: DocumentModel): MarkdownSource {
  const out = exportMarkdownFull(doc, { assetDir: "immagini" });
  return { text: new TextDecoder().decode(out.bytes).replace(META_RE, "").replace(/\n*$/, "\n"), images: out.refs };
}

/** Rilegge un sorgente modificato: le immagini note tornano quelle di prima, e stili/pagina/intestazioni restano quelli del documento. */
export function markdownFromSource(current: DocumentModel, text: string, images: Map<string, ImageRun>): DocumentModel {
  const meta = buildMeta(current);
  const full = meta ? `${text.replace(/\s*$/, "\n")}\n${meta}\n` : text;
  const doc = importMarkdown(new TextEncoder().encode(full));
  for (const p of [...allParagraphs(doc.blocks)]) {
    for (const r of p.runs) {
      if (r.type !== "image" || !r.srcPath) continue;
      const o = images.get(r.srcPath);
      if (!o) continue;
      const placeholder = r.width === 96 && r.height === 96; // senza `<img width>` esplicito, la misura è quella di prima
      r.src = o.src; r.mime = o.mime;
      if (placeholder) { r.width = o.width; r.height = o.height; }
      if (o.srcPath) r.srcPath = o.srcPath; else delete r.srcPath;
      if (o.missing) r.missing = true;
    }
  }
  return doc;
}

/** Markdown con le immagini incorporate nel testo (data URI): un solo file. */
export function exportMarkdown(doc: DocumentModel): Uint8Array {
  return exportMarkdownFull(doc).bytes;
}

/** Elenca ciò che nemmeno ZikOffice riesce a salvare in un file Markdown (vuoto se non si perde nulla). */
export function markdownLosses(doc: DocumentModel): string[] {
  const found = new Set<string>();
  const check = (p: Paragraph) => {
    if (p.props.tabs?.length || p.runs.some((r) => !isAtomic(r) && r.text.includes("\t"))) found.add("tabulazioni");
    if (p.props.pageBreakBefore || p.runs.some((r) => !isAtomic(r) && r.text.includes("\f"))) found.add("interruzioni di pagina");
    if (p.props.numId !== undefined && !p.props.numLevel) {
      const f = doc.numbering[p.props.numId]?.levels[0]?.format;
      if (f && f !== "bullet" && f !== "decimal" && f !== "none") found.add("lettere e numeri romani negli elenchi");
    }
    if (p.runs.some((r) => r.type === "field")) found.add("numeri di pagina nel corpo");
  };
  for (const b of doc.blocks) {
    if (b.type === "p") check(b);
    else if (b.type === "table") {
      for (const row of b.rows) for (const c of row.cells) {
        if (c.span > 1 || c.vMerge) found.add("celle unite");
        c.paragraphs.forEach(check);
      }
    } else if (b.type === "toc") found.add("sommario");
  }
  if (doc.comments?.length) found.add("commenti");
  return [...found];
}
