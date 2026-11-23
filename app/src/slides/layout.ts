// Posizionamento automatico: il tema decide dove stanno titolo e contenuto, e ciò che si
// aggiunge alla diapositiva si dispone da solo nello spazio libero.
import type { Frame, ImageItem, LayoutId, Para, Presentation, Role, ShapeItem, Slide, SlideItem, Theme } from "./model";

export interface Placed {
  item: SlideItem;
  frame: Frame;
  /** Il riquadro è nel posto deciso dal layout (non spostato a mano). */
  auto: boolean;
}

export interface Boxes {
  title?: Frame;
  subtitle?: Frame;
  /** Zona del contenuto. */
  body?: Frame;
}

/** Le decorazioni del tema occupano spazio: i margini si spostano di conseguenza. */
function margins(p: Presentation): { left: number; right: number; top: number } {
  const W = p.width, H = p.height;
  const side = p.theme.decoration === "side" ? W * 0.045 : 0;
  return { left: W * 0.06 + side, right: W * 0.06, top: H * 0.065 };
}

export function layoutBoxes(p: Presentation, layout: LayoutId): Boxes {
  const W = p.width, H = p.height;
  const m = margins(p);
  const w = W - m.left - m.right;
  const band = p.theme.decoration === "band";
  switch (layout) {
    case "title":
      return {
        title: { x: m.left, y: H * 0.24, w, h: H * 0.28 },
        subtitle: { x: m.left, y: H * 0.56, w, h: H * 0.16 },
      };
    case "section":
      return {
        title: { x: m.left, y: H * 0.34, w, h: H * 0.22 },
        subtitle: { x: m.left, y: H * 0.58, w, h: H * 0.14 },
      };
    case "blank":
      return { body: { x: m.left, y: m.top, w, h: H - m.top * 2 } };
    default: {
      const titleH = band ? H * 0.15 : H * 0.15;
      const titleY = band ? H * 0.025 : m.top;
      const bodyY = band ? H * 0.235 : titleY + titleH + H * 0.04;
      return {
        title: { x: m.left, y: titleY, w, h: titleH },
        body: { x: m.left, y: bodyY, w, h: H - bodyY - H * 0.07 },
      };
    }
  }
}

const GAP = 0.03;

/** Inserisce un'immagine in un riquadro mantenendo le proporzioni, centrata. */
function fitInto(cell: Frame, img: ImageItem): Frame {
  const ar = img.natW > 0 && img.natH > 0 ? img.natW / img.natH : 4 / 3;
  let w = cell.w, h = w / ar;
  if (h > cell.h) { h = cell.h; w = h * ar; }
  return { x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

function grid(area: Frame, n: number, cols: number, gap: number): Frame[] {
  const rows = Math.ceil(n / cols);
  const cw = (area.w - gap * (cols - 1)) / cols;
  const ch = (area.h - gap * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    // L'ultima riga incompleta si centra.
    const inRow = r === rows - 1 ? n - r * cols : cols;
    const offset = (cols - inRow) * (cw + gap) / 2;
    return { x: area.x + offset + c * (cw + gap), y: area.y + r * (ch + gap), w: cw, h: ch };
  });
}

function stack(area: Frame, n: number, gap: number): Frame[] {
  const ch = (area.h - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ x: area.x, y: area.y + i * (ch + gap), w: area.w, h: ch }));
}

const hasText = (i: SlideItem) => i.kind === "shape" && i.paras.some((q) => q.runs.some((r) => r.text.trim()));

/** Divide la zona del contenuto fra gli elementi senza una posizione fissata a mano. */
function arrange(layout: LayoutId, area: Frame, items: SlideItem[], gap: number): Frame[] {
  const n = items.length;
  if (!n) return [];
  if (n === 1) return [area];
  if (layout === "two") {
    const half = Math.ceil(n / 2);
    const cols = grid(area, 2, 2, gap * 1.5);
    return [...stack(cols[0], half, gap), ...stack(cols[1], n - half, gap)];
  }
  const texts = items.filter((i) => i.kind === "shape");
  const media = items.filter((i) => i.kind !== "shape");
  // Un testo e qualche immagine o tabella: testo a sinistra, il resto a destra.
  if (texts.length === 1 && media.length) {
    const textFirst = hasText(texts[0]) || items.indexOf(texts[0]) === 0;
    const [a, b] = grid(area, 2, 2, gap * 1.5);
    const textCell = textFirst ? a : b, mediaCell = textFirst ? b : a;
    const mediaCells = media.length === 1 ? [mediaCell] : media.length <= 3 ? stack(mediaCell, media.length, gap) : grid(mediaCell, media.length, 2, gap);
    let mi = 0;
    return items.map((i) => (i.kind === "shape" ? textCell : mediaCells[mi++]));
  }
  // Solo immagini, o più testi: griglia che sfrutta la larghezza della diapositiva.
  const cols = n <= 3 ? n : n === 4 ? 2 : Math.ceil(Math.sqrt(n * 1.5));
  return grid(area, n, cols, gap);
}

/** Posizione di ogni elemento della diapositiva. */
export function placeItems(p: Presentation, slide: Slide): Placed[] {
  const boxes = layoutBoxes(p, slide.layout);
  const gap = p.width * GAP;
  const out = new Map<SlideItem, Placed>();
  const free: SlideItem[] = [];
  let subtitleUsed = false, titleUsed = false;
  for (const item of slide.items) {
    if (item.frame) { out.set(item, { item, frame: item.frame, auto: false }); continue; }
    if (item.kind === "shape" && item.role === "title" && boxes.title && !titleUsed) {
      titleUsed = true;
      out.set(item, { item, frame: boxes.title, auto: true });
    } else if (item.kind === "shape" && item.role === "subtitle" && boxes.subtitle && !subtitleUsed) {
      subtitleUsed = true;
      out.set(item, { item, frame: boxes.subtitle, auto: true });
    } else free.push(item);
  }
  const area = boxes.body ?? (() => {
    // Diapositiva titolo o di sezione con altro contenuto: va sotto il sottotitolo.
    const s = boxes.subtitle!;
    return { x: s.x, y: s.y + s.h + p.height * 0.03, w: s.w, h: Math.max(p.height * 0.12, p.height * 0.93 - s.y - s.h) };
  })();
  const cells = arrange(slide.layout, area, free, gap);
  free.forEach((item, i) => {
    const cell = cells[i];
    let frame = item.kind === "image" ? fitInto(cell, item) : cell;
    // Le tabelle non si allungano: righe di altezza normale, in alto nella zona.
    if (item.kind === "table") frame = { ...cell, h: Math.min(cell.h, item.rows.length * tableRowHeight(p)) };
    out.set(item, { item, frame, auto: true });
  });
  return slide.items.map((i) => out.get(i)!);
}

export function tableRowHeight(p: Presentation): number {
  return Math.round(p.theme.bodySize * 0.72 * 2.3);
}

/** Colore fra a e b (amount = quota di a). */
export function mixColor(a: string, b: string, amount: number): string {
  const pa = parseInt(a.replace("#", ""), 16), pb = parseInt(b.replace("#", ""), 16);
  const ch = (n: number, s: number) => (n >> s) & 255;
  return "#" + [16, 8, 0].map((s) => Math.round(ch(pa, s) * amount + ch(pb, s) * (1 - amount)).toString(16).padStart(2, "0")).join("");
}

/** Stile di testo previsto dal tema per un ruolo. */
export interface RoleStyle {
  size: number;
  color: string;
  font: string;
  bold: boolean;
  align: "l" | "ctr" | "r" | "just";
  anchor: "t" | "ctr" | "b";
  bullets: boolean;
}

export function isTitleLike(layout: LayoutId): boolean {
  return layout === "title" || layout === "section";
}

export function slideBackground(p: Presentation, slide: Slide): string {
  if (slide.background) return slide.background;
  if (isTitleLike(slide.layout) && p.theme.titleBackground) return p.theme.titleBackground;
  return p.theme.background;
}

export function roleStyle(theme: Theme, layout: LayoutId, role: Role, onTitleBg: boolean): RoleStyle {
  // Con la banda colorata il titolo delle diapositive normali sta sopra la banda.
  const onBand = theme.decoration === "band" && !isTitleLike(layout) && layout !== "blank";
  const titleColor = (onTitleBg || onBand) && theme.titleSlideText ? theme.titleSlideText : theme.title;
  const textColor = onTitleBg && theme.titleSlideText ? theme.titleSlideText : theme.text;
  switch (role) {
    case "title":
      if (layout === "title") return { size: Math.round(theme.titleSize * 1.3), color: titleColor, font: theme.headingFont, bold: true, align: "ctr", anchor: "b", bullets: false };
      if (layout === "section") return { size: Math.round(theme.titleSize * 1.15), color: titleColor, font: theme.headingFont, bold: true, align: "l", anchor: "b", bullets: false };
      return { size: theme.titleSize, color: titleColor, font: theme.headingFont, bold: true, align: theme.titleAlign, anchor: theme.decoration === "band" ? "ctr" : "b", bullets: false };
    case "subtitle":
      return { size: Math.round(theme.bodySize * 1.05), color: textColor, font: theme.bodyFont, bold: false, align: layout === "title" ? "ctr" : "l", anchor: "t", bullets: false };
    case "body":
      return { size: theme.bodySize, color: textColor, font: theme.bodyFont, bold: false, align: "l", anchor: "t", bullets: true };
    default:
      return { size: Math.round(theme.bodySize * 0.8), color: textColor, font: theme.bodyFont, bold: false, align: "l", anchor: "t", bullets: false };
  }
}

/** Dimensione del testo per livello di elenco (come in PowerPoint: ogni livello un po' più piccolo). */
export function levelSize(base: number, level: number): number {
  return Math.max(10, Math.round(base * [1, 0.88, 0.78, 0.72, 0.72][Math.min(level, 4)]));
}

export function paraBullet(p: Para, role: Role, style: RoleStyle): "none" | "bullet" | "number" {
  return p.bullet ?? (style.bullets && role === "body" ? "bullet" : "none");
}

/** Decorazioni del tema (barre, bande, cornici) come forme semplici. */
export function themeDecor(p: Presentation, slide: Slide): ShapeItem[] {
  const W = p.width, H = p.height, t = p.theme;
  const shape = (frame: Frame, fill: string, extra: Partial<ShapeItem> = {}): ShapeItem =>
    ({ kind: "shape", id: -1, role: "text", geom: "rect", frame, fill, line: null, paras: [], ...extra });
  const titleSlide = isTitleLike(slide.layout);
  const m = margins(p);
  switch (t.decoration) {
    case "bar":
      if (slide.layout === "title") return [shape({ x: W * 0.42, y: H * 0.535, w: W * 0.16, h: H * 0.008 }, t.accent)];
      if (slide.layout === "section") return [shape({ x: m.left, y: H * 0.565, w: W * 0.09, h: H * 0.008 }, t.accent)];
      if (slide.layout === "blank") return [];
      return [shape({ x: m.left, y: layoutBoxes(p, "content").title!.y + H * 0.165, w: W * 0.09, h: H * 0.008 }, t.accent)];
    case "band":
      if (titleSlide) return [shape({ x: 0, y: H * 0.9, w: W, h: H * 0.1 }, t.accent2)];
      return [
        shape({ x: 0, y: 0, w: W, h: H * 0.2 }, t.accent),
        shape({ x: 0, y: H * 0.2, w: W, h: H * 0.012 }, t.accent2),
      ];
    case "side":
      return [shape({ x: 0, y: 0, w: W * 0.045, h: H }, titleSlide ? t.accent2 : t.accent)];
    case "frame":
      return [shape({ x: W * 0.025, y: H * 0.04, w: W * 0.95, h: H * 0.92 }, "", { fill: null, line: { color: t.accent, width: 1.5 } })];
    default:
      return [];
  }
}
