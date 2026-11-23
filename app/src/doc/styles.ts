// Stili predefiniti (come quelli di Word) e calcolo delle proprietà effettive.
import {
  A4, type DocumentModel, type NumberingDef, type NumFormat, type Paragraph, type ParaProps, type Run, type RunProps, type StyleDef,
} from "./model";

const HEADING_COLOR = "#2F5496";

export function defaultStyles(): Record<string, StyleDef> {
  const list: StyleDef[] = [
    { id: "Normal", name: "Normale", type: "paragraph", quick: true, para: { spaceAfter: 8, line: 1.08, lineRule: "auto" } },
    { id: "NoSpacing", name: "Nessuna spaziatura", type: "paragraph", quick: true, basedOn: "Normal", para: { spaceAfter: 0, line: 1, lineRule: "auto" } },
    { id: "Heading1", name: "Titolo 1", type: "paragraph", quick: true, basedOn: "Normal", next: "Normal",
      para: { spaceBefore: 12, spaceAfter: 0, keepNext: true, outlineLevel: 0 }, run: { font: "Calibri Light", size: 16, color: HEADING_COLOR } },
    { id: "Heading2", name: "Titolo 2", type: "paragraph", quick: true, basedOn: "Normal", next: "Normal",
      para: { spaceBefore: 2, spaceAfter: 0, keepNext: true, outlineLevel: 1 }, run: { font: "Calibri Light", size: 13, color: HEADING_COLOR } },
    { id: "Heading3", name: "Titolo 3", type: "paragraph", quick: true, basedOn: "Normal", next: "Normal",
      para: { spaceBefore: 2, spaceAfter: 0, keepNext: true, outlineLevel: 2 }, run: { font: "Calibri Light", size: 12, color: "#1F3763" } },
    { id: "Heading4", name: "Titolo 4", type: "paragraph", basedOn: "Normal", next: "Normal",
      para: { spaceBefore: 2, spaceAfter: 0, keepNext: true, outlineLevel: 3 }, run: { font: "Calibri Light", italic: true, color: HEADING_COLOR } },
    { id: "Title", name: "Titolo", type: "paragraph", quick: true, basedOn: "Normal", next: "Normal",
      para: { spaceAfter: 0, line: 1, lineRule: "auto" }, run: { font: "Calibri Light", size: 28 } },
    { id: "Subtitle", name: "Sottotitolo", type: "paragraph", quick: true, basedOn: "Normal", next: "Normal",
      para: { spaceAfter: 8 }, run: { color: "#5A5A5A", size: 11 } },
    { id: "Quote", name: "Citazione", type: "paragraph", quick: true, basedOn: "Normal", next: "Normal",
      para: { spaceBefore: 10, spaceAfter: 8, indentLeft: 43.2, indentRight: 43.2, align: "center" }, run: { italic: true, color: "#404040" } },
    { id: "ListParagraph", name: "Paragrafo elenco", type: "paragraph", basedOn: "Normal", para: { indentLeft: 36 } },
    { id: "Caption", name: "Didascalia", type: "paragraph", basedOn: "Normal", next: "Normal",
      para: { spaceAfter: 10, line: 1, lineRule: "auto" }, run: { italic: true, size: 9, color: "#44546A" } },
    { id: "TOCHeading", name: "Titolo sommario", type: "paragraph", basedOn: "Heading1", next: "Normal", para: { outlineLevel: undefined } },
    { id: "TOC1", name: "Sommario 1", type: "paragraph", basedOn: "Normal", next: "Normal", para: { spaceAfter: 5 } },
    { id: "TOC2", name: "Sommario 2", type: "paragraph", basedOn: "Normal", next: "Normal", para: { spaceAfter: 5, indentLeft: 11 } },
    { id: "TOC3", name: "Sommario 3", type: "paragraph", basedOn: "Normal", next: "Normal", para: { spaceAfter: 5, indentLeft: 22 } },
    { id: "Header", name: "Intestazione", type: "paragraph", basedOn: "Normal", para: { spaceAfter: 0, line: 1, lineRule: "auto" } },
    { id: "Footer", name: "Piè di pagina", type: "paragraph", basedOn: "Normal", para: { spaceAfter: 0, line: 1, lineRule: "auto" } },
    { id: "Hyperlink", name: "Collegamento ipertestuale", type: "character", run: { color: "#0563C1", underline: true } },
  ];
  return Object.fromEntries(list.map((s) => [s.id, s]));
}

/** Stili usati dal Markdown (codice, citazione a blocco, linea, titoli 5-6): si aggiungono al documento se mancano. */
export function ensureMarkdownStyles(doc: DocumentModel): void {
  const s = doc.styles;
  s.CodeBlock ??= {
    id: "CodeBlock", name: "Codice", type: "paragraph", basedOn: "Normal",
    para: { shading: "#f3f4f6", spaceBefore: 2, spaceAfter: 8, line: 1, lineRule: "auto" }, run: { font: "Consolas", size: 10 },
  };
  s.BlockQuote ??= {
    id: "BlockQuote", name: "Blocco citazione", type: "paragraph", basedOn: "Normal",
    para: { shading: "#f6f7f9", indentLeft: 18, spaceBefore: 2, spaceAfter: 6 }, run: { color: "#555555" },
  };
  s.Rule ??= {
    id: "Rule", name: "Linea orizzontale", type: "paragraph", basedOn: "Normal",
    para: { shading: "#b6bcc6", spaceBefore: 8, spaceAfter: 8, line: 1, lineRule: "auto" }, run: { size: 1 },
  };
  s.Heading5 ??= { id: "Heading5", name: "Titolo 5", type: "paragraph", basedOn: "Normal", next: "Normal", para: { spaceBefore: 2, spaceAfter: 0, keepNext: true, outlineLevel: 4 }, run: { font: "Calibri Light", color: HEADING_COLOR } };
  s.Heading6 ??= { id: "Heading6", name: "Titolo 6", type: "paragraph", basedOn: "Normal", next: "Normal", para: { spaceBefore: 2, spaceAfter: 0, keepNext: true, outlineLevel: 5 }, run: { font: "Calibri Light", color: "#1F3763" } };
}

export function newDocument(): DocumentModel {
  const doc: DocumentModel = {
    blocks: [], styles: defaultStyles(), numbering: {}, page: { ...A4 },
    header: [], footer: [],
    defaultRun: { font: "Calibri", size: 11 }, defaultPara: {},
    nextId: 1,
  };
  doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  return doc;
}

// ---------- elenchi ----------

const BULLETS = ["•", "◦", "▪"];
const NUM_CYCLE: [NumFormat, string][] = [["decimal", "%."], ["lowerLetter", "%."], ["lowerRoman", "%."]];

/** Crea (o riusa) la numerazione standard per elenchi puntati o numerati. */
export function ensureListNumbering(doc: DocumentModel, kind: "bullet" | "number"): number {
  for (const n of Object.values(doc.numbering)) {
    if ((n.levels[0].format === "bullet") === (kind === "bullet") && (n as NumberingDef & { builtin?: boolean }).builtin) return n.id;
  }
  const id = Math.max(0, ...Object.keys(doc.numbering).map(Number)) + 1;
  const levels = Array.from({ length: 9 }, (_, l) => {
    const indentLeft = 36 + 18 * l;
    if (kind === "bullet") return { format: "bullet" as const, text: BULLETS[l % 3], start: 1, indentLeft, hanging: 18, font: l % 3 === 0 ? "Symbol" : undefined };
    const [format, tpl] = NUM_CYCLE[l % 3];
    return { format, text: tpl.replace("%", `%${l + 1}`), start: 1, indentLeft, hanging: 18 };
  });
  const def: NumberingDef & { builtin: boolean } = { id, levels, builtin: true };
  doc.numbering[id] = def;
  return id;
}

export function isBulletList(doc: DocumentModel, numId: number | undefined): boolean {
  return numId !== undefined && doc.numbering[numId]?.levels[0]?.format === "bullet";
}

export function formatNumber(n: number, format: NumFormat): string {
  switch (format) {
    case "decimal": return String(n);
    case "lowerLetter": return letters(n).toLowerCase();
    case "upperLetter": return letters(n);
    case "lowerRoman": return roman(n).toLowerCase();
    case "upperRoman": return roman(n);
    default: return "";
  }
}

function letters(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function roman(n: number): string {
  const map: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let s = "";
  for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
  return s;
}

// ---------- proprietà effettive ----------

function styleChain(doc: DocumentModel, id: string | undefined): StyleDef[] {
  const chain: StyleDef[] = [];
  const seen = new Set<string>();
  for (let s: StyleDef | undefined = doc.styles[id ?? "Normal"] ?? doc.styles.Normal; s && !seen.has(s.id); s = s.basedOn ? doc.styles[s.basedOn] : undefined) {
    seen.add(s.id);
    chain.unshift(s);
  }
  return chain;
}

const defined = <T extends object>(o: T | undefined): Partial<T> =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

export function effectivePara(doc: DocumentModel, p: Paragraph): ParaProps {
  let out: ParaProps = { ...defined(doc.defaultPara) };
  for (const s of styleChain(doc, p.props.style)) out = { ...out, ...defined(s.para) };
  // Il rientro dell'elenco vale se il paragrafo non ne specifica uno proprio.
  if (p.props.numId !== undefined) {
    const lvl = doc.numbering[p.props.numId]?.levels[p.props.numLevel ?? 0];
    if (lvl) out = { ...out, indentLeft: lvl.indentLeft, firstLine: -lvl.hanging };
  }
  out = { ...out, ...defined(p.props) };
  return out;
}

/** Proprietà del testo del paragrafo (stile del paragrafo), senza quelle dirette del run. */
export function paragraphRunProps(doc: DocumentModel, p: Paragraph): RunProps {
  let out: RunProps = { ...defined(doc.defaultRun) };
  for (const s of styleChain(doc, p.props.style)) out = { ...out, ...defined(s.run) };
  return out;
}

export function effectiveRun(doc: DocumentModel, p: Paragraph, run: Run | { props: RunProps }): RunProps {
  const base = paragraphRunProps(doc, p);
  const r = { ...base, ...defined(run.props) };
  if (run.props.link && run.props.color === undefined) Object.assign(r, defined(doc.styles.Hyperlink?.run));
  return r;
}

export { A4 };
