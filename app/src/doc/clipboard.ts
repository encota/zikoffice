// Conversione tra paragrafi e HTML per scambiare testo formattato con altri programmi.
import { normalizeRuns, type DocumentModel, type Paragraph, type RunProps } from "./model";
import { effectivePara, effectiveRun, ensureListNumbering } from "./styles";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** HTML semplice ma fedele (grassetto, colori, titoli, elenchi) per incollare altrove. */
export function fragmentsToHtml(doc: DocumentModel, paras: Paragraph[]): string {
  const out: string[] = [];
  for (const p of paras) {
    const pp = effectivePara(doc, p);
    const level = pp.outlineLevel;
    const tag = level !== undefined && level < 6 ? `h${level + 1}` : "p";
    const style = pp.align && pp.align !== "left" ? ` style="text-align:${pp.align}"` : "";
    let inner = "";
    for (const r of p.runs) {
      if (r.type === "image") { inner += `<img src="${r.src}" width="${Math.round(r.width * 4 / 3)}" height="${Math.round(r.height * 4 / 3)}" alt="${esc(r.alt ?? "")}">`; continue; }
      if (r.type === "field") continue;
      const e = effectiveRun(doc, p, r);
      const css: string[] = [];
      if (e.font) css.push(`font-family:'${e.font}'`);
      if (e.size) css.push(`font-size:${e.size}pt`);
      if (e.color) css.push(`color:${e.color}`);
      if (e.highlight) css.push(`background:${e.highlight}`);
      let t = esc(r.text).replace(/[\u000b\n]/g, "<br>").replace(/\t/g, "&emsp;").replace(/\f/g, "");
      if (e.bold) t = `<b>${t}</b>`;
      if (e.italic) t = `<i>${t}</i>`;
      if (e.underline) t = `<u>${t}</u>`;
      if (e.strike) t = `<s>${t}</s>`;
      if (e.vertAlign === "superscript") t = `<sup>${t}</sup>`;
      if (e.vertAlign === "subscript") t = `<sub>${t}</sub>`;
      if (r.props.link) t = `<a href="${esc(r.props.link)}">${t}</a>`;
      inner += css.length ? `<span style="${css.join(";")}">${t}</span>` : t;
    }
    out.push(`<${tag}${style}>${inner || "<br>"}</${tag}>`);
  }
  return `<meta charset="utf-8">${out.join("")}`;
}

/** Converte l'HTML incollato (da browser, LibreOffice, Word…) in paragrafi. */
export function htmlToParagraphs(doc: DocumentModel, html: string): Paragraph[] {
  const dom = new DOMParser().parseFromString(html, "text/html");
  const out: Paragraph[] = [];
  let current: Paragraph | null = null;
  const BLOCK = /^(P|DIV|H[1-6]|LI|TR|BLOCKQUOTE|PRE|TABLE|UL|OL|SECTION|ARTICLE|HEADER|FOOTER|DT|DD)$/;

  const newPara = (el?: Element): Paragraph => {
    const p: Paragraph = { type: "p", id: doc.nextId++, props: {}, runs: [] };
    const tag = el?.tagName ?? "";
    const m = /^H([1-6])$/.exec(tag);
    if (m) p.props.style = Number(m[1]) <= 4 ? `Heading${m[1]}` : "Heading4";
    if (tag === "BLOCKQUOTE") p.props.style = "Quote";
    if (tag === "LI") {
      const ordered = el!.closest("ol") !== null;
      p.props.numId = ensureListNumbering(doc, ordered ? "number" : "bullet");
      let level = 0;
      for (let a = el!.parentElement; a; a = a.parentElement) if (a.tagName === "UL" || a.tagName === "OL") level++;
      p.props.numLevel = Math.max(0, level - 1);
      p.props.style = "ListParagraph";
    }
    const align = (el as HTMLElement | undefined)?.style?.textAlign;
    if (align === "center" || align === "right" || align === "justify") p.props.align = align;
    out.push(p);
    return p;
  };

  const walk = (node: Node, props: RunProps) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ");
      if (!text.trim() && !current) return;
      current ??= newPara();
      current.runs.push({ text, props: { ...props } });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName;
    if (tag === "STYLE" || tag === "SCRIPT" || tag === "HEAD" || tag === "TITLE") return;
    if (tag === "BR") { current ??= newPara(); current.runs.push({ text: "\u000b", props: { ...props } }); return; }
    if (tag === "IMG") {
      const src = node.getAttribute("src");
      if (src?.startsWith("data:")) {
        current ??= newPara();
        const w = Number(node.getAttribute("width")) || (node as HTMLImageElement).naturalWidth || 200;
        const hh = Number(node.getAttribute("height")) || (node as HTMLImageElement).naturalHeight || 150;
        current.runs.push({ type: "image", src, mime: /^data:([^;,]+)/.exec(src)?.[1] ?? "image/png", width: w * 0.75, height: hh * 0.75, alt: node.getAttribute("alt") ?? "", props: {} });
      }
      return;
    }
    const next: RunProps = { ...props };
    const st = node.style;
    if (tag === "B" || tag === "STRONG" || /^(bold|[6-9]00)$/.test(st.fontWeight)) next.bold = true;
    if (st.fontWeight === "normal" || st.fontWeight === "400") delete next.bold;
    if (tag === "I" || tag === "EM" || st.fontStyle === "italic") next.italic = true;
    if (tag === "U" || st.textDecoration.includes("underline")) next.underline = true;
    if (tag === "S" || tag === "STRIKE" || tag === "DEL" || st.textDecoration.includes("line-through")) next.strike = true;
    if (tag === "SUP") next.vertAlign = "superscript";
    if (tag === "SUB") next.vertAlign = "subscript";
    if (tag === "A" && node.getAttribute("href")) next.link = node.getAttribute("href")!;
    const color = cssColor(st.color);
    if (color && color !== "#000000") next.color = color;
    const pt = cssPt(st.fontSize);
    if (pt) next.size = pt;
    const family = st.fontFamily.split(",")[0]?.replace(/['"]/g, "").trim();
    if (family && !/^(sans-serif|serif|monospace|system-ui|-apple-system)$/i.test(family)) next.font = family;

    const block = BLOCK.test(tag);
    if (block && tag !== "UL" && tag !== "OL" && tag !== "TABLE") current = newPara(node);
    for (const child of node.childNodes) walk(child, next);
    if (block) current = null;
  };
  walk(dom.body, {});
  for (const p of out) {
    // Spazi all'inizio e alla fine dei paragrafi vengono dall'indentazione dell'HTML.
    const first = p.runs[0], last = p.runs[p.runs.length - 1];
    if (first && first.type !== "image" && first.type !== "field") first.text = first.text.replace(/^ +/, "");
    if (last && last.type !== "image" && last.type !== "field") last.text = last.text.replace(/ +$/, "");
    normalizeRuns(p);
  }
  return out.filter((p, i) => p.runs.length || (i > 0 && i < out.length - 1));
}

function cssColor(v: string): string | undefined {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  if (m) return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  return undefined;
}

function cssPt(v: string): number | undefined {
  const m = /^([\d.]+)(pt|px)$/.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]) * (m[2] === "px" ? 0.75 : 1);
  return n > 4 && n < 200 ? Math.round(n * 2) / 2 : undefined;
}
