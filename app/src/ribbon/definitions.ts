import type { IconName } from "../icons";
import { NUMBER_FORMATS, SHEET_FONTS } from "../sheet/format";
import { THEMES } from "../slides/themes";
import type {
  Command, DocKind, GalleryItem, GroupItem, RibbonGroup, RibbonTab, RowControl, SelectControl,
} from "./types";

import { t } from "../i18n";
// ---------- helper di costruzione ----------

const c = (id: string, label: string, icon: IconName, extra: Partial<Command> = {}): Command => ({
  id, label, icon, ...extra,
});
const large = (cmd: Command): GroupItem => ({ kind: "large", cmd });
const stack = (...cmds: Command[]): GroupItem => ({ kind: "stack", cmds });
const rows = (...r: RowControl[][]): GroupItem => ({ kind: "rows", rows: r });
const ico = (cmd: Command): RowControl => ({ kind: "icon", cmd });
const sep: RowControl = { kind: "sep" };
const sel = (id: string, label: string, options: string[], value: string, width: number): SelectControl => ({
  kind: "select", id, label, options, value, width,
});
const group = (label: string, ...items: GroupItem[]): RibbonGroup => ({ label, items });

// Font con metriche compatibili con quelli di Office: fondamentale per non "rompere"
// l'impaginazione dei .docx/.xlsx (Carlito = Calibri, Caladea = Cambria, Liberation = Arial/Times).
export const FONTS = [
  "Carlito", "Caladea", "Liberation Sans", "Liberation Serif", "Liberation Mono",
  "Noto Sans", "Noto Serif", "DejaVu Sans", "Ubuntu",
];
const SIZES = ["8", "9", "10", "11", "12", "14", "16", "18", "20", "24", "28", "36", "48", "72"];

// ---------- comandi condivisi ----------

const cmd = {
  paste: c("paste", "Incolla", "ClipboardPaste", { shortcut: "Ctrl+V", menu: true, split: true }),
  cut: c("cut", "Taglia", "Scissors", { shortcut: "Ctrl+X" }),
  copy: c("copy", "Copia", "Copy", { shortcut: "Ctrl+C" }),
  painter: c("formatPainter", "Copia formato", "Paintbrush", { toggle: true }),
  bold: c("bold", "Grassetto", "Bold", { shortcut: "Ctrl+B", toggle: true }),
  italic: c("italic", "Corsivo", "Italic", { shortcut: "Ctrl+I", toggle: true }),
  underline: c("underline", "Sottolineato", "Underline", { shortcut: "Ctrl+U", toggle: true }),
  strike: c("strike", "Barrato", "Strikethrough", { toggle: true }),
  sub: c("subscript", "Pedice", "Subscript", { shortcut: "Ctrl+=", toggle: true }),
  sup: c("superscript", "Apice", "Superscript", { shortcut: "Ctrl+Maiusc++", toggle: true }),
  grow: c("growFont", "Aumenta dimensione carattere", "AArrowUp", { shortcut: "Ctrl+>" }),
  shrink: c("shrinkFont", "Riduci dimensione carattere", "AArrowDown", { shortcut: "Ctrl+<" }),
  clearFmt: c("clearFormatting", "Cancella formattazione", "Eraser"),
  color: c("fontColor", "Colore carattere", "Baseline", { menu: true }),
  highlight: c("highlight", "Evidenzia testo", "Highlighter", { menu: true }),
  find: c("find", "Trova", "Search", { shortcut: "Ctrl+F" }),
  replace: c("replace", "Sostituisci", "Replace", { shortcut: "Ctrl+H" }),
  select: c("select", "Seleziona", "MousePointer2", { menu: true }),
  zoom: c("zoomDialog", "Zoom", "ZoomIn"),
  comment: c("newComment", "Nuovo commento", "MessageSquarePlus"),
  spell: c("spelling", "Controllo ortografico", "SpellCheck", { toggle: true, tip: "Sottolinea in rosso le parole sbagliate (dizionario della lingua scelta)" }),
};

const clipboard = group("Appunti", large(cmd.paste), stack(cmd.cut, cmd.copy, cmd.painter));

// ---------- Editor di testo ----------

const styleGallery: GalleryItem[] = [
  { id: "style.normal", label: "Normale", preview: "font-size:13px" },
  { id: "style.noSpacing", label: "Nessuna spaziatura", preview: "font-size:13px" },
  { id: "style.h1", label: "Titolo 1", preview: "font-size:16px;color:var(--accent);font-weight:500" },
  { id: "style.h2", label: "Titolo 2", preview: "font-size:14px;color:var(--accent);font-weight:500" },
  { id: "style.h3", label: "Titolo 3", preview: "font-size:13px;color:var(--accent);font-weight:600" },
  { id: "style.title", label: "Titolo", preview: "font-size:20px;letter-spacing:-.5px" },
  { id: "style.subtitle", label: "Sottotitolo", preview: "font-size:13px;color:var(--text-muted)" },
  { id: "style.quote", label: "Citazione", preview: "font-size:13px;font-style:italic" },
  { id: "style.blockquote", label: "Blocco citazione", preview: "font-size:13px;color:var(--text-muted);background:var(--hover)" },
  { id: "style.code", label: "Codice", preview: "font-size:12px;font-family:Consolas,monospace;background:var(--hover)" },
  { id: "style.emphasis", label: "Enfasi", preview: "font-size:13px;font-style:italic;color:var(--accent)" },
];

const docTabs: RibbonTab[] = [
  {
    id: "home", label: "Home",
    groups: [
      clipboard,
      group("Carattere", rows(
        [sel("fontName", "Tipo di carattere", SHEET_FONTS, "Calibri", 132), sel("fontSize", "Dimensione", SIZES, "11", 52), ico(cmd.grow), ico(cmd.shrink), ico(cmd.clearFmt)],
        [ico(cmd.bold), ico(cmd.italic), ico(cmd.underline), ico(cmd.strike), ico(cmd.sub), ico(cmd.sup), sep, ico(cmd.highlight), ico(cmd.color)],
      )),
      group("Paragrafo", rows(
        [
          ico(c("bullets", "Elenco puntato", "List", { menu: true, split: true, toggle: true })),
          ico(c("numbering", "Elenco numerato", "ListOrdered", { menu: true, split: true, toggle: true })),
          ico(c("multilevel", "Elenco a più livelli", "ListTree", { menu: true })),
          sep,
          ico(c("outdent", "Riduci rientro", "IndentDecrease")),
          ico(c("indent", "Aumenta rientro", "IndentIncrease")),
          sep,
          ico(c("showMarks", "Mostra tutto (¶)", "Pilcrow", { shortcut: "Ctrl+*", toggle: true })),
        ],
        [
          ico(c("alignLeft", "Allinea a sinistra", "TextAlignStart", { shortcut: "Ctrl+L", toggle: true, radio: "align" })),
          ico(c("alignCenter", "Centra", "TextAlignCenter", { shortcut: "Ctrl+E", toggle: true, radio: "align" })),
          ico(c("alignRight", "Allinea a destra", "TextAlignEnd", { shortcut: "Ctrl+R", toggle: true, radio: "align" })),
          ico(c("justify", "Giustifica", "TextAlignJustify", { shortcut: "Ctrl+J", toggle: true, radio: "align" })),
          sep,
          ico(c("lineSpacing", "Interlinea e spaziatura paragrafo", "ArrowUpDown", { menu: true })),
          ico(c("shading", "Sfondo", "PaintBucket", { menu: true })),
          ico(c("borders", "Bordi", "SquareDashed", { menu: true })),
        ],
      )),
      group("Stili", { kind: "gallery", id: "styles", items: styleGallery }),
      group("Modifica", stack(cmd.find, cmd.replace, cmd.select)),
    ],
  },
  {
    id: "insert", label: "Inserisci",
    groups: [
      group("Pagine", stack(
        c("coverPage", "Frontespizio", "FileText", { menu: true }),
        c("blankPage", "Pagina vuota", "FilePlus2"),
        c("pageBreak", "Interruzione di pagina", "SeparatorHorizontal", { shortcut: "Ctrl+Invio" }),
      )),
      group("Tabelle", large(c("insertTable", "Tabella", "Table", { menu: true }))),
      group("Illustrazioni",
        large(c("insertImage", "Immagini", "Image", { menu: true })),
      ),
      group("Collegamenti", large(c("insertLink", "Collegamento", "Link", { shortcut: "Ctrl+K" }))),
      group("Commenti", large(cmd.comment)),
      group("Intestazione e piè di pagina", stack(
        c("header", "Intestazione", "PanelTop", { menu: true }),
        c("footer", "Piè di pagina", "PanelBottom", { menu: true }),
        c("pageNumber", "Numero di pagina", "Hash", { menu: true }),
      )),
      group("Testo",
        large(c("textBox", "Casella di testo", "TextCursorInput", { menu: true })),
        large(c("symbol", "Simbolo", "Omega", { menu: true })),
      ),
    ],
  },
  {
    id: "layout", label: "Layout",
    groups: [
      group("Imposta pagina",
        large(c("margins", "Margini", "Scaling", { menu: true })),
        large(c("orientation", "Orientamento", "RectangleVertical", { menu: true })),
        large(c("pageSize", "Dimensioni", "RectangleHorizontal", { menu: true })),
        large(c("breaks", "Interruzioni", "SeparatorHorizontal", { menu: true })),
        large(c("watermark", "Filigrana", "Stamp", { menu: true })),
      ),
    ],
  },
  {
    id: "references", label: "Riferimenti",
    groups: [
      group("Sommario",
        large(c("toc", "Sommario", "BookOpen", { menu: true })),
        stack(c("tocUpdate", "Aggiorna sommario", "RefreshCw"), c("tocAddText", "Aggiungi testo", "Plus", { menu: true })),
      ),
      group("Note a piè di pagina", large(c("footnote", "Inserisci nota", "Footprints", { shortcut: "Alt+Ctrl+F" }))),
      group("Didascalie", large(c("caption", "Inserisci didascalia", "Tag"))),
      group("Citazioni e bibliografia", large(c("citation", "Inserisci citazione", "BookOpenText", { menu: true }))),
    ],
  },
  {
    id: "review", label: "Revisione",
    groups: [
      group("Strumenti di correzione", large(cmd.spell), large(c("docStats", "Statistiche", "ChartColumn"))),
      group("Commenti", large(cmd.comment), stack(c("deleteComment", "Elimina", "Trash2"))),
      group("Revisioni", large(c("trackChanges", "Revisioni", "FileDiff", { toggle: true, shortcut: "Ctrl+Maiusc+E" }))),
      group("Lettere", large(c("mailMerge", "Stampa unione", "Mail"))),
    ],
  },
  {
    id: "view", label: "Visualizza",
    groups: [
      group("Visualizzazioni",
        large(c("printLayout", "Layout di stampa", "FileText", { toggle: true, radio: "docView" })),
        large(c("readMode", "Modalità lettura", "BookOpen", { toggle: true, radio: "docView" })),
      ),
      group("Mostra", stack(
        c("ruler", "Righello", "Ruler", { toggle: true }),
        c("outlinePane", "Struttura titoli", "ListTree", { toggle: true }),
      )),
      group("Pannelli",
        large(c("dockTerminal", "Terminale", "SquareTerminal", { toggle: true, shortcut: "Ctrl+`" })),
        large(c("dockAssistant", "Assistente", "Sparkles", { toggle: true, shortcut: "Ctrl+Maiusc+A", tip: "Riassumi o riscrivi il testo con Claude o Antigravity" })),
        large(c("dockSource", "Sorgente", "FileCode", { toggle: true, shortcut: "Ctrl+Maiusc+M", tip: "Mostra e modifica il testo Markdown del documento, accanto al documento" })),
      ),
      group("Zoom", large(cmd.zoom), stack(c("zoom100", "100%", "Search"), c("pageWidth", "Larghezza pagina", "Columns2"))),
      group("Aspetto", large(c("themeCycle", "Tema", "Sun", { tip: "Cambia tema: sistema, chiaro, scuro" }))),
    ],
  },
];

// ---------- Foglio di calcolo ----------

const NUMBER_FORMAT_LABELS = [...NUMBER_FORMATS.map(([label]) => label), "Personalizzato"];
const autoSum = c("autoSum", "Somma automatica", "Sigma", { shortcut: "Alt+=", menu: true, split: true });

const sheetTabs: RibbonTab[] = [
  {
    id: "home", label: "Home",
    groups: [
      clipboard,
      group("Carattere", rows(
        [sel("fontName", "Tipo di carattere", SHEET_FONTS, "Calibri", 132), sel("fontSize", "Dimensione", SIZES, "11", 52), ico(cmd.grow), ico(cmd.shrink)],
        [ico(cmd.bold), ico(cmd.italic), ico(cmd.underline), ico(cmd.strike), sep, ico(c("cellBorders", "Bordi", "Grid3x3", { menu: true })), ico(c("fillColor", "Colore riempimento", "PaintBucket", { menu: true })), ico(cmd.color)],
      )),
      group("Allineamento", rows(
        [
          ico(c("vAlignTop", "Allinea in alto", "AlignVerticalJustifyStart", { toggle: true, radio: "valign" })),
          ico(c("vAlignMiddle", "Allinea al centro", "AlignVerticalJustifyCenter", { toggle: true, radio: "valign" })),
          ico(c("vAlignBottom", "Allinea in basso", "AlignVerticalJustifyEnd", { toggle: true, radio: "valign" })),
          sep,
          ico(c("wrap", "Testo a capo", "WrapText", { toggle: true })),
        ],
        [
          ico(c("alignLeft", "Allinea a sinistra", "TextAlignStart", { toggle: true, radio: "align" })),
          ico(c("alignCenter", "Centra", "TextAlignCenter", { toggle: true, radio: "align" })),
          ico(c("alignRight", "Allinea a destra", "TextAlignEnd", { toggle: true, radio: "align" })),
          sep,
          ico(c("outdent", "Riduci rientro", "IndentDecrease")),
          ico(c("indent", "Aumenta rientro", "IndentIncrease")),
          sep,
          ico(c("mergeCells", "Unisci e allinea al centro", "TableCellsMerge", { menu: true })),
        ],
      )),
      group("Numeri", rows(
        [sel("numberFormat", "Formato numero", NUMBER_FORMAT_LABELS, "Generale", 128)],
        [
          ico(c("fmtCurrency", "Formato valuta", "Euro", { menu: true, split: true })),
          ico(c("fmtPercent", "Stile percentuale", "Percent", { shortcut: "Ctrl+Maiusc+%" })),
          ico(c("fmtThousands", "Separatore delle migliaia", "Hash")),
          sep,
          ico(c("decimalsMore", "Aumenta decimali", "Plus")),
          ico(c("decimalsLess", "Riduci decimali", "Minus")),
        ],
      )),
      group("Stili", stack(
        c("conditionalFormat", "Formattazione condizionale", "ChartColumn", { menu: true }),
        c("formatAsTable", "Formatta come tabella", "TableProperties", { menu: true }),
        c("cellStyles", "Stili cella", "Paintbrush", { menu: true }),
      )),
      group("Celle", stack(
        c("insertCells", "Inserisci", "Plus", { menu: true }),
        c("deleteCells", "Elimina", "Trash2", { menu: true }),
        c("formatCells", "Formato", "Rows3", { menu: true }),
      )),
      group("Modifica",
        stack(
          autoSum,
          c("clearMenu", "Cancella", "Eraser", { menu: true }),
          c("sortFilter", "Ordina e filtra", "ArrowDownWideNarrow", { menu: true }),
        ),
        stack(
          c("find", "Trova", "Search", { shortcut: "Ctrl+F" }),
          c("replace", "Sostituisci", "Replace", { shortcut: "Ctrl+H" }),
        ),
      ),
    ],
  },
  {
    id: "insert", label: "Inserisci",
    groups: [
      group("Tabelle",
        large(c("pivot", "Tabella Pivot", "Table")),
        large(c("insertTable", "Tabella", "TableProperties", { shortcut: "Ctrl+T" })),
      ),
      group("Grafici",
        large(c("chartColumn", "Colonne", "ChartColumn", { menu: true })),
        large(c("chartLine", "Linee", "ChartLine", { menu: true })),
        large(c("chartPie", "Torta", "ChartPie", { menu: true })),
      ),
      group("Collegamenti", large(c("insertLink", "Collegamento", "Link", { shortcut: "Ctrl+K" }))),
      group("Commenti", large(cmd.comment)),
    ],
  },
  {
    id: "formulas", label: "Formule",
    groups: [
      group("Libreria di funzioni",
        large(c("insertFunction", "Inserisci funzione", "SquareFunction", { shortcut: "Maiusc+F3" })),
        large(autoSum),
        stack(c("fnRecent", "Usate di recente", "Clock", { menu: true }), c("fnFinancial", "Finanziarie", "Euro", { menu: true }), c("fnLogical", "Logiche", "Calculator", { menu: true })),
        stack(c("fnText", "Testo", "Type", { menu: true }), c("fnDate", "Data e ora", "Clock", { menu: true }), c("fnLookup", "Ricerca e riferimento", "Search", { menu: true })),
      ),
      group("Nomi definiti", stack(
        c("defineName", "Definisci nome", "Plus"),
        c("nameManager", "Gestione nomi", "Tag", { menu: true }),
      )),
      group("Calcolo", large(c("calcNow", "Calcola ora", "RefreshCw", { shortcut: "F9" }))),
    ],
  },
  {
    id: "data", label: "Dati",
    groups: [
      group("Ordina e filtra",
        large(c("sort", "Ordina A → Z", "ArrowDownAZ")),
        large(c("sortDesc", "Ordina Z → A", "ArrowDownZA")),
        large(c("filter", "Filtro", "Filter", { shortcut: "Ctrl+Maiusc+L", toggle: true })),
      ),
      group("Strumenti dati", stack(
        c("textToColumns", "Testo in colonne", "Columns3"),
        c("removeDuplicates", "Rimuovi duplicati", "ListFilter"),
        c("validation", "Convalida dati", "SpellCheck", { menu: true }),
      )),
      group("Struttura", large(c("subtotal", "Subtotale", "Sigma"))),
    ],
  },
  {
    id: "review", label: "Revisione",
    groups: [
      group("Commenti", large(cmd.comment), stack(c("deleteComment", "Elimina", "Trash2"))),
    ],
  },
  {
    id: "view", label: "Visualizza",
    groups: [
      group("Mostra", stack(
        c("gridlines", "Griglia", "Grid3x3", { toggle: true }),
        c("headings", "Intestazioni", "Rows3", { toggle: true }),
        c("formulaBar", "Barra della formula", "SquareFunction", { toggle: true }),
      )),
      group("Pannelli",
        large(c("dockTerminal", "Terminale", "SquareTerminal", { toggle: true, shortcut: "Ctrl+`" })),
        large(c("dockAssistant", "Assistente", "Sparkles", { toggle: true, shortcut: "Ctrl+Maiusc+A", tip: "Riassumi o riscrivi il testo con Claude o Antigravity" })),
      ),
      group("Zoom", large(cmd.zoom), stack(c("zoom100", "100%", "Search"))),
      group("Finestra", large(c("freezePanes", "Blocca riquadri", "Snowflake", { menu: true }))),
      group("Aspetto", large(c("themeCycle", "Tema", "Sun", { tip: "Cambia tema: sistema, chiaro, scuro" }))),
    ],
  },
];

// ---------- PDF ----------

const pdfTabs: RibbonTab[] = [
  {
    id: "home", label: "Modifica",
    groups: [
      group("Selezione",
        large(c("pdfSelectAll", "Seleziona tutto", "MousePointer2", { shortcut: "Ctrl+A", tip: "Seleziona tutti gli oggetti della pagina" })),
        large(c("pdfDelete", "Elimina", "Trash2", { shortcut: "Canc", tip: "Elimina gli oggetti selezionati" })),
      ),
      group("Oggetti selezionabili", stack(
        c("pdfShowText", "Testo", "Type", { toggle: true }),
        c("pdfShowImages", "Immagini", "Image", { toggle: true }),
        c("pdfShowGraphics", "Grafica", "Shapes", { toggle: true }),
        c("pdfShowHidden", "Testo nascosto (OCR)", "EyeOff", { toggle: true, tip: "Il testo invisibile aggiunto dal riconoscimento (OCR)" }),
      )),
      group("Vista",
        large(c("pdfShowBoxes", "Mostra oggetti", "BoxSelect", { toggle: true, tip: "Mostra il contorno di tutti gli oggetti della pagina" })),
        large(c("pdfGroupLines", "Testo per righe", "TextAlignStart", { toggle: true, tip: "Il testo vicino sulla stessa riga si seleziona insieme" })),
      ),
      group("Testo", large(c("pdfExtractText", "Estrai testo", "FileText", { tip: "Apri il testo del PDF come documento da modificare" }))),
    ],
  },
  {
    id: "pages", label: "Pagine",
    groups: [
      group("Pagina corrente",
        large(c("pdfRotateLeft", "Ruota a sinistra", "RotateCcw")),
        large(c("pdfRotateRight", "Ruota a destra", "RotateCw")),
        large(c("pdfDeletePage", "Elimina pagina", "Trash2", { tip: "Elimina la pagina visibile (si può annullare)" })),
        stack(c("pdfMoveUp", "Sposta su", "ArrowUp"), c("pdfMoveDown", "Sposta giù", "ArrowDown")),
      ),
    ],
  },
  {
    id: "ocr", label: "OCR",
    groups: [
      group("Riconoscimento del testo",
        large(c("pdfOcrPage", "Questa pagina", "ScanText", { tip: "Riconosce il testo della pagina visibile (serve Tesseract)" })),
        large(c("pdfOcrAll", "Tutto il documento", "FileSearch", { tip: "Riconosce il testo di tutte le pagine" })),
        stack(c("pdfOcrLang", "Lingua…", "Languages")),
      ),
    ],
  },
  {
    id: "view", label: "Visualizza",
    groups: [
      group("Pannelli",
        large(c("dockTerminal", "Terminale", "SquareTerminal", { toggle: true, shortcut: "Ctrl+`" })),
        large(c("dockAssistant", "Assistente", "Sparkles", { toggle: true, shortcut: "Ctrl+Maiusc+A", tip: "Riassumi o riscrivi il testo con Claude o Antigravity" })),
      ),
      group("Zoom", large(cmd.zoom), stack(c("zoom100", "100%", "Search"), c("pageWidth", "Larghezza pagina", "Columns2"))),
      group("Aspetto", large(c("themeCycle", "Tema", "Sun", { tip: "Cambia tema: sistema, chiaro, scuro" }))),
    ],
  },
];

// ---------- Presentazioni ----------

const themeGallery: GalleryItem[] = THEMES.map((th) => ({
  id: `theme.${th.id}`, label: th.name,
  preview: `background:${th.titleBackground ?? th.background};color:${th.titleSlideText ?? th.title};font-family:"${th.headingFont}";font-weight:700;font-size:13px;padding:2px 6px;border-bottom:3px solid ${th.accent};border-radius:2px`,
}));

const newSlide = c("newSlide", "Nuova diapositiva", "Presentation", { shortcut: "Ctrl+M", menu: true, split: true });
const slideshowStart = c("slideshowStart", "Dall'inizio", "Play", { shortcut: "F5" });
const slideshowCurrent = c("slideshowCurrent", "Dalla diapositiva corrente", "MonitorPlay", { shortcut: "Maiusc+F5" });

const slidesTabs: RibbonTab[] = [
  {
    id: "home", label: "Home",
    groups: [
      clipboard,
      group("Diapositive",
        large(newSlide),
        stack(
          c("slideLayout", "Layout", "LayoutTemplate", { menu: true }),
          c("autoLayout", "Disposizione automatica", "WandSparkles", { tip: "Rimette titolo e contenuto nei posti del tema e ridispone il resto nello spazio libero" }),
          c("duplicateSlide", "Duplica", "CopyPlus", { shortcut: "Ctrl+D" }),
        ),
        stack(
          c("deleteSlide", "Elimina diapositiva", "Trash2"),
          c("hideSlide", "Nascondi diapositiva", "EyeOff", { toggle: true, tip: "Non mostrarla durante la presentazione" }),
        ),
      ),
      group("Carattere", rows(
        [sel("fontName", "Tipo di carattere", SHEET_FONTS, "Calibri", 132), sel("fontSize", "Dimensione", [...SIZES.slice(0, -1), "40", "44", "54", "60", "66", "72", "80", "96"], "24", 52), ico(cmd.grow), ico(cmd.shrink), ico(cmd.clearFmt)],
        [ico(cmd.bold), ico(cmd.italic), ico(cmd.underline), ico(cmd.strike), sep, ico(cmd.color)],
      )),
      group("Paragrafo", rows(
        [
          ico(c("bullets", "Elenco puntato", "List", { toggle: true })),
          ico(c("numbering", "Elenco numerato", "ListOrdered", { toggle: true })),
          sep,
          ico(c("outdent", "Riduci livello elenco", "IndentDecrease", { shortcut: "Maiusc+Tab" })),
          ico(c("indent", "Aumenta livello elenco", "IndentIncrease", { shortcut: "Tab" })),
        ],
        [
          ico(c("alignLeft", "Allinea a sinistra", "TextAlignStart", { shortcut: "Ctrl+L", toggle: true })),
          ico(c("alignCenter", "Centra", "TextAlignCenter", { shortcut: "Ctrl+E", toggle: true })),
          ico(c("alignRight", "Allinea a destra", "TextAlignEnd", { shortcut: "Ctrl+R", toggle: true })),
          ico(c("justify", "Giustifica", "TextAlignJustify", { shortcut: "Ctrl+J", toggle: true })),
          sep,
          ico(c("textAnchor", "Allinea testo in verticale", "AlignVerticalJustifyCenter", { menu: true })),
        ],
      )),
      group("Disegno", stack(
        c("shapeFill", "Riempimento forma", "PaintBucket", { menu: true }),
        c("shapeLine", "Contorno forma", "SquareDashed", { menu: true }),
        c("arrange", "Disponi", "BringToFront", { menu: true }),
      )),
      group("Modifica", stack(cmd.find, cmd.replace, c("selectAll", "Seleziona tutto", "MousePointer2", { shortcut: "Ctrl+A" }))),
    ],
  },
  {
    id: "insert", label: "Inserisci",
    groups: [
      group("Diapositive", large(newSlide)),
      group("Tabelle", large(c("insertTable", "Tabella", "Table", { menu: true }))),
      group("Illustrazioni",
        large(c("insertImage", "Immagini", "ImagePlus", { tip: "Inserisci un'immagine: si dispone da sola nello spazio libero" })),
        large(c("insertShape", "Forme", "Shapes", { menu: true })),
      ),
      group("Testo", large(c("textBox", "Casella di testo", "TextCursorInput"))),
      group("Collegamenti", large(c("insertLink", "Collegamento", "Link", { shortcut: "Ctrl+K" }))),
    ],
  },
  {
    id: "design", label: "Progettazione",
    groups: [
      group("Temi", { kind: "gallery", id: "themes", items: themeGallery }),
      group("Personalizza",
        large(c("slideBackground", "Sfondo", "Palette", { menu: true, tip: "Colore di sfondo della diapositiva" })),
        large(c("slideSize", "Dimensioni diapositiva", "Ratio", { menu: true })),
      ),
    ],
  },
  {
    id: "show", label: "Presentazione",
    groups: [
      group("Avvia presentazione", large(slideshowStart), large(slideshowCurrent)),
      group("Imposta", large(c("hideSlide", "Nascondi diapositiva", "EyeOff", { toggle: true, tip: "Non mostrarla durante la presentazione" }))),
    ],
  },
  {
    id: "view", label: "Visualizza",
    groups: [
      group("Mostra", stack(
        c("notesPane", "Note", "StickyNote", { toggle: true, tip: "Note del relatore sotto la diapositiva" }),
        c("thumbsPane", "Miniature", "PanelLeft", { toggle: true }),
      )),
      group("Pannelli",
        large(c("dockTerminal", "Terminale", "SquareTerminal", { toggle: true, shortcut: "Ctrl+`" })),
        large(c("dockAssistant", "Assistente", "Sparkles", { toggle: true, shortcut: "Ctrl+Maiusc+A", tip: "Riassumi o riscrivi il testo con Claude o Antigravity" })),
      ),
      group("Zoom", large(cmd.zoom), stack(c("zoom100", "100%", "Search"), c("pageWidth", "Adatta alla finestra", "Columns2"))),
      group("Aspetto", large(c("themeCycle", "Tema", "Sun", { tip: "Cambia tema: sistema, chiaro, scuro" }))),
    ],
  },
];

export function ribbonFor(kind: DocKind): RibbonTab[] {
  return kind === "doc" ? docTabs : kind === "pdf" ? pdfTabs : kind === "slides" ? slidesTabs : sheetTabs;
}

/** Tutti i comandi di un tipo di documento, per la palette comandi (Ctrl+K). */
export function allCommands(kind: DocKind): Command[] {
  const seen = new Map<string, Command>();
  for (const tab of ribbonFor(kind)) {
    for (const g of tab.groups) {
      for (const item of g.items) {
        const cmds: Command[] =
          item.kind === "large" ? [item.cmd]
          : item.kind === "stack" ? item.cmds
          : item.kind === "rows" ? item.rows.flat().flatMap((r) => (r.kind === "icon" ? [r.cmd] : []))
          : item.items.map((s) => ({ id: s.id, label: s.id.startsWith("theme.") ? t("Tema: {0}", s.label) : t("Stile: {0}", s.label), icon: (s.id.startsWith("theme.") ? "Palette" : "Type") as IconName }));
        for (const cm of cmds) if (!seen.has(cm.id)) seen.set(cm.id, cm);
      }
    }
  }
  return [...seen.values()];
}
