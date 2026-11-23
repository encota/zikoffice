// Testo dei riquadri: dal modello al DOM modificabile e ritorno.
import { cssFontFamily } from "../sheet/format";
import type { Para, Role, TextRun } from "./model";
import { levelSize, paraBullet, type RoleStyle } from "./layout";

/** Le dimensioni passano dalla variabile --fit: riducendo il testo non si ricostruisce il DOM. */
export const fitSize = (pt: number) => `calc(var(--fit, 1) * ${pt}px)`;

function runSpan(r: TextRun): HTMLElement {
  const s = document.createElement("span");
  const css: string[] = [];
  if (r.b !== undefined) css.push(`font-weight:${r.b ? 700 : 400}`);
  if (r.i !== undefined) css.push(`font-style:${r.i ? "italic" : "normal"}`);
  const deco = [r.u ? "underline" : "", r.strike ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) css.push(`text-decoration:${deco}`);
  if (r.color) css.push(`color:${r.color}`);
  if (r.size) css.push(`font-size:${fitSize(r.size)}`);
  if (r.font) css.push(`font-family:${cssFontFamily(r.font)}`);
  if (r.spacing) css.push(`letter-spacing:${r.spacing}px`);
  if (r.caps === "all") css.push("text-transform:uppercase");
  if (r.caps === "small") css.push("font-variant:small-caps");
  if (css.length) s.setAttribute("style", css.join(";"));
  if (r.link) s.dataset.link = r.link;
  const parts = r.text.split("\n");
  parts.forEach((t, i) => {
    if (i) s.append(document.createElement("br"));
    if (t) s.append(t);
  });
  return s;
}

export function paraElement(p: Para, role: Role, style: RoleStyle): HTMLElement {
  const el = document.createElement("div");
  el.className = "p";
  const bullet = paraBullet(p, role, style);
  el.dataset.level = String(p.level);
  if (p.bullet) el.dataset.bulletSet = p.bullet;
  el.dataset.bullet = bullet;
  // L'altezza della riga dipende dalla dimensione del paragrafo: se tutto il testo ha una
  // dimensione propria (file importati), il paragrafo prende quella più grande.
  const sized = p.runs.filter((r) => r.text);
  const own = sized.length && sized.every((r) => r.size) ? Math.max(...sized.map((r) => r.size!)) : 0;
  el.style.fontSize = fitSize(own || levelSize(style.size, role === "body" ? p.level : 0));
  if (p.align) el.dataset.alignSet = "1";
  // Spaziature del paragrafo: conservate negli attributi per ritrovarle dopo la modifica.
  if (p.lineSpacing) { el.style.lineHeight = String(1.2 * p.lineSpacing); el.dataset.ln = String(p.lineSpacing); }
  if (p.spaceBefore !== undefined) { el.style.marginTop = `${p.spaceBefore}px`; el.dataset.sb = String(p.spaceBefore); }
  if (p.spaceAfter !== undefined) { el.style.marginBottom = `${p.spaceAfter}px`; el.dataset.sa = String(p.spaceAfter); }
  el.style.textAlign = { l: "left", ctr: "center", r: "right", just: "justify" }[p.align ?? style.align];
  const indent = p.level * 1.4 + (bullet !== "none" ? 1.1 : 0);
  if (indent) el.style.paddingLeft = `${indent}em`;
  for (const r of p.runs) if (r.text) el.append(runSpan(r));
  if (!el.childNodes.length) el.append(document.createElement("br"));
  return el;
}

export function fillText(box: HTMLElement, paras: Para[], role: Role, style: RoleStyle): void {
  box.replaceChildren(...(paras.length ? paras : [{ runs: [], level: 0 }]).map((p) => paraElement(p, role, style)));
}

// ---------- dal DOM al modello ----------

interface Fmt { b?: boolean; i?: boolean; u?: boolean; strike?: boolean; color?: string; size?: number; font?: string; link?: string; spacing?: number; caps?: "all" | "small" }

function rgbToHex(v: string): string | undefined {
  const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined;
}

function fmtOf(el: HTMLElement, base: Fmt): Fmt {
  const f: Fmt = { ...base };
  const tag = el.tagName;
  if (tag === "B" || tag === "STRONG") f.b = true;
  if (tag === "I" || tag === "EM") f.i = true;
  if (tag === "U") f.u = true;
  if (tag === "S" || tag === "STRIKE") f.strike = true;
  if (tag === "FONT") {
    const c = el.getAttribute("color");
    if (c) f.color = rgbToHex(c) ?? f.color;
  }
  const st = el.style;
  if (st.fontWeight) f.b = st.fontWeight === "bold" || Number(st.fontWeight) >= 600;
  if (st.fontStyle) f.i = st.fontStyle === "italic";
  const deco = st.textDecorationLine || st.textDecoration;
  if (deco) { f.u = deco.includes("underline"); f.strike = deco.includes("line-through"); }
  if (st.color) f.color = rgbToHex(st.color) ?? f.color;
  const fs = el.getAttribute("style")?.match(/font-size:\s*(?:calc\(var\(--fit(?:,\s*1)?\)\s*\*\s*)?([\d.]+)px/);
  if (fs && tag !== "DIV") f.size = Number(fs[1]);
  const ff = st.fontFamily;
  if (ff && tag !== "DIV") f.font = ff.split(",")[0].replace(/["']/g, "").trim();
  if (el.dataset.link) f.link = el.dataset.link;
  const ls = el.style.letterSpacing.match(/^(-?[\d.]+)px$/);
  if (ls && tag !== "DIV") f.spacing = Number(ls[1]);
  if (st.textTransform === "uppercase") f.caps = "all";
  else if (st.fontVariant === "small-caps") f.caps = "small";
  return f;
}

function sameFmt(a: Fmt, b: Fmt): boolean {
  return a.b === b.b && a.i === b.i && a.u === b.u && a.strike === b.strike && a.color === b.color && a.size === b.size && a.font === b.font && a.link === b.link && a.spacing === b.spacing && a.caps === b.caps;
}

function pushText(runs: TextRun[], text: string, f: Fmt): void {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && sameFmt(last, f)) { last.text += text; return; }
  const r: TextRun = { text };
  for (const k of ["b", "i", "u", "strike", "color", "size", "font", "link", "spacing", "caps"] as const) {
    if (f[k] !== undefined && f[k] !== false) (r as unknown as Record<string, unknown>)[k] = f[k];
  }
  runs.push(r);
}

function collect(node: Node, f: Fmt, runs: TextRun[]): void {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) pushText(runs, (child.textContent ?? "").replace(/​/g, ""), f);
    else if (child instanceof HTMLElement) {
      if (child.tagName === "BR") {
        // Un <br> finale di un paragrafo è solo il segnaposto del paragrafo vuoto.
        if (child.nextSibling) pushText(runs, "\n", f);
      } else collect(child, fmtOf(child, f), runs);
    }
  }
}

/** Legge i paragrafi da un riquadro modificato dall'utente. */
export function readText(box: HTMLElement): Para[] {
  const paras: Para[] = [];
  const blockOf = (el: HTMLElement): Para => {
    const runs: TextRun[] = [];
    collect(el, {}, runs);
    // Ciò che il browser incolla resta in un unico stile: grassetto "normale" non serve.
    const level = Math.max(0, Math.min(4, Number(el.dataset.level ?? 0) || 0));
    const p: Para = { runs, level };
    const set = el.dataset.bulletSet;
    if (set === "none" || set === "bullet" || set === "number") p.bullet = set;
    const align = el.style.textAlign;
    for (const [k, attr] of [["lineSpacing", "ln"], ["spaceBefore", "sb"], ["spaceAfter", "sa"]] as const) {
      if (el.dataset[attr] !== undefined) p[k] = Number(el.dataset[attr]);
    }
    if (align && el.dataset.alignSet) p.align = ({ left: "l", center: "ctr", right: "r", justify: "just" } as const)[align as "left"] ?? undefined;
    return p;
  };
  let loose: HTMLElement | null = null;
  for (const child of [...box.childNodes]) {
    if (child instanceof HTMLElement && (child.tagName === "DIV" || child.tagName === "P")) {
      loose = null;
      paras.push(blockOf(child));
    } else {
      // Testo fuori da un paragrafo (es. dopo aver cancellato tutto): lo si raccoglie in uno nuovo.
      if (!loose) { loose = document.createElement("div"); paras.push({ runs: [], level: 0 }); }
      loose.append(child.cloneNode(true));
      paras[paras.length - 1] = blockOf(loose);
    }
  }
  return paras.length ? paras : [{ runs: [], level: 0 }];
}

export function isTextEmpty(paras: Para[]): boolean {
  return paras.every((p) => p.runs.every((r) => !r.text.trim()));
}
