// Menu a comparsa (ribbon, tasto destro) e tavolozza dei colori.
import { h } from "../dom";
import { icon, type IconName } from "../icons";

export type MenuItem =
  | { label: string; icon?: IconName; shortcut?: string; checked?: boolean; disabled?: boolean; action: () => void }
  | { separator: true }
  | { heading: string }
  | { colors: (color: string | null) => void; noneLabel: string }
  | { element: HTMLElement };

let current: { el: HTMLElement; restore: Element | null; cleanup: () => void } | null = null;

export function closeMenu(): void {
  if (!current) return;
  const { el, restore, cleanup } = current;
  current = null;
  cleanup();
  el.remove();
  if (restore instanceof HTMLElement) restore.focus();
}

/** Apre un menu sotto un elemento oppure in un punto (tasto destro). */
export function openMenu(at: HTMLElement | { x: number; y: number }, items: MenuItem[]): void {
  closeMenu();
  const restore = document.activeElement;
  const el = h("div", { class: "menu", role: "menu" });
  const buttons: HTMLButtonElement[] = [];

  for (const item of items) {
    if ("separator" in item) { el.append(h("div", { class: "menu-sep", role: "separator" })); continue; }
    if ("heading" in item) { el.append(h("div", { class: "menu-heading" }, item.heading)); continue; }
    if ("colors" in item) { el.append(colorGrid(item.colors, item.noneLabel)); continue; }
    if ("element" in item) { el.append(item.element); continue; }
    const btn = h("button", {
      class: "menu-item", role: "menuitem", disabled: item.disabled,
      onclick: () => { closeMenu(); item.action(); },
    },
      h("span", { class: "menu-icon" }, item.checked ? icon("Check", 14) : item.icon ? icon(item.icon, 16) : null),
      h("span", { class: "menu-label" }, item.label),
      item.shortcut ? h("kbd", {}, item.shortcut) : null);
    if (item.checked) btn.classList.add("checked");
    buttons.push(btn);
    el.append(btn);
  }

  document.body.append(el);
  const r = el.getBoundingClientRect();
  let x: number, y: number;
  if (at instanceof HTMLElement) {
    const a = at.getBoundingClientRect();
    x = a.left; y = a.bottom + 2;
    if (y + r.height > innerHeight - 8) y = Math.max(8, a.top - r.height - 2);
  } else {
    ({ x, y } = at);
    if (y + r.height > innerHeight - 8) y = Math.max(8, y - r.height);
  }
  x = Math.max(8, Math.min(x, innerWidth - r.width - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  const onDown = (e: Event) => { if (!el.contains(e.target as Node)) closeMenu(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const enabled = buttons.filter((b) => !b.disabled);
      const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (i + 1) % enabled.length : (i - 1 + enabled.length) % enabled.length;
      enabled[next]?.focus();
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", onDown, true));
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeMenu);
  current = {
    el, restore,
    cleanup: () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", closeMenu);
    },
  };
  (buttons.find((b) => !b.disabled) ?? el.querySelector<HTMLElement>(".swatch"))?.focus({ preventScroll: true });
}

// Tavolozza in stile Office: una riga di colori base, sfumature, colori standard.
const BASE = ["#ffffff", "#000000", "#e7e6e6", "#44546a", "#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"];
const STANDARD = ["#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050", "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0"];

function mix(hex: string, target: number, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (target - v) * amount));
  return `#${ch.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function colorGrid(pick: (c: string | null) => void, noneLabel: string): HTMLElement {
  const swatch = (c: string) => h("button", {
    class: "swatch", title: c, style: `background:${c}`,
    onclick: () => { closeMenu(); pick(c); },
  });
  const shades = [0.8, 0.6, 0.4].map((a) => BASE.map((c) => mix(c, c === "#ffffff" ? 0 : 255, c === "#ffffff" ? 1 - a : a)))
    .concat([0.25, 0.5].map((a) => BASE.map((c) => mix(c, c === "#000000" ? 255 : 0, c === "#000000" ? 1 - a : a))));
  return h("div", { class: "color-picker" },
    h("button", { class: "menu-item", onclick: () => { closeMenu(); pick(null); } },
      h("span", { class: "menu-icon" }, icon("SquareDashed", 16)), h("span", { class: "menu-label" }, noneLabel)),
    h("div", { class: "menu-heading" }, "Colori tema"),
    h("div", { class: "swatches" }, ...BASE.map(swatch)),
    h("div", { class: "swatches shades" }, ...shades.flat().map(swatch)),
    h("div", { class: "menu-heading" }, "Colori standard"),
    h("div", { class: "swatches" }, ...STANDARD.map(swatch)));
}
