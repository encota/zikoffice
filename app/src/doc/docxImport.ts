// Lettura dei documenti .docx (Office Open XML, Transitional e Strict) nel modello dell'editor.
import { strFromU8, unzipSync } from "fflate";
import {
  type Align, type Block, type CellBorder, type DocumentModel, type NumFormat, type NumLevel, type Paragraph,
  type ParaProps, type Run, type RunProps, type StyleDef, type TabStop, type Table, type TableCell,
} from "./model";
import { defaultStyles, newDocument } from "./styles";

const NS = {
  w: ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"],
  r: ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"],
  a: ["http://schemas.openxmlformats.org/drawingml/2006/main", "http://purl.oclc.org/ooxml/drawingml/main"],
};

/** Nomi standard degli stili di Word → id usati dall'editor (Word italiano usa id come "Titolo1"). */
const BUILTIN: Record<string, string> = {
  normal: "Normal", title: "Title", subtitle: "Subtitle", quote: "Quote", "no spacing": "NoSpacing",
  "list paragraph": "ListParagraph", caption: "Caption", "toc heading": "TOCHeading", header: "Header", footer: "Footer",
  hyperlink: "Hyperlink", "toc 1": "TOC1", "toc 2": "TOC2", "toc 3": "TOC3",
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`heading ${i + 1}`, `Heading${i + 1}`])),
};

const HIGHLIGHT: Record<string, string> = {
  yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff", red: "#ff0000",
  darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000",
  darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000", white: "#ffffff",
};

const THEME_COLOR_ALIASES: Record<string, string> = {
  dark1: "dk1", light1: "lt1", dark2: "dk2", light2: "lt2",
  text1: "dk1", background1: "lt1", text2: "dk2", background2: "lt2",
  hyperlink: "hlink", followedHyperlink: "folHlink",
};

// ---------- utilità XML e ZIP ----------

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml.replace(/^\uFEFF/, ""), "application/xml");
}

const kids = (el: Element | null | undefined, name?: string): Element[] =>
  el ? [...el.children].filter((c) => !name || c.localName === name) : [];
const kid = (el: Element | null | undefined, name: string): Element | undefined => kids(el, name)[0];

function findAll(el: Element | Document | null | undefined, localName: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  for (const node of el.getElementsByTagName("*")) {
    if (node.localName === localName) out.push(node);
  }
  return out;
}

function findFirst(el: Element | Document | null | undefined, localName: string): Element | undefined {
  if (!el) return undefined;
  for (const node of el.getElementsByTagName("*")) {
    if (node.localName === localName) return node;
  }
  return undefined;
}

function attr(el: Element | null | undefined, name: string, ns: "w" | "r" = "w"): string | null {
  if (!el) return null;
  for (const uri of NS[ns]) {
    const v = el.getAttributeNS(uri, name);
    if (v !== null && v !== "") return v;
  }
  const prefixed = el.getAttribute(`${ns}:${name}`);
  if (prefixed !== null && prefixed !== "") return prefixed;
  // Fallback su attributo senza prefisso (alcuni generatori non mettono il prefisso).
  const plain = el.getAttribute(name);
  return plain !== null && plain !== "" ? plain : null;
}

const num = (v: string | null | undefined): number | undefined => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const twip = (v: string | null | undefined) => { const n = num(v); return n === undefined ? undefined : n / 20; };

/** Valore booleano di Word: <w:b/> è vero, <w:b w:val="0"/> è falso. */
function toggle(el: Element | undefined): boolean | undefined {
  if (!el) return undefined;
  const v = attr(el, "val");
  return !(v === "0" || v === "false" || v === "off" || v === "none");
}

function hexColor(v: string | null): string | undefined {
  if (!v || v === "auto" || !/^[0-9a-fA-F]{6}$/.test(v)) return undefined;
  return `#${v.toLowerCase()}`;
}

function normalizeZip(raw: Record<string, Uint8Array>): { files: Record<string, Uint8Array>; lower: Map<string, string> } {
  const files: Record<string, Uint8Array> = {};
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) {
    const norm = k.replace(/^\/+/, "");
    files[norm] = v;
    lower.set(norm.toLowerCase(), norm);
  }
  return { files, lower };
}

function getFile(ctx: { files: Record<string, Uint8Array>; lower: Map<string, string> }, path: string): Uint8Array | undefined {
  const norm = path.replace(/^\/+/, "");
  return ctx.files[norm] ?? ctx.files[ctx.lower.get(norm.toLowerCase()) ?? ""];
}

// ---------- contesto di importazione ----------

interface Ctx {
  doc: DocumentModel;
  files: Record<string, Uint8Array>;
  lower: Map<string, string>;
  rels: Map<string, { target: string; external: boolean }>;
  /** Font e colori del tema (per asciiTheme="minorHAnsi" e themeColor="accent1"). */
  theme: { major?: string; minor?: string; colors: Record<string, string> };
  styleIds: Map<string, string>;
  /** Stato dei campi complessi (PAGE, TOC, HYPERLINK…) che attraversano più run e paragrafi. */
  field: { instr: string; phase: "instr" | "result"; depth: number; link?: string } | null;
  tocInserted: boolean;
  inToc: boolean;
  /** Riferimenti a note a piè di pagina / chiusura incontrati nel testo. */
  notes: { kind: "footnote" | "endnote"; id: string; num: number }[];
}

function relsFor(zip: { files: Record<string, Uint8Array>; lower: Map<string, string> }, part: string): Ctx["rels"] {
  const dir = part.slice(0, part.lastIndexOf("/") + 1);
  const file = `${dir}_rels/${part.slice(dir.length)}.rels`;
  const map: Ctx["rels"] = new Map();
  const bytes = getFile(zip, file);
  if (!bytes) return map;
  for (const rel of findAll(parse(strFromU8(bytes)), "Relationship")) {
    const external = rel.getAttribute("TargetMode") === "External";
    let target = rel.getAttribute("Target") ?? "";
    if (!external) target = resolvePath(dir, target);
    map.set(rel.getAttribute("Id") ?? "", { target, external });
  }
  return map;
}

function resolvePath(dir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (dir + target).split("/");
  const out: string[] = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); }
  return out.join("/");
}

function resolveColor(ctx: Ctx, el: Element | undefined, attrName = "val", themeAttr = "themeColor"): string | undefined {
  if (!el) return undefined;
  const direct = hexColor(attr(el, attrName));
  if (direct) return direct;
  const tc = attr(el, themeAttr);
  if (!tc) return undefined;
  const key = THEME_COLOR_ALIASES[tc] ?? tc;
  return ctx.theme.colors[key];
}

// ---------- proprietà ----------

function runProps(ctx: Ctx, rPr: Element | undefined): RunProps & { caps?: boolean; vanish?: boolean } {
  const p: RunProps & { caps?: boolean; vanish?: boolean } = {};
  if (!rPr) return p;
  const b = toggle(kid(rPr, "b")); if (b !== undefined) p.bold = b;
  const i = toggle(kid(rPr, "i")); if (i !== undefined) p.italic = i;
  const strike = toggle(kid(rPr, "strike")) ?? toggle(kid(rPr, "dstrike")); if (strike !== undefined) p.strike = strike;
  const u = kid(rPr, "u");
  if (u) p.underline = !["none", "0", "false"].includes(attr(u, "val") ?? "single");
  const fonts = kid(rPr, "rFonts");
  if (fonts) {
    const theme = attr(fonts, "asciiTheme") ?? attr(fonts, "hAnsiTheme");
    const f = attr(fonts, "ascii") ?? attr(fonts, "hAnsi") ?? attr(fonts, "cs") ?? (theme ? (theme.startsWith("major") ? ctx.theme.major : ctx.theme.minor) : null);
    if (f) p.font = f;
  }
  const sz = num(attr(kid(rPr, "sz"), "val")); if (sz) p.size = sz / 2;
  const c = resolveColor(ctx, kid(rPr, "color")); if (c) p.color = c;
  const hl = attr(kid(rPr, "highlight"), "val");
  if (hl && HIGHLIGHT[hl]) p.highlight = HIGHLIGHT[hl];
  else { const shd = resolveColor(ctx, kid(rPr, "shd"), "fill", "themeFill"); if (shd && shd !== "#ffffff") p.highlight = shd; }
  const va = attr(kid(rPr, "vertAlign"), "val");
  if (va === "superscript" || va === "subscript") p.vertAlign = va;
  const caps = toggle(kid(rPr, "caps")); if (caps) p.caps = true;
  const vanish = toggle(kid(rPr, "vanish")); if (vanish) p.vanish = true;
  const rStyle = attr(kid(rPr, "rStyle"), "val");
  if (rStyle) {
    // Gli stili di carattere (es. Enfasi, Forte) diventano proprietà dirette: non li gestiamo come stili.
    const st = ctx.doc.styles[ctx.styleIds.get(rStyle) ?? rStyle];
    if (st?.type === "character" && st.id !== "Hyperlink") Object.assign(p, { ...st.run, ...p });
  }
  return p;
}

function paraProps(ctx: Ctx, pPr: Element | undefined): ParaProps {
  const p: ParaProps = {};
  if (!pPr) return p;
  const style = attr(kid(pPr, "pStyle"), "val");
  if (style) p.style = ctx.styleIds.get(style) ?? style;
  const jc = attr(kid(pPr, "jc"), "val");
  const align: Record<string, Align> = { left: "left", start: "left", center: "center", right: "right", end: "right", both: "justify", distribute: "justify" };
  if (jc && align[jc]) p.align = align[jc];
  const ind = kid(pPr, "ind");
  if (ind) {
    const left = twip(attr(ind, "left") ?? attr(ind, "start")); if (left !== undefined) p.indentLeft = Math.max(0, left);
    const right = twip(attr(ind, "right") ?? attr(ind, "end")); if (right !== undefined) p.indentRight = Math.max(0, right);
    const first = twip(attr(ind, "firstLine")); if (first !== undefined) p.firstLine = first;
    const hanging = twip(attr(ind, "hanging")); if (hanging !== undefined) p.firstLine = -hanging;
  }
  const sp = kid(pPr, "spacing");
  if (sp) {
    const before = twip(attr(sp, "before")); if (before !== undefined) p.spaceBefore = Math.max(0, before);
    const after = twip(attr(sp, "after")); if (after !== undefined) p.spaceAfter = Math.max(0, after);
    if (toggle(kid(sp, "beforeAutospacing")) || attr(sp, "beforeAutospacing") === "1") p.spaceBefore = 14;
    if (attr(sp, "afterAutospacing") === "1") p.spaceAfter = 14;
    const line = num(attr(sp, "line"));
    if (line && line > 0) {
      const rule = attr(sp, "lineRule") ?? "auto";
      if (rule === "auto") { p.line = line / 240; p.lineRule = "auto"; }
      else { p.line = line / 20; p.lineRule = rule === "exact" ? "exact" : "atLeast"; }
    }
  }
  const kn = toggle(kid(pPr, "keepNext")); if (kn !== undefined) p.keepNext = kn;
  const pb = toggle(kid(pPr, "pageBreakBefore")); if (pb) p.pageBreakBefore = true;
  const ol = num(attr(kid(pPr, "outlineLvl"), "val")); if (ol !== undefined && ol < 9) p.outlineLevel = ol;
  const numPr = kid(pPr, "numPr");
  if (numPr) {
    const id = num(attr(kid(numPr, "numId"), "val"));
    if (id !== undefined) { p.numId = id; p.numLevel = num(attr(kid(numPr, "ilvl"), "val")) ?? 0; }
  }
  const shd = resolveColor(ctx, kid(pPr, "shd"), "fill", "themeFill"); if (shd && shd !== "#ffffff") p.shading = shd;
  const tabs = kid(pPr, "tabs");
  if (tabs) {
    const list: TabStop[] = [];
    for (const t of kids(tabs, "tab")) {
      const v = attr(t, "val");
      const pos = twip(attr(t, "pos"));
      if (pos === undefined || v === "clear") continue;
      const leader = attr(t, "leader");
      list.push({
        pos, align: v === "right" || v === "end" ? "right" : v === "center" ? "center" : v === "decimal" ? "decimal" : "left",
        leader: leader === "dot" ? "dot" : leader === "hyphen" ? "hyphen" : leader === "underscore" ? "underscore" : undefined,
      });
    }
    if (list.length) p.tabs = list;
  }
  return p;
}

// ---------- stili, tema, numerazioni ----------

function readTheme(ctx: Ctx): void {
  const file = Object.keys(ctx.files).find((f) => /^word\/theme\/theme\d*\.xml$/i.test(f));
  if (!file) return;
  const x = parse(strFromU8(ctx.files[file]));
  const latin = (tag: string) => {
    const el = findFirst(x, tag);
    return el ? kid(el, "latin")?.getAttribute("typeface") ?? undefined : undefined;
  };
  const colors: Record<string, string> = {};
  const scheme = findFirst(x, "clrScheme");
  if (scheme) {
    for (const c of kids(scheme)) {
      const srgb = kid(c, "srgbClr")?.getAttribute("val");
      const sys = kid(c, "sysClr")?.getAttribute("lastClr");
      const hex = hexColor(srgb ?? sys ?? null);
      if (hex) colors[c.localName] = hex;
    }
  }
  ctx.theme = { major: latin("majorFont"), minor: latin("minorFont"), colors };
}

function readStyles(ctx: Ctx): void {
  const data = getFile(ctx, "word/styles.xml");
  if (!data) return;
  const x = parse(strFromU8(data)).documentElement;
  // Proprietà predefinite del documento
  const defaults = kid(x, "docDefaults");
  const rPrDef = kid(kid(defaults, "rPrDefault"), "rPr");
  const pPrDef = kid(kid(defaults, "pPrDefault"), "pPr");
  ctx.doc.defaultRun = { font: ctx.theme.minor ?? "Calibri", size: 10, ...runProps(ctx, rPrDef) };
  ctx.doc.defaultPara = paraProps(ctx, pPrDef);

  const styles: Record<string, StyleDef> = {};
  const raw = kids(x, "style");
  // Prima gli id: Word italiano usa "Titolo1", noi "Heading1".
  for (const s of raw) {
    const id = attr(s, "styleId") ?? "";
    const name = attr(kid(s, "name"), "val") ?? id;
    ctx.styleIds.set(id, BUILTIN[name.toLowerCase()] ?? id);
  }
  for (const s of raw) {
    const type = attr(s, "type");
    if (type !== "paragraph" && type !== "character" && type !== "table") continue;
    const srcId = attr(s, "styleId") ?? "";
    const id = ctx.styleIds.get(srcId) ?? srcId;
    const name = attr(kid(s, "name"), "val") ?? id;
    const basedOn = attr(kid(s, "basedOn"), "val");
    const next = attr(kid(s, "next"), "val");
    const def: StyleDef = {
      id, name: displayName(id, name), type,
      basedOn: basedOn ? ctx.styleIds.get(basedOn) ?? basedOn : undefined,
      next: next ? ctx.styleIds.get(next) ?? next : undefined,
      para: paraProps(ctx, kid(s, "pPr")),
      run: runProps(ctx, kid(s, "rPr")),
      quick: kid(s, "qFormat") !== undefined,
    };
    if (def.para?.style) delete def.para.style;
    // I titoli hanno sempre il livello di struttura (serve al sommario)
    const m = /^Heading(\d)$/.exec(id);
    if (m && def.para && def.para.outlineLevel === undefined) def.para.outlineLevel = Number(m[1]) - 1;
    if (type === "table") {
      const borders = kid(kid(s, "tblPr"), "tblBorders");
      (def as StyleDef & { borders?: CellBorder | null }).borders = borders ? tableBorder(ctx, borders) : undefined;
    }
    styles[id] = def;
  }
  // Gli stili dell'editor che mancano nel file restano disponibili.
  ctx.doc.styles = { ...defaultStyles(), ...styles };
}

const ITALIAN_NAMES: Record<string, string> = {
  Normal: "Normale", Title: "Titolo", Subtitle: "Sottotitolo", Quote: "Citazione", NoSpacing: "Nessuna spaziatura",
  ListParagraph: "Paragrafo elenco", Caption: "Didascalia", TOCHeading: "Titolo sommario", Header: "Intestazione", Footer: "Piè di pagina",
};

function displayName(id: string, name: string): string {
  const h = /^Heading(\d)$/.exec(id);
  if (h) return `Titolo ${h[1]}`;
  return ITALIAN_NAMES[id] ?? name;
}

function tableBorder(ctx: Ctx, el: Element): CellBorder | null {
  const side = kid(el, "insideH") ?? kid(el, "insideV") ?? kid(el, "top") ?? kid(el, "left") ?? kid(el, "bottom") ?? kid(el, "right");
  return borderOf(ctx, side);
}

function borderOf(ctx: Ctx, el: Element | undefined): CellBorder | null {
  if (!el) return null;
  const v = attr(el, "val");
  if (!v || v === "nil" || v === "none") return null;
  const sz = num(attr(el, "sz")) ?? 4;
  return {
    width: Math.max(0.25, sz / 8), color: resolveColor(ctx, el, "color") ?? "#000000",
    style: v === "double" ? "double" : v.startsWith("dash") ? "dashed" : v === "dotted" ? "dotted" : "single",
  };
}

function resolveTableStyleBorders(ctx: Ctx, styleId: string | null): CellBorder | null | undefined {
  if (!styleId) return undefined;
  const seen = new Set<string>();
  let cur: string | undefined = ctx.styleIds.get(styleId) ?? styleId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const st = ctx.doc.styles[cur] as (StyleDef & { borders?: CellBorder | null }) | undefined;
    if (!st) break;
    if (st.borders !== undefined) return st.borders;
    cur = st.basedOn;
  }
  if (/grid|griglia/i.test(styleId)) return { width: 0.5, color: "#000000", style: "single" };
  return undefined;
}

const BULLET_MAP: Record<string, string> = { "": "•", "": "▪", "": "➢", "": "❖", "": "✓", "": "□", o: "◦", "": "◦" };

function readNumbering(ctx: Ctx): void {
  const data = getFile(ctx, "word/numbering.xml");
  if (!data) return;
  const x = parse(strFromU8(data)).documentElement;
  const abstract = new Map<string, NumLevel[]>();
  for (const a of kids(x, "abstractNum")) {
    const levels: NumLevel[] = [];
    for (const lvl of kids(a, "lvl")) {
      const i = num(attr(lvl, "ilvl")) ?? levels.length;
      const fmt = attr(kid(lvl, "numFmt"), "val") ?? "decimal";
      const format: NumFormat = (["decimal", "lowerLetter", "upperLetter", "lowerRoman", "upperRoman", "bullet", "none"] as const).find((f) => f === fmt)
        ?? (fmt.startsWith("decimal") ? "decimal" : "decimal");
      let text = attr(kid(lvl, "lvlText"), "val") ?? "";
      if (format === "bullet") text = BULLET_MAP[text] ?? (/[-]/.test(text) ? ["•", "◦", "▪"][i % 3] : text || "•");
      const ind = kid(kid(lvl, "pPr"), "ind");
      levels[i] = {
        format, text, start: num(attr(kid(lvl, "start"), "val")) ?? 1,
        indentLeft: twip(attr(ind, "left") ?? attr(ind, "start")) ?? 36 + 18 * i,
        hanging: twip(attr(ind, "hanging")) ?? 18,
      };
    }
    abstract.set(attr(a, "abstractNumId") ?? "", levels);
  }
  for (const n of kids(x, "num")) {
    const id = num(attr(n, "numId"));
    const levels = abstract.get(attr(kid(n, "abstractNumId"), "val") ?? "");
    if (id === undefined || !levels) continue;
    const copy = structuredClone(levels);
    for (const o of kids(n, "lvlOverride")) {
      const i = num(attr(o, "ilvl")) ?? 0;
      const start = num(attr(kid(o, "startOverride"), "val"));
      if (start !== undefined && copy[i]) copy[i].start = start;
    }
    ctx.doc.numbering[id] = { id, levels: copy };
  }
}

// ---------- contenuto ----------

function parseCssLengthPt(style: string, prop: string): number | undefined {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([0-9.]+)\\s*(pt|px|in|cm|mm)?`, "i").exec(style);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (Number.isNaN(v) || v <= 0) return undefined;
  const u = (m[2] ?? "pt").toLowerCase();
  if (u === "in") return v * 72;
  if (u === "cm") return v * 28.3465;
  if (u === "mm") return v * 2.83465;
  if (u === "px") return v * 0.75;
  return v;
}

function imageRun(ctx: Ctx, drawing: Element, props: RunProps): Run | null {
  const blip = findFirst(drawing, "blip");
  const imagedata = blip ? undefined : findFirst(drawing, "imagedata");
  const rid = blip
    ? (attr(blip, "embed", "r") ?? attr(blip, "link", "r"))
    : imagedata
      ? (attr(imagedata, "id", "r") ?? imagedata.getAttribute("r:id") ?? imagedata.getAttribute("o:relid"))
      : null;
  const rel = rid ? ctx.rels.get(rid) : undefined;
  const bytes = rel && !rel.external ? getFile(ctx, rel.target) : undefined;
  if (!bytes) return null;
  const ext = (rel!.target.split(".").pop() ?? "png").toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : ext === "bmp" ? "image/bmp" : ext === "webp" ? "image/webp" : "image/png";
  if (!/^image\/(png|jpeg|gif|svg\+xml|bmp|webp)$/.test(mime)) return null;

  let width = 72, height = 72;
  if (blip) {
    const extent = findFirst(drawing, "extent");
    const cx = num(extent?.getAttribute("cx")) ?? 914400;
    const cy = num(extent?.getAttribute("cy")) ?? 914400;
    width = Math.max(8, cx / 12700);
    height = Math.max(8, cy / 12700);
  } else {
    const shape = findFirst(drawing, "shape");
    const style = shape?.getAttribute("style") ?? "";
    width = parseCssLengthPt(style, "width") ?? 144;
    height = parseCssLengthPt(style, "height") ?? 108;
  }
  const docPr = findFirst(drawing, "docPr");
  return { type: "image", src: `data:${mime};base64,${toBase64(bytes)}`, mime, width, height, alt: docPr?.getAttribute("descr") ?? imagedata?.getAttribute("o:title") ?? "", props };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function parseHyperlinkInstr(instr: string): string | undefined {
  const m = /^\s*HYPERLINK\s+(?:\\l\s+)?"([^"]+)"/i.exec(instr);
  if (!m) return undefined;
  return /\\l\s+"/i.test(instr) ? `#${m[1]}` : m[1];
}

function readAlternateContent(el: Element): Element | undefined {
  const choice = kid(el, "Choice");
  const fallback = kid(el, "Fallback");
  if (choice && kids(choice).length) return choice;
  return fallback;
}

/** Legge i run di un paragrafo (anche dentro collegamenti, revisioni, campi, AlternateContent). */
function readRuns(ctx: Ctx, el: Element, out: Run[], link?: string): void {
  for (const c of kids(el)) {
    switch (c.localName) {
      case "r": readRun(ctx, c, out, link); break;
      case "hyperlink": {
        const rid = attr(c, "id", "r");
        const rel = rid ? ctx.rels.get(rid) : undefined;
        const anchor = attr(c, "anchor");
        readRuns(ctx, c, out, rel?.target ?? (anchor ? `#${anchor}` : link));
        break;
      }
      case "fldSimple": {
        const rawInstr = (attr(c, "instr") ?? "").trim();
        const instr = rawInstr.split(/\s+/)[0]?.toUpperCase();
        if (instr === "PAGE" || instr === "NUMPAGES") {
          out.push({ type: "field", field: instr, props: runProps(ctx, kid(kid(c, "r"), "rPr")) });
        } else {
          readRuns(ctx, c, out, parseHyperlinkInstr(rawInstr) ?? link);
        }
        break;
      }
      // Revisioni: si tiene il testo inserito, si scarta quello cancellato (come "accetta tutto").
      case "ins": case "smartTag": case "customXml": case "sdtContent": case "moveTo": case "dir": case "bdo":
        readRuns(ctx, c, out, link); break;
      case "sdt": readRuns(ctx, kid(c, "sdtContent") ?? c, out, link); break;
      case "AlternateContent": {
        const branch = readAlternateContent(c);
        if (branch) readRuns(ctx, branch, out, link);
        break;
      }
      default: break; // del, moveFrom, bookmark, proofErr, commenti…
    }
  }
}

function readRun(ctx: Ctx, r: Element, out: Run[], link?: string): void {
  const rawProps = runProps(ctx, kid(r, "rPr"));
  const { caps, vanish, ...props } = rawProps;
  const effLink = link ?? (ctx.field?.phase === "result" ? ctx.field.link : undefined);
  if (effLink) props.link = effLink;
  const push = (text: string) => {
    if (vanish || ctx.field?.phase === "instr" || ctx.inToc) return;
    const last = out[out.length - 1];
    if (last && last.type !== "image" && last.type !== "field" && JSON.stringify(last.props) === JSON.stringify(props)) last.text += text;
    else out.push({ text, props: { ...props } });
  };
  const handleNode = (c: Element) => {
    switch (c.localName) {
      case "t": {
        let t = c.textContent ?? "";
        if (caps) t = t.toLocaleUpperCase("it");
        push(t);
        break;
      }
      case "tab": push("\t"); break;
      case "br": push(attr(c, "type") === "page" ? "\f" : "\u000b"); break;
      case "cr": push("\u000b"); break;
      case "noBreakHyphen": push("‑"); break;
      case "softHyphen": break;
      case "sym": {
        const ch = attr(c, "char");
        push(ch ? (BULLET_MAP[String.fromCharCode(parseInt(ch, 16))] ?? "•") : "");
        break;
      }
      case "footnoteReference":
      case "endnoteReference": {
        if (vanish || ctx.field?.phase === "instr" || ctx.inToc) break;
        const id = attr(c, "id");
        if (id && id !== "-1" && id !== "0") {
          const numIdx = ctx.notes.length + 1;
          ctx.notes.push({ kind: c.localName === "footnoteReference" ? "footnote" : "endnote", id, num: numIdx });
          out.push({ text: `[${numIdx}]`, props: { ...props, vertAlign: "superscript" } });
        }
        break;
      }
      case "drawing": case "pict": case "object": {
        if (vanish || ctx.field?.phase === "instr" || ctx.inToc) break;
        // Caselle di testo dentro forme/disegni: estraiamo il testo per non perderlo.
        const txbx = findFirst(c, "txbxContent");
        if (txbx) {
          const txbxParas = kids(txbx, "p");
          txbxParas.forEach((tp, idx) => {
            if (idx > 0) push("\u000b");
            readRuns(ctx, tp, out, effLink);
          });
          break;
        }
        const img = imageRun(ctx, c, { ...props, link: undefined });
        if (img) out.push(img);
        break;
      }
      case "AlternateContent": {
        const branch = readAlternateContent(c);
        if (branch) for (const sub of kids(branch)) handleNode(sub);
        break;
      }
      case "fldChar": {
        const type = attr(c, "fldCharType");
        if (type === "begin") {
          if (ctx.field) ctx.field.depth++;
          else ctx.field = { instr: "", phase: "instr", depth: 0 };
        } else if (type === "separate" && ctx.field && ctx.field.depth === 0) {
          ctx.field.phase = "result";
          const name = ctx.field.instr.trim().split(/\s+/)[0]?.toUpperCase();
          if (name === "PAGE" || name === "NUMPAGES") { out.push({ type: "field", field: name, props }); ctx.field.phase = "instr"; }
          else if (name === "HYPERLINK") ctx.field.link = parseHyperlinkInstr(ctx.field.instr);
        } else if (type === "end" && ctx.field) {
          if (ctx.field.depth > 0) ctx.field.depth--;
          else {
            const name = ctx.field.instr.trim().split(/\s+/)[0]?.toUpperCase();
            if (name === "TOC") ctx.inToc = false;
            ctx.field = null;
          }
        }
        break;
      }
      case "instrText":
        if (ctx.field && ctx.field.depth === 0) {
          ctx.field.instr += c.textContent ?? "";
          if (/^\s*TOC\b/i.test(ctx.field.instr)) ctx.inToc = true;
        }
        break;
      default: break;
    }
  };
  for (const c of kids(r)) handleNode(c);
}

function readParagraph(ctx: Ctx, el: Element): Paragraph {
  const pPr = kid(el, "pPr");
  const p: Paragraph = { type: "p", id: ctx.doc.nextId++, props: paraProps(ctx, pPr), runs: [] };
  const { caps: _c, vanish: _v, ...mark } = runProps(ctx, kid(pPr, "rPr"));
  void _c; void _v;
  if (Object.keys(mark).length) p.markProps = mark;
  readRuns(ctx, el, p.runs);
  return p;
}

function collectRowCells(el: Element, out: Element[]): void {
  for (const c of kids(el)) {
    if (c.localName === "tc") out.push(c);
    else if (c.localName === "sdt") collectRowCells(kid(c, "sdtContent") ?? c, out);
    else if (c.localName === "ins" || c.localName === "customXml") collectRowCells(c, out);
  }
}

function collectCellBlocks(ctx: Ctx, el: Element, out: Paragraph[]): void {
  for (const c of kids(el)) {
    if (c.localName === "p") out.push(readParagraph(ctx, c));
    else if (c.localName === "tbl") out.push(...flattenTable(ctx, c));
    else if (c.localName === "sdt") collectCellBlocks(ctx, kid(c, "sdtContent") ?? c, out);
    else if (c.localName === "ins" || c.localName === "customXml") collectCellBlocks(ctx, c, out);
    else if (c.localName === "AlternateContent") {
      const branch = readAlternateContent(c);
      if (branch) collectCellBlocks(ctx, branch, out);
    }
  }
}

function readTable(ctx: Ctx, el: Element): Table {
  const tblPr = kid(el, "tblPr");
  const grid = kids(kid(el, "tblGrid"), "gridCol").map((g) => twip(attr(g, "w")) ?? 0);
  const styleId = attr(kid(tblPr, "tblStyle"), "val");
  const tblBorders = kid(tblPr, "tblBorders");
  const styleBorders = resolveTableStyleBorders(ctx, styleId);
  const borders = tblBorders ? tableBorder(ctx, tblBorders) : styleBorders !== undefined ? styleBorders : null;
  const jc = attr(kid(tblPr, "jc"), "val");
  const t: Table = {
    type: "table", id: ctx.doc.nextId++, grid, rows: [], borders,
    align: jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : "left",
  };
  const firstRowWidths: (number | undefined)[] = [];
  const pageContentW = Math.max(200, ctx.doc.page.width - ctx.doc.page.marginLeft - ctx.doc.page.marginRight);
  for (const tr of kids(el, "tr")) {
    const trPr = kid(tr, "trPr");
    const row = { cells: [] as TableCell[], height: twip(attr(kid(trPr, "trHeight"), "val")), header: kid(trPr, "tblHeader") !== undefined };
    const tcs: Element[] = [];
    collectRowCells(tr, tcs);
    for (const tc of tcs) {
      const tcPr = kid(tc, "tcPr");
      const vm = kid(tcPr, "vMerge");
      const cb = kid(tcPr, "tcBorders");
      const span = Math.max(1, num(attr(kid(tcPr, "gridSpan"), "val")) ?? 1);
      if (t.rows.length === 0) {
        const tcW = kid(tcPr, "tcW");
        const wVal = num(attr(tcW, "w"));
        const wType = attr(tcW, "type") ?? "dxa";
        let pt: number | undefined;
        if (wVal && wVal > 0) {
          if (wType === "dxa") pt = wVal / 20;
          else if (wType === "pct") pt = (wVal / 5000) * pageContentW;
        }
        for (let k = 0; k < span; k++) firstRowWidths.push(pt ? pt / span : undefined);
      }
      const cell: TableCell = {
        span,
        vMerge: vm ? (attr(vm, "val") === "restart" ? "restart" : "continue") : undefined,
        shading: resolveColor(ctx, kid(tcPr, "shd"), "fill", "themeFill"),
        vAlign: (attr(kid(tcPr, "vAlign"), "val") as TableCell["vAlign"]) ?? undefined,
        paragraphs: [],
      };
      if (cb) {
        cell.borders = {};
        for (const s of ["top", "bottom", "left", "right"] as const) {
          const e = kid(cb, s) ?? kid(cb, s === "left" ? "start" : s === "right" ? "end" : s);
          if (e) cell.borders[s] = borderOf(ctx, e);
        }
      }
      collectCellBlocks(ctx, tc, cell.paragraphs);
      if (!cell.paragraphs.length) cell.paragraphs.push({ type: "p", id: ctx.doc.nextId++, props: {}, runs: [] });
      row.cells.push(cell);
    }
    if (row.cells.length) t.rows.push(row);
  }
  // Griglia mancante o incompleta: usa tcW della prima riga o ripartisce la larghezza della pagina.
  const cols = Math.max(1, ...t.rows.map((r) => r.cells.reduce((n, c) => n + c.span, 0)));
  const fallbackCol = Math.max(36, pageContentW / cols);
  t.grid = Array.from({ length: cols }, (_, i) => {
    const g = t.grid[i];
    if (g && g > 0) return g;
    const fw = firstRowWidths[i];
    if (fw && fw > 0) return fw;
    return fallbackCol;
  });
  return t;
}

function flattenTable(ctx: Ctx, el: Element): Paragraph[] {
  const out: Paragraph[] = [];
  for (const tr of kids(el, "tr")) {
    const tcs: Element[] = [];
    collectRowCells(tr, tcs);
    for (const tc of tcs) collectCellBlocks(ctx, tc, out);
  }
  return out;
}

function readBlocks(ctx: Ctx, container: Element, out: Block[]): void {
  for (const c of kids(container)) {
    if (c.localName === "p") {
      const wasToc = ctx.inToc;
      const p = readParagraph(ctx, c);
      // Un sommario (campo TOC) diventa il nostro sommario automatico.
      if (wasToc || ctx.inToc) {
        if (!ctx.tocInserted) { out.push({ type: "toc", id: ctx.doc.nextId++, maxLevel: 3, title: "Sommario" }); ctx.tocInserted = true; }
        continue;
      }
      // Titolo del sommario subito prima del campo
      if (p.props.style === "TOCHeading" && !ctx.tocInserted) continue;
      out.push(p);
    } else if (c.localName === "tbl") {
      if (!ctx.inToc) out.push(readTable(ctx, c));
    } else if (c.localName === "sdt") {
      const gallery = findFirst(c, "docPartGallery");
      if (gallery && /Table of Contents/i.test(attr(gallery, "val") ?? "")) {
        if (!ctx.tocInserted) { out.push({ type: "toc", id: ctx.doc.nextId++, maxLevel: 3, title: tocTitle(c) }); ctx.tocInserted = true; }
        ctx.inToc = false;
        ctx.field = null;
        continue;
      }
      readBlocks(ctx, kid(c, "sdtContent") ?? c, out);
    } else if (c.localName === "AlternateContent") {
      const branch = readAlternateContent(c);
      if (branch) readBlocks(ctx, branch, out);
    } else if (["customXml", "ins", "smartTag"].includes(c.localName)) {
      readBlocks(ctx, c, out);
    }
  }
}

function tocTitle(sdt: Element): string {
  for (const p of findAll(sdt, "p")) {
    const st = attr(kid(kid(p, "pPr"), "pStyle"), "val") ?? "";
    if (/toc ?heading|sommario|Titolosommario/i.test(st)) return p.textContent?.trim() || "Sommario";
  }
  return "Sommario";
}

function readHeaderFooter(ctx: Ctx, part: string): Paragraph[] {
  const data = getFile(ctx, part);
  if (!data) return [];
  const saved = ctx.rels;
  ctx.rels = relsFor(ctx, part);
  const blocks: Block[] = [];
  readBlocks(ctx, parse(strFromU8(data)).documentElement, blocks);
  ctx.rels = saved;
  const paras: Paragraph[] = [];
  for (const b of blocks) {
    if (b.type === "p") paras.push(b);
    else if (b.type === "table") for (const r of b.rows) {
      // Una tabella nell'intestazione (molto comune) diventa una riga con tabulazioni.
      const runs: Run[] = [];
      r.cells.forEach((cell, i) => { if (i) runs.push({ text: "\t", props: {} }); for (const p of cell.paragraphs) runs.push(...p.runs); });
      paras.push({ type: "p", id: ctx.doc.nextId++, props: { style: "Header" }, runs });
    }
  }
  // Intestazioni fatte solo di paragrafi vuoti: le ignoriamo.
  return paras.some((p) => p.runs.length) ? paras : [];
}

function appendNotes(ctx: Ctx): void {
  if (!ctx.notes.length) return;
  const loadMap = (part: string, tag: string) => {
    const bytes = getFile(ctx, part);
    const map = new Map<string, Element>();
    if (!bytes) return map;
    for (const n of findAll(parse(strFromU8(bytes)), tag)) {
      const id = attr(n, "id");
      if (id) map.set(id, n);
    }
    return map;
  };
  const fnMap = loadMap("word/footnotes.xml", "footnote");
  const enMap = loadMap("word/endnotes.xml", "endnote");
  const resolved: Paragraph[] = [];
  for (const ref of ctx.notes) {
    const el = ref.kind === "footnote" ? fnMap.get(ref.id) : enMap.get(ref.id);
    if (!el) continue;
    const savedRels = ctx.rels;
    ctx.rels = relsFor(ctx, ref.kind === "footnote" ? "word/footnotes.xml" : "word/endnotes.xml");
    const runs: Run[] = [{ text: `[${ref.num}] `, props: { bold: true, size: 9 } }];
    for (const p of kids(el, "p")) {
      const parsed = readParagraph(ctx, p);
      for (const r of parsed.runs) runs.push(r);
    }
    ctx.rels = savedRels;
    if (runs.length > 1) {
      resolved.push({ type: "p", id: ctx.doc.nextId++, props: { spaceAfter: 3 }, runs });
    }
  }
  if (resolved.length) {
    ctx.doc.blocks.push({ type: "p", id: ctx.doc.nextId++, props: { spaceBefore: 12, spaceAfter: 4 }, runs: [{ text: "Note", props: { bold: true, size: 10, color: "#555555" } }] });
    ctx.doc.blocks.push(...resolved);
  }
}

/** Legge un file .docx. Lancia un errore con un messaggio comprensibile se non è valido. */
export function importDocx(bytes: Uint8Array): DocumentModel {
  let raw: Record<string, Uint8Array>;
  try { raw = unzipSync(bytes); } catch { throw new Error("Il file non è un documento .docx valido (archivio danneggiato)"); }
  const zip = normalizeZip(raw);
  const main = (zip.files["word/document.xml"] ? "word/document.xml" : undefined)
    ?? zip.lower.get("word/document.xml")
    ?? findMainPart(zip);
  if (!main) throw new Error("Il file non contiene un documento di Word");
  const doc = newDocument();
  doc.blocks = [];
  const ctx: Ctx = { doc, files: zip.files, lower: zip.lower, rels: relsFor(zip, main), theme: { colors: {} }, styleIds: new Map(), field: null, tocInserted: false, inToc: false, notes: [] };
  readTheme(ctx);
  readStyles(ctx);
  readNumbering(ctx);

  const mainBytes = getFile(ctx, main);
  if (!mainBytes) throw new Error("Il file non contiene il corpo del documento");
  const xml = parse(strFromU8(mainBytes));
  if (xml.getElementsByTagName("parsererror").length) throw new Error("Il documento contiene XML non valido");
  const body = kid(xml.documentElement, "body");
  if (!body) throw new Error("Il documento è vuoto o non valido");

  // Leggiamo prima le dimensioni pagina (così tabelle senza griglia conoscono la larghezza utile).
  const sect = kid(body, "sectPr") ?? findAll(body, "sectPr").pop();
  if (sect) {
    const sz = kid(sect, "pgSz"), mar = kid(sect, "pgMar");
    let w = twip(attr(sz, "w")), hh = twip(attr(sz, "h"));
    if (w && hh) {
      if (attr(sz, "orient") === "landscape" && w < hh) [w, hh] = [hh, w];
      doc.page.width = w; doc.page.height = hh;
    }
    const m = (n: string) => twip(attr(mar, n));
    doc.page.marginTop = Math.abs(m("top") ?? doc.page.marginTop);
    doc.page.marginBottom = Math.abs(m("bottom") ?? doc.page.marginBottom);
    doc.page.marginLeft = Math.max(0, m("left") ?? m("start") ?? doc.page.marginLeft);
    doc.page.marginRight = Math.max(0, m("right") ?? m("end") ?? doc.page.marginRight);
    doc.page.headerDistance = Math.max(0, m("header") ?? doc.page.headerDistance);
    doc.page.footerDistance = Math.max(0, m("footer") ?? doc.page.footerDistance);
  }

  readBlocks(ctx, body, doc.blocks);

  // Intestazione e piè di pagina
  if (sect) {
    const ref = (kind: string) => {
      const refs = kids(sect, kind);
      const r = refs.find((x) => attr(x, "type") === "default") ?? refs[0];
      const id = r ? attr(r, "id", "r") : null;
      return id ? ctx.rels.get(id)?.target : undefined;
    };
    const hdr = ref("headerReference"), ftr = ref("footerReference");
    if (hdr) doc.header = readHeaderFooter(ctx, hdr);
    if (ftr) doc.footer = readHeaderFooter(ctx, ftr);
  }

  appendNotes(ctx);

  // Commenti a margine (word/comments.xml)
  const commentsBytes = getFile(ctx, "word/comments.xml");
  if (commentsBytes) {
    const cXml = parse(strFromU8(commentsBytes));
    const list: NonNullable<DocumentModel["comments"]> = [];
    for (const cm of findAll(cXml, "comment")) {
      const id = num(attr(cm, "id")) ?? list.length + 1;
      const author = attr(cm, "author") ?? "Autore";
      const date = attr(cm, "date") ?? "";
      const text = kids(cm, "p").map((p) => p.textContent?.trim() ?? "").filter(Boolean).join(" ");
      if (text) list.push({ id, author, date, text, quote: "" });
    }
    if (list.length) doc.comments = list;
  }

  // Adattamento immagini più larghe della pagina (mantenendo le proporzioni).
  const maxImgW = Math.max(100, doc.page.width - doc.page.marginLeft - doc.page.marginRight);
  const clampRuns = (runs: Run[]) => {
    for (const r of runs) {
      if (r.type === "image" && r.width > maxImgW) {
        const s = maxImgW / r.width;
        r.width *= s; r.height *= s;
      }
    }
  };
  for (const b of doc.blocks) {
    if (b.type === "p") clampRuns(b.runs);
    else if (b.type === "table") for (const row of b.rows) for (const c of row.cells) for (const p of c.paragraphs) clampRuns(p.runs);
  }

  // Paragrafi di elenco che puntano a numerazioni inesistenti: niente elenco.
  for (const b of doc.blocks) if (b.type === "p" && b.props.numId !== undefined && (b.props.numId === 0 || !doc.numbering[b.props.numId])) { delete b.props.numId; delete b.props.numLevel; }
  if (!doc.blocks.some((b) => b.type === "p")) doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  // Il documento deve finire con un paragrafo (dopo una tabella si deve poter scrivere).
  if (doc.blocks[doc.blocks.length - 1].type !== "p") doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  return doc;
}

function findMainPart(zip: { files: Record<string, Uint8Array>; lower: Map<string, string> }): string | undefined {
  const rels = getFile(zip, "_rels/.rels");
  if (!rels) return undefined;
  for (const rel of findAll(parse(strFromU8(rels)), "Relationship")) {
    if ((rel.getAttribute("Type") ?? "").endsWith("/officeDocument")) return resolvePath("", rel.getAttribute("Target") ?? "");
  }
  return undefined;
}
