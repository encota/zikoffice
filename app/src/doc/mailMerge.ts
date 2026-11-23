// Stampa unione (Mail Merge): sostituisce i segnaposto {{Campo}} in un documento modello
// usando i record di una tabella CSV/TSV e produce un unico documento pronto da stampare/esportare in PDF.
import { cloneDoc, type Block, type DocumentModel, type Paragraph } from "./model";

export interface MergeRecord {
  [field: string]: string;
}

/** Analizza un testo CSV/TSV (separatore ; , o tab) in una lista di record { colonna: valore }. */
export function parseCsvRecords(text: string): MergeRecord[] {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const first = lines[0];
  const sep = first.includes(";") ? ";" : first.includes("\t") ? "\t" : ",";
  const splitLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === sep && !inQ) {
        out.push(cur.trim()); cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };
  const headers = splitLine(lines[0]);
  const out: MergeRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitLine(lines[i]);
    const rec: MergeRecord = {};
    headers.forEach((h, idx) => { if (h) rec[h] = vals[idx] ?? ""; });
    out.push(rec);
  }
  return out;
}

function replaceInParagraph(p: Paragraph, rec: MergeRecord): void {
  const map = new Map(Object.entries(rec).map(([k, v]) => [k.toLowerCase(), v]));
  for (const r of p.runs) {
    if (r.type) continue;
    r.text = r.text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, key: string) => map.get(key.toLowerCase()) ?? m);
  }
}

function renumberBlocks(blocks: Block[], nextId: () => number): void {
  for (const b of blocks) {
    b.id = nextId();
    if (b.type === "table") {
      for (const row of b.rows) for (const cell of row.cells) for (const p of cell.paragraphs) p.id = nextId();
    }
  }
}

/** Genera un documento combinato con una copia per ogni record separata da interruzione di pagina. */
export function runMailMerge(template: DocumentModel, records: MergeRecord[]): DocumentModel {
  const out = cloneDoc(template);
  out.blocks = [];
  out.nextId = 1;
  const nextId = () => out.nextId++;

  records.forEach((rec, idx) => {
    const copy = cloneDoc(template);
    for (const b of copy.blocks) {
      if (b.type === "p") replaceInParagraph(b, rec);
      else if (b.type === "table") {
        for (const row of b.rows) for (const cell of row.cells) for (const p of cell.paragraphs) replaceInParagraph(p, rec);
      }
    }
    renumberBlocks(copy.blocks, nextId);
    if (idx > 0 && copy.blocks[0]?.type === "p") {
      copy.blocks[0].props.pageBreakBefore = true;
    } else if (idx > 0) {
      out.blocks.push({ type: "p", id: nextId(), props: {}, runs: [{ text: "\f", props: {} }] });
    }
    out.blocks.push(...copy.blocks);
  });

  if (!out.blocks.length) out.blocks.push({ type: "p", id: nextId(), props: {}, runs: [] });
  return out;
}
