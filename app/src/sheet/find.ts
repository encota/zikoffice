// Barra "Trova e sostituisci" (Ctrl+F / Ctrl+H).
import { h } from "../dom";
import { icon } from "../icons";

import { t } from "../i18n";
export interface FindOptions {
  query: string;
  matchCase: boolean;
  wholeCell: boolean;
}

export interface FindHost<T> {
  /** Risultati in ordine di lettura. */
  search(opts: FindOptions): T[];
  /** Indice del primo risultato dalla posizione corrente in poi. */
  startIndex(results: T[]): number;
  /** Vero se il risultato è quello selezionato ora (per "Sostituisci"). */
  isCurrent(item: T): boolean;
  goTo(item: T, all: T[]): void;
  /** Sostituisce nei risultati indicati; restituisce quante sostituzioni ha fatto. */
  replace(items: T[], opts: FindOptions, replacement: string): number;
  close(): void;
}

/** Applica la sostituzione a un testo (rispettando maiuscole e cella intera). */
export function replaceText(text: string, opts: FindOptions, replacement: string): string {
  if (opts.wholeCell) return matches(text, opts) ? replacement : text;
  const escaped = opts.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, opts.matchCase ? "g" : "gi"), () => replacement);
}

export function matches(text: string, opts: FindOptions): boolean {
  if (!opts.query) return false;
  const a = opts.matchCase ? text : text.toLocaleLowerCase("it");
  const q = opts.matchCase ? opts.query : opts.query.toLocaleLowerCase("it");
  return opts.wholeCell ? a === q : a.includes(q);
}

export class FindBar<T> {
  readonly el: HTMLElement;
  private input = h("input", { class: "find-input", placeholder: "Trova", spellcheck: "false", "aria-label": "Testo da cercare" });
  private replaceInput = h("input", { class: "find-input", placeholder: "Sostituisci con", spellcheck: "false", "aria-label": "Sostituisci con" });
  private count = h("span", { class: "find-count" });
  private matchCase = h("input", { type: "checkbox" });
  private wholeCell = h("input", { type: "checkbox" });
  private replaceRow: HTMLElement;
  private results: T[] = [];
  private index = -1;

  constructor(private host: FindHost<T>, wholeLabel = "Cella intera") {
    const btn = (label: string, iconName: Parameters<typeof icon>[0] | null, onclick: () => void, title = label) =>
      h("button", { class: iconName ? "icon-btn" : "find-btn", title, "aria-label": title, onclick }, iconName ? icon(iconName, 16) : label);
    this.replaceRow = h("div", { class: "find-row" },
      this.replaceInput,
      btn("Sostituisci", null, () => this.replaceOne()),
      btn("Sostituisci tutto", null, () => this.replaceAll()));
    this.el = h("div", { class: "find-bar", role: "search", hidden: true },
      h("div", { class: "find-row" },
        this.input, this.count,
        btn("", "ChevronUp", () => this.step(-1), "Precedente (Maiusc+Invio)"),
        btn("", "ChevronDown", () => this.step(1), "Successivo (Invio)"),
        btn("", "X", () => this.hide(), "Chiudi (Esc)")),
      this.replaceRow,
      h("div", { class: "find-options" },
        h("label", {}, this.matchCase, "Maiuscole/minuscole"),
        h("label", {}, this.wholeCell, wholeLabel)));

    this.input.addEventListener("input", () => this.refresh(true));
    for (const cb of [this.matchCase, this.wholeCell]) cb.addEventListener("change", () => this.refresh(true));
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); this.hide(); }
      else if (e.key === "Enter" && e.target === this.input) { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      else if (e.key === "Enter" && e.target === this.replaceInput) { e.preventDefault(); this.replaceOne(); }
      e.stopPropagation();
    };
    this.input.addEventListener("keydown", keys);
    this.replaceInput.addEventListener("keydown", keys);
    this.el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.hide(); } });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  show(withReplace: boolean, initial?: string): void {
    this.el.hidden = false;
    this.replaceRow.hidden = !withReplace;
    if (initial && !this.input.value) this.input.value = initial;
    this.input.focus();
    this.input.select();
    this.refresh(false);
  }

  hide(): void {
    this.el.hidden = true;
    this.host.close();
  }

  private options(): FindOptions {
    return { query: this.input.value, matchCase: this.matchCase.checked, wholeCell: this.wholeCell.checked };
  }

  /** Ricalcola i risultati; se `jump`, va al primo dopo la cella attiva. */
  refresh(jump: boolean): void {
    const opts = this.options();
    this.results = opts.query ? this.host.search(opts) : [];
    this.index = this.results.length ? Math.max(0, this.host.startIndex(this.results)) : -1;
    if (jump && this.index >= 0) this.host.goTo(this.results[this.index], this.results);
    this.updateCount();
  }

  private updateCount(): void {
    this.count.textContent = !this.input.value ? "" : this.results.length ? t("{0} di {1}", this.index + 1, this.results.length) : t("Nessun risultato");
    this.count.classList.toggle("none", !!this.input.value && !this.results.length);
  }

  private step(dir: number): void {
    if (!this.results.length) { this.refresh(true); return; }
    this.index = (this.index + dir + this.results.length) % this.results.length;
    this.host.goTo(this.results[this.index], this.results);
    this.updateCount();
  }

  private replaceOne(): void {
    const opts = this.options();
    if (!opts.query) return;
    // Se il risultato selezionato è quello corrente lo sostituisce, poi passa al successivo.
    const cur = this.results.find((r) => this.host.isCurrent(r));
    if (cur) this.host.replace([cur], opts, this.replaceInput.value);
    this.refresh(false);
    if (this.results.length) this.step(0);
    this.input.focus();
  }

  private replaceAll(): void {
    const opts = this.options();
    if (!opts.query) return;
    const n = this.host.replace(this.host.search(opts), opts, this.replaceInput.value);
    this.refresh(false);
    this.count.textContent = n === 1 ? t("1 sostituzione") : t("{0} sostituzioni", n);
    this.count.classList.toggle("none", n === 0);
  }
}
