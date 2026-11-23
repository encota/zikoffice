// Modello del documento di testo. Ricalca i concetti di Word (paragrafi, run, stili,
// numerazioni, sezioni) così che l'import/export .docx non debba "tradurre" e perdere pezzi.
// Unità: punti tipografici (1 pt = 1/72 di pollice), come in Word.

export interface RunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Nome del font come in Office (es. "Calibri"); il rendering usa l'equivalente libero. */
  font?: string;
  /** Dimensione in punti. */
  size?: number;
  /** Colore del testo "#rrggbb". */
  color?: string;
  /** Evidenziazione "#rrggbb". */
  highlight?: string;
  vertAlign?: "superscript" | "subscript";
  /** Collegamento ipertestuale. */
  link?: string;
}

export interface TextRun {
  type?: "text";
  text: string; // "\t" = tabulazione, "\n" = a capo nella riga, "\f" = interruzione di pagina
  props: RunProps;
}

export interface ImageRun {
  type: "image";
  /** Immagine come data URL o blob URL. */
  src: string;
  /** Tipo MIME (per il salvataggio). */
  mime: string;
  /** Dimensioni in punti. */
  width: number;
  height: number;
  /** Testo alternativo. */
  alt?: string;
  /** Markdown: percorso originale dell'immagine nel file .md (relativo alla sua cartella). */
  srcPath?: string;
  /** Markdown: il file dell'immagine non c'era; `src` è un segnaposto e si riscrive `srcPath` così com'era. */
  missing?: boolean;
  props: RunProps;
}

/** Campo calcolato: numero di pagina o numero totale di pagine. */
export interface FieldRun {
  type: "field";
  field: "PAGE" | "NUMPAGES";
  props: RunProps;
}

export type Run = TextRun | ImageRun | FieldRun;

/** Un run "atomico" (immagine o campo) occupa un solo carattere nelle posizioni. */
export const isAtomic = (r: Run): r is ImageRun | FieldRun => r.type === "image" || r.type === "field";
export const runLength = (r: Run): number => (isAtomic(r) ? 1 : r.text.length);

export type Align = "left" | "center" | "right" | "justify";

export interface TabStop {
  /** Posizione in punti dal margine sinistro. */
  pos: number;
  align: "left" | "center" | "right" | "decimal";
  leader?: "dot" | "hyphen" | "underscore" | "none";
}

export interface ParaProps {
  style?: string;
  align?: Align;
  /** Rientri in punti. `firstLine` negativo = sporgente. */
  indentLeft?: number;
  indentRight?: number;
  firstLine?: number;
  /** Spazio prima/dopo in punti. */
  spaceBefore?: number;
  spaceAfter?: number;
  /** Interlinea: multiplo (1 = singola) se lineRule è "auto", altrimenti punti. */
  line?: number;
  lineRule?: "auto" | "exact" | "atLeast";
  keepNext?: boolean;
  pageBreakBefore?: boolean;
  /** Elenco: id della numerazione e livello (0-8). */
  numId?: number;
  numLevel?: number;
  tabs?: TabStop[];
  /** Sfondo del paragrafo. */
  shading?: string;
  /** Livello di struttura per il sommario (0 = Titolo 1). */
  outlineLevel?: number;
  /** Markdown: linguaggio indicato su un blocco di codice (```js). */
  codeLang?: string;
}

export interface Paragraph {
  type: "p";
  id: number;
  props: ParaProps;
  runs: Run[];
  /** Proprietà del segno di paragrafo (usate quando il paragrafo è vuoto). */
  markProps?: RunProps;
}

export interface CellBorder {
  width: number; // pt
  color: string;
  style?: "single" | "double" | "dashed" | "dotted";
}

export interface TableCell {
  paragraphs: Paragraph[];
  /** Quante colonne della griglia occupa. */
  span: number;
  /** Unione verticale: "restart" inizia, "continue" prosegue la cella sopra. */
  vMerge?: "restart" | "continue";
  shading?: string;
  vAlign?: "top" | "center" | "bottom";
  borders?: Partial<Record<"top" | "bottom" | "left" | "right", CellBorder | null>>;
}

export interface TableRow {
  cells: TableCell[];
  /** Altezza minima in punti. */
  height?: number;
  header?: boolean;
}

export interface Table {
  type: "table";
  id: number;
  /** Larghezze delle colonne della griglia in punti. */
  grid: number[];
  rows: TableRow[];
  /** Bordi predefiniti di tutte le celle. */
  borders?: CellBorder | null;
  align?: "left" | "center" | "right";
  style?: string;
}

/** Sommario generato dai titoli del documento. */
export interface Toc {
  type: "toc";
  id: number;
  /** Livelli inclusi (1..maxLevel). */
  maxLevel: number;
  title?: string;
}

export type Block = Paragraph | Table | Toc;

export interface PageSetup {
  width: number;   // pt (A4 = 595.3)
  height: number;  // pt (A4 = 841.9)
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  headerDistance: number;
  footerDistance: number;
}

export interface StyleDef {
  id: string;
  name: string;
  type: "paragraph" | "character" | "table";
  basedOn?: string;
  next?: string;
  para?: ParaProps;
  run?: RunProps;
  /** Mostrato nella galleria degli stili. */
  quick?: boolean;
}

export type NumFormat = "decimal" | "lowerLetter" | "upperLetter" | "lowerRoman" | "upperRoman" | "bullet" | "none";

export interface NumLevel {
  format: NumFormat;
  /** Testo con segnaposto: "%1." oppure il carattere del punto elenco. */
  text: string;
  start: number;
  indentLeft: number; // pt
  hanging: number;    // pt
  font?: string;
}

export interface NumberingDef {
  id: number;
  levels: NumLevel[];
}

export interface DocumentComment {
  id: number;
  author: string;
  date: string;
  text: string;
  quote: string;
}

export interface DocumentModel {
  blocks: Block[];
  styles: Record<string, StyleDef>;
  numbering: Record<number, NumberingDef>;
  page: PageSetup;
  header: Paragraph[];
  footer: Paragraph[];
  /** Commenti a margine (importati/esportati anche in word/comments.xml). */
  comments?: DocumentComment[];
  /** Filigrana diagonale su ogni pagina (es. "BOZZA", "RISERVATO"). */
  watermark?: string;
  /** Markdown: blocco YAML iniziale (--- … ---), conservato così com'è e non mostrato. */
  frontMatter?: string;
  /** Proprietà predefinite del testo (docDefaults). */
  defaultRun: RunProps;
  defaultPara: ParaProps;
  /** Prossimo id libero per paragrafi/tabelle. */
  nextId: number;
}

// ---------- costruzione ----------

export const A4: PageSetup = {
  width: 595.3, height: 841.9,
  marginTop: 70.85, marginBottom: 56.7, marginLeft: 56.7, marginRight: 56.7, // come Word in italiano (2,5/2/2/2 cm)
  headerDistance: 35.4, footerDistance: 35.4,
};

export function newId(doc: DocumentModel): number {
  return doc.nextId++;
}

export function paragraph(doc: DocumentModel, text = "", props: ParaProps = {}, runProps: RunProps = {}): Paragraph {
  return { type: "p", id: newId(doc), props: { ...props }, runs: text ? [{ text, props: { ...runProps } }] : [] };
}

export function paragraphText(p: Paragraph): string {
  return p.runs.map((r) => (isAtomic(r) ? "\uFFFC" : r.text)).join("");
}

/** Lunghezza del paragrafo in caratteri (un'immagine conta 1). */
export function paragraphLength(p: Paragraph): number {
  let n = 0;
  for (const r of p.runs) n += runLength(r);
  return n;
}

export function cm(v: number): number {
  return (v / 2.54) * 72;
}

export function toCm(pt: number): number {
  return (pt / 72) * 2.54;
}

/** Tutti i paragrafi del corpo in ordine di lettura (anche quelli nelle tabelle). */
export function* allParagraphs(blocks: Block[]): Generator<Paragraph> {
  for (const b of blocks) {
    if (b.type === "p") yield b;
    else if (b.type === "table") for (const row of b.rows) for (const cell of row.cells) yield* allParagraphs(cell.paragraphs);
  }
}

export function cloneDoc(doc: DocumentModel): DocumentModel {
  return structuredClone(doc);
}

export function sameRunProps(a: RunProps, b: RunProps): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof RunProps>;
  for (const k of keys) if ((a[k] ?? undefined) !== (b[k] ?? undefined)) return false;
  return true;
}

/** Unisce run adiacenti con le stesse proprietà e toglie quelli vuoti. */
export function normalizeRuns(p: Paragraph): void {
  const out: Run[] = [];
  for (const r of p.runs) {
    if (!isAtomic(r) && r.text === "") continue;
    const last = out[out.length - 1];
    if (last && !isAtomic(last) && !isAtomic(r) && sameRunProps(last.props, r.props)) last.text += r.text;
    else out.push(isAtomic(r) ? { ...r, props: { ...r.props } } : { text: r.text, props: { ...r.props } });
  }
  p.runs = out;
}
