// Scrittura del documento in formato .docx (Office Open XML), compatibile con Word e LibreOffice.
import { localeTag } from "../i18n";
import { strToU8, zipSync } from "fflate";
import { allParagraphs, paragraphText, type Block, type CellBorder, type DocumentModel, type Paragraph, type ParaProps, type Run, type RunProps, type Table } from "./model";
import { effectivePara } from "./styles";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tw = (pt: number) => Math.round(pt * 20);

/** Nomi standard di Word per gli stili predefiniti (Word li riconosce e li traduce). */
const WORD_NAMES: Record<string, string> = {
  Normal: "Normal", Title: "Title", Subtitle: "Subtitle", Quote: "Quote", NoSpacing: "No Spacing",
  ListParagraph: "List Paragraph", Caption: "caption", TOCHeading: "TOC Heading", Header: "header", Footer: "footer",
  Hyperlink: "Hyperlink", TOC1: "toc 1", TOC2: "toc 2", TOC3: "toc 3",
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`Heading${i + 1}`, `heading ${i + 1}`])),
};

const NAMED_HIGHLIGHT: Record<string, string> = {
  "#ffff00": "yellow", "#00ff00": "green", "#00ffff": "cyan", "#ff00ff": "magenta", "#0000ff": "blue", "#ff0000": "red",
  "#000080": "darkBlue", "#008080": "darkCyan", "#008000": "darkGreen", "#800080": "darkMagenta", "#800000": "darkRed",
  "#808000": "darkYellow", "#808080": "darkGray", "#c0c0c0": "lightGray", "#000000": "black", "#ffffff": "white",
};

interface Out {
  rels: { id: string; type: string; target: string; external?: boolean }[];
  media: { name: string; bytes: Uint8Array; ext: string }[];
  /** Immagini già salvate (stessa immagine usata più volte). */
  mediaBySrc: Map<string, string>;
  nextDrawing: number;
}

function relId(out: Out, type: string, target: string, external = false): string {
  const existing = out.rels.find((r) => r.type === type && r.target === target);
  if (existing) return existing.id;
  const id = `rId${out.rels.length + 10}`;
  out.rels.push({ id, type, target, external });
  return id;
}

// ---------- proprietà ----------

function rPr(p: RunProps, extra = ""): string {
  let s = extra;
  if (p.font) s += `<w:rFonts w:ascii="${esc(p.font)}" w:hAnsi="${esc(p.font)}" w:cs="${esc(p.font)}" w:eastAsia="${esc(p.font)}"/>`;
  if (p.bold !== undefined) s += p.bold ? "<w:b/><w:bCs/>" : `<w:b w:val="0"/>`;
  if (p.italic !== undefined) s += p.italic ? "<w:i/><w:iCs/>" : `<w:i w:val="0"/>`;
  if (p.strike) s += "<w:strike/>";
  if (p.color) s += `<w:color w:val="${p.color.slice(1).toUpperCase()}"/>`;
  if (p.size) s += `<w:sz w:val="${Math.round(p.size * 2)}"/><w:szCs w:val="${Math.round(p.size * 2)}"/>`;
  if (p.highlight) {
    const named = NAMED_HIGHLIGHT[p.highlight.toLowerCase()];
    s += named ? `<w:highlight w:val="${named}"/>` : `<w:shd w:val="clear" w:color="auto" w:fill="${p.highlight.slice(1).toUpperCase()}"/>`;
  }
  if (p.underline !== undefined) s += `<w:u w:val="${p.underline ? "single" : "none"}"/>`;
  if (p.vertAlign) s += `<w:vertAlign w:val="${p.vertAlign}"/>`;
  return s ? `<w:rPr>${s}</w:rPr>` : "";
}

function pPr(p: ParaProps, markProps?: RunProps): string {
  let s = "";
  if (p.style && p.style !== "Normal") s += `<w:pStyle w:val="${esc(p.style)}"/>`;
  if (p.keepNext !== undefined) s += p.keepNext ? "<w:keepNext/>" : `<w:keepNext w:val="0"/>`;
  if (p.pageBreakBefore) s += "<w:pageBreakBefore/>";
  if (p.numId !== undefined) s += `<w:numPr><w:ilvl w:val="${p.numLevel ?? 0}"/><w:numId w:val="${p.numId}"/></w:numPr>`;
  if (p.shading) s += `<w:shd w:val="clear" w:color="auto" w:fill="${p.shading.slice(1).toUpperCase()}"/>`;
  if (p.tabs?.length) {
    s += `<w:tabs>${p.tabs.map((t) => `<w:tab w:val="${t.align}" w:pos="${tw(t.pos)}"${t.leader && t.leader !== "none" ? ` w:leader="${t.leader}"` : ""}/>`).join("")}</w:tabs>`;
  }
  if (p.spaceBefore !== undefined || p.spaceAfter !== undefined || p.line !== undefined) {
    let a = "";
    if (p.spaceBefore !== undefined) a += ` w:before="${tw(p.spaceBefore)}"`;
    if (p.spaceAfter !== undefined) a += ` w:after="${tw(p.spaceAfter)}"`;
    if (p.line !== undefined) {
      a += p.lineRule === "exact" || p.lineRule === "atLeast"
        ? ` w:line="${tw(p.line)}" w:lineRule="${p.lineRule}"`
        : ` w:line="${Math.round(p.line * 240)}" w:lineRule="auto"`;
    }
    s += `<w:spacing${a}/>`;
  }
  if (p.indentLeft !== undefined || p.indentRight !== undefined || p.firstLine !== undefined) {
    let a = "";
    if (p.indentLeft !== undefined) a += ` w:left="${tw(p.indentLeft)}"`;
    if (p.indentRight !== undefined) a += ` w:right="${tw(p.indentRight)}"`;
    if (p.firstLine !== undefined) a += p.firstLine < 0 ? ` w:hanging="${tw(-p.firstLine)}"` : ` w:firstLine="${tw(p.firstLine)}"`;
    s += `<w:ind${a}/>`;
  }
  if (p.align && p.align !== "left") s += `<w:jc w:val="${p.align === "justify" ? "both" : p.align}"/>`;
  if (p.outlineLevel !== undefined) s += `<w:outlineLvl w:val="${p.outlineLevel}"/>`;
  if (markProps && Object.keys(markProps).length) s += rPr(markProps);
  return s ? `<w:pPr>${s}</w:pPr>` : "";
}

// ---------- contenuto ----------

function textRun(text: string, props: RunProps): string {
  const parts: string[] = [];
  let buf = "";
  const flush = () => { if (buf) { parts.push(`<w:t xml:space="preserve">${esc(buf)}</w:t>`); buf = ""; } };
  for (const ch of text) {
    if (ch === "\t") { flush(); parts.push("<w:tab/>"); }
    else if (ch === "\u000b" || ch === "\n") { flush(); parts.push("<w:br/>"); }
    else if (ch === "\f") { flush(); parts.push(`<w:br w:type="page"/>`); }
    else buf += ch;
  }
  flush();
  const { link: _l, ...rest } = props;
  void _l;
  return `<w:r>${rPr(rest, props.link ? `<w:rStyle w:val="Hyperlink"/>` : "")}${parts.join("")}</w:r>`;
}

function imageXml(out: Out, run: Extract<Run, { type: "image" }>): string {
  let target = out.mediaBySrc.get(run.src);
  if (!target) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(run.src);
    if (!m) return "";
    const ext = ({ "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/svg+xml": "svg", "image/bmp": "bmp", "image/webp": "webp" } as Record<string, string>)[m[1]] ?? "png";
    const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : strToU8(decodeURIComponent(m[3]));
    const name = `image${out.media.length + 1}.${ext}`;
    out.media.push({ name, bytes, ext });
    target = `media/${name}`;
    out.mediaBySrc.set(run.src, target);
  }
  const rid = relId(out, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", target);
  const cx = Math.round(run.width * 12700), cy = Math.round(run.height * 12700);
  const id = out.nextDrawing++;
  const alt = esc(run.alt ?? "");
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Immagine ${id}" descr="${alt}"/>`
    + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="Immagine ${id}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
    + `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function fieldXml(field: string, props: RunProps, cached: string): string {
  const r = rPr(props);
  return `<w:r>${r}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${r}<w:instrText xml:space="preserve"> ${field} </w:instrText></w:r>`
    + `<w:r>${r}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${r}<w:t>${cached}</w:t></w:r><w:r>${r}<w:fldChar w:fldCharType="end"/></w:r>`;
}

function paragraphXml(out: Out, p: Paragraph): string {
  let body = "";
  let i = 0;
  while (i < p.runs.length) {
    const run = p.runs[i];
    if (run.type === "image") { body += imageXml(out, run); i++; continue; }
    if (run.type === "field") { body += fieldXml(run.field, run.props, "1"); i++; continue; }
    if (run.props.link) {
      // Run consecutivi con lo stesso collegamento vanno in un unico <w:hyperlink>.
      const link = run.props.link;
      let inner = "";
      while (i < p.runs.length) {
        const r = p.runs[i];
        if (r.type === "image" || r.type === "field" || r.props.link !== link) break;
        inner += textRun(r.text, r.props);
        i++;
      }
      body += link.startsWith("#")
        ? `<w:hyperlink w:anchor="${esc(link.slice(1))}">${inner}</w:hyperlink>`
        : `<w:hyperlink r:id="${relId(out, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", link, true)}">${inner}</w:hyperlink>`;
      continue;
    }
    body += textRun(run.text, run.props);
    i++;
  }
  return `<w:p>${pPr(p.props, p.markProps)}${body}</w:p>`;
}

function borderXml(tag: string, b: CellBorder | null | undefined): string {
  if (b === undefined) return "";
  if (b === null) return `<w:${tag} w:val="nil"/>`;
  const val = b.style === "double" ? "double" : b.style === "dashed" ? "dashed" : b.style === "dotted" ? "dotted" : "single";
  return `<w:${tag} w:val="${val}" w:sz="${Math.max(2, Math.round(b.width * 8))}" w:space="0" w:color="${b.color.slice(1).toUpperCase()}"/>`;
}

function tableXml(out: Out, t: Table): string {
  const b = t.borders === undefined ? { width: 0.5, color: "#000000" } : t.borders;
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => borderXml(s, b)).join("");
  let xml = `<w:tbl><w:tblPr><w:tblW w:w="${tw(t.grid.reduce((a, c) => a + c, 0))}" w:type="dxa"/>`
    + (t.align && t.align !== "left" ? `<w:jc w:val="${t.align}"/>` : "")
    + `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="04A0"/></w:tblPr>`
    + `<w:tblGrid>${t.grid.map((w) => `<w:gridCol w:w="${tw(w)}"/>`).join("")}</w:tblGrid>`;
  for (const row of t.rows) {
    xml += "<w:tr>";
    if (row.height || row.header) xml += `<w:trPr>${row.height ? `<w:trHeight w:val="${tw(row.height)}"/>` : ""}${row.header ? "<w:tblHeader/>" : ""}</w:trPr>`;
    let col = 0;
    for (const cell of row.cells) {
      const w = t.grid.slice(col, col + cell.span).reduce((a, c) => a + c, 0);
      col += cell.span;
      let tcPr = `<w:tcW w:w="${tw(w)}" w:type="dxa"/>`;
      if (cell.span > 1) tcPr += `<w:gridSpan w:val="${cell.span}"/>`;
      if (cell.vMerge) tcPr += cell.vMerge === "restart" ? `<w:vMerge w:val="restart"/>` : "<w:vMerge/>";
      if (cell.borders) tcPr += `<w:tcBorders>${(["top", "left", "bottom", "right"] as const).map((s) => borderXml(s, cell.borders![s])).join("")}</w:tcBorders>`;
      if (cell.shading) tcPr += `<w:shd w:val="clear" w:color="auto" w:fill="${cell.shading.slice(1).toUpperCase()}"/>`;
      if (cell.vAlign && cell.vAlign !== "top") tcPr += `<w:vAlign w:val="${cell.vAlign}"/>`;
      const paras = cell.paragraphs.length ? cell.paragraphs : [{ type: "p" as const, id: 0, props: {}, runs: [] }];
      xml += `<w:tc><w:tcPr>${tcPr}</w:tcPr>${paras.map((p) => paragraphXml(out, p)).join("")}</w:tc>`;
    }
    xml += "</w:tr>";
  }
  return `${xml}</w:tbl>`;
}

/** Sommario come vero campo TOC di Word, con le voci già calcolate (Word può aggiornarlo con F9). */
function tocXml(doc: DocumentModel, maxLevel: number, title: string, pages: Map<number, number>): string {
  const width = doc.page.width - doc.page.marginLeft - doc.page.marginRight;
  const entries = [...allParagraphs(doc.blocks)]
    .map((p) => ({ p, level: effectivePara(doc, p).outlineLevel }))
    .filter((e): e is { p: Paragraph; level: number } => e.level !== undefined && e.level < maxLevel);
  let xml = `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>`;
  xml += `<w:p><w:pPr><w:pStyle w:val="TOCHeading"/></w:pPr><w:r><w:t>${esc(title)}</w:t></w:r></w:p>`;
  const begin = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-${maxLevel}" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`;
  const end = `<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  if (!entries.length) {
    xml += `<w:p>${begin}<w:r><w:t>Nessuna voce di sommario.</w:t></w:r>${end}</w:p>`;
  } else {
    entries.forEach(({ p, level }, i) => {
      const text = esc(paragraphText(p).replace(/[\t\n\f\u000b￼]/g, " ").trim());
      xml += `<w:p><w:pPr><w:pStyle w:val="TOC${Math.min(3, level + 1)}"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${tw(width)}"/></w:tabs></w:pPr>`
        + (i === 0 ? begin : "")
        + `<w:r><w:t xml:space="preserve">${text}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>${pages.get(p.id) ?? ""}</w:t></w:r>`
        + (i === entries.length - 1 ? end : "") + `</w:p>`;
    });
  }
  return `${xml}</w:sdtContent></w:sdt>`;
}

function blocksXml(out: Out, doc: DocumentModel, blocks: Block[], pages: Map<number, number>): string {
  return blocks.map((b) => b.type === "p" ? paragraphXml(out, b) : b.type === "table" ? tableXml(out, b) : tocXml(doc, b.maxLevel, b.title ?? "Sommario", pages)).join("");
}

// ---------- parti del pacchetto ----------

const DOC_NS = `xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

function stylesXml(doc: DocumentModel): string {
  const d = doc.defaultRun;
  let xml = `${XML}<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr>`
    + `<w:rFonts w:ascii="${esc(d.font ?? "Calibri")}" w:hAnsi="${esc(d.font ?? "Calibri")}" w:eastAsia="${esc(d.font ?? "Calibri")}" w:cs="${esc(d.font ?? "Calibri")}"/>`
    + `<w:sz w:val="${Math.round((d.size ?? 11) * 2)}"/><w:szCs w:val="${Math.round((d.size ?? 11) * 2)}"/><w:lang w:val="${localeTag()}" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>`
    + `<w:pPrDefault>${pPr(doc.defaultPara) || "<w:pPr/>"}</w:pPrDefault></w:docDefaults>`;
  for (const s of Object.values(doc.styles)) {
    if (s.type === "table") continue;
    const isDefault = s.id === "Normal" || (s.type === "character" && s.id === "DefaultParagraphFont");
    xml += `<w:style w:type="${s.type}"${isDefault ? ` w:default="1"` : ""} w:styleId="${esc(s.id)}"><w:name w:val="${esc(WORD_NAMES[s.id] ?? s.name)}"/>`
      + (s.basedOn ? `<w:basedOn w:val="${esc(s.basedOn)}"/>` : "")
      + (s.next ? `<w:next w:val="${esc(s.next)}"/>` : "")
      + (s.quick ? "<w:qFormat/>" : "")
      + (s.type === "paragraph" ? pPr({ ...(s.para ?? {}), style: undefined }) : "")
      + rPr(s.run ?? {})
      + "</w:style>";
  }
  xml += `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>`;
  return `${xml}</w:styles>`;
}

function numberingXml(doc: DocumentModel): string {
  let abs = "", nums = "";
  for (const n of Object.values(doc.numbering)) {
    abs += `<w:abstractNum w:abstractNumId="${n.id}"><w:multiLevelType w:val="hybridMultilevel"/>`;
    n.levels.forEach((l, i) => {
      abs += `<w:lvl w:ilvl="${i}"><w:start w:val="${l.start}"/><w:numFmt w:val="${l.format}"/><w:lvlText w:val="${esc(l.text)}"/><w:lvlJc w:val="left"/>`
        + `<w:pPr><w:ind w:left="${tw(l.indentLeft)}" w:hanging="${tw(l.hanging)}"/></w:pPr>`
        + (l.format === "bullet" ? `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:hint="default"/></w:rPr>` : "")
        + "</w:lvl>";
    });
    abs += "</w:abstractNum>";
    nums += `<w:num w:numId="${n.id}"><w:abstractNumId w:val="${n.id}"/></w:num>`;
  }
  return `${XML}<w:numbering xmlns:w="${W_NS}">${abs}${nums}</w:numbering>`;
}

function relsXml(rels: Out["rels"]): string {
  return `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ` TargetMode="External"` : ""}/>`).join("")
    + "</Relationships>";
}

/** Crea il file .docx. `headingPages` = pagina di ogni titolo, per le voci del sommario. */
export function exportDocx(doc: DocumentModel, headingPages: Map<number, number> = new Map()): Uint8Array {
  const out: Out = { rels: [], media: [], mediaBySrc: new Map(), nextDrawing: 1 };
  const RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  out.rels.push(
    { id: "rId1", type: `${RT}/styles`, target: "styles.xml" },
    { id: "rId2", type: `${RT}/numbering`, target: "numbering.xml" },
    { id: "rId3", type: `${RT}/settings`, target: "settings.xml" },
  );
  const files: Record<string, Uint8Array> = {};
  let sectRefs = "";
  const part = (kind: "header" | "footer", paras: Paragraph[]) => {
    if (!paras.length) return;
    const sub: Out = { rels: [], media: out.media, mediaBySrc: out.mediaBySrc, nextDrawing: out.nextDrawing };
    const tag = kind === "header" ? "hdr" : "ftr";
    files[`word/${kind}1.xml`] = strToU8(`${XML}<w:${tag} ${DOC_NS}>${paras.map((p) => paragraphXml(sub, p)).join("")}</w:${tag}>`);
    out.nextDrawing = sub.nextDrawing;
    if (sub.rels.length) files[`word/_rels/${kind}1.xml.rels`] = strToU8(relsXml(sub.rels));
    const id = relId(out, `${RT}/${kind}`, `${kind}1.xml`);
    sectRefs += `<w:${kind}Reference w:type="default" r:id="${id}"/>`;
  };
  part("header", doc.header);
  part("footer", doc.footer);

  const pg = doc.page;
  const sect = `<w:sectPr>${sectRefs}<w:pgSz w:w="${tw(pg.width)}" w:h="${tw(pg.height)}"${pg.width > pg.height ? ` w:orient="landscape"` : ""}/>`
    + `<w:pgMar w:top="${tw(pg.marginTop)}" w:right="${tw(pg.marginRight)}" w:bottom="${tw(pg.marginBottom)}" w:left="${tw(pg.marginLeft)}" w:header="${tw(pg.headerDistance)}" w:footer="${tw(pg.footerDistance)}" w:gutter="0"/>`
    + `<w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>`;
  const body = blocksXml(out, doc, doc.blocks, headingPages);
  files["word/document.xml"] = strToU8(`${XML}<w:document ${DOC_NS}><w:body>${body}${sect}</w:body></w:document>`);
  files["word/styles.xml"] = strToU8(stylesXml(doc));
  files["word/numbering.xml"] = strToU8(numberingXml(doc));
  files["word/settings.xml"] = strToU8(`${XML}<w:settings xmlns:w="${W_NS}"><w:defaultTabStop w:val="708"/><w:hyphenationZone w:val="283"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat><w:themeFontLang w:val="${localeTag()}"/></w:settings>`);
  if (doc.comments?.length) {
    const cXml = doc.comments.map((cm) =>
      `<w:comment w:id="${cm.id}" w:author="${esc(cm.author)}" w:date="${esc(cm.date || new Date().toISOString())}"><w:p><w:r><w:t xml:space="preserve">${esc(cm.text)}</w:t></w:r></w:p></w:comment>`
    ).join("");
    files["word/comments.xml"] = strToU8(`${XML}<w:comments xmlns:w="${W_NS}">${cXml}</w:comments>`);
    relId(out, `${RT}/comments`, "comments.xml");
  }
  for (const m of out.media) files[`word/media/${m.name}`] = m.bytes;
  files["word/_rels/document.xml.rels"] = strToU8(relsXml(out.rels));

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  files["docProps/core.xml"] = strToU8(`${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  files["docProps/app.xml"] = strToU8(`${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>ZikOffice</Application></Properties>`);
  files["_rels/.rels"] = strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${RT}/extended-properties" Target="docProps/app.xml"/></Relationships>`);

  const exts = new Set(out.media.map((m) => m.ext));
  const mimeOf: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp", webp: "image/webp" };
  const WML = "application/vnd.openxmlformats-officedocument.wordprocessingml";
  files["[Content_Types].xml"] = strToU8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
    + [...exts].map((e) => `<Default Extension="${e}" ContentType="${mimeOf[e]}"/>`).join("")
    + `<Override PartName="/word/document.xml" ContentType="${WML}.document.main+xml"/>`
    + `<Override PartName="/word/styles.xml" ContentType="${WML}.styles+xml"/>`
    + `<Override PartName="/word/numbering.xml" ContentType="${WML}.numbering+xml"/>`
    + `<Override PartName="/word/settings.xml" ContentType="${WML}.settings+xml"/>`
    + (doc.header.length ? `<Override PartName="/word/header1.xml" ContentType="${WML}.header+xml"/>` : "")
    + (doc.footer.length ? `<Override PartName="/word/footer1.xml" ContentType="${WML}.footer+xml"/>` : "")
    + (doc.comments?.length ? `<Override PartName="/word/comments.xml" ContentType="${WML}.comments+xml"/>` : "")
    + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`
    + `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`
    + "</Types>");
  return zipSync(files, { level: 6 });
}
