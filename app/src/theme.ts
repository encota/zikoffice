// Tema chiaro/scuro: "system" segue l'impostazione del desktop (GNOME, KDE...).
export type ThemeMode = "system" | "light" | "dark";

const KEY = "zikoffice.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
let mode: ThemeMode = load();
const listeners = new Set<() => void>();

function load(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch { /* storage non disponibile: usiamo il default */ }
  return "system";
}

export function resolvedTheme(): "light" | "dark" {
  return mode === "system" ? (media.matches ? "dark" : "light") : mode;
}

function apply(): void {
  document.documentElement.dataset.theme = resolvedTheme();
  listeners.forEach((fn) => fn());
}

export function themeMode(): ThemeMode {
  return mode;
}

export function setTheme(next: ThemeMode): void {
  mode = next;
  try { localStorage.setItem(KEY, next); } catch { /* ignora */ }
  apply();
}

export function cycleTheme(): ThemeMode {
  const order: ThemeMode[] = ["system", "light", "dark"];
  setTheme(order[(order.indexOf(mode) + 1) % order.length]);
  return mode;
}

/** Chiamato quando il tema effettivo cambia (utile per ridisegnare i canvas). */
export function onThemeChange(fn: () => void): void {
  listeners.add(fn);
}

media.addEventListener("change", () => { if (mode === "system") apply(); });
apply();
