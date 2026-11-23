// Funzionalità enterprise per fogli di calcolo: formattazione condizionale, convalida dati,
// note sulle celle, rimuovi duplicati, testo in colonne, stili tabella e subtotali.
import type { Model } from "./engine";

export interface CellRange { r0: number; c0: number; r1: number; c1: number }

export type CondKind = "gt" | "lt" | "eq" | "contains" | "duplicates" | "databar" | "colorscale";

export interface CondRule {
  sheet: number;
  range: CellRange;
  kind: CondKind;
  value?: string;
  bg?: string;
  fg?: string;
}

export interface ValidationRule {
  kind: "list" | "number";
  options?: string[];
  min?: number;
  max?: number;
}

function parseNum(s: string): number | null {
  if (!s.trim()) return null;
  const cleaned = s.replace(/[€$£%\s]/g, "").replace(/\.(?=\d{3}(?:[,\s]|$))/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function evalCondFormat(
  model: Model,
  rules: CondRule[],
  sheet: number,
  r: number,
  c: number,
): { bg?: string; fg?: string; bar?: { pct: number; color: string } } | null {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule.sheet !== sheet) continue;
    const { r0, c0, r1, c1 } = rule.range;
    if (r < r0 || r > r1 || c < c0 || c > c1) continue;
    const raw = model.getFormattedCellValue(sheet, r, c);
    if (!raw.trim()) continue;
    const n = parseNum(raw);

    if (rule.kind === "gt" && n !== null && rule.value !== undefined) {
      const target = parseNum(rule.value);
      if (target !== null && n > target) return { bg: rule.bg ?? "#dcfce7", fg: rule.fg ?? "#166534" };
    } else if (rule.kind === "lt" && n !== null && rule.value !== undefined) {
      const target = parseNum(rule.value);
      if (target !== null && n < target) return { bg: rule.bg ?? "#fee2e2", fg: rule.fg ?? "#991b1b" };
    } else if (rule.kind === "eq" && rule.value !== undefined) {
      if (raw.trim().toLowerCase() === rule.value.trim().toLowerCase()) return { bg: rule.bg ?? "#fef3c7", fg: rule.fg ?? "#92400e" };
    } else if (rule.kind === "contains" && rule.value) {
      if (raw.toLowerCase().includes(rule.value.toLowerCase())) return { bg: rule.bg ?? "#dbeafe", fg: rule.fg ?? "#1e40af" };
    } else if (rule.kind === "duplicates") {
      let count = 0;
      const key = raw.trim().toLowerCase();
      for (let rr = r0; rr <= Math.min(r1, r0 + 500); rr++) {
        for (let cc = c0; cc <= Math.min(c1, c0 + 40); cc++) {
          if (model.getFormattedCellValue(sheet, rr, cc).trim().toLowerCase() === key) count++;
          if (count > 1) return { bg: "#fee2e2", fg: "#991b1b" };
        }
      }
    } else if ((rule.kind === "databar" || rule.kind === "colorscale") && n !== null) {
      let min = Infinity, max = -Infinity;
      for (let rr = r0; rr <= Math.min(r1, r0 + 500); rr++) {
        for (let cc = c0; cc <= Math.min(c1, c0 + 40); cc++) {
          const v = parseNum(model.getFormattedCellValue(sheet, rr, cc));
          if (v !== null) { if (v < min) min = v; if (v > max) max = v; }
        }
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
      const pct = max === min ? 1 : Math.max(0, Math.min(1, (n - min) / (max - min)));
      if (rule.kind === "databar") return { bar: { pct, color: "#93c5fd" } };
      // Scala verde-giallo-rosso
      const red = pct < 0.5 ? 248 : Math.round(248 - (pct - 0.5) * 2 * (248 - 134));
      const grn = pct < 0.5 ? Math.round(113 + pct * 2 * (222 - 113)) : 239;
      const blu = pct < 0.5 ? 113 : Math.round(113 + (pct - 0.5) * 2 * (172 - 113));
      return { bg: `rgb(${red},${grn},${blu})` };
    }
  }
  return null;
}

/** Rimuove le righe duplicate nell'intervallo e restituisce il numero di righe eliminate. */
export function removeDuplicateRows(model: Model, sheet: number, range: CellRange): number {
  const { r0, c0, r1, c1 } = range;
  const seen = new Set<string>();
  const kept: string[][] = [];
  let removed = 0;
  for (let r = r0; r <= r1; r++) {
    const vals: string[] = [];
    const raw: string[] = [];
    for (let c = c0; c <= c1; c++) {
      vals.push(model.getFormattedCellValue(sheet, r, c).trim());
      raw.push(model.getCellContent(sheet, r, c));
    }
    if (vals.every((v) => !v)) continue;
    const key = vals.join("\u001f");
    if (seen.has(key)) { removed++; continue; }
    seen.add(key);
    kept.push(raw);
  }
  if (!removed) return 0;
  for (let r = r0; r <= r1; r++) {
    const row = kept[r - r0];
    for (let c = c0; c <= c1; c++) {
      const next = row ? row[c - c0] : "";
      model.setUserInput(sheet, r, c, next || "");
    }
  }
  model.evaluate();
  return removed;
}

/** Divide il testo della prima colonna selezionata in più colonne usando un separatore. */
export function splitTextToColumns(model: Model, sheet: number, range: CellRange, delimiter: string): number {
  let affected = 0;
  for (let r = range.r0; r <= range.r1; r++) {
    const val = model.getFormattedCellValue(sheet, r, range.c0);
    if (!val || !val.includes(delimiter)) continue;
    const parts = val.split(delimiter);
    parts.forEach((p, idx) => {
      model.setUserInput(sheet, r, range.c0 + idx, p.trim());
    });
    affected++;
  }
  if (affected) model.evaluate();
  return affected;
}

/** Applica stile tabella (intestazione colorata, righe alternate e bordi leggeri). */
export function formatRangeAsTable(model: Model, sheet: number, range: CellRange, accentHex = "#1F4E79", stripeHex = "#EDF2F8"): void {
  const { r0, c0, r1, c1 } = range;
  const w = c1 - c0 + 1;
  model.updateRangeStyle({ sheet, row: r0, column: c0, width: w, height: 1 }, "fill.color", accentHex);
  model.updateRangeStyle({ sheet, row: r0, column: c0, width: w, height: 1 }, "font.color", "#FFFFFF");
  model.updateRangeStyle({ sheet, row: r0, column: c0, width: w, height: 1 }, "font.b", "true");
  for (let r = r0 + 1; r <= r1; r++) {
    const bg = (r - r0) % 2 === 0 ? stripeHex : "#FFFFFF";
    model.updateRangeStyle({ sheet, row: r, column: c0, width: w, height: 1 }, "fill.color", bg);
  }
}

export const CELL_STYLE_PRESETS: Record<string, { label: string; bg?: string; fg?: string; bold?: boolean; italic?: boolean; size?: string }> = {
  good: { label: "Buono", bg: "#DCFCE7", fg: "#166534" },
  bad: { label: "Errore / Negativo", bg: "#FEE2E2", fg: "#991B1B" },
  neutral: { label: "Neutro / Attenzione", bg: "#FEF3C7", fg: "#92400E" },
  heading: { label: "Intestazione", bg: "#E2E8F0", fg: "#0F172A", bold: true },
  total: { label: "Totale", bg: "#F1F5F9", fg: "#0F172A", bold: true },
  note: { label: "Nota", bg: "#FFFBEB", fg: "#78350F", italic: true },
};
