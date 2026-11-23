// Modello di una presentazione. Le coordinate sono in punti (1/72 di pollice), con l'origine
// in alto a sinistra della diapositiva: 1 punto = 12700 EMU nel formato .pptx.

export type Align = "l" | "ctr" | "r" | "just";
export type Anchor = "t" | "ctr" | "b";
export type Bullet = "none" | "bullet" | "number";

export interface TextRun {
  text: string; // "\n" = a capo nella riga (a:br)
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  /** Colore "#rrggbb"; se manca vale quello del tema per il ruolo del riquadro. */
  color?: string;
  /** Dimensione in punti; se manca vale quella del tema per il ruolo e il livello. */
  size?: number;
  font?: string;
  link?: string;
  /** Spaziatura fra le lettere in punti. */
  spacing?: number;
  /** Tutto maiuscolo o maiuscoletto (senza cambiare il testo). */
  caps?: "all" | "small";
}

export interface Para {
  runs: TextRun[];
  /** Livello di rientro dell'elenco, 0-4. */
  level: number;
  /** Se manca, decide il ruolo: il corpo ha l'elenco puntato, titoli e caselle di testo no. */
  bullet?: Bullet;
  align?: Align;
  /** Spazio prima e dopo il paragrafo in punti. */
  spaceBefore?: number;
  spaceAfter?: number;
  /** Interlinea in multipli (1 = singola). */
  lineSpacing?: number;
}

export interface Frame { x: number; y: number; w: number; h: number; rot?: number }

/** Ruolo di un riquadro nel layout: titolo e corpo vanno nei posti decisi dal tema. */
export type Role = "title" | "subtitle" | "body" | "text";

export type Geometry = "rect" | "roundRect" | "ellipse" | "triangle" | "rightArrow" | "line" | "star5" | "diamond" | "chevron";

export interface ShapeItem {
  kind: "shape";
  id: number;
  role: Role;
  geom: Geometry;
  /** Se manca, la posizione la calcola il layout (posizionamento automatico). */
  frame?: Frame;
  fill?: string | null; // null = nessun riempimento; undefined = predefinito del ruolo
  line?: { color: string; width: number } | null;
  paras: Para[];
  anchor?: Anchor;
  /** Margini interni in punti [sinistra, sopra, destra, sotto]. */
  inset?: [number, number, number, number];
  flipH?: boolean;
  flipV?: boolean;
  /** Riduzione del testo per farlo stare nel riquadro (1 = nessuna), calcolata durante il disegno. */
  fit?: number;
  /** Il testo non va a capo (wrap="none"). */
  noWrap?: boolean;
  /** Forma disegnata a mano (a:custGeom): XML originale e tracciati SVG per mostrarla. */
  custom?: { xml: string; paths: CustomPath[] };
  /** Forma predefinita che non sappiamo disegnare: XML originale (a:prstGeom), riscritto uguale. */
  prstXml?: string;
}

export interface CustomPath {
  /** Sistema di coordinate del tracciato (0 = quello della forma). */
  w: number;
  h: number;
  d: string;
  noFill?: boolean;
  noStroke?: boolean;
}

export interface ImageItem {
  kind: "image";
  id: number;
  frame?: Frame;
  bytes: Uint8Array;
  mime: string;
  /** Dimensioni naturali in pixel (per mantenere le proporzioni). */
  natW: number;
  natH: number;
  alt?: string;
}

export interface TableCell { paras: Para[]; fill?: string }

export interface TableItem {
  kind: "table";
  id: number;
  frame?: Frame;
  rows: TableCell[][];
  /** Prima riga come intestazione (colore d'accento). */
  header: boolean;
  /** Larghezze relative delle colonne. */
  cols?: number[];
}

/** Elemento importato che non sappiamo modificare (grafico, SmartArt, video…): torna nel file com'era. */
export interface RawItem {
  kind: "raw";
  id: number;
  frame: Frame;
  /** XML dell'elemento nello spTree, con i riferimenti r:id originali. */
  xml: string;
  /** Parti collegate copiate dal file originale: r:id → parte. */
  parts: Record<string, RawPart>;
  /** Tutte le parti del pacchetto da copiare con l'elemento (le collegate e le loro collegate). */
  closure: string[];
  label: string;
}

export interface RawPart {
  type: string; // tipo della relazione
  /** Percorso della parte nel pacchetto originale (es. "ppt/charts/chart1.xml"); vuoto se esterno. */
  path: string;
  external?: string;
}

export type SlideItem = ShapeItem | ImageItem | TableItem | RawItem;

export type LayoutId = "title" | "content" | "two" | "section" | "titleOnly" | "blank";

export interface Slide {
  id: number;
  layout: LayoutId;
  items: SlideItem[];
  notes: string;
  /** Colore di sfondo che sostituisce quello del tema. */
  background?: string;
  /** Immagine di sfondo importata (riempie la diapositiva). */
  backgroundImage?: { bytes: Uint8Array; mime: string };
  hidden?: boolean;
  /** Decorazioni comuni (dal layout o dallo schema importato), chiave in `Presentation.decor`. */
  decor?: string;
  /** XML della transizione importata, riscritto così com'è. */
  transition?: string;
}

export interface Theme {
  id: string;
  name: string;
  background: string;
  /** Sfondo della diapositiva titolo e di sezione (se diverso). */
  titleBackground?: string;
  text: string;
  /** Colore del titolo nelle diapositive normali. */
  title: string;
  /** Colore del titolo sulla diapositiva titolo/sezione. */
  titleSlideText?: string;
  accent: string;
  /** Secondo colore d'accento (forme nuove, intestazioni di tabella…). */
  accent2: string;
  headingFont: string;
  bodyFont: string;
  /** Decorazione disegnata dal tema. */
  decoration: "none" | "bar" | "band" | "side" | "frame";
  titleSize: number;
  bodySize: number;
  /** Titolo allineato a sinistra o al centro nelle diapositive normali. */
  titleAlign: Align;
}

export interface Presentation {
  /** Dimensioni della diapositiva in punti (16:9 = 960 × 540). */
  width: number;
  height: number;
  theme: Theme;
  slides: Slide[];
  nextId: number;
  /** Decorazioni condivise importate (forme e immagini dello schema o del layout). */
  decor: Record<string, SlideItem[]>;
  /** Le diapositive importate non hanno ancora i posti del tema: le si lascia dove sono. */
  imported?: boolean;
  /** Parti del file originale conservate per gli elementi non modificabili: percorso → contenuto e tipo. */
  parts: Record<string, { bytes: Uint8Array; type: string }>;
  title?: string;
}

export const emptyPara = (level = 0): Para => ({ runs: [], level });
export const textPara = (text: string, level = 0, extra: Partial<Para> = {}): Para => ({ runs: text ? [{ text }] : [], level, ...extra });

export function paraText(p: Para): string {
  return p.runs.map((r) => r.text).join("");
}

export function itemText(item: SlideItem): string {
  if (item.kind === "shape") return item.paras.map(paraText).join("\n");
  if (item.kind === "table") return item.rows.map((r) => r.map((c) => c.paras.map(paraText).join(" ")).join("\t")).join("\n");
  return "";
}

export function slideTitle(slide: Slide): string {
  const t = slide.items.find((i): i is ShapeItem => i.kind === "shape" && i.role === "title");
  return t ? t.paras.map(paraText).join(" ").trim() : "";
}

export function newId(p: Presentation): number {
  return p.nextId++;
}

/** Diapositiva nuova con i riquadri vuoti previsti dal layout. */
export function newSlide(p: Presentation, layout: LayoutId): Slide {
  const items: SlideItem[] = [];
  const shape = (role: Role): ShapeItem => ({ kind: "shape", id: newId(p), role, geom: "rect", paras: [emptyPara()] });
  if (layout !== "blank") items.push(shape("title"));
  if (layout === "title" || layout === "section") items.push(shape("subtitle"));
  if (layout === "content") items.push(shape("body"));
  if (layout === "two") items.push(shape("body"), shape("body"));
  return { id: newId(p), layout, items, notes: "" };
}

/** Copia profonda che condivide i byte delle immagini (non cambiano mai). */
export function deepCopy<T>(v: T): T {
  if (v instanceof Uint8Array || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(deepCopy) as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = deepCopy(x);
  return out as T;
}

export function cloneSlide(p: Presentation, s: Slide): Slide {
  const copy: Slide = deepCopy(s);
  copy.id = newId(p);
  for (const it of copy.items) it.id = newId(p);
  return copy;
}

/** I riquadri segnaposto rimasti vuoti non si stampano né si salvano come testo. */
export function isEmptyPlaceholder(item: SlideItem): boolean {
  return item.kind === "shape" && item.role !== "text" && !item.frame && item.paras.every((q) => !paraText(q).trim());
}

export function newPresentation(theme: Theme, width = 960, height = 540): Presentation {
  const p: Presentation = { width, height, theme: { ...theme }, slides: [], nextId: 1, decor: {}, parts: {} };
  p.slides.push(newSlide(p, "title"));
  return p;
}

// ---------- copia di recupero (JSON con i byte in base64) ----------

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function serializePresentation(p: Presentation): string {
  return JSON.stringify(p, (_k, v) => (v instanceof Uint8Array ? { $bytes: b64(v) } : v));
}

export function deserializePresentation(text: string): Presentation {
  return JSON.parse(text, (_k, v) => (v && typeof v === "object" && typeof v.$bytes === "string"
    ? Uint8Array.from(atob(v.$bytes), (c) => c.charCodeAt(0)) : v)) as Presentation;
}
