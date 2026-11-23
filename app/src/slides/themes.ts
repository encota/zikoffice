// Temi delle presentazioni: pochi, semplici, e ognuno decide dove vanno titolo e contenuto.
import type { Theme } from "./model";

export const THEMES: Theme[] = [
  {
    id: "chiaro", name: "Chiaro", background: "#ffffff", text: "#2b2f36", title: "#1f3b63", accent: "#2f6fd6", accent2: "#e8833a",
    headingFont: "Calibri", bodyFont: "Calibri", decoration: "bar", titleSize: 40, bodySize: 24, titleAlign: "l",
  },
  {
    id: "scuro", name: "Scuro", background: "#1c2029", text: "#e6e9ef", title: "#ffffff", accent: "#3fb6d8", accent2: "#f0b429",
    headingFont: "Calibri", bodyFont: "Calibri", decoration: "bar", titleSize: 40, bodySize: 24, titleAlign: "l",
  },
  {
    id: "notte", name: "Blu notte", background: "#ffffff", titleBackground: "#17325c", text: "#28303c", title: "#17325c", titleSlideText: "#ffffff",
    accent: "#17325c", accent2: "#d4891a", headingFont: "Calibri", bodyFont: "Calibri", decoration: "band", titleSize: 36, bodySize: 22, titleAlign: "l",
  },
  {
    id: "carta", name: "Carta", background: "#faf6ef", text: "#3a3029", title: "#7a3b1d", accent: "#b5542c", accent2: "#5f7d4e",
    headingFont: "Cambria", bodyFont: "Calibri", decoration: "none", titleSize: 40, bodySize: 24, titleAlign: "ctr",
  },
  {
    id: "verde", name: "Verde", background: "#ffffff", text: "#26332b", title: "#1d5e3a", accent: "#2e8b57", accent2: "#c4a000",
    headingFont: "Calibri", bodyFont: "Calibri", decoration: "side", titleSize: 38, bodySize: 22, titleAlign: "l",
  },
  {
    id: "essenziale", name: "Essenziale", background: "#ffffff", text: "#111111", title: "#111111", accent: "#111111", accent2: "#d03030",
    headingFont: "Arial", bodyFont: "Arial", decoration: "frame", titleSize: 44, bodySize: 24, titleAlign: "l",
  },
];

export const DEFAULT_THEME = THEMES[0];

export function themeById(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** Contrasto sufficiente fra testo e sfondo (rapporto WCAG ≥ 3). */
export function readable(fg: string, bg: string): boolean {
  if (!/^#[0-9a-f]{6}$/i.test(fg) || !/^#[0-9a-f]{6}$/i.test(bg)) return true;
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05) >= 3;
}

/** Colore leggibile sopra uno sfondo (bianco o quasi nero). */
export function contrastOn(bg: string): string {
  const n = parseInt(bg.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 150 ? "#1c1c1c" : "#ffffff";
}
