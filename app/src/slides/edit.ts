// Operazioni sul testo di un riquadro per intervalli di caratteri (paragrafi uniti da "\n"),
// e conversione fra la selezione del browser e questi intervalli.
import type { Para, TextRun } from "./model";

export const paraLen = (p: Para) => p.runs.reduce((n, r) => n + r.text.length, 0);

/** Inizio di ogni paragrafo nel testo complessivo. */
function starts(paras: Para[]): number[] {
  const out: number[] = [];
  let pos = 0;
  for (const p of paras) { out.push(pos); pos += paraLen(p) + 1; }
  return out;
}

export function totalLen(paras: Para[]): number {
  return Math.max(0, paras.reduce((n, p) => n + paraLen(p) + 1, 0) - 1);
}

/** Divide i run perché ci sia un confine esattamente in `off` (relativo al paragrafo). */
function splitAt(p: Para, off: number): void {
  let pos = 0;
  for (let i = 0; i < p.runs.length; i++) {
    const r = p.runs[i];
    if (off > pos && off < pos + r.text.length) {
      const a: TextRun = { ...r, text: r.text.slice(0, off - pos) };
      const b: TextRun = { ...r, text: r.text.slice(off - pos) };
      p.runs.splice(i, 1, a, b);
      return;
    }
    pos += r.text.length;
  }
}

/** I run (interi) compresi fra start ed end. */
export function runsInRange(paras: Para[], start: number, end: number): TextRun[] {
  const st = starts(paras);
  const out: TextRun[] = [];
  paras.forEach((p, i) => {
    const a = Math.max(0, start - st[i]), b = Math.min(paraLen(p), end - st[i]);
    if (b <= a) return;
    splitAt(p, a);
    splitAt(p, b);
    let pos = 0;
    for (const r of p.runs) {
      if (pos >= a && pos + r.text.length <= b && r.text) out.push(r);
      pos += r.text.length;
    }
  });
  return out;
}

export function parasInRange(paras: Para[], start: number, end: number): Para[] {
  const st = starts(paras);
  return paras.filter((p, i) => st[i] <= end && st[i] + paraLen(p) >= start);
}

/** Il run in cui si trova il cursore (per mostrare lo stato di grassetto ecc.). */
export function runAt(paras: Para[], off: number): TextRun | undefined {
  const st = starts(paras);
  for (let i = paras.length - 1; i >= 0; i--) {
    if (st[i] > off) continue;
    let pos = st[i];
    const p = paras[i];
    for (const r of p.runs) {
      if (off > pos && off <= pos + r.text.length) return r;
      pos += r.text.length;
    }
    return p.runs[0];
  }
  return undefined;
}

/** Con il solo cursore, la formattazione si applica alla parola in cui si trova. */
export function wordAround(paras: Para[], off: number): [number, number] {
  const text = paras.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
  let a = off, b = off;
  while (a > 0 && /[\p{L}\p{N}_'’-]/u.test(text[a - 1])) a--;
  while (b < text.length && /[\p{L}\p{N}_'’-]/u.test(text[b])) b++;
  return [a, b];
}

/** Unisce i run vicini con la stessa formattazione. */
export function normalize(paras: Para[]): void {
  for (const p of paras) {
    const out: TextRun[] = [];
    for (const r of p.runs) {
      if (!r.text) continue;
      const last = out[out.length - 1];
      const { text: _a, ...fa } = r;
      if (last) {
        const { text: _b, ...fb } = last;
        if (JSON.stringify(fa) === JSON.stringify(fb)) { last.text += r.text; continue; }
      }
      out.push({ ...r });
    }
    p.runs = out;
  }
}

// ---------- selezione del browser ----------

function blocks(box: HTMLElement): Node[] {
  return [...box.childNodes];
}

/** Lunghezza di un nodo con le stesse regole di readText (un <br> finale non conta). */
function nodeLen(n: Node): number {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? "").replace(/​/g, "").length;
  if (n instanceof HTMLElement && n.tagName === "BR") return n.nextSibling ? 1 : 0;
  let len = 0;
  for (const c of n.childNodes) len += nodeLen(c);
  return len;
}

function offsetOf(box: HTMLElement, node: Node, offset: number): number {
  let pos = 0;
  const bl = blocks(box);
  const isBlock = (n: Node) => n instanceof HTMLElement && (n.tagName === "DIV" || n.tagName === "P");
  if (node === box) {
    for (let i = 0; i < Math.min(offset, bl.length); i++) pos += nodeLen(bl[i]) + (isBlock(bl[i]) && i < bl.length - 1 ? 1 : 0);
    return pos;
  }
  for (let i = 0; i < bl.length; i++) {
    const b = bl[i];
    if (b === node || b.contains(node)) {
      const walk = (n: Node): boolean => {
        if (n === node) {
          if (n.nodeType === Node.TEXT_NODE) pos += (n.textContent ?? "").slice(0, offset).replace(/​/g, "").length;
          else for (let k = 0; k < offset; k++) pos += nodeLen(n.childNodes[k]);
          return true;
        }
        if (n.nodeType === Node.TEXT_NODE || (n instanceof HTMLElement && n.tagName === "BR")) { pos += nodeLen(n); return false; }
        for (const c of n.childNodes) if (walk(c)) return true;
        return false;
      };
      walk(b);
      return pos;
    }
    pos += nodeLen(b) + (isBlock(b) && i < bl.length - 1 ? 1 : 0);
  }
  return pos;
}

export function getOffsets(box: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!box.contains(r.startContainer) || !box.contains(r.endContainer)) return null;
  const a = offsetOf(box, r.startContainer, r.startOffset), b = offsetOf(box, r.endContainer, r.endOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function locate(box: HTMLElement, off: number): [Node, number] {
  const bl = blocks(box);
  let pos = 0;
  for (let i = 0; i < bl.length; i++) {
    const b = bl[i];
    const len = nodeLen(b);
    if (off <= pos + len || i === bl.length - 1) {
      let rest = off - pos;
      let found: [Node, number] | null = null;
      const walk = (n: Node): boolean => {
        if (n.nodeType === Node.TEXT_NODE) {
          const l = nodeLen(n);
          if (rest <= l) { found = [n, rest]; return true; }
          rest -= l;
          return false;
        }
        if (n instanceof HTMLElement && n.tagName === "BR") {
          const l = nodeLen(n);
          if (rest === 0) { found = [n.parentNode!, [...n.parentNode!.childNodes].indexOf(n)]; return true; }
          rest -= l;
          return false;
        }
        for (const c of n.childNodes) if (walk(c)) return true;
        return false;
      };
      walk(b);
      return found ?? [b, b.childNodes.length && (b.lastChild as HTMLElement).tagName === "BR" ? b.childNodes.length - 1 : b.childNodes.length];
    }
    pos += len + 1;
  }
  return [box, 0];
}

export function setOffsets(box: HTMLElement, start: number, end = start): void {
  const sel = window.getSelection();
  if (!sel) return;
  const [sn, so] = locate(box, start);
  const [en, eo] = locate(box, end);
  const r = document.createRange();
  try {
    r.setStart(sn, so);
    r.setEnd(en, eo);
  } catch { return; }
  sel.removeAllRanges();
  sel.addRange(r);
}
