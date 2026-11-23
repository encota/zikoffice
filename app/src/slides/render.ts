// Disegno di una diapositiva come DOM (1 px = 1 punto): la stessa funzione serve per
// l'editor, le miniature, la presentazione a schermo intero e la stampa.
import { cssFontFamily } from "../sheet/format";
import { tr } from "../i18n";
import type { Frame, Geometry, Presentation, ShapeItem, Slide, SlideItem, TableItem } from "./model";
import { isTitleLike, mixColor, placeItems, roleStyle, slideBackground, themeDecor, type RoleStyle } from "./layout";
import { fillText, fitSize, isTextEmpty } from "./text";
import { contrastOn, readable } from "./themes";

export type RenderMode = "edit" | "show" | "thumb" | "print";

const urls = new WeakMap<Uint8Array, string>();

export function imageUrl(bytes: Uint8Array, mime: string): string {
  let u = urls.get(bytes);
  if (!u) {
    u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    urls.set(bytes, u);
  }
  return u;
}

/** Per la stampa le immagini vanno come data URL (il documento di stampa può essere separato). */
export function dataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

const SVG = "http://www.w3.org/2000/svg";

export function geometryPath(geom: Geometry, w: number, h: number): string {
  switch (geom) {
    case "triangle": return `M${w / 2},0 L${w},${h} L0,${h} Z`;
    case "diamond": return `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z`;
    case "rightArrow": {
      const hl = Math.min(w, h * 0.5);
      return `M0,${h * 0.25} L${w - hl},${h * 0.25} L${w - hl},0 L${w},${h / 2} L${w - hl},${h} L${w - hl},${h * 0.75} L0,${h * 0.75} Z`;
    }
    case "chevron": {
      const a = Math.min(w, h * 0.5);
      return `M0,0 L${w - a},0 L${w},${h / 2} L${w - a},${h} L0,${h} L${a},${h / 2} Z`;
    }
    case "star5": {
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.38 : 0.5;
        pts.push(`${w / 2 + Math.cos(ang) * r * w},${h / 2 + Math.sin(ang) * r * h * 1.05 + h * 0.03}`);
      }
      return `M${pts.join(" L")} Z`;
    }
    default: return "";
  }
}

function shapeSvg(item: ShapeItem, f: Frame, fill: string | null, line: { color: string; width: number } | null): SVGElement | null {
  if (!fill && !line) return null;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "st-geom");
  const pad = line ? line.width : 0;
  svg.setAttribute("width", String(f.w + pad * 2));
  svg.setAttribute("height", String(f.h + pad * 2));
  svg.setAttribute("viewBox", `${-pad} ${-pad} ${f.w + pad * 2} ${f.h + pad * 2}`);
  svg.style.left = svg.style.top = `${-pad}px`;
  let el: SVGElement;
  const w = f.w, h = f.h;
  if (item.custom) {
    const g = document.createElementNS(SVG, "g");
    for (const cp of item.custom.paths) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", cp.d);
      // Senza un sistema proprio, il tracciato è in EMU della forma.
      path.setAttribute("transform", cp.w && cp.h ? `scale(${w / cp.w} ${h / cp.h})` : `scale(${1 / 12700})`);
      path.setAttribute("fill", cp.noFill ? "none" : fill ?? "none");
      if (line && !cp.noStroke) {
        path.setAttribute("stroke", line.color);
        path.setAttribute("stroke-width", String(line.width));
        path.setAttribute("vector-effect", "non-scaling-stroke");
      }
      g.append(path);
    }
    if (item.flipH || item.flipV) g.setAttribute("transform", `translate(${item.flipH ? w : 0} ${item.flipV ? h : 0}) scale(${item.flipH ? -1 : 1} ${item.flipV ? -1 : 1})`);
    svg.append(g);
    return svg;
  }
  if (item.geom === "line") {
    el = document.createElementNS(SVG, "line");
    const [x1, x2] = item.flipH ? [w, 0] : [0, w];
    const [y1, y2] = item.flipV ? [h, 0] : [0, h];
    Object.entries({ x1, y1, x2, y2 }).forEach(([k, v]) => el.setAttribute(k, String(v)));
  } else if (item.geom === "rect" || item.geom === "roundRect") {
    el = document.createElementNS(SVG, "rect");
    el.setAttribute("width", String(w));
    el.setAttribute("height", String(h));
    if (item.geom === "roundRect") el.setAttribute("rx", String(Math.min(w, h) * 0.1667));
  } else if (item.geom === "ellipse") {
    el = document.createElementNS(SVG, "ellipse");
    Object.entries({ cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 }).forEach(([k, v]) => el.setAttribute(k, String(v)));
  } else {
    el = document.createElementNS(SVG, "path");
    el.setAttribute("d", geometryPath(item.geom, w, h));
  }
  el.setAttribute("fill", item.geom === "line" ? "none" : fill ?? "none");
  if (line) {
    el.setAttribute("stroke", line.color);
    el.setAttribute("stroke-width", String(line.width));
  }
  svg.append(el);
  return svg;
}

export function placeholderPrompt(role: string, layout: string): string {
  if (role === "title") return layout === "title" ? tr("Fai clic per aggiungere il titolo") : tr("Fai clic per aggiungere un titolo");
  if (role === "subtitle") return tr("Fai clic per aggiungere un sottotitolo");
  if (role === "body") return tr("Fai clic per aggiungere testo");
  return "";
}

export function shapeStyle(p: Presentation, slide: Slide, item: ShapeItem): RoleStyle {
  const onTitleBg = isTitleLike(slide.layout) && !!p.theme.titleBackground && !slide.background;
  const style = roleStyle(p.theme, slide.layout, item.role, onTitleBg);
  // Testo dentro una forma piena: centrato e leggibile sul colore della forma.
  if (item.role === "text" && item.fill && item.geom !== "line") {
    return { ...style, color: contrastOn(item.fill), align: "ctr", anchor: "ctr" };
  }
  // Sfondo cambiato a mano: se il colore del tema non si legge più, si passa a bianco o nero.
  if (slide.background && item.role !== "text" && !readable(style.color, slide.background)) return { ...style, color: contrastOn(slide.background) };
  return style;
}

function renderShape(p: Presentation, slide: Slide, item: ShapeItem, frame: Frame, mode: RenderMode): HTMLElement {
  const el = document.createElement("div");
  const style = shapeStyle(p, slide, item);
  const fill = item.fill === undefined ? null : item.fill;
  const line = item.line === undefined ? null : item.line;
  const svg = shapeSvg(item, frame, fill, line);
  if (svg) el.append(svg);
  if (item.geom !== "line") {
    const text = document.createElement("div");
    text.className = "st-text";
    text.dataset.anchor = item.anchor ?? style.anchor;
    const [l, t, r, b] = item.inset ?? [7.2, 3.6, 7.2, 3.6];
    text.style.padding = `${t}px ${r}px ${b}px ${l}px`;
    text.style.fontFamily = cssFontFamily(style.font);
    text.style.color = style.color;
    text.style.fontSize = fitSize(style.size);
    if (style.bold) text.style.fontWeight = "700";
    text.style.setProperty("--fit", String(item.fit ?? 1));
    if (item.noWrap) { text.style.whiteSpace = "pre"; text.style.overflow = "visible"; }
    text.style.setProperty("--bullet", p.theme.accent);
    fillText(text, item.paras, item.role, style);
    const empty = isTextEmpty(item.paras);
    if (empty && item.role !== "text") {
      if (mode === "edit") {
        text.dataset.placeholder = placeholderPrompt(item.role, slide.layout);
        text.classList.add("empty");
      } else if (mode !== "thumb" || item.role !== "body") {
        text.style.visibility = "hidden";
      }
    }
    el.append(text);
  }
  return el;
}

function renderTable(p: Presentation, item: TableItem): HTMLElement {
  const el = document.createElement("div");
  const table = document.createElement("table");
  table.className = "st-table";
  table.style.fontFamily = cssFontFamily(p.theme.bodyFont);
  table.style.setProperty("--fit", "1");
  const total = item.cols?.reduce((a, b) => a + b, 0) ?? 0;
  if (item.cols && total > 0) {
    const cg = document.createElement("colgroup");
    for (const c of item.cols) {
      const col = document.createElement("col");
      col.style.width = `${(c / total) * 100}%`;
      cg.append(col);
    }
    table.append(cg);
  }
  const style: RoleStyle = { size: Math.round(p.theme.bodySize * 0.72), color: p.theme.text, font: p.theme.bodyFont, bold: false, align: "l", anchor: "t", bullets: false };
  item.rows.forEach((row, ri) => {
    const tr = document.createElement("tr");
    row.forEach((cell) => {
      const td = document.createElement("td");
      const head = item.header && ri === 0;
      const bg = cell.fill ?? (head ? p.theme.accent : mixColor(p.theme.accent, p.theme.background, ri % 2 ? 0.14 : 0.06));
      td.style.background = bg;
      td.style.color = head ? contrastOn(p.theme.accent) : cell.fill ? contrastOn(cell.fill) : p.theme.text;
      if (head) td.style.fontWeight = "700";
      const box = document.createElement("div");
      box.className = "st-cell";
      fillText(box, cell.paras, "text", style);
      td.append(box);
      tr.append(td);
    });
    table.append(tr);
  });
  el.append(table);
  return el;
}

function renderItem(p: Presentation, slide: Slide, item: SlideItem, frame: Frame, mode: RenderMode, auto: boolean): HTMLElement {
  let el: HTMLElement;
  if (item.kind === "shape") el = renderShape(p, slide, item, frame, mode);
  else if (item.kind === "image") {
    el = document.createElement("div");
    const img = document.createElement("img");
    img.src = mode === "print" ? dataUrl(item.bytes, item.mime) : imageUrl(item.bytes, item.mime);
    img.alt = item.alt ?? "";
    img.draggable = false;
    el.append(img);
  } else if (item.kind === "table") el = renderTable(p, item);
  else {
    el = document.createElement("div");
    el.className = "st-raw";
    if (mode === "edit" || mode === "thumb") el.append(document.createTextNode(tr(item.label)));
  }
  el.classList.add("st-item", `st-${item.kind}`);
  if (item.id >= 0) el.dataset.id = String(item.id);
  if (auto) el.dataset.auto = "1";
  el.style.left = `${frame.x}px`;
  el.style.top = `${frame.y}px`;
  el.style.width = `${Math.max(1, frame.w)}px`;
  el.style.height = `${Math.max(item.kind === "shape" && item.geom === "line" ? 0 : 1, frame.h)}px`;
  if (frame.rot) el.style.transform = `rotate(${frame.rot}deg)`;
  return el;
}

/** Disegna la diapositiva; l'elemento ha le dimensioni della diapositiva in punti. */
export function renderSlide(p: Presentation, slide: Slide, mode: RenderMode): HTMLElement {
  const root = document.createElement("div");
  root.className = `st-slide mode-${mode}`;
  root.style.width = `${p.width}px`;
  root.style.height = `${p.height}px`;
  root.style.background = slideBackground(p, slide);
  if (slide.backgroundImage) {
    const u = mode === "print" ? dataUrl(slide.backgroundImage.bytes, slide.backgroundImage.mime) : imageUrl(slide.backgroundImage.bytes, slide.backgroundImage.mime);
    root.style.backgroundImage = `url("${u}")`;
    root.style.backgroundSize = "100% 100%";
  }
  const decor = [...themeDecor(p, slide), ...(slide.decor ? p.decor[slide.decor] ?? [] : [])];
  for (const d of decor) {
    const f = d.frame ?? { x: 0, y: 0, w: p.width, h: p.height };
    const el = renderItem(p, slide, d, f, mode === "edit" ? "show" : mode, false);
    el.classList.add("st-decor");
    delete el.dataset.id;
    root.append(el);
  }
  for (const placed of placeItems(p, slide)) root.append(renderItem(p, slide, placed.item, placed.frame, mode, placed.auto));
  return root;
}

/**
 * Riduce il testo dei titoli e del corpo che non stanno nel loro riquadro (come "Adatta testo"
 * di PowerPoint). Va chiamata con la diapositiva già nel documento. Restituisce gli id cambiati.
 */
export function fitText(root: HTMLElement, slide: Slide): number[] {
  const changed: number[] = [];
  for (const item of slide.items) {
    if (item.kind !== "shape" || item.role === "text") continue;
    const el = root.querySelector<HTMLElement>(`.st-item[data-id="${item.id}"] .st-text`);
    if (!el) continue;
    let fit = 1;
    el.style.setProperty("--fit", "1");
    while (fit > 0.4 && el.scrollHeight > el.clientHeight + 1) {
      fit = Math.round((fit - 0.05) * 100) / 100;
      el.style.setProperty("--fit", String(fit));
    }
    const value = fit < 1 ? fit : undefined;
    if (value !== item.fit) { item.fit = value; changed.push(item.id); }
  }
  return changed;
}

export { fitSize };
