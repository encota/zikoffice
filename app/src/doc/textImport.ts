// Importazione ed esportazione di testi semplici (.txt), Markdown (.md) e HTML (.html/.htm).
import {
  paragraphText, type Align, type Block, type DocumentModel, type Run, type RunProps, type Table, type TableCell,
} from "./model";
import { ensureListNumbering, newDocument } from "./styles";

const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";

/** Decodifica UTF-8 (con o senza BOM), con ripiego su Windows-1252. */
export function decodeBytes(bytes: Uint8Array): string {
  const clean = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(clean);
  } catch {
    let out = "";
    for (const b of clean) out += b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b);
    return out;
  }
}

// ---------- Testo semplice (.txt) ----------

export function importPlainText(bytes: Uint8Array): DocumentModel {
  const doc = newDocument();
  doc.blocks = [];
  const text = decodeBytes(bytes).replace(/\r\n?/g, "\n");
  for (const line of text.split("\n")) {
    doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: line ? [{ text: line, props: {} }] : [] });
  }
  if (!doc.blocks.length) doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  return doc;
}

export function exportPlainText(doc: DocumentModel): Uint8Array {
  const lines: string[] = [];
  for (const b of doc.blocks) {
    if (b.type === "p") lines.push(paragraphText(b));
    else if (b.type === "table") {
      for (const r of b.rows) lines.push(r.cells.map((c) => c.paragraphs.map(paragraphText).join(" ")).join("\t"));
    }
  }
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

// Il Markdown (.md) è in markdown.ts.
export { exportMarkdown, importMarkdown } from "./markdown";

// ---------- HTML (.html / .htm) ----------

export function importHtml(bytes: Uint8Array): DocumentModel {
  const doc = newDocument();
  doc.blocks = [];
  const html = decodeBytes(bytes);
  const dom = new DOMParser().parseFromString(html, "text/html");

  const readInline = (node: Node, inherited: RunProps, out: Run[]) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const text = (child.textContent ?? "").replace(/\s+/g, " ");
        if (text) out.push({ text, props: { ...inherited } });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === "br") { out.push({ text: "\u000b", props: { ...inherited } }); continue; }
      if (tag === "script" || tag === "style") continue;
      if (tag === "img") {
        const src = el.getAttribute("src") ?? "";
        if (src.startsWith("data:image/")) {
          const w = Number(el.getAttribute("width")) || 180;
          const h = Number(el.getAttribute("height")) || 120;
          out.push({ type: "image", src, mime: src.slice(5, src.indexOf(";")) || "image/png", width: w * 0.75, height: h * 0.75, alt: el.getAttribute("alt") ?? "", props: {} });
        }
        continue;
      }
      const next: RunProps = { ...inherited };
      if (tag === "b" || tag === "strong") next.bold = true;
      if (tag === "i" || tag === "em") next.italic = true;
      if (tag === "u") next.underline = true;
      if (tag === "s" || tag === "strike" || tag === "del") next.strike = true;
      if (tag === "sup") next.vertAlign = "superscript";
      if (tag === "sub") next.vertAlign = "subscript";
      if (tag === "code") next.font = "Consolas";
      if (tag === "a" && el.getAttribute("href")) next.link = el.getAttribute("href")!;
      readInline(el, next, out);
    }
  };

  const alignOf = (el: HTMLElement): Align | undefined => {
    const a = (el.style.textAlign || el.getAttribute("align") || "").toLowerCase();
    return a === "center" || a === "right" || a === "justify" || a === "left" ? a : undefined;
  };

  const walk = (container: Element, out: Block[], list?: { numId: number; level: number }) => {
    for (const child of [...container.children]) {
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "head") continue;
      if (/^h[1-6]$/.test(tag)) {
        const lvl = Number(tag[1]);
        const runs: Run[] = [];
        readInline(el, {}, runs);
        out.push({ type: "p", id: doc.nextId++, props: { style: `Heading${lvl}`, outlineLevel: lvl - 1, align: alignOf(el) }, runs });
      } else if (tag === "ul" || tag === "ol") {
        const numId = ensureListNumbering(doc, tag === "ul" ? "bullet" : "number");
        for (const li of [...el.children].filter((c) => c.tagName.toLowerCase() === "li")) {
          const runs: Run[] = [];
          readInline(li, {}, runs);
          out.push({ type: "p", id: doc.nextId++, props: { numId, numLevel: list ? Math.min(8, list.level + 1) : 0 }, runs });
        }
      } else if (tag === "table") {
        const rows: Table["rows"] = [];
        for (const tr of [...el.querySelectorAll("tr")]) {
          const cells: TableCell[] = [];
          for (const td of [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH")) {
            const runs: Run[] = [];
            readInline(td, td.tagName === "TH" ? { bold: true } : {}, runs);
            cells.push({
              span: Math.max(1, Number(td.getAttribute("colspan")) || 1),
              shading: td.tagName === "TH" ? "#f3f4f6" : undefined,
              paragraphs: [{ type: "p", id: doc.nextId++, props: {}, runs }],
            });
          }
          if (cells.length) rows.push({ cells, header: tr.parentElement?.tagName === "THEAD" });
        }
        if (rows.length) {
          const cols = Math.max(1, ...rows.map((r) => r.cells.reduce((n, c) => n + c.span, 0)));
          const avail = doc.page.width - doc.page.marginLeft - doc.page.marginRight;
          out.push({ type: "table", id: doc.nextId++, grid: Array.from({ length: cols }, () => Math.max(36, avail / cols)), rows, borders: { width: 0.5, color: "#000000", style: "single" }, align: "left" });
        }
      } else if (tag === "p" || tag === "blockquote" || tag === "pre") {
        const runs: Run[] = [];
        readInline(el, tag === "pre" ? { font: "Consolas" } : {}, runs);
        out.push({ type: "p", id: doc.nextId++, props: { style: tag === "blockquote" ? "Quote" : undefined, align: alignOf(el) }, runs });
      } else if (el.children.length) {
        walk(el, out, list);
      } else {
        const runs: Run[] = [];
        readInline(el, {}, runs);
        if (runs.length) out.push({ type: "p", id: doc.nextId++, props: { align: alignOf(el) }, runs });
      }
    }
  };

  if (dom.body) walk(dom.body, doc.blocks);
  if (!doc.blocks.some((b) => b.type === "p")) doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  if (doc.blocks[doc.blocks.length - 1].type !== "p") doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  return doc;
}
