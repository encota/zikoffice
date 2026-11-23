// Generatore di Tabelle Pivot: raggruppa per colonna, aggrega valori numerici e scrive un nuovo foglio formattato.
import type { Model } from "./engine";
import { formatRangeAsTable, type CellRange } from "./enterprise";
import { fn } from "./functions";

export type PivotAgg = "sum" | "avg" | "count" | "min" | "max";

export const PIVOT_AGG_LABELS: Record<PivotAgg, string> = {
  sum: "Somma",
  avg: "Media",
  count: "Conteggio",
  min: "Minimo",
  max: "Massimo",
};

function parseNum(s: string): number | null {
  if (!s.trim()) return null;
  const cleaned = s.replace(/[€$£%\s]/g, "").replace(/\.(?=\d{3}(?:[,\s]|$))/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface PivotSummary {
  groupHeader: string;
  valueHeader: string;
  rows: { key: string; value: number; count: number }[];
  total: number;
}

export function computePivot(
  model: Model,
  sheet: number,
  range: CellRange,
  groupColOffset: number,
  valueColOffset: number,
  agg: PivotAgg,
): PivotSummary {
  const { r0, c0, r1 } = range;
  const gCol = c0 + groupColOffset;
  const vCol = c0 + valueColOffset;
  const groupHeader = model.getFormattedCellValue(sheet, r0, gCol).trim() || "Categoria";
  const valueHeader = model.getFormattedCellValue(sheet, r0, vCol).trim() || "Valore";

  const buckets = new Map<string, number[]>();
  for (let r = r0 + 1; r <= r1; r++) {
    const key = model.getFormattedCellValue(sheet, r, gCol).trim() || "(Vuoto)";
    const rawVal = model.getFormattedCellValue(sheet, r, vCol);
    const num = parseNum(rawVal);
    if (!buckets.has(key)) buckets.set(key, []);
    if (agg === "count") {
      if (rawVal.trim() !== "") buckets.get(key)!.push(1);
    } else if (num !== null) {
      buckets.get(key)!.push(num);
    }
  }

  const calc = (arr: number[]): number => {
    if (!arr.length) return 0;
    switch (agg) {
      case "sum": return arr.reduce((a, b) => a + b, 0);
      case "avg": return arr.reduce((a, b) => a + b, 0) / arr.length;
      case "count": return arr.length;
      case "min": return Math.min(...arr);
      case "max": return Math.max(...arr);
    }
  };

  const rows = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "it"))
    .map(([key, arr]) => ({ key, value: calc(arr), count: arr.length }));
  const allNums = [...buckets.values()].flat();
  const total = calc(allNums);
  return { groupHeader, valueHeader, rows, total };
}

/** Crea un nuovo foglio "Pivot" con i risultati aggregati e formattati. Restituisce l'indice del nuovo foglio. */
export function createPivotSheet(
  model: Model,
  sheet: number,
  range: CellRange,
  groupColOffset: number,
  valueColOffset: number,
  agg: PivotAgg,
): number {
  const summary = computePivot(model, sheet, range, groupColOffset, valueColOffset, agg);
  model.newSheet();
  const sheets = model.getWorksheetsProperties();
  const newIdx = sheets.length - 1;
  const baseName = "Pivot";
  let name = baseName;
  let k = 2;
  while (sheets.some((s) => s.name === name)) name = `${baseName} ${k++}`;
  try { model.renameSheet(newIdx, name); } catch { /* mantieni nome predefinito */ }

  model.setUserInput(newIdx, 1, 1, summary.groupHeader);
  model.setUserInput(newIdx, 1, 2, `${PIVOT_AGG_LABELS[agg]} di ${summary.valueHeader}`);
  summary.rows.forEach((row, i) => {
    const r = i + 2;
    model.setUserInput(newIdx, r, 1, row.key);
    model.setUserInput(newIdx, r, 2, String(Math.round(row.value * 10000) / 10000).replace(".", ","));
  });
  const totalRow = summary.rows.length + 2;
  model.setUserInput(newIdx, totalRow, 1, "Totale complessivo");
  const formulaFn = fn(agg === "sum" ? "SOMMA" : agg === "avg" ? "MEDIA" : agg === "count" ? "SOMMA" : agg === "min" ? "MIN" : "MAX");
  if (summary.rows.length > 0) {
    model.setUserInput(newIdx, totalRow, 2, `=${formulaFn}(B2:B${totalRow - 1})`);
  } else {
    model.setUserInput(newIdx, totalRow, 2, "0");
  }
  model.evaluate();
  formatRangeAsTable(model, newIdx, { r0: 1, c0: 1, r1: totalRow - 1, c1: 2 }, "#1F4E79", "#EDF2F8");
  model.updateRangeStyle({ sheet: newIdx, row: totalRow, column: 1, width: 2, height: 1 }, "font.b", "true");
  model.updateRangeStyle({ sheet: newIdx, row: totalRow, column: 1, width: 2, height: 1 }, "fill.color", "#E2E8F0");
  return newIdx;
}
