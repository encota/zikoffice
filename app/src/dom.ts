// Piccolo helper per creare elementi DOM in modo leggibile, senza framework.
// I testi passano da qui: sono tradotti nella lingua scelta (vedi i18n/).
import { tr, trKeys } from "./i18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (e: any) => void;
type Attrs = Record<string, string | number | boolean | Handler | undefined>;
type Child = Node | string | null | undefined | false;

/** Attributi che contengono testo per l'utente. */
const TEXT_ATTRS = new Set(["title", "placeholder", "aria-label", "alt", "label"]);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else if (typeof value === "string" && TEXT_ATTRS.has(key)) {
      el.setAttribute(key, trKeys(tr(value)));
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? (tag === "kbd" ? trKeys(child) : tr(child)) : child);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

let toastTimer: number | undefined;

/** Messaggio breve in basso a destra. */
export function toast(message: string): void {
  let el = document.querySelector<HTMLElement>(".toast");
  if (!el) {
    el = h("div", { class: "toast", role: "status" });
    document.body.append(el);
  }
  el.textContent = tr(message);
  el.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("visible"), 2200);
}
