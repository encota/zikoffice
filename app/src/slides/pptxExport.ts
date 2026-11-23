// Salvataggio in .pptx (Office Open XML, ECMA-376). Ogni riquadro ha la sua posizione e il suo
// stile scritti per esteso: PowerPoint, Keynote e LibreOffice mostrano la diapositiva come qui.
import { strToU8, zipSync } from "fflate";
import { localeTag, tr } from "../i18n";
import type { Frame, ImageItem, LayoutId, Para, Presentation, RawItem, ShapeItem, Slide, SlideItem, TableItem, TextRun } from "./model";
import { isTitleLike, layoutBoxes, mixColor, levelSize, paraBullet, placeItems, roleStyle, slideBackground, themeDecor } from "./layout";
import { shapeStyle } from "./render";
import { contrastOn } from "./themes";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const CT = "application/vnd.openxmlformats-officedocument.presentationml.";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  // Caratteri di controllo non ammessi in XML 1.0.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const emu = (pt: number) => Math.round(pt * 12700);
const hex = (c: string) => c.replace("#", "").toUpperCase().slice(0, 6).padEnd(6, "0");
const solid = (c: string) => `<a:solidFill><a:srgbClr val="${hex(c)}"/></a:solidFill>`;

class Rels {
  list: { id: string; type: string; target: string; external?: boolean }[] = [];
  add(type: string, target: string, external = false): string {
    const same = this.list.find((r) => r.type === type && r.target === target);
    if (same) return same.id;
    const id = `rId${this.list.length + 1}`;
    this.list.push({ id, type, target, external });
    return id;
  }
  xml(): string {
    return `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${this.list.map((r) =>
      `<Relationship Id="${r.id}" Type="${r.type.includes("://") ? r.type : REL + r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
  }
}

interface Pkg {
  files: Record<string, Uint8Array>;
  overrides: Map<string, string>;
  defaults: Map<string, string>;
  media: Map<Uint8Array, string>;
  lang: string;
}

const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/bmp": "bmp", "image/svg+xml": "svg", "image/webp": "webp", "image/tiff": "tiff" };

function mediaPath(pkg: Pkg, bytes: Uint8Array, mime: string): string {
  let path = pkg.media.get(bytes);
  if (!path) {
    const ext = MIME_EXT[mime] ?? "png";
    path = `ppt/media/zimage${pkg.media.size + 1}.${ext}`;
    pkg.media.set(bytes, path);
    pkg.files[path] = bytes;
    pkg.defaults.set(ext, mime);
  }
  return path;
}

const rel = (fromDir: string, path: string) => {
  // Percorso relativo da una cartella di "ppt/..." a un'altra parte.
  const from = fromDir.split("/"), to = path.split("/");
  while (from.length && to.length > 1 && from[0] === to[0]) { from.shift(); to.shift(); }
  return [...from.map(() => ".."), ...to].join("/");
};

// ---------- testo ----------

interface TextCtx { size: number; color: string; font: string; bold: boolean; bullet: string; rels: Rels; pkg: Pkg }

function runXml(r: TextRun, base: { size: number; color: string; font: string; bold: boolean }, ctx: TextCtx, tag = "a:rPr"): string {
  const size = r.size ?? base.size;
  const attrs = [`lang="${ctx.pkg.lang}"`, `sz="${Math.round(size * 100)}"`];
  const bold = r.b ?? base.bold;
  if (bold) attrs.push('b="1"');
  if (r.i) attrs.push('i="1"');
  if (r.u) attrs.push('u="sng"');
  if (r.strike) attrs.push('strike="sngStrike"');
  if (r.spacing) attrs.push(`spc="${Math.round(r.spacing * 100)}"`);
  if (r.caps) attrs.push(`cap="${r.caps}"`);
  attrs.push('dirty="0"');
  const font = r.font ?? base.font;
  let inner = solid(r.color ?? base.color) + `<a:latin typeface="${esc(font)}"/><a:cs typeface="${esc(font)}"/>`;
  if (r.link && tag === "a:rPr") inner += `<a:hlinkClick r:id="${ctx.rels.add("hyperlink", r.link, true)}"/>`;
  return `<${tag} ${attrs.join(" ")}>${inner}</${tag}>`;
}

function parasXml(paras: Para[], role: ShapeItem["role"], style: ReturnType<typeof roleStyle>, ctx: TextCtx, bulletColor: string): string {
  const list = paras.length ? paras : [{ runs: [], level: 0 }];
  return list.map((p) => {
    const size = levelSize(style.size, role === "body" ? p.level : 0);
    const bullet = paraBullet(p, role, style);
    const em = emu(size);
    const marL = Math.round(em * (p.level * 1.4 + (bullet !== "none" ? 1.1 : 0)));
    const indent = bullet !== "none" ? -Math.round(em * 1.1) : 0;
    const algn = p.align ?? style.align;
    const bu = bullet === "bullet"
      ? `<a:buClr><a:srgbClr val="${hex(bulletColor)}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="•"/>`
      : bullet === "number" ? `<a:buClr><a:srgbClr val="${hex(bulletColor)}"/></a:buClr><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>` : "<a:buNone/>";
    const spacing = (p.lineSpacing ? `<a:lnSpc><a:spcPct val="${Math.round(p.lineSpacing * 100000)}"/></a:lnSpc>` : "")
      + (p.spaceBefore !== undefined ? `<a:spcBef><a:spcPts val="${Math.round(p.spaceBefore * 100)}"/></a:spcBef>` : "")
      + (p.spaceAfter !== undefined ? `<a:spcAft><a:spcPts val="${Math.round(p.spaceAfter * 100)}"/></a:spcAft>` : "");
    const pPr = `<a:pPr marL="${marL}" indent="${indent}" algn="${algn}"${p.level ? ` lvl="${p.level}"` : ""}>${spacing}${bu}</a:pPr>`;
    const base = { size, color: style.color, font: style.font, bold: style.bold };
    const runs = p.runs.flatMap((r) => r.text.split("\n").map((t, i) => (i ? "<a:br>" + runXml(r, base, ctx) + "</a:br>" : "") + (t ? `<a:r>${runXml(r, base, ctx)}<a:t>${esc(t)}</a:t></a:r>` : ""))).join("");
    return `<a:p>${pPr}${runs}${runXml(p.runs[p.runs.length - 1] ?? { text: "" }, base, ctx, "a:endParaRPr")}</a:p>`;
  }).join("");
}

function bodyPr(item: ShapeItem, anchor: string): string {
  const [l, t, r, b] = item.inset ?? [7.2, 3.6, 7.2, 3.6];
  const fit = item.role === "text" ? "" : item.fit && item.fit < 1
    ? `<a:normAutofit fontScale="${Math.round(item.fit * 100000)}"/>` : "<a:normAutofit/>";
  return `<a:bodyPr wrap="${item.noWrap ? "none" : "square"}" lIns="${emu(l)}" tIns="${emu(t)}" rIns="${emu(r)}" bIns="${emu(b)}" rtlCol="0" anchor="${anchor}">${fit}</a:bodyPr>`;
}

// ---------- elementi ----------

interface ItemCtx { pkg: Pkg; rels: Rels; dir: string; nextId: () => number; p: Presentation; slide: Slide }

const xfrm = (f: Frame, extra = "") => {
  const rot = f.rot ? ` rot="${Math.round(f.rot * 60000)}"` : "";
  return `<a:xfrm${rot}${extra}><a:off x="${emu(f.x)}" y="${emu(f.y)}"/><a:ext cx="${emu(Math.max(0, f.w))}" cy="${emu(Math.max(0, f.h))}"/></a:xfrm>`;
};

const PRST: Record<ShapeItem["geom"], string> = {
  rect: "rect", roundRect: "roundRect", ellipse: "ellipse", triangle: "triangle", rightArrow: "rightArrow", line: "line", star5: "star5", diamond: "diamond", chevron: "chevron",
};

function phXml(item: ShapeItem, layout: LayoutId, bodyIdx: () => number): string | null {
  if (item.role === "title") return `<p:ph type="${layout === "title" ? "ctrTitle" : "title"}"/>`;
  if (item.role === "subtitle") {
    if (layout === "title") return '<p:ph type="subTitle" idx="1"/>';
    if (layout === "section") return '<p:ph type="body" idx="1"/>';
    return null;
  }
  if (item.role === "body") return `<p:ph idx="${bodyIdx()}"/>`;
  return null;
}

function shapeXml(item: ShapeItem, frame: Frame, ctx: ItemCtx, ph: string | null): string {
  const id = ctx.nextId();
  const style = shapeStyle(ctx.p, ctx.slide, item);
  const flips = `${item.flipH ? ' flipH="1"' : ""}${item.flipV ? ' flipV="1"' : ""}`;
  const fill = item.fill ? solid(item.fill) : "<a:noFill/>";
  const line = item.line ? `<a:ln w="${emu(item.line.width)}">${solid(item.line.color)}</a:ln>` : "<a:ln><a:noFill/></a:ln>";
  const geom = item.custom?.xml ?? item.prstXml ?? `<a:prstGeom prst="${PRST[item.geom]}"><a:avLst/></a:prstGeom>`;
  const name = ph ? (item.role === "title" ? "Titolo" : item.role === "subtitle" ? "Sottotitolo" : "Contenuto") : item.geom === "line" ? "Linea" : item.fill ? "Forma" : "Casella di testo";
  const nv = `<p:nvSpPr><p:cNvPr id="${id}" name="${name} ${id}"/><p:cNvSpPr${!ph && !item.fill && item.geom === "rect" ? ' txBox="1"' : ""}>${ph ? '<a:spLocks noGrp="1"/>' : ""}</p:cNvSpPr><p:nvPr>${ph ?? ""}</p:nvPr></p:nvSpPr>`;
  const spPr = `<p:spPr>${xfrm(frame, flips)}${geom}${item.geom === "line" ? "" : fill}${line}</p:spPr>`;
  if (item.geom === "line") return `<p:sp>${nv}${spPr}</p:sp>`;
  const tctx: TextCtx = { ...style, bullet: "", rels: ctx.rels, pkg: ctx.pkg };
  const body = `<p:txBody>${bodyPr(item, item.anchor ?? style.anchor)}<a:lstStyle/>${parasXml(item.paras, item.role, style, tctx, ctx.p.theme.accent)}</p:txBody>`;
  return `<p:sp>${nv}${spPr}${body}</p:sp>`;
}

function imageXml(item: ImageItem, frame: Frame, ctx: ItemCtx): string {
  const id = ctx.nextId();
  const rid = ctx.rels.add("image", rel(ctx.dir, mediaPath(ctx.pkg, item.bytes, item.mime)));
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Immagine ${id}" descr="${esc(item.alt ?? "")}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr>${xfrm(frame)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function tableXml(item: TableItem, frame: Frame, ctx: ItemCtx): string {
  const id = ctx.nextId();
  const t = ctx.p.theme;
  const ncols = Math.max(1, ...item.rows.map((r) => r.length));
  const weights = item.cols && item.cols.length === ncols ? item.cols : Array(ncols).fill(1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const widths = weights.map((w) => Math.round(emu(frame.w) * (w / total)));
  const rowH = Math.round(emu(frame.h) / Math.max(1, item.rows.length));
  const border = `<a:lnL w="12700">${solid("#ffffff")}</a:lnL><a:lnR w="12700">${solid("#ffffff")}</a:lnR><a:lnT w="12700">${solid("#ffffff")}</a:lnT><a:lnB w="12700">${solid("#ffffff")}</a:lnB>`;
  const size = Math.round(t.bodySize * 0.72);
  const rows = item.rows.map((row, ri) => {
    const head = item.header && ri === 0;
    const cells = Array.from({ length: ncols }, (_, ci) => {
      const cell = row[ci] ?? { paras: [] };
      const bg = cell.fill ?? (head ? t.accent : mixColor(t.accent, t.background, ri % 2 ? 0.14 : 0.06));
      const color = head ? contrastOn(t.accent) : cell.fill ? contrastOn(cell.fill) : t.text;
      const style = { size, color, font: t.bodyFont, bold: head, align: "l" as const, anchor: "t" as const, bullets: false };
      const tctx: TextCtx = { ...style, bullet: "", rels: ctx.rels, pkg: ctx.pkg };
      return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${parasXml(cell.paras, "text", style, tctx, t.accent)}</a:txBody><a:tcPr marL="${emu(6)}" marR="${emu(6)}" marT="${emu(4)}" marB="${emu(4)}">${border}${solid(bg)}</a:tcPr></a:tc>`;
    }).join("");
    return `<a:tr h="${rowH}">${cells}</a:tr>`;
  }).join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Tabella ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`
    + `<p:xfrm><a:off x="${emu(frame.x)}" y="${emu(frame.y)}"/><a:ext cx="${emu(frame.w)}" cy="${emu(frame.h)}"/></p:xfrm>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="${item.header ? 1 : 0}" bandRow="1"/>`
    + `<a:tblGrid>${widths.map((w) => `<a:gridCol w="${w}"/>`).join("")}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function rawXml(item: RawItem, ctx: ItemCtx): string {
  const id = ctx.nextId();
  // Le parti collegate tornano nel pacchetto; i riferimenti r:id si rinumerano per questa diapositiva.
  for (const path of item.closure) {
    const part = ctx.p.parts[path];
    if (!part || ctx.pkg.files[path]) continue;
    ctx.pkg.files[path] = part.bytes;
    if (part.type) ctx.pkg.overrides.set(`/${path}`, part.type);
  }
  const map = new Map<string, string>();
  for (const [oldId, part] of Object.entries(item.parts)) {
    map.set(oldId, part.external ? ctx.rels.add(part.type, part.external, true) : ctx.rels.add(part.type, rel(ctx.dir, part.path)));
  }
  return item.xml
    .replace(/(<(?:\w+:)?cNvPr\b[^>]*?\bid=")\d+"/, `$1${id}"`)
    .replace(/(\sr:\w+=")(rId\w+)"/g, (m, pre: string, rid: string) => (map.has(rid) ? `${pre}${map.get(rid)}"` : m));
}

function itemsXml(items: { item: SlideItem; frame: Frame }[], ctx: ItemCtx, placeholders: boolean): string {
  let bodyIdx = isTitleLike(ctx.slide.layout) ? 1 : 0;
  const nextBody = () => ++bodyIdx;
  return items.map(({ item, frame }) => {
    switch (item.kind) {
      case "shape": return shapeXml(item, frame, ctx, placeholders ? phXml(item, ctx.slide.layout, nextBody) : null);
      case "image": return imageXml(item, frame, ctx);
      case "table": return tableXml(item, frame, ctx);
      case "raw": return rawXml(item, ctx);
    }
  }).join("");
}

const spTree = (inner: string) =>
  `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${inner}</p:spTree>`;

function bgXml(color: string | undefined, image: string | undefined): string {
  if (image) return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${image}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
  return color ? `<p:bg><p:bgPr>${solid(color)}<a:effectLst/></p:bgPr></p:bg>` : "";
}

// ---------- tema, schema, layout ----------

function themeXml(p: Presentation, name: string): string {
  const t = p.theme;
  const c = (tag: string, v: string) => `<a:${tag}><a:srgbClr val="${hex(v)}"/></a:${tag}>`;
  const fonts = (f: string) => `<a:latin typeface="${esc(f)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const ln = (w: number) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  return `${XML}<a:theme xmlns:a="${NS_A}" name="${esc(name)}"><a:themeElements><a:clrScheme name="${esc(name)}">`
    + `<a:dk1><a:srgbClr val="${hex(t.text)}"/></a:dk1><a:lt1><a:srgbClr val="${hex(t.background)}"/></a:lt1>`
    + c("dk2", t.title) + c("lt2", "#E7E6E6") + c("accent1", t.accent) + c("accent2", t.accent2)
    + c("accent3", "#A5A5A5") + c("accent4", "#FFC000") + c("accent5", "#5B9BD5") + c("accent6", "#70AD47")
    + c("hlink", "#0563C1") + c("folHlink", "#954F72") + "</a:clrScheme>"
    + `<a:fontScheme name="${esc(name)}"><a:majorFont>${fonts(t.headingFont)}</a:majorFont><a:minorFont>${fonts(t.bodyFont)}</a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="${esc(name)}"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst>`
    + `<a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst>`
    + "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>"
    + `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

const CLRMAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

function masterXml(p: Presentation, layoutIds: string[]): string {
  const t = p.theme;
  const b = layoutBoxes(p, "content");
  const title = roleStyle(t, "content", "title", false), body = roleStyle(t, "content", "body", false);
  const ph = (id: number, name: string, ph: string, f: Frame, anchor: string, text: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm(f)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    + `<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="${localeTag()}"/><a:t>${esc(text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const lvl = (i: number) => {
    const size = levelSize(body.size, i), em = emu(size);
    return `<a:lvl${i + 1}pPr marL="${Math.round(em * (i * 1.4 + 1.1))}" indent="${-Math.round(em * 1.1)}" algn="l" rtl="0"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buClr><a:schemeClr val="accent1"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="•"/>`
      + `<a:defRPr sz="${size * 100}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`;
  };
  return `${XML}<p:sldMaster ${NS}><p:cSld>${bgXml(t.background, undefined)}${spTree(
    ph(2, "Segnaposto titolo", '<p:ph type="title"/>', b.title!, "b", "Titolo") + ph(3, "Segnaposto testo", '<p:ph type="body" idx="1"/>', b.body!, "t", "Testo"),
  )}</p:cSld><p:clrMap ${CLRMAP}/>`
    + `<p:sldLayoutIdLst>${layoutIds.map((rid, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="${rid}"/>`).join("")}</p:sldLayoutIdLst>`
    + `<p:txStyles><p:titleStyle><a:lvl1pPr algn="${title.align}" rtl="0"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/>`
    + `<a:defRPr sz="${title.size * 100}" b="1" kern="1200"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>`
    + `<p:bodyStyle>${[0, 1, 2, 3, 4].map(lvl).join("")}</p:bodyStyle>`
    + `<p:otherStyle><a:lvl1pPr marL="0" algn="l" rtl="0"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
}

const LAYOUT_TYPE: Record<LayoutId, [string, string]> = {
  title: ["title", "Diapositiva titolo"], content: ["obj", "Titolo e contenuto"], two: ["twoObj", "Due contenuti"],
  section: ["secHead", "Intestazione sezione"], titleOnly: ["titleOnly", "Solo titolo"], blank: ["blank", "Vuota"],
};

function layoutXml(p: Presentation, layout: LayoutId, decorKey: string | undefined, ctx: ItemCtx): string {
  const b = layoutBoxes(p, layout);
  const [type, name] = LAYOUT_TYPE[layout];
  let id = 1;
  const ph = (n: string, phTag: string, f: Frame) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${++id}" name="${n}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${phTag}</p:nvPr></p:nvSpPr><p:spPr>${xfrm(f)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="${localeTag()}"/></a:p></p:txBody></p:sp>`;
  const fake: Slide = { id: 0, layout, items: [], notes: "", decor: decorKey };
  const decorItems = [...themeDecor(p, fake), ...(decorKey ? p.decor[decorKey] ?? [] : [])];
  const dctx: ItemCtx = { ...ctx, slide: fake, nextId: () => 1000 + ++id };
  let phs = "";
  if (b.title) phs += ph("Titolo", `<p:ph type="${layout === "title" ? "ctrTitle" : "title"}"/>`, b.title);
  if (layout === "title" && b.subtitle) phs += ph("Sottotitolo", '<p:ph type="subTitle" idx="1"/>', b.subtitle);
  if (layout === "section" && b.subtitle) phs += ph("Testo", '<p:ph type="body" idx="1"/>', b.subtitle);
  if (layout === "content" && b.body) phs += ph("Contenuto", '<p:ph idx="1"/>', b.body);
  if (layout === "two" && b.body) {
    const g = p.width * 0.045, w = (b.body.w - g) / 2;
    phs += ph("Contenuto 1", '<p:ph sz="half" idx="1"/>', { ...b.body, w }) + ph("Contenuto 2", '<p:ph sz="half" idx="2"/>', { ...b.body, x: b.body.x + w + g, w });
  }
  const bg = isTitleLike(layout) && p.theme.titleBackground ? bgXml(p.theme.titleBackground, undefined) : "";
  const decorXml = itemsXml(decorItems.map((item) => ({ item, frame: item.frame ?? { x: 0, y: 0, w: p.width, h: p.height } })), dctx, false);
  return `${XML}<p:sldLayout ${NS} type="${type}" preserve="1"><p:cSld name="${esc(tr(name))}">${bg}${spTree(decorXml + phs)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

// ---------- note ----------

function notesMasterXml(): string {
  return `${XML}<p:notesMaster ${NS}><p:cSld>${bgXml("#FFFFFF", undefined)}${spTree(
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Immagine diapositiva"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="381000" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>`
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Note"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="${localeTag()}"/></a:p></p:txBody></p:sp>`,
  )}</p:cSld><p:clrMap ${CLRMAP}/><p:notesStyle><a:lvl1pPr marL="0" algn="l" rtl="0"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;
}

function notesSlideXml(text: string): string {
  const paras = text.split("\n").map((l) => `<a:p>${l ? `<a:r><a:rPr lang="${localeTag()}" dirty="0"/><a:t>${esc(l)}</a:t></a:r>` : `<a:endParaRPr lang="${localeTag()}"/>`}</a:p>`).join("");
  return `${XML}<p:notes ${NS}><p:cSld>${spTree(
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Immagine diapositiva"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>`
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Note"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`,
  )}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

// ---------- pacchetto ----------

export function exportPptx(p: Presentation): Uint8Array {
  const pkg: Pkg = { files: {}, overrides: new Map(), defaults: new Map([["rels", "application/vnd.openxmlformats-package.relationships+xml"], ["xml", "application/xml"]]), media: new Map(), lang: localeTag() };
  const put = (path: string, xml: string, type?: string) => {
    pkg.files[path] = strToU8(xml);
    if (type) pkg.overrides.set(`/${path}`, type);
  };
  const presRels = new Rels();
  const masterRels = new Rels();

  // Un layout per ogni combinazione (tipo di diapositiva, decorazioni) usata.
  const layoutKeys: string[] = [];
  const keyOf = (s: Slide) => `${s.layout}|${s.decor ?? ""}`;
  const order: LayoutId[] = ["title", "content", "two", "section", "titleOnly", "blank"];
  for (const l of order) layoutKeys.push(`${l}|`);
  for (const s of p.slides) if (!layoutKeys.includes(keyOf(s))) layoutKeys.push(keyOf(s));

  const dummy: Slide = { id: 0, layout: "content", items: [], notes: "" };
  const layoutRids: string[] = [];
  layoutKeys.forEach((key, i) => {
    const [layout, decor] = key.split("|") as [LayoutId, string];
    const path = `ppt/slideLayouts/slideLayout${i + 1}.xml`;
    const rels = new Rels();
    rels.add("slideMaster", "../slideMasters/slideMaster1.xml");
    const xml = layoutXml(p, layout, decor || undefined, { pkg, rels, dir: "ppt/slideLayouts", nextId: () => 0, p, slide: dummy });
    put(path, xml, `${CT}slideLayout+xml`);
    pkg.files[`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`] = strToU8(rels.xml());
    layoutRids.push(masterRels.add("slideLayout", `../slideLayouts/slideLayout${i + 1}.xml`));
  });
  masterRels.add("theme", "../theme/theme1.xml");
  put("ppt/slideMasters/slideMaster1.xml", masterXml(p, layoutRids), `${CT}slideMaster+xml`);
  pkg.files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = strToU8(masterRels.xml());
  const themeName = p.theme.name || "ZikOffice";
  put("ppt/theme/theme1.xml", themeXml(p, themeName), "application/vnd.openxmlformats-officedocument.theme+xml");

  const masterRid = presRels.add("slideMaster", "slideMasters/slideMaster1.xml");
  const hasNotes = p.slides.some((s) => s.notes.trim());
  const sldIds: string[] = [];
  p.slides.forEach((slide, i) => {
    const n = i + 1;
    const rels = new Rels();
    rels.add("slideLayout", `../slideLayouts/slideLayout${layoutKeys.indexOf(keyOf(slide)) + 1}.xml`);
    let id = 1;
    const ctx: ItemCtx = { pkg, rels, dir: "ppt/slides", nextId: () => ++id, p, slide };
    const placed = placeItems(p, slide);
    const items = itemsXml(placed, ctx, true);
    const bgImg = slide.backgroundImage ? rels.add("image", rel("ppt/slides", mediaPath(pkg, slide.backgroundImage.bytes, slide.backgroundImage.mime))) : undefined;
    const bg = slide.background || bgImg ? bgXml(slide.background ?? slideBackground(p, slide), bgImg) : "";
    if (slide.notes.trim()) {
      const nrels = new Rels();
      nrels.add("notesMaster", "../notesMasters/notesMaster1.xml");
      nrels.add("slide", `../slides/slide${n}.xml`);
      put(`ppt/notesSlides/notesSlide${n}.xml`, notesSlideXml(slide.notes), `${CT}notesSlide+xml`);
      pkg.files[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = strToU8(nrels.xml());
      rels.add("notesSlide", `../notesSlides/notesSlide${n}.xml`);
    }
    const transition = slide.transition ?? "";
    put(`ppt/slides/slide${n}.xml`, `${XML}<p:sld ${NS}${slide.hidden ? ' show="0"' : ""}><p:cSld>${bg}${spTree(items)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transition}</p:sld>`, `${CT}slide+xml`);
    pkg.files[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(rels.xml());
    sldIds.push(`<p:sldId id="${256 + i}" r:id="${presRels.add("slide", `slides/slide${n}.xml`)}"/>`);
  });

  let notesMasterLst = "";
  if (hasNotes) {
    const nmRels = new Rels();
    nmRels.add("theme", "../theme/theme2.xml");
    put("ppt/notesMasters/notesMaster1.xml", notesMasterXml(), `${CT}notesMaster+xml`);
    pkg.files["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = strToU8(nmRels.xml());
    put("ppt/theme/theme2.xml", themeXml({ ...p, theme: { ...p.theme, background: "#ffffff", text: "#000000" } }, "Note"), "application/vnd.openxmlformats-officedocument.theme+xml");
    notesMasterLst = `<p:notesMasterIdLst><p:notesMasterId r:id="${presRels.add("notesMaster", "notesMasters/notesMaster1.xml")}"/></p:notesMasterIdLst>`;
  }
  presRels.add("presProps", "presProps.xml");
  presRels.add("viewProps", "viewProps.xml");
  presRels.add("theme", "theme/theme1.xml");
  presRels.add("tableStyles", "tableStyles.xml");

  const W = emu(p.width), H = emu(p.height);
  const sizeType = Math.abs(p.width / p.height - 16 / 9) < 0.01 ? "" : Math.abs(p.width / p.height - 4 / 3) < 0.01 ? ' type="screen4x3"' : ' type="custom"';
  put("ppt/presentation.xml", `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="${masterRid}"/></p:sldMasterIdLst>${notesMasterLst}`
    + `<p:sldIdLst>${sldIds.join("")}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"${sizeType}/><p:notesSz cx="6858000" cy="9144000"/>`
    + `<p:defaultTextStyle><a:lvl1pPr marL="0" algn="l" rtl="0"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle></p:presentation>`,
    `${CT}presentation.main+xml`);
  pkg.files["ppt/_rels/presentation.xml.rels"] = strToU8(presRels.xml());
  put("ppt/presProps.xml", `${XML}<p:presentationPr ${NS}/>`, `${CT}presProps+xml`);
  put("ppt/viewProps.xml", `${XML}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`, `${CT}viewProps+xml`);
  put("ppt/tableStyles.xml", `${XML}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`, `${CT}tableStyles+xml`);

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  put("docProps/core.xml", `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `${p.title ? `<dc:title>${esc(p.title)}</dc:title>` : ""}<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
    "application/vnd.openxmlformats-package.core-properties+xml");
  put("docProps/app.xml", `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>ZikOffice</Application><PresentationFormat>${sizeType ? "4:3" : "16:9"}</PresentationFormat><Slides>${p.slides.length}</Slides><Notes>${p.slides.filter((s) => s.notes.trim()).length}</Notes><HiddenSlides>${p.slides.filter((s) => s.hidden).length}</HiddenSlides></Properties>`,
    "application/vnd.openxmlformats-officedocument.extended-properties+xml");
  const root = new Rels();
  root.add("officeDocument", "ppt/presentation.xml");
  root.add("http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml");
  root.add("extended-properties", "docProps/app.xml");
  pkg.files["_rels/.rels"] = strToU8(root.xml());

  // Le parti conservate portano con sé i loro tipi per estensione (es. .xlsx incorporati nei grafici).
  for (const path of Object.keys(pkg.files)) {
    const ext = path.split(".").pop()!.toLowerCase();
    if (!pkg.defaults.has(ext) && !pkg.overrides.has(`/${path}`)) {
      const t = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bin: "application/vnd.openxmlformats-officedocument.oleObject", emf: "image/x-emf", wmf: "image/x-wmf", png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", mp4: "video/mp4" }[ext];
      if (t) pkg.defaults.set(ext, t);
    }
  }
  const ct = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${[...pkg.defaults].map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`).join("")}`
    + `${[...pkg.overrides].map(([n, t]) => `<Override PartName="${esc(n)}" ContentType="${t}"/>`).join("")}</Types>`;
  // Immagini e file incorporati sono già compressi: si copiano senza ricomprimerli.
  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 | 6 }]> = { "[Content_Types].xml": strToU8(ct) };
  for (const [name, data] of Object.entries(pkg.files)) entries[name] = /\.(xml|rels)$/i.test(name) ? data : [data, { level: 0 }];
  return zipSync(entries, { level: 6 });
}
