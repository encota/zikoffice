// Apertura dei .pptx: testo, forme, immagini e tabelle diventano modificabili; grafici, SmartArt,
// video e simili restano come sono (copiati nel file al salvataggio).
import { strFromU8, unzipSync } from "fflate";
import type { Align, Anchor, Bullet, CustomPath, Frame, Geometry, LayoutId, Para, Presentation, RawItem, Role, ShapeItem, Slide, SlideItem, TableCell, TextRun, Theme } from "./model";
import { DEFAULT_THEME } from "./themes";

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const pt = (emu: string | null | undefined, fallback = 0) => (emu == null || emu === "" ? fallback : Number(emu) / 12700);

type Files = Record<string, Uint8Array>;

function parse(bytes: Uint8Array | undefined): Document | null {
  if (!bytes) return null;
  const doc = new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
  return doc.getElementsByTagName("parsererror").length ? null : doc;
}

/** Figli diretti con un certo nome locale. */
const kids = (el: Element | null | undefined, name: string): Element[] => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el: Element | null | undefined, name: string): Element | undefined => kids(el, name)[0];
const path = (el: Element | null | undefined, ...names: string[]): Element | undefined => {
  let cur: Element | undefined = el ?? undefined;
  for (const n of names) cur = kid(cur, n);
  return cur;
};
const rAttr = (el: Element | undefined, name: string) => el?.getAttributeNS(NS_R, name) ?? el?.getAttribute(`r:${name}`) ?? null;

interface Rel { type: string; target: string; external: boolean }

function resolve(dir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = dir ? dir.split("/") : [];
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

const dirOf = (p: string) => p.replace(/\/[^/]*$/, "");
const relsPath = (p: string) => `${dirOf(p)}/_rels/${p.split("/").pop()}.rels`;

function readRels(files: Files, part: string): Map<string, Rel> {
  const out = new Map<string, Rel>();
  const doc = parse(files[relsPath(part)]);
  if (!doc) return out;
  for (const r of doc.getElementsByTagName("Relationship")) {
    const external = r.getAttribute("TargetMode") === "External";
    const target = r.getAttribute("Target") ?? "";
    out.set(r.getAttribute("Id") ?? "", { type: (r.getAttribute("Type") ?? "").split("/").pop() ?? "", target: external ? target : resolve(dirOf(part), target), external });
  }
  return out;
}

// ---------- colori ----------

interface ColorCtx { scheme: Record<string, string>; map: Record<string, string> }

function hsl(hex: string): [number, number, number] {
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}

const PRESET: Record<string, string> = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080" };

function colorOf(el: Element | undefined, ctx: ColorCtx, phClr?: string): string | undefined {
  if (!el) return undefined;
  let hex: string | undefined;
  switch (el.localName) {
    case "srgbClr": hex = el.getAttribute("val") ?? undefined; break;
    case "sysClr": hex = el.getAttribute("lastClr") ?? (el.getAttribute("val") === "window" ? "FFFFFF" : "000000"); break;
    case "prstClr": hex = PRESET[el.getAttribute("val") ?? ""] ?? "000000"; break;
    case "schemeClr": {
      const v = el.getAttribute("val") ?? "";
      if (v === "phClr") { hex = phClr?.replace("#", ""); break; }
      hex = ctx.scheme[ctx.map[v] ?? v]?.replace("#", "");
      break;
    }
    case "scrgbClr": {
      const c = ["r", "g", "b"].map((k) => Math.round((Number(el.getAttribute(k)) / 100000) * 255));
      hex = c.map((v) => v.toString(16).padStart(2, "0")).join("");
      break;
    }
    default: return undefined;
  }
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  // Modificatori: luminosità (lumMod/lumOff), tinta (tint) e ombra (shade).
  let [h, s, l] = hsl(hex);
  let touched = false;
  for (const m of el.children) {
    const v = Number(m.getAttribute("val")) / 100000;
    if (m.localName === "lumMod") { l *= v; touched = true; }
    else if (m.localName === "lumOff") { l += v; touched = true; }
    else if (m.localName === "tint") { l = l + (1 - l) * (1 - v); touched = true; }
    else if (m.localName === "shade") { l *= v; touched = true; }
  }
  if (touched) hex = fromHsl(h, s, Math.max(0, Math.min(1, l)));
  return `#${hex.toLowerCase()}`;
}

const firstColor = (el: Element | undefined, ctx: ColorCtx, phClr?: string) =>
  el ? colorOf([...el.children].find((c) => /Clr$/.test(c.localName)), ctx, phClr) : undefined;

// ---------- testo ----------

interface Inherit {
  /** Proprietà di testo per livello ereditate da layout e schema. */
  levels: { size?: number; color?: string; bold?: boolean; font?: string; bullet?: Bullet; align?: Align; spacing?: { line?: number; before?: number; after?: number }; cap?: string; spc?: number }[];
  anchor?: Anchor;
}

interface Ctx {
  files: Files;
  color: ColorCtx;
  fonts: { major: string; minor: string };
  rels: Map<string, Rel>;
  p: Presentation;
  notes: string[];
  /** Riempimento del gruppo che contiene la forma (per a:grpFill). */
  groupFill?: string | null;
}

function fontName(v: string | null, ctx: Ctx): string | undefined {
  if (!v) return undefined;
  if (v.startsWith("+mj")) return ctx.fonts.major;
  if (v.startsWith("+mn")) return ctx.fonts.minor;
  return v;
}

function levelProps(lvl: Element | undefined, ctx: Ctx): Inherit["levels"][number] {
  const out: Inherit["levels"][number] = {};
  if (!lvl) return out;
  const def = kid(lvl, "defRPr");
  if (def?.getAttribute("sz")) out.size = Number(def.getAttribute("sz")) / 100;
  if (def?.getAttribute("b")) out.bold = def.getAttribute("b") === "1";
  if (def?.getAttribute("cap")) out.cap = def.getAttribute("cap")!;
  if (def?.getAttribute("spc")) out.spc = Number(def.getAttribute("spc"));
  const fill = kid(def, "solidFill");
  if (fill) out.color = firstColor(fill, ctx.color);
  const latin = kid(def, "latin");
  if (latin) out.font = fontName(latin.getAttribute("typeface"), ctx);
  if (kid(lvl, "buNone")) out.bullet = "none";
  else if (kid(lvl, "buAutoNum")) out.bullet = "number";
  else if (kid(lvl, "buChar") || kid(lvl, "buBlip")) out.bullet = "bullet";
  // Interlinea e spazi: le percentuali (spcPct) si convertono con la dimensione del testo.
  const pts = (el: Element | undefined) => {
    const p = kid(el, "spcPts")?.getAttribute("val");
    if (p) return Number(p) / 100;
    const pc = kid(el, "spcPct")?.getAttribute("val");
    return pc ? (Number(pc) / 100000) * (out.size ?? 18) : undefined;
  };
  const ln = kid(kid(lvl, "lnSpc"), "spcPct")?.getAttribute("val");
  const spacing = { line: ln ? Number(ln) / 100000 : undefined, before: pts(kid(lvl, "spcBef")), after: pts(kid(lvl, "spcAft")) };
  if (spacing.line !== undefined || spacing.before !== undefined || spacing.after !== undefined) out.spacing = spacing;
  const algn = lvl.getAttribute("algn");
  if (algn === "l" || algn === "ctr" || algn === "r" || algn === "just") out.align = algn;
  return out;
}

function mergeInherit(base: Inherit, lst: Element | undefined, ctx: Ctx): Inherit {
  const levels = base.levels.map((l) => ({ ...l }));
  for (let i = 0; i < 9; i++) {
    const props = levelProps(kid(lst, `lvl${i + 1}pPr`), ctx);
    levels[i] = { ...(levels[i] ?? {}), ...Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)) };
  }
  return { ...base, levels };
}

function readRun(r: Element, inh: Inherit["levels"][number], ctx: Ctx, fontColor?: string): TextRun {
  const rPr = kid(r, "rPr");
  const run: TextRun = { text: r.localName === "br" ? "\n" : kid(r, "t")?.textContent ?? "" };
  const size = rPr?.getAttribute("sz") ? Number(rPr.getAttribute("sz")) / 100 : inh.size;
  if (size) run.size = size;
  const b = rPr?.getAttribute("b");
  if (b ? b === "1" || b === "true" : inh.bold) run.b = true;
  const i = rPr?.getAttribute("i");
  if (i === "1" || i === "true") run.i = true;
  const u = rPr?.getAttribute("u");
  if (u && u !== "none") run.u = true;
  const strike = rPr?.getAttribute("strike");
  if (strike && strike !== "noStrike") run.strike = true;
  const spc = Number(rPr?.getAttribute("spc") ?? inh.spc ?? 0);
  if (spc) run.spacing = spc / 100;
  const cap = rPr?.getAttribute("cap") ?? inh.cap;
  if (cap === "all" || cap === "small") run.caps = cap;
  const color = firstColor(kid(rPr, "solidFill"), ctx.color) ?? inh.color ?? fontColor;
  if (color) run.color = color;
  const font = fontName(kid(rPr, "latin")?.getAttribute("typeface") ?? null, ctx) ?? inh.font;
  if (font) run.font = font;
  const link = rAttr(kid(rPr, "hlinkClick"), "id");
  if (link) {
    const rel = ctx.rels.get(link);
    if (rel?.external) run.link = rel.target;
  }
  return run;
}

function readParas(txBody: Element | undefined, inh: Inherit, ctx: Ctx, fontColor?: string): Para[] {
  const own = mergeInherit(inh, kid(txBody, "lstStyle"), ctx);
  return kids(txBody, "p").map((p) => {
    const pPr = kid(p, "pPr");
    const level = Math.min(4, Number(pPr?.getAttribute("lvl") ?? 0) || 0);
    const lv = { ...(own.levels[level] ?? {}), ...Object.fromEntries(Object.entries(levelProps(pPr, ctx)).filter(([, v]) => v !== undefined)) };
    const runs: TextRun[] = [];
    for (const r of p.children) {
      if (r.localName === "r" || r.localName === "br" || r.localName === "fld") {
        const run = readRun(r, lv, ctx, fontColor);
        const last = runs[runs.length - 1];
        const { text: _a, ...fa } = run;
        if (last) {
          const { text: _b, ...fb } = last;
          if (JSON.stringify(fa) === JSON.stringify(fb)) { last.text += run.text; continue; }
        }
        runs.push(run);
      }
    }
    // Un a capo finale da solo non serve.
    const para: Para = { runs: runs.filter((r) => r.text), level, bullet: lv.bullet ?? "none" };
    if (lv.align) para.align = lv.align;
    const sp = lv.spacing;
    if (sp?.line) para.lineSpacing = sp.line;
    if (sp?.before !== undefined) para.spaceBefore = sp.before;
    if (sp?.after !== undefined) para.spaceAfter = sp.after;
    return para;
  });
}

// ---------- forme ----------

const GEOM: Record<string, Geometry> = {
  rect: "rect", roundRect: "roundRect", snipRoundRect: "roundRect", round2SameRect: "roundRect", flowChartAlternateProcess: "roundRect",
  ellipse: "ellipse", flowChartConnector: "ellipse", donut: "ellipse",
  triangle: "triangle", rtTriangle: "triangle", flowChartExtract: "triangle",
  rightArrow: "rightArrow", diamond: "diamond", flowChartDecision: "diamond",
  chevron: "chevron", homePlate: "chevron", star5: "star5",
  line: "line", straightConnector1: "line", bentConnector2: "line", bentConnector3: "line", curvedConnector3: "line",
};

interface Xf { frame: Frame; flipH: boolean; flipV: boolean }

function readXfrm(x: Element | undefined): Xf | undefined {
  if (!x) return undefined;
  const off = kid(x, "off"), ext = kid(x, "ext");
  if (!off || !ext) return undefined;
  const frame: Frame = { x: pt(off.getAttribute("x")), y: pt(off.getAttribute("y")), w: pt(ext.getAttribute("cx")), h: pt(ext.getAttribute("cy")) };
  const rot = Number(x.getAttribute("rot") ?? 0) / 60000;
  if (rot) frame.rot = rot;
  return { frame, flipH: x.getAttribute("flipH") === "1", flipV: x.getAttribute("flipV") === "1" };
}

/** Trasformazione di un gruppo: dalle coordinate dei figli a quelle della diapositiva. */
type Tx = (f: Frame) => Frame;
const identity: Tx = (f) => f;

function groupTx(grpSpPr: Element | undefined, outer: Tx): Tx {
  const x = kid(grpSpPr, "xfrm");
  if (!x) return outer;
  const off = kid(x, "off"), ext = kid(x, "ext"), chOff = kid(x, "chOff"), chExt = kid(x, "chExt");
  if (!off || !ext || !chOff || !chExt) return outer;
  const ox = pt(off.getAttribute("x")), oy = pt(off.getAttribute("y"));
  const cx = pt(chOff.getAttribute("x")), cy = pt(chOff.getAttribute("y"));
  const sx = pt(chExt.getAttribute("cx")) ? pt(ext.getAttribute("cx")) / pt(chExt.getAttribute("cx")) : 1;
  const sy = pt(chExt.getAttribute("cy")) ? pt(ext.getAttribute("cy")) / pt(chExt.getAttribute("cy")) : 1;
  return (f) => outer({ ...f, x: ox + (f.x - cx) * sx, y: oy + (f.y - cy) * sy, w: f.w * sx, h: f.h * sy });
}

interface PhInfo { type: string; idx: string; frame?: Frame; inherit: Inherit; anchor?: Anchor; inset?: [number, number, number, number] }

/** Segnaposto di layout e schema, per ereditare posizione e stile. */
interface PhSource { list: PhInfo[]; master: { title: Inherit; body: Inherit; other: Inherit } }

const phKey = (type: string) => (type === "ctrTitle" ? "title" : type === "subTitle" || type === "obj" || type === "" ? "body" : type);

function findPh(src: PhSource[], type: string, idx: string): PhInfo | undefined {
  for (const s of src) {
    const byIdx = idx ? s.list.find((p) => p.idx === idx && (phKey(p.type) === phKey(type) || !type || !p.type)) : undefined;
    const byType = s.list.find((p) => phKey(p.type) === phKey(type) && (type !== "" || !p.idx || p.idx === idx));
    const hit = byIdx ?? byType ?? (idx ? s.list.find((p) => p.idx === idx) : undefined);
    if (hit) return hit;
  }
  return undefined;
}

function bodyPrInfo(bodyPr: Element | undefined): { anchor?: Anchor; inset?: [number, number, number, number]; fit?: number; noWrap?: boolean } {
  if (!bodyPr) return {};
  const a = bodyPr.getAttribute("anchor");
  const anchor = a === "t" || a === "ctr" || a === "b" ? a : undefined;
  const ins = ["lIns", "tIns", "rIns", "bIns"].map((k) => bodyPr.getAttribute(k));
  const inset = ins.some((v) => v !== null)
    ? ins.map((v, i) => (v === null ? (i % 2 ? 3.6 : 7.2) : pt(v))) as [number, number, number, number] : undefined;
  const fs = kid(bodyPr, "normAutofit")?.getAttribute("fontScale");
  return { anchor, inset, fit: fs ? Number(fs) / 100000 : undefined, noWrap: bodyPr.getAttribute("wrap") === "none" || undefined };
}

function shapeFill(spPr: Element | undefined, style: Element | undefined, ctx: Ctx): string | null | undefined {
  if (kid(spPr, "noFill")) return null;
  if (kid(spPr, "grpFill")) return ctx.groupFill ?? null;
  const sf = kid(spPr, "solidFill");
  if (sf) return firstColor(sf, ctx.color) ?? null;
  const grad = kid(spPr, "gradFill");
  if (grad) {
    // Sfumatura: si usa il primo colore.
    const gs = path(grad, "gsLst")?.children[0];
    return firstColor(gs, ctx.color) ?? null;
  }
  const ref = kid(style, "fillRef");
  if (ref && Number(ref.getAttribute("idx")) > 0) return firstColor(ref, ctx.color) ?? null;
  return null;
}

function shapeLine(spPr: Element | undefined, style: Element | undefined, ctx: Ctx): { color: string; width: number } | null {
  const ln = kid(spPr, "ln");
  if (ln && kid(ln, "noFill")) return null;
  const width = ln?.getAttribute("w") ? pt(ln.getAttribute("w")) : 0.75;
  const c = firstColor(kid(ln, "solidFill"), ctx.color);
  if (c) return { color: c, width };
  const ref = kid(style, "lnRef");
  if (ref && Number(ref.getAttribute("idx")) > 0) {
    const rc = firstColor(ref, ctx.color);
    if (rc) return { color: rc, width };
  }
  return null;
}

function readShape(sp: Element, tx: Tx, ctx: Ctx, phs: PhSource[], layout: LayoutId, decor: boolean): ShapeItem | null {
  const nvPr = path(sp, "nvSpPr", "nvPr") ?? path(sp, "nvCxnSpPr", "nvPr");
  const phEl = kid(nvPr, "ph");
  const spPr = kid(sp, "spPr");
  const style = kid(sp, "style");
  const xf = readXfrm(kid(spPr, "xfrm"));
  let role: Role = "text";
  let inherit: Inherit = { levels: [] };
  let frame = xf?.frame;
  let anchor: Anchor | undefined, inset: [number, number, number, number] | undefined;
  if (phEl) {
    if (decor) return null; // i segnaposto di layout e schema non sono decorazioni
    const type = phEl.getAttribute("type") ?? "";
    const idx = phEl.getAttribute("idx") ?? "";
    if (["dt", "ftr", "sldNum", "hdr", "sldImg"].includes(type)) {
      // Data, piè di pagina e numero: si tengono solo se hanno testo scritto sulla diapositiva.
      if (!kid(sp, "txBody")?.textContent?.trim()) return null;
    }
    role = type === "title" || type === "ctrTitle" ? "title" : type === "subTitle" ? "subtitle" : ["dt", "ftr", "sldNum", "hdr"].includes(type) ? "text" : "body";
    if (role === "subtitle" && layout !== "title") role = layout === "section" ? "subtitle" : "body";
    const info = findPh(phs, type, idx);
    frame ??= info?.frame;
    anchor = info?.anchor;
    inset = info?.inset;
    const m = phs[phs.length - 1]?.master;
    const base = role === "title" ? m?.title : role === "text" ? m?.other : m?.body;
    inherit = info ? mergeInherit(base ?? { levels: [] }, undefined, ctx) : base ?? { levels: [] };
    if (info) inherit = { ...inherit, levels: inherit.levels.map((l, i) => ({ ...l, ...Object.fromEntries(Object.entries(info.inherit.levels[i] ?? {}).filter(([, v]) => v !== undefined)) })) };
  } else {
    inherit = phs[phs.length - 1]?.master.other ?? { levels: [] };
  }
  const prstEl = kid(spPr, "prstGeom");
  const prst = prstEl?.getAttribute("prst") ?? (sp.localName === "cxnSp" ? "line" : "rect");
  const geom = GEOM[prst] ?? "rect";
  const custEl = kid(spPr, "custGeom");
  const custom = custEl ? customPaths(custEl) : null;
  const fill = shapeFill(spPr, style, ctx);
  const line = shapeLine(spPr, style, ctx);
  const txBody = kid(sp, "txBody");
  const fontRefColor = firstColor(kid(style, "fontRef"), ctx.color);
  const bp = bodyPrInfo(kid(txBody, "bodyPr"));
  const paras = txBody ? readParas(txBody, inherit, ctx, fontRefColor) : [];
  if (!frame && role === "text") return null;
  const item: ShapeItem = {
    kind: "shape", id: ctx.p.nextId++, role, geom, paras: paras.length ? paras : [{ runs: [], level: 0 }],
    fill, line: geom === "line" ? line ?? { color: "#000000", width: 0.75 } : line,
  };
  if (frame) item.frame = tx(frame);
  const a = bp.anchor ?? anchor ?? (role === "title" ? "b" : role === "text" && fill ? "ctr" : "t");
  item.anchor = a;
  item.inset = bp.inset ?? inset ?? [7.2, 3.6, 7.2, 3.6];
  if (bp.fit) item.fit = bp.fit;
  if (bp.noWrap) item.noWrap = true;
  if (custEl) {
    const xml = new XMLSerializer().serializeToString(custEl);
    // Un tracciato che non sappiamo leggere (formule) si mostra come rettangolo ma si salva com'era.
    if (custom) item.custom = { xml, paths: custom }; else item.prstXml = xml;
  } else if (prstEl && (!GEOM[prst] || GEOM[prst] !== prst || kid(prstEl, "avLst")?.children.length)) {
    // Varianti (es. angoli diversi, forme rare): la forma torna in PowerPoint identica.
    item.prstXml = new XMLSerializer().serializeToString(prstEl);
  }
  if (xf?.flipH) item.flipH = true;
  if (xf?.flipV) item.flipV = true;
  // Le forme importate hanno colori e dimensioni scritti per esteso: il tema non li cambia.
  for (const p of item.paras) for (const r of p.runs) {
    r.b ??= false;
    r.size ??= inherit.levels[p.level]?.size ?? (role === "title" ? 44 : 18);
    r.color ??= fontRefColor ?? ctx.color.scheme.dk1;
    r.font ??= role === "title" ? ctx.fonts.major : ctx.fonts.minor;
  }
  return item;
}

/** Converte i tracciati DrawingML (a:path) in tracciati SVG; null se usano formule. */
function customPaths(cust: Element): CustomPath[] | null {
  const out: CustomPath[] = [];
  const num = (v: string | null) => (v !== null && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN);
  for (const path of kids(kid(cust, "pathLst"), "path")) {
    const w = num(path.getAttribute("w") ?? "0"), h = num(path.getAttribute("h") ?? "0");
    if (Number.isNaN(w) || Number.isNaN(h)) return null;
    let cx = 0, cy = 0;
    const d: string[] = [];
    const pts = (el: Element) => kids(el, "pt").map((p) => [num(p.getAttribute("x")), num(p.getAttribute("y"))]);
    for (const c of path.children) {
      if (c.localName === "close") { d.push("Z"); continue; }
      if (c.localName === "arcTo") {
        const wR = num(c.getAttribute("wR")), hR = num(c.getAttribute("hR"));
        const st = num(c.getAttribute("stAng")) / 60000 * Math.PI / 180, sw = num(c.getAttribute("swAng")) / 60000 * Math.PI / 180;
        if ([wR, hR, st, sw].some(Number.isNaN)) return null;
        // Gli angoli di DrawingML sono "visivi": si convertono nel parametro dell'ellisse.
        const param = (a: number) => Math.atan2(wR * Math.sin(a), hR * Math.cos(a));
        const t1 = param(st), t2 = param(st + sw);
        const ox = cx - wR * Math.cos(t1), oy = cy - hR * Math.sin(t1);
        cx = ox + wR * Math.cos(t2); cy = oy + hR * Math.sin(t2);
        if (Math.abs(sw) >= 2 * Math.PI - 1e-6) {
          // Ellisse completa: due archi.
          const mx = ox - (cx - ox), my = oy - (cy - oy);
          d.push(`A${wR},${hR} 0 1 ${sw > 0 ? 1 : 0} ${mx},${my} A${wR},${hR} 0 1 ${sw > 0 ? 1 : 0} ${cx},${cy}`);
        } else d.push(`A${wR},${hR} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${cx},${cy}`);
        continue;
      }
      const p = pts(c);
      if (p.flat().some(Number.isNaN)) return null;
      const cmd = { moveTo: "M", lnTo: "L", cubicBezTo: "C", quadBezTo: "Q" }[c.localName];
      if (!cmd || !p.length) continue;
      d.push(cmd + p.map(([x, y]) => `${x},${y}`).join(" "));
      [cx, cy] = p[p.length - 1];
    }
    const cp: CustomPath = { w, h, d: d.join(" ") };
    if (path.getAttribute("fill") === "none") cp.noFill = true;
    if (path.getAttribute("stroke") === "0" || path.getAttribute("stroke") === "false") cp.noStroke = true;
    out.push(cp);
  }
  return out.length ? out : null;
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff" };

function imageSize(bytes: Uint8Array, mime: string): [number, number] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mime === "image/png" && bytes.length > 24) return [dv.getUint32(16), dv.getUint32(20)];
    if (mime === "image/gif" && bytes.length > 10) return [dv.getUint16(6, true), dv.getUint16(8, true)];
    if (mime === "image/jpeg") {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) { i++; continue; }
        const m = bytes[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [dv.getUint16(i + 7), dv.getUint16(i + 5)];
        i += 2 + dv.getUint16(i + 2);
      }
    }
  } catch { /* dimensione sconosciuta */ }
  return [0, 0];
}

export function mimeOf(name: string): string {
  return MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

function readPic(pic: Element, tx: Tx, ctx: Ctx): SlideItem | null {
  const xf = readXfrm(path(pic, "spPr", "xfrm"));
  const blip = path(pic, "blipFill", "blip");
  const rel = ctx.rels.get(rAttr(blip, "embed") ?? "");
  if (!xf || !rel || rel.external) return null;
  const bytes = ctx.files[rel.target];
  if (!bytes) return null;
  const mime = mimeOf(rel.target);
  if (!mime.startsWith("image/") || /x-emf|x-wmf/.test(mime)) return null;
  const [natW, natH] = imageSize(bytes, mime);
  const alt = path(pic, "nvPicPr", "cNvPr")?.getAttribute("descr") ?? undefined;
  return { kind: "image", id: ctx.p.nextId++, frame: tx(xf.frame), bytes, mime, natW: natW || xf.frame.w, natH: natH || xf.frame.h, alt };
}

function readTable(gf: Element, frame: Frame, ctx: Ctx): SlideItem | null {
  const tbl = path(gf, "graphic", "graphicData", "tbl");
  if (!tbl) return null;
  const cols = kids(kid(tbl, "tblGrid"), "gridCol").map((c) => Number(c.getAttribute("w")) || 1);
  const header = kid(tbl, "tblPr")?.getAttribute("firstRow") === "1";
  const rows: TableCell[][] = kids(tbl, "tr").map((tr) => kids(tr, "tc").filter((tc) => tc.getAttribute("hMerge") !== "1").map((tc) => {
    const cell: TableCell = { paras: readParas(kid(tc, "txBody"), { levels: [] }, ctx) };
    const fill = firstColor(path(tc, "tcPr", "solidFill"), ctx.color);
    if (fill) cell.fill = fill;
    return cell;
  }));
  if (!rows.length) return null;
  return { kind: "table", id: ctx.p.nextId++, frame, rows, header, cols };
}

function closure(files: Files, start: string[], seen: Set<string>): void {
  for (const part of start) {
    if (seen.has(part) || !files[part]) continue;
    seen.add(part);
    const rp = relsPath(part);
    if (files[rp]) {
      seen.add(rp);
      closure(files, [...readRels(files, part).values()].filter((r) => !r.external).map((r) => r.target), seen);
    }
  }
}

function readRaw(el: Element, frame: Frame, ctx: Ctx, label: string, contentTypes: Map<string, string>): RawItem {
  const xml = new XMLSerializer().serializeToString(el);
  const parts: RawItem["parts"] = {};
  for (const m of xml.matchAll(/\sr:\w+="(rId\w+)"/g)) {
    const rel = ctx.rels.get(m[1]);
    if (!rel) continue;
    parts[m[1]] = rel.external ? { type: rel.type, path: "", external: rel.target } : { type: rel.type, path: rel.target };
  }
  const seen = new Set<string>();
  closure(ctx.files, Object.values(parts).filter((p) => p.path).map((p) => p.path), seen);
  for (const part of seen) {
    ctx.p.parts[part] = { bytes: ctx.files[part], type: part.endsWith(".rels") ? "" : contentTypes.get(`/${part}`) ?? "" };
  }
  return { kind: "raw", id: ctx.p.nextId++, frame, xml, parts, closure: [...seen], label };
}

function rawLabel(uri: string): string {
  if (uri.includes("/chart")) return "Grafico (si modifica in PowerPoint)";
  if (uri.includes("/diagram")) return "SmartArt (si modifica in PowerPoint)";
  if (uri.includes("ole") || uri.includes("/presentationml/2006/ole")) return "Oggetto incorporato";
  return "Oggetto non modificabile";
}

function readTree(tree: Element | undefined, tx: Tx, ctx: Ctx, phs: PhSource[], layout: LayoutId, decor: boolean, ct: Map<string, string>, out: SlideItem[]): void {
  for (const el of tree?.children ?? []) {
    switch (el.localName) {
      case "sp": case "cxnSp": {
        const s = readShape(el, tx, ctx, phs, layout, decor);
        if (s) out.push(s);
        break;
      }
      case "pic": {
        const pic = readPic(el, tx, ctx);
        if (pic) out.push(pic);
        break;
      }
      case "grpSp": {
        const gp = kid(el, "grpSpPr");
        const own = gp && (kid(gp, "solidFill") || kid(gp, "gradFill") || kid(gp, "noFill") || kid(gp, "grpFill")) ? shapeFill(gp, undefined, ctx) : ctx.groupFill;
        readTree(el, groupTx(gp, tx), { ...ctx, groupFill: own }, phs, layout, decor, ct, out);
        break;
      }
      case "graphicFrame": {
        const xf = readXfrm(kid(el, "xfrm"));
        if (!xf) break;
        const frame = tx(xf.frame);
        const uri = path(el, "graphic", "graphicData")?.getAttribute("uri") ?? "";
        const table = uri.endsWith("/table") ? readTable(el, frame, ctx) : null;
        out.push(table ?? readRaw(el, frame, ctx, rawLabel(uri), ct));
        break;
      }
      case "AlternateContent": {
        // Contenuti di versioni più recenti (es. video, modelli 3D): si usa la versione di riserva.
        const fb = kid(el, "Fallback") ?? kid(el, "Choice");
        if (fb) readTree(fb, tx, ctx, phs, layout, decor, ct, out);
        break;
      }
    }
  }
}

function readPhList(tree: Element | undefined, ctx: Ctx): PhInfo[] {
  const list: PhInfo[] = [];
  for (const sp of tree?.getElementsByTagNameNS("*", "sp") ?? []) {
    const ph = path(sp, "nvSpPr", "nvPr", "ph");
    if (!ph) continue;
    const bp = bodyPrInfo(path(sp, "txBody", "bodyPr"));
    list.push({
      type: ph.getAttribute("type") ?? "", idx: ph.getAttribute("idx") ?? "",
      frame: readXfrm(path(sp, "spPr", "xfrm"))?.frame,
      inherit: mergeInherit({ levels: [] }, path(sp, "txBody", "lstStyle"), ctx), anchor: bp.anchor, inset: bp.inset,
    });
  }
  return list;
}

const LAYOUTS: Record<string, LayoutId> = { title: "title", obj: "content", tx: "content", twoObj: "two", twoTxTwoObj: "two", secHead: "section", titleOnly: "titleOnly", blank: "blank", cust: "content" };

function readBg(cSld: Element | undefined, ctx: Ctx): { color?: string; image?: { bytes: Uint8Array; mime: string } } | undefined {
  const bg = kid(cSld, "bg");
  if (!bg) return undefined;
  const bgPr = kid(bg, "bgPr");
  if (bgPr) {
    const blip = path(bgPr, "blipFill", "blip");
    if (blip) {
      const rel = ctx.rels.get(rAttr(blip, "embed") ?? "");
      const bytes = rel && !rel.external ? ctx.files[rel.target] : undefined;
      if (bytes && mimeOf(rel!.target).startsWith("image/")) return { image: { bytes, mime: mimeOf(rel!.target) } };
    }
    const c = shapeFill(bgPr, undefined, ctx);
    return c ? { color: c } : undefined;
  }
  const ref = kid(bg, "bgRef");
  const c = firstColor(ref, ctx.color);
  return c ? { color: c } : undefined;
}

function plainText(txBody: Element | undefined): string {
  return kids(txBody, "p").map((p) => [...p.children].map((r) => (r.localName === "br" ? "\n" : r.localName === "r" || r.localName === "fld" ? kid(r, "t")?.textContent ?? "" : "")).join("")).join("\n");
}

export function importPptx(bytes: Uint8Array): Presentation {
  const raw = unzipSync(bytes);
  // I nomi delle parti nel pacchetto non distinguono maiuscole: si normalizzano i percorsi.
  const files: Files = {};
  for (const [k, v] of Object.entries(raw)) files[k.replace(/^\//, "")] = v;
  const ctDoc = parse(files["[Content_Types].xml"]);
  const ct = new Map<string, string>();
  for (const o of ctDoc?.getElementsByTagName("Override") ?? []) ct.set(o.getAttribute("PartName") ?? "", o.getAttribute("ContentType") ?? "");

  const presPath = "ppt/presentation.xml";
  const pres = parse(files[presPath]);
  if (!pres) throw new Error("Il file non è una presentazione PowerPoint valida (manca ppt/presentation.xml)");
  const presRels = readRels(files, presPath);
  const root = pres.documentElement;
  const sz = kid(root, "sldSz");
  const p: Presentation = {
    width: pt(sz?.getAttribute("cx"), 720) || 720, height: pt(sz?.getAttribute("cy"), 540) || 540,
    theme: { ...DEFAULT_THEME }, slides: [], nextId: 1, decor: {}, imported: true, parts: {},
  };

  // Ogni schema diapositiva ha il suo tema (colori e font), i suoi stili di testo e le sue decorazioni.
  interface MasterInfo { color: ColorCtx; fonts: Ctx["fonts"]; inherit: PhSource["master"]; phs: PhSource; bg: ReturnType<typeof readBg>; decor: SlideItem[]; themeName?: string }
  const masters = new Map<string, MasterInfo>();
  const loadMaster = (masterPath: string): MasterInfo => {
    const known = masters.get(masterPath);
    if (known) return known;
    const masterRels = readRels(files, masterPath);
    const themePath = [...masterRels.values()].find((r) => r.type === "theme")?.target ?? [...presRels.values()].find((r) => r.type === "theme")?.target ?? "";
    const themeDoc = parse(files[themePath]);
    const scheme: Record<string, string> = {};
    const color: ColorCtx = { scheme, map: { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" } };
    for (const c of themeDoc?.getElementsByTagNameNS(NS_A, "clrScheme")[0]?.children ?? []) { const v = firstColor(c, color); if (v) scheme[c.localName] = v; }
    const majorLatin = themeDoc?.getElementsByTagNameNS(NS_A, "majorFont")[0];
    const minorLatin = themeDoc?.getElementsByTagNameNS(NS_A, "minorFont")[0];
    const fonts = { major: kid(majorLatin, "latin")?.getAttribute("typeface") || "Calibri", minor: kid(minorLatin, "latin")?.getAttribute("typeface") || "Calibri" };
    const master = parse(files[masterPath]);
    const clrMap = master ? kid(master.documentElement, "clrMap") : undefined;
    if (clrMap) for (const at of clrMap.attributes) color.map[at.name] = at.value;
    const mctx: Ctx = { files, color, fonts, rels: masterRels, p, notes: [] };
    const txStyles = master ? kid(master.documentElement, "txStyles") : undefined;
    const inherit = {
      title: mergeInherit({ levels: [] }, kid(txStyles, "titleStyle"), mctx),
      body: mergeInherit({ levels: [] }, kid(txStyles, "bodyStyle"), mctx),
      other: mergeInherit({ levels: [] }, kid(txStyles, "otherStyle"), mctx),
    };
    const cSld = master ? kid(master.documentElement, "cSld") : undefined;
    const tree = kid(cSld, "spTree");
    const phs: PhSource = { list: readPhList(tree, mctx), master: inherit };
    const info: MasterInfo = { color, fonts, inherit, phs, bg: readBg(cSld, mctx), decor: [], themeName: themeDoc?.documentElement.getAttribute("name") ?? undefined };
    // Decorazioni dello schema (logo, barre…), calcolate una volta.
    readTree(tree, identity, mctx, [phs], "blank", true, ct, info.decor);
    masters.set(masterPath, info);
    return info;
  };

  const firstMaster = loadMaster([...presRels.values()].find((r) => r.type === "slideMaster")?.target ?? "");
  const { scheme } = firstMaster.color;
  const cmap = firstMaster.color.map;
  const theme: Theme = {
    ...DEFAULT_THEME, id: "file", name: firstMaster.themeName ?? "Tema del file",
    background: firstMaster.bg?.color ?? scheme[cmap.bg1 ?? "lt1"] ?? "#ffffff",
    text: scheme[cmap.tx1 ?? "dk1"] ?? "#000000",
    title: firstMaster.inherit.title.levels[0]?.color ?? scheme[cmap.tx1 ?? "dk1"] ?? "#000000",
    accent: scheme.accent1 ?? DEFAULT_THEME.accent, accent2: scheme.accent2 ?? DEFAULT_THEME.accent2,
    headingFont: firstMaster.fonts.major, bodyFont: firstMaster.fonts.minor, decoration: "none",
    titleSize: firstMaster.inherit.title.levels[0]?.size ?? 44, bodySize: firstMaster.inherit.body.levels[0]?.size ?? 28, titleAlign: "l",
  };
  p.theme = theme;
  const layoutCache = new Map<string, { phs: PhInfo[]; decor: string; layout: LayoutId; bg?: ReturnType<typeof readBg>; master: MasterInfo }>();

  const sldIds = kids(kid(root, "sldIdLst"), "sldId");
  for (const sldId of sldIds) {
    const rel = presRels.get(rAttr(sldId, "id") ?? "");
    if (!rel) continue;
    const slidePath = rel.target;
    const doc = parse(files[slidePath]);
    if (!doc) continue;
    const slideRels = readRels(files, slidePath);
    const layoutPath = [...slideRels.values()].find((r) => r.type === "slideLayout")?.target ?? "";
    let lay = layoutCache.get(layoutPath);
    if (!lay) {
      const ld = parse(files[layoutPath]);
      const lRels = readRels(files, layoutPath);
      const m = loadMaster([...lRels.values()].find((r) => r.type === "slideMaster")?.target ?? "") ;
      const lctx: Ctx = { files, color: m.color, fonts: m.fonts, rels: lRels, p, notes: [] };
      const lcSld = ld ? kid(ld.documentElement, "cSld") : undefined;
      const lTree = kid(lcSld, "spTree");
      const decorItems: SlideItem[] = [];
      if (ld?.documentElement.getAttribute("showMasterSp") !== "0") decorItems.push(...m.decor);
      readTree(lTree, identity, lctx, [{ list: [], master: m.inherit }], "blank", true, ct, decorItems);
      if (decorItems.length) p.decor[layoutPath] = decorItems;
      lay = {
        phs: readPhList(lTree, lctx), decor: decorItems.length ? layoutPath : "", master: m,
        layout: LAYOUTS[ld?.documentElement.getAttribute("type") ?? ""] ?? "content", bg: readBg(lcSld, lctx),
      };
      layoutCache.set(layoutPath, lay);
    }
    const m = lay.master;
    const sctx: Ctx = { files, color: m.color, fonts: m.fonts, rels: slideRels, p, notes: [] };
    const cSld = kid(doc.documentElement, "cSld");
    const items: SlideItem[] = [];
    readTree(kid(cSld, "spTree"), identity, sctx, [{ list: lay.phs, master: m.inherit }, m.phs], lay.layout, false, ct, items);
    const bg = readBg(cSld, sctx) ?? lay.bg ?? m.bg;
    const slide: Slide = { id: p.nextId++, layout: lay.layout, items, notes: "" };
    if (bg?.color && bg.color !== theme.background) slide.background = bg.color;
    if (bg?.image) slide.backgroundImage = bg.image;
    const showMasterSp = doc.documentElement.getAttribute("showMasterSp") !== "0";
    if (lay.decor && showMasterSp) slide.decor = lay.decor;
    if (doc.documentElement.getAttribute("show") === "0") slide.hidden = true;
    const tr = kid(doc.documentElement, "transition") ?? path(kid(doc.documentElement, "AlternateContent"), "Fallback", "transition");
    if (tr) slide.transition = new XMLSerializer().serializeToString(tr);
    const notesPath = [...slideRels.values()].find((r) => r.type === "notesSlide")?.target;
    const notesDoc = notesPath ? parse(files[notesPath]) : null;
    if (notesDoc) {
      for (const sp of notesDoc.getElementsByTagNameNS("*", "sp")) {
        const ph = path(sp, "nvSpPr", "nvPr", "ph");
        if (ph?.getAttribute("type") === "body") { slide.notes = plainText(kid(sp, "txBody")).trim(); break; }
      }
    }
    p.slides.push(slide);
  }
  if (!p.slides.length) throw new Error("La presentazione non contiene diapositive leggibili");
  const core = parse(files["docProps/core.xml"]);
  const title = core?.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", "title")[0]?.textContent?.trim();
  if (title) p.title = title;
  return p;
}
