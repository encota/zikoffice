// Lettura dei documenti .rtf (Rich Text Format) nel modello dell'editor.
import { type Align, type DocumentModel, type Paragraph, type ParaProps, type Run, type RunProps, type Table, type TableCell } from "./model";
import { newDocument } from "./styles";

const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
const cp1252 = (b: number) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b));

const SKIP_DEST = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "footer",
  "headerl", "headerr", "headerf", "footerl", "footerr", "footerf", "listtable",
  "listoverridetable", "revtbl", "rsidtbl", "generator", "themedata", "colorschememapping",
  "datastore", "latentstyles", "xmlnstbl", "mmathPr", "fldinst", "bkmkstart", "bkmkend",
]);

interface State {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  size?: number;
  fontIdx?: number;
  colorIdx?: number;
  highlightIdx?: number;
  align?: Align;
  uc: number;
  skip: boolean;
  inTable: boolean;
}

function parseColorTable(src: string): string[] {
  const m = /\{\\colortbl\b([^}]*)\}/.exec(src);
  if (!m) return [];
  const colors: string[] = [];
  for (const entry of m[1].split(";")) {
    const r = /\\red(\d+)/.exec(entry);
    const g = /\\green(\d+)/.exec(entry);
    const b = /\\blue(\d+)/.exec(entry);
    if (r && g && b) {
      const hex = [r[1], g[1], b[1]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, "0")).join("");
      colors.push(`#${hex}`);
    } else {
      colors.push("");
    }
  }
  return colors;
}

function parseFontTable(src: string): Map<number, string> {
  const fonts = new Map<number, string>();
  const start = src.indexOf("{\\fonttbl");
  if (start < 0) return fonts;
  let depth = 0, end = start;
  for (; end < src.length; end++) {
    if (src[end] === "{") depth++;
    else if (src[end] === "}") { depth--; if (depth === 0) break; }
  }
  const block = src.slice(start, end + 1);
  const re = /\\f(\d+)[^;{}]*?\s+([^;{}]+);/g;
  for (let m; (m = re.exec(block));) {
    fonts.set(Number(m[1]), m[2].replace(/\\[a-z]+-?\d*\s*/gi, "").trim());
  }
  return fonts;
}

/** Legge un file .rtf (Rich Text Format) nel modello dell'editor. */
export function importRtf(bytes: Uint8Array): DocumentModel {
  let src = "";
  for (let i = 0; i < bytes.length; i++) src += String.fromCharCode(bytes[i]);
  if (!src.trimStart().startsWith("{\\rtf")) {
    throw new Error("Il file non è un documento .rtf valido");
  }

  const doc = newDocument();
  doc.blocks = [];
  const colors = parseColorTable(src);
  const fonts = parseFontTable(src);

  const stack: State[] = [{ uc: 1, skip: false, inTable: false }];
  const cur = () => stack[stack.length - 1];

  let runs: Run[] = [];
  let paraProps: ParaProps = {};
  let pendingRow: TableCell[] = [];
  let pendingTable: Table | null = null;

  const currentRunProps = (): RunProps => {
    const s = cur();
    const p: RunProps = {};
    if (s.bold) p.bold = true;
    if (s.italic) p.italic = true;
    if (s.underline) p.underline = true;
    if (s.strike) p.strike = true;
    if (s.size) p.size = s.size;
    if (s.fontIdx !== undefined && fonts.get(s.fontIdx)) p.font = fonts.get(s.fontIdx);
    if (s.colorIdx && colors[s.colorIdx]) p.color = colors[s.colorIdx];
    if (s.highlightIdx && colors[s.highlightIdx]) p.highlight = colors[s.highlightIdx];
    return p;
  };

  const pushText = (text: string) => {
    if (cur().skip || !text) return;
    const props = currentRunProps();
    const last = runs[runs.length - 1];
    if (last && last.type !== "image" && last.type !== "field" && JSON.stringify(last.props) === JSON.stringify(props)) last.text += text;
    else runs.push({ text, props });
  };

  const flushTable = () => {
    if (!pendingTable) return;
    const cols = Math.max(1, ...pendingTable.rows.map((r) => r.cells.length));
    const avail = doc.page.width - doc.page.marginLeft - doc.page.marginRight;
    pendingTable.grid = Array.from({ length: cols }, () => Math.max(36, avail / cols));
    doc.blocks.push(pendingTable);
    pendingTable = null;
  };

  const flushParagraph = () => {
    flushTable();
    const p: Paragraph = { type: "p", id: doc.nextId++, props: { ...paraProps }, runs };
    if (cur().align) p.props.align = cur().align;
    doc.blocks.push(p);
    runs = [];
    paraProps = {};
  };

  let i = 0;
  let ignorable = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") {
      stack.push({ ...cur() });
      ignorable = false;
      i++;
      continue;
    }
    if (ch === "}") {
      if (stack.length > 1) stack.pop();
      ignorable = false;
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") { i++; continue; }
    if (ch === "\\") {
      i++;
      if (i >= src.length) break;
      const next = src[i];
      if (next === "\\" || next === "{" || next === "}") { pushText(next); i++; continue; }
      if (next === "~") { pushText("\u00a0"); i++; continue; }
      if (next === "_") { pushText("‑"); i++; continue; }
      if (next === "-") { i++; continue; }
      if (next === "*") { ignorable = true; i++; continue; }
      if (next === "'") {
        const hex = src.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { pushText(cp1252(parseInt(hex, 16))); i += 3; continue; }
        i++;
        continue;
      }
      if (next === "\r" || next === "\n") { flushParagraph(); i++; continue; }
      // Parola di controllo \word[param]
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i));
      if (!m) { i++; continue; }
      i += m[0].length;
      const word = m[1];
      const param = m[2] !== undefined ? Number(m[2]) : undefined;

      if (ignorable || SKIP_DEST.has(word)) {
        cur().skip = true;
        ignorable = false;
        continue;
      }
      if (cur().skip) continue;

      switch (word) {
        case "par": flushParagraph(); break;
        case "line": pushText("\u000b"); break;
        case "tab": pushText("\t"); break;
        case "page": pushText("\f"); break;
        case "emdash": pushText("—"); break;
        case "endash": pushText("–"); break;
        case "lquote": pushText("‘"); break;
        case "rquote": pushText("’"); break;
        case "ldblquote": pushText("“"); break;
        case "rdblquote": pushText("”"); break;
        case "bullet": pushText("•"); break;
        case "b": cur().bold = param !== 0; break;
        case "i": cur().italic = param !== 0; break;
        case "ul": cur().underline = param !== 0; break;
        case "ulnone": cur().underline = false; break;
        case "strike": cur().strike = param !== 0; break;
        case "fs": if (param && param > 0) cur().size = param / 2; break;
        case "f": if (param !== undefined) cur().fontIdx = param; break;
        case "cf": if (param !== undefined) cur().colorIdx = param; break;
        case "highlight": case "cb": if (param !== undefined) cur().highlightIdx = param; break;
        case "ql": cur().align = "left"; break;
        case "qc": cur().align = "center"; break;
        case "qr": cur().align = "right"; break;
        case "qj": cur().align = "justify"; break;
        case "plain":
          cur().bold = false; cur().italic = false; cur().underline = false; cur().strike = false;
          cur().size = undefined; cur().colorIdx = undefined; cur().highlightIdx = undefined;
          break;
        case "pard":
          cur().align = undefined; cur().inTable = false; paraProps = {};
          break;
        case "intbl": cur().inTable = true; break;
        case "cell": {
          const cellPara: Paragraph = { type: "p", id: doc.nextId++, props: { ...paraProps }, runs };
          pendingRow.push({ span: 1, paragraphs: [cellPara] });
          runs = [];
          paraProps = {};
          break;
        }
        case "row": {
          if (pendingRow.length) {
            if (!pendingTable) pendingTable = { type: "table", id: doc.nextId++, grid: [], rows: [], borders: { width: 0.5, color: "#000000", style: "single" }, align: "left" };
            pendingTable.rows.push({ cells: pendingRow });
            pendingRow = [];
          }
          break;
        }
        case "uc": if (param !== undefined) cur().uc = Math.max(0, param); break;
        case "u": {
          if (param !== undefined) {
            const code = param < 0 ? param + 65536 : param;
            pushText(String.fromCharCode(code));
            // Salta i caratteri di ripiego ANSI successivi (\ucN).
            let skip = cur().uc;
            while (skip > 0 && i < src.length) {
              if (src[i] === "\\" && src[i + 1] === "'") { i += 4; skip--; }
              else if (src[i] === "{" || src[i] === "}") break;
              else { i++; skip--; }
            }
          }
          break;
        }
        default: break;
      }
      continue;
    }
    pushText(ch);
    i++;
  }

  if (runs.length) flushParagraph();
  flushTable();
  if (!doc.blocks.some((b) => b.type === "p")) doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  if (doc.blocks[doc.blocks.length - 1].type !== "p") doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  return doc;
}
