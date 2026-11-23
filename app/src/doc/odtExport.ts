// Scrittura del documento in formato .odt (OpenDocument Text), compatibile con LibreOffice Writer e Word.
import { strToU8, zipSync } from "fflate";
import { type DocumentModel, type Paragraph, type ParaProps, type Run, type RunProps, type Table } from "./model";
import { effectivePara, effectiveRun, isBulletList } from "./styles";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pt = (n: number) => `${Math.round(n * 100) / 100}pt`;

const NS_OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const NS_STYLE = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
const NS_TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const NS_TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
const NS_DRAW = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0";
const NS_FO = "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0";
const NS_XLINK = "http://www.w3.org/1999/xlink";
const NS_SVG = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";

const COMMON_NS = `xmlns:office="${NS_OFFICE}" xmlns:style="${NS_STYLE}" xmlns:text="${NS_TEXT}" xmlns:table="${NS_TABLE}" xmlns:draw="${NS_DRAW}" xmlns:fo="${NS_FO}" xmlns:xlink="${NS_XLINK}" xmlns:svg="${NS_SVG}" office:version="1.2"`;

interface OdtOut {
  autoStyles: string[];
  pStyleCache: Map<string, string>;
  tStyleCache: Map<string, string>;
  media: { path: string; bytes: Uint8Array; mime: string }[];
  mediaBySrc: Map<string, string>;
}

function paraStyleName(out: OdtOut, p: ParaProps): string {
  const key = JSON.stringify(p);
  const hit = out.pStyleCache.get(key);
  if (hit) return hit;
  const name = `P${out.pStyleCache.size + 1}`;
  let attrs = "";
  if (p.align && p.align !== "left") attrs += ` fo:text-align="${p.align}"`;
  if (p.indentLeft) attrs += ` fo:margin-left="${pt(p.indentLeft)}"`;
  if (p.indentRight) attrs += ` fo:margin-right="${pt(p.indentRight)}"`;
  if (p.firstLine) attrs += ` fo:text-indent="${pt(p.firstLine)}"`;
  if (p.spaceBefore !== undefined) attrs += ` fo:margin-top="${pt(p.spaceBefore)}"`;
  if (p.spaceAfter !== undefined) attrs += ` fo:margin-bottom="${pt(p.spaceAfter)}"`;
  if (p.line !== undefined) {
    attrs += p.lineRule === "exact" || p.lineRule === "atLeast"
      ? ` fo:line-height="${pt(p.line)}"`
      : ` fo:line-height="${Math.round(p.line * 100)}%"`;
  }
  if (p.shading) attrs += ` fo:background-color="${p.shading}"`;
  if (p.pageBreakBefore) attrs += ` fo:break-before="page"`;
  if (p.keepNext) attrs += ` fo:keep-with-next="always"`;
  out.autoStyles.push(`<style:style style:name="${name}" style:family="paragraph"><style:paragraph-properties${attrs}/></style:style>`);
  out.pStyleCache.set(key, name);
  return name;
}

function textStyleName(out: OdtOut, r: RunProps): string {
  const key = JSON.stringify({ ...r, link: undefined });
  const hit = out.tStyleCache.get(key);
  if (hit) return hit;
  const name = `T${out.tStyleCache.size + 1}`;
  let attrs = "";
  if (r.font) attrs += ` fo:font-family="${esc(r.font)}"`;
  if (r.size) attrs += ` fo:font-size="${pt(r.size)}"`;
  if (r.bold) attrs += ` fo:font-weight="bold"`;
  if (r.italic) attrs += ` fo:font-style="italic"`;
  if (r.underline) attrs += ` style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"`;
  if (r.strike) attrs += ` style:text-line-through-style="solid"`;
  if (r.color) attrs += ` fo:color="${r.color}"`;
  if (r.highlight) attrs += ` fo:background-color="${r.highlight}"`;
  if (r.vertAlign === "superscript") attrs += ` style:text-position="super 58%"`;
  else if (r.vertAlign === "subscript") attrs += ` style:text-position="sub 58%"`;
  out.autoStyles.push(`<style:style style:name="${name}" style:family="text"><style:text-properties${attrs}/></style:style>`);
  out.tStyleCache.set(key, name);
  return name;
}

function encodeText(text: string): string {
  let out = "";
  let spaces = 0;
  const flushSpaces = () => {
    if (!spaces) return;
    out += spaces === 1 ? " " : ` <text:s text:c="${spaces - 1}"/>`;
    spaces = 0;
  };
  for (const ch of text) {
    if (ch === " ") { spaces++; continue; }
    flushSpaces();
    if (ch === "\t") out += "<text:tab/>";
    else if (ch === "\u000b" || ch === "\n") out += "<text:line-break/>";
    else if (ch === "\f") out += "";
    else out += esc(ch);
  }
  flushSpaces();
  return out;
}

function runXml(out: OdtOut, doc: DocumentModel, p: Paragraph, r: Run): string {
  if (r.type === "image") {
    let href = out.mediaBySrc.get(r.src);
    if (!href) {
      const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(r.src);
      if (!m) return "";
      const mime = m[1];
      const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp" } as Record<string, string>)[mime] ?? "png";
      const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : strToU8(decodeURIComponent(m[3]));
      href = `Pictures/image${out.media.length + 1}.${ext}`;
      out.media.push({ path: href, bytes, mime });
      out.mediaBySrc.set(r.src, href);
    }
    return `<draw:frame text:anchor-type="as-char" svg:width="${pt(r.width)}" svg:height="${pt(r.height)}"><draw:image xlink:href="${href}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`;
  }
  if (r.type === "field") {
    return r.field === "PAGE" ? "<text:page-number/>" : "<text:page-count/>";
  }
  const eff = effectiveRun(doc, p, r);
  const tStyle = textStyleName(out, eff);
  const span = `<text:span text:style-name="${tStyle}">${encodeText(r.text)}</text:span>`;
  return r.props.link ? `<text:a xlink:type="simple" xlink:href="${esc(r.props.link)}">${span}</text:a>` : span;
}

function paragraphXml(out: OdtOut, doc: DocumentModel, p: Paragraph): string {
  const eff = effectivePara(doc, p);
  const pStyle = paraStyleName(out, eff);
  const inner = p.runs.map((r) => runXml(out, doc, p, r)).join("");
  if (eff.outlineLevel !== undefined && eff.outlineLevel < 6) {
    return `<text:h text:style-name="${pStyle}" text:outline-level="${eff.outlineLevel + 1}">${inner}</text:h>`;
  }
  return `<text:p text:style-name="${pStyle}">${inner}</text:p>`;
}

function tableXml(out: OdtOut, doc: DocumentModel, t: Table): string {
  let colsXml = "";
  t.grid.forEach((w, i) => {
    const colStyle = `TC_${t.id}_${i}`;
    out.autoStyles.push(`<style:style style:name="${colStyle}" style:family="table-column"><style:table-column-properties style:column-width="${pt(w)}"/></style:style>`);
    colsXml += `<table:table-column table:style-name="${colStyle}"/>`;
  });
  let rowsXml = "";
  for (const row of t.rows) {
    let cellsXml = "";
    for (const cell of row.cells) {
      const span = cell.span > 1 ? ` table:number-columns-spanned="${cell.span}"` : "";
      const body = cell.paragraphs.map((p) => paragraphXml(out, doc, p)).join("");
      cellsXml += `<table:table-cell table:style-name="CellDefault"${span}>${body}</table:table-cell>`;
      for (let k = 1; k < cell.span; k++) cellsXml += "<table:covered-table-cell/>";
    }
    rowsXml += `<table:table-row>${cellsXml}</table:table-row>`;
  }
  return `<table:table table:name="Tabella${t.id}">${colsXml}${rowsXml}</table:table>`;
}

/** Esporta il documento in formato .odt (OpenDocument Text). */
export function exportOdt(doc: DocumentModel): Uint8Array {
  const out: OdtOut = { autoStyles: [], pStyleCache: new Map(), tStyleCache: new Map(), media: [], mediaBySrc: new Map() };
  out.autoStyles.push(`<style:style style:name="CellDefault" style:family="table-cell"><style:table-cell-properties fo:padding="3pt" fo:border="0.5pt solid #000000"/></style:style>`);

  let body = "";
  let i = 0;
  while (i < doc.blocks.length) {
    const b = doc.blocks[i];
    if (b.type === "p" && b.props.numId !== undefined) {
      const numId = b.props.numId;
      const listStyle = isBulletList(doc, numId) ? "LBullet" : "LNumber";
      body += `<text:list text:style-name="${listStyle}">`;
      while (i < doc.blocks.length) {
        const cur = doc.blocks[i];
        if (cur.type !== "p" || cur.props.numId !== numId) break;
        body += `<text:list-item>${paragraphXml(out, doc, cur)}</text:list-item>`;
        i++;
      }
      body += "</text:list>";
      continue;
    }
    if (b.type === "p") body += paragraphXml(out, doc, b);
    else if (b.type === "table") body += tableXml(out, doc, b);
    i++;
  }

  const XML = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  const pg = doc.page;
  const contentXml = `${XML}<office:document-content ${COMMON_NS}><office:automatic-styles>${out.autoStyles.join("")}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
  const stylesXml = `${XML}<office:document-styles ${COMMON_NS}><office:styles>`
    + `<text:list-style style:name="LBullet"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/></text:list-style>`
    + `<text:list-style style:name="LNumber"><text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1"/></text:list-style>`
    + `</office:styles><office:automatic-styles><style:page-layout style:name="PM1">`
    + `<style:page-layout-properties fo:page-width="${pt(pg.width)}" fo:page-height="${pt(pg.height)}" fo:margin-top="${pt(pg.marginTop)}" fo:margin-bottom="${pt(pg.marginBottom)}" fo:margin-left="${pt(pg.marginLeft)}" fo:margin-right="${pt(pg.marginRight)}"/>`
    + `</style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`;
  const manifestXml = `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">`
    + `<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>`
    + `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>`
    + `<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>`
    + out.media.map((m) => `<manifest:file-entry manifest:full-path="${m.path}" manifest:media-type="${m.mime}"/>`).join("")
    + `</manifest:manifest>`;

  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    // Lo standard ODF richiede che `mimetype` sia il primo file, non compresso.
    mimetype: [strToU8("application/vnd.oasis.opendocument.text"), { level: 0 }],
    "content.xml": strToU8(contentXml),
    "styles.xml": strToU8(stylesXml),
    "META-INF/manifest.xml": strToU8(manifestXml),
  };
  for (const m of out.media) files[m.path] = m.bytes;
  return zipSync(files, { level: 6 });
}
