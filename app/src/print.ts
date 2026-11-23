// Stampa ed esportazione PDF: si costruisce una versione "da stampa" del documento
import { localeTag } from "./i18n";
// (pagine SVG con testo vettoriale per i documenti, tabella per i fogli di calcolo).
import type { DocEditor } from "./doc/editor";
import { measure, type Line, type PageBox } from "./doc/layout";
import type { CellStyle, Model } from "./sheet/engine";
import { cssFontFamily } from "./sheet/format";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- documenti ----------

function fontAttrs(font: string): string {
  // font CSS: "[italic ][bold ]<size>px <famiglie>"
  const m = /^(italic )?(bold )?([\d.]+)px (.*)$/.exec(font);
  if (!m) return "";
  return `font-family="${esc(m[4])}" font-size="${m[3]}"${m[2] ? ` font-weight="bold"` : ""}${m[1] ? ` font-style="italic"` : ""}`;
}

function lineSvg(line: Line): string {
  let s = "";
  const baseY = line.y + line.baseline;
  for (const f of line.fragments) {
    const x = line.x + f.x;
    if (f.image) {
      s += `<image href="${esc(f.image.src)}" x="${x}" y="${baseY - f.image.height}" width="${f.image.width}" height="${f.image.height}" preserveAspectRatio="none"/>`;
      continue;
    }
    if (f.props.highlight && !f.label) s += `<rect x="${x}" y="${line.y}" width="${f.width}" height="${line.height}" fill="${f.props.highlight}"/>`;
    if (f.tab) {
      if (f.tab.leader === "dot") {
        for (let dx = Math.ceil(x / 3.2) * 3.2 + 1; dx < x + f.width - 3; dx += 3.2) s += `<rect x="${dx}" y="${baseY - 0.8}" width="0.8" height="0.8" fill="${f.props.color ?? "#000"}"/>`;
      }
      continue;
    }
    if (!f.text) continue;
    const y = baseY + f.shift;
    const fill = f.props.color ?? "#000000";
    if (f.justify) {
      let cx = x;
      for (const part of f.text.split(/( )/)) {
        if (part === " ") { cx += measure(f.font, " ") + f.justify; continue; }
        if (part) s += `<text x="${cx}" y="${y}" ${fontAttrs(f.font)} fill="${fill}" xml:space="preserve">${esc(part)}</text>`;
        cx += measure(f.font, part);
      }
    } else {
      s += `<text x="${x}" y="${y}" ${fontAttrs(f.font)} fill="${fill}" xml:space="preserve">${esc(f.text)}</text>`;
    }
    const size = f.props.size ?? 11;
    if (f.props.underline) s += `<rect x="${x}" y="${y + size * 0.12}" width="${f.width}" height="${Math.max(0.5, size * 0.06)}" fill="${fill}"/>`;
    if (f.props.strike) s += `<rect x="${x}" y="${y - size * 0.3}" width="${f.width}" height="${Math.max(0.5, size * 0.06)}" fill="${fill}"/>`;
  }

  return s;
}

export function pageSvg(page: PageBox, width: number, height: number, watermark?: string): string {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}pt" height="${height}pt" viewBox="0 0 ${width} ${height}">`;
  s += `<rect width="${width}" height="${height}" fill="#fff"/>`;
  if (watermark) {
    s += `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="64" font-weight="700" fill="rgba(128,128,128,0.16)" transform="rotate(-35 ${width / 2} ${height / 2})">${esc(watermark)}</text>`;
  }
  for (const f of page.fills) s += `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" fill="${f.color}"/>`;
  for (const line of page.lines) s += lineSvg(line);
  for (const b of page.borders) {
    s += `<line x1="${b.x1}" y1="${b.y1}" x2="${b.x2}" y2="${b.y2}" stroke="${b.color}" stroke-width="${b.width}"${b.style === "dashed" ? ` stroke-dasharray="3 2"` : b.style === "dotted" ? ` stroke-dasharray="1 1.5"` : ""}/>`;
  }
  return `${s}</svg>`;
}

export function documentPrintHtml(ed: DocEditor): { html: string; width: number; height: number } {
  const { width, height } = ed.doc.page;
  // Ogni pagina è alta un soffio meno del foglio: evita pagine bianche per arrotondamenti.
  const pages = ed.layout.pages.map((p) => `<div class="print-page" style="width:${width}pt;height:${height - 1}pt;overflow:hidden">${pageSvg(p, width, height, ed.doc.watermark)}</div>`).join("");
  return { html: pages, width, height };
}

// ---------- fogli di calcolo ----------

/** Margine dei fogli di calcolo stampati (1,5 cm). */
export const SHEET_MARGIN = 42.5;

export interface SheetPrintOptions {
  orientation?: "auto" | "portrait" | "landscape";
  margin?: number;
  scale?: "fit" | number;
  repeatHeader?: boolean;
  showTitle?: boolean;
}

/**
 * Tabella da stampare e formato pagina: verticale se ci sta, altrimenti orizzontale,
 * altrimenti rimpicciolita per stare nella larghezza (come "Adatta alla pagina" di Excel).
 */
export function sheetPrintable(
  model: Model,
  sheet: number,
  title: string,
  opts: SheetPrintOptions = {},
): { html: string; page: { width: number; height: number }; margin: number } {
  const margin = opts.margin ?? SHEET_MARGIN;
  const { html, width } = sheetTable(model, sheet, title, !!opts.repeatHeader);
  const orient = opts.orientation ?? "auto";
  const portraitW = 595.3 - 2 * margin, landscapeW = 841.9 - 2 * margin;
  const isLandscape = orient === "landscape" || (orient === "auto" && width > portraitW);
  const page = isLandscape ? { width: 841.9, height: 595.3 } : { width: 595.3, height: 841.9 };
  const avail = isLandscape ? landscapeW : portraitW;
  const scale = typeof opts.scale === "number" ? opts.scale : Math.min(1, avail / Math.max(1, width));
  const header = opts.showTitle ? `<div style="display:flex;justify-content:space-between;font-size:9pt;color:#555;margin-bottom:8pt;border-bottom:0.5pt solid #ccc;padding-bottom:3pt"><strong>${esc(title)}</strong><span>${new Date().toLocaleDateString(localeTag())}</span></div>` : "";
  const wrapped = scale < 0.999 ? `<div style="zoom:${scale.toFixed(4)}">${html}</div>` : html;
  return { html: `${header}${wrapped}`, page, margin };
}

export function sheetPrintHtml(model: Model, sheet: number, title: string): string {
  return sheetTable(model, sheet, title, false).html;
}

function sheetTable(model: Model, sheet: number, title: string, repeatHeader: boolean): { html: string; width: number } {
  let maxRow = 0, maxCol = 0;
  for (let c = 1; c <= 1000; c++) {
    const rows = model.getRowsWithData(sheet, c);
    if (rows.length) { maxCol = c; maxRow = Math.max(maxRow, rows[rows.length - 1]); }
  }
  if (!maxRow) return { html: `<p class="print-empty">Il foglio «${esc(title)}» è vuoto.</p>`, width: 0 };
  const merged = model.getMergedCells(sheet);
  const covered = new Set<string>();
  for (const m of merged) for (let r = m.row; r < m.row + m.height; r++) for (let c = m.column; c < m.column + m.width; c++) if (r !== m.row || c !== m.column) covered.add(`${r},${c}`);
  const colsW: number[] = [];
  for (let c = 1; c <= maxCol; c++) colsW.push(model.getColumnWidth(sheet, c) * 0.75);
  const tableWidth = colsW.reduce((a, b) => a + b, 0);
  let html = `<table class="print-sheet"><colgroup>${colsW.map((w) => `<col style="width:${w}pt">`).join("")}</colgroup>`;
  const color = (c: unknown) => (c ? model.resolveColor(c as never) : "");
  const border = (b: { style: string; color?: unknown } | undefined) =>
    b ? `${b.style === "medium" ? 1.5 : b.style === "thick" ? 2.25 : 0.75}pt ${b.style === "double" ? "double" : b.style.includes("dash") ? "dashed" : b.style === "dotted" ? "dotted" : "solid"} ${color(b.color) || "#000"}` : "";
  for (let r = 1; r <= maxRow; r++) {
    const h = model.getRowHeight(sheet, r);
    if (h === 0) continue;
    if (repeatHeader && r === 1) html += "<thead>";
    else if (repeatHeader && r === 2) html += "<tbody>";
    html += `<tr style="height:${h * 0.75}pt">`;
    for (let c = 1; c <= maxCol; c++) {
      if (covered.has(`${r},${c}`)) continue;
      if (model.getColumnWidth(sheet, c) === 0) continue;
      const st: CellStyle = model.getCellStyle(sheet, r, c).style;
      const m = merged.find((x) => x.row === r && x.column === c);
      const text = model.getFormattedCellValue(sheet, r, c);
      const type = model.getCellType(sheet, r, c);
      let align = st.alignment?.horizontal ?? "general";
      if (align === "general") align = type === 1 ? "right" : type === 4 || type === 16 ? "center" : "left";
      const css = [
        `font-family:${esc(cssFontFamily(st.font.name))}`, `font-size:${st.font.sz}pt`,
        st.font.b ? "font-weight:bold" : "", st.font.i ? "font-style:italic" : "",
        st.font.u || st.font.strike ? `text-decoration:${st.font.u ? "underline" : ""} ${st.font.strike ? "line-through" : ""}` : "",
        st.font.color ? `color:${color(st.font.color)}` : "",
        st.fill?.color ? `background:${color(st.fill.color)}` : "",
        `text-align:${align === "centerContinuous" ? "center" : align}`,
        `vertical-align:${st.alignment?.vertical === "top" ? "top" : st.alignment?.vertical === "center" ? "middle" : "bottom"}`,
        st.alignment?.wrap_text ? "white-space:pre-wrap" : "white-space:pre",
        st.border?.top ? `border-top:${border(st.border.top)}` : "", st.border?.bottom ? `border-bottom:${border(st.border.bottom)}` : "",
        st.border?.left ? `border-left:${border(st.border.left)}` : "", st.border?.right ? `border-right:${border(st.border.right)}` : "",
      ].filter(Boolean).join(";");
      html += `<td${m ? ` colspan="${m.width}" rowspan="${m.height}"` : ""} style="${css}">${esc(text)}</td>`;
    }
    html += "</tr>";
    if (repeatHeader && r === 1) html += "</thead>";
  }
  if (repeatHeader && maxRow >= 2) html += "</tbody>";
  return { html: `${html}</table>`, width: tableWidth };
}

// ---------- stampa ----------

/** Prepara il contenuto da stampare; restituisce la funzione per rimuoverlo. */
export function mountPrint(html: string, page: { width: number; height: number } | null, margin = 0): () => void {
  const root = document.createElement("div");
  root.className = "print-root";
  root.innerHTML = html;
  const style = document.createElement("style");
  style.textContent = page
    ? `@page { size: ${page.width}pt ${page.height}pt; margin: ${margin}pt; }`
    : `@page { size: A4; margin: 1.5cm; }`;
  document.head.append(style);
  document.body.append(root);
  document.body.classList.add("printing");
  return () => { root.remove(); style.remove(); document.body.classList.remove("printing"); };
}

/** Apre la finestra di stampa del sistema (da cui si può anche salvare in PDF). */
export async function printHtml(html: string, page: { width: number; height: number } | null, margin = 0): Promise<void> {
  const unmount = mountPrint(html, page, margin);
  // Le immagini devono essere caricate prima di stampare.
  await Promise.all([...document.querySelectorAll<HTMLImageElement>(".print-root img")].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  try {
    window.print();
  } finally {
    // In alcune webview print() ritorna subito: lasciamo il contenuto finché la stampa parte.
    setTimeout(unmount, 1500);
  }
}
