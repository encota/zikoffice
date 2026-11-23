// Aiuto alla scrittura delle formule: suggerimenti dei nomi di funzione e sintassi.
import { h } from "../dom";
import { functionHelp, functionNames } from "./functions";

type Field = HTMLTextAreaElement;

/** Nome di funzione che si sta scrivendo subito prima del cursore. */
function tokenBefore(text: string, caret: number): { start: number; token: string } | null {
  if (!text.startsWith("=")) return null;
  const before = text.slice(0, caret);
  // Niente suggerimenti dentro una stringa tra virgolette.
  if ((before.match(/"/g)?.length ?? 0) % 2 === 1) return null;
  const m = /([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9.]*)$/.exec(before);
  if (!m) return null;
  const start = caret - m[1].length;
  if (/[A-Za-z0-9_!$:]/.test(before[start - 1] ?? "")) return null;
  return { start, token: m[1] };
}

/** Funzione la cui parentesi è aperta al punto del cursore (per mostrarne la sintassi). */
function enclosingFunction(text: string, caret: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) {
        const m = /([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9.]*)$/.exec(text.slice(0, i));
        return m ? m[1].toUpperCase() : null;
      }
      depth--;
    }
  }
  return null;
}

export class FormulaAssist {
  readonly el = h("div", { class: "fx-assist", role: "listbox", hidden: true });
  private items: string[] = [];
  private selected = 0;
  private field: Field | null = null;
  private range: { start: number; end: number } | null = null;

  constructor(private onAccept: (field: Field) => void) {
    this.el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const li = (e.target as Element).closest<HTMLElement>("[data-i]");
      if (li) { this.selected = Number(li.dataset.i); this.accept(); }
    });
  }

  get open(): boolean {
    return !this.el.hidden && this.items.length > 0;
  }

  hide(): void {
    this.el.hidden = true;
    this.items = [];
  }

  /** Da chiamare a ogni modifica del testo o spostamento del cursore. */
  update(field: Field, anchor: DOMRect): void {
    this.field = field;
    const caret = field.selectionStart ?? field.value.length;
    const tok = tokenBefore(field.value, caret);
    this.items = [];
    if (tok) {
      const t = tok.token.toUpperCase();
      this.items = functionNames().filter((n) => n.startsWith(t) && n !== t).slice(0, 8);
      this.range = { start: tok.start, end: caret };
    }
    this.selected = 0;
    const fn = this.items.length ? null : enclosingFunction(field.value, caret);
    const help = fn ? functionHelp(fn) : undefined;
    if (!this.items.length && !help) { this.hide(); return; }

    if (this.items.length) {
      this.el.replaceChildren(...this.items.map((name, i) => {
        const info = functionHelp(name);
        return h("div", { class: "fx-item", role: "option", "data-i": String(i), "aria-selected": String(i === 0) },
          h("span", { class: "fx-name" }, name),
          info ? h("span", { class: "fx-desc" }, info[1]) : null);
      }));
    } else if (help) {
      this.el.replaceChildren(h("div", { class: "fx-signature" }, h("code", {}, help[0]), h("span", {}, help[1])));
    }
    this.el.hidden = false;
    // Sotto il campo, ma senza uscire dalla finestra.
    const top = anchor.bottom + 4;
    const left = Math.min(anchor.left, window.innerWidth - 420);
    Object.assign(this.el.style, { left: `${Math.max(8, left)}px`, top: `${top}px` });
  }

  /** Gestisce i tasti mentre la lista è aperta. Restituisce true se il tasto è stato usato. */
  key(e: KeyboardEvent): boolean {
    if (!this.open) {
      if (e.key === "Escape" && !this.el.hidden) { this.hide(); }
      return false;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.selected = (this.selected + (e.key === "ArrowDown" ? 1 : -1) + this.items.length) % this.items.length;
      this.el.querySelectorAll(".fx-item").forEach((el, i) => el.setAttribute("aria-selected", String(i === this.selected)));
      return true;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.altKey)) {
      e.preventDefault();
      this.accept();
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this.hide();
      return true;
    }
    return false;
  }

  private accept(): void {
    const f = this.field, r = this.range, name = this.items[this.selected];
    if (!f || !r || !name) return;
    const text = `${name}(`;
    f.value = f.value.slice(0, r.start) + text + f.value.slice(r.end);
    const caret = r.start + text.length;
    f.setSelectionRange(caret, caret);
    this.hide();
    this.onAccept(f);
  }
}
