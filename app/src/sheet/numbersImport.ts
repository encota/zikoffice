// Importazione di un file Numbers (.numbers): ogni tabella diventa un foglio di calcolo.
// Si importano i valori mostrati (le formule di Numbers non vengono tradotte).
import { all, first, str } from "../doc/iwork/iwa";
import { Pkg } from "../doc/iwork/pkg";
import { cellPlain, scanTable } from "../doc/iwork/tables";
import { newModel, type Model } from "./engine";

import { t as tl } from "../i18n";
function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Foglio";
  let candidate = base, n = 2;
  while (used.has(candidate.toLowerCase())) { const suffix = ` (${n++})`; candidate = base.slice(0, 31 - suffix.length) + suffix; }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Elenca le tabelle con il nome del foglio di Numbers a cui appartengono. */
function listTables(pkg: Pkg): { sheet: string; table: number }[] {
  const out: { sheet: string; table: number }[] = [];
  const seen = new Set<number>();
  for (const sheetId of pkg.allOfType(2)) {
    const fs = pkg.f(sheetId);
    const sheetName = str(first(fs, 1));
    for (const f of all(fs, 2)) {
      const id = pkg.refId(f);
      if (id !== undefined && pkg.type(id) === 6000 && !seen.has(id)) { seen.add(id); out.push({ sheet: sheetName, table: id }); }
    }
  }
  for (const id of pkg.allOfType(6000)) if (!seen.has(id)) { seen.add(id); out.push({ sheet: "", table: id }); }
  return out;
}

/** Costruisce la cartella di lavoro e ne restituisce i byte nel formato del motore di calcolo. */
export function importNumbers(bytes: Uint8Array): Uint8Array {
  const pkg = Pkg.open(bytes);
  const tables = listTables(pkg);
  if (!tables.length) throw new Error("Il file Numbers non contiene tabelle leggibili");
  const perSheet = new Map<string, number>();
  for (const t of tables) perSheet.set(t.sheet, (perSheet.get(t.sheet) ?? 0) + 1);

  const model: Model = newModel("Numbers");
  const used = new Set<string>();
  let index = 0;
  for (const t of tables) {
    const scan = scanTable(pkg, t.table);
    if (!scan) continue;
    if (index > 0) model.newSheet();
    const name = perSheet.get(t.sheet)! > 1 || !t.sheet ? [t.sheet, scan.name].filter(Boolean).join(" - ") || tl("Tabella {0}", index + 1) : t.sheet;
    try { model.renameSheet(index, safeSheetName(name, used)); } catch { /* nome predefinito */ }
    for (let r = 0; r < scan.rows; r++) {
      for (let c = 0; c < scan.cols; c++) {
        const cell = cellPlain(pkg, scan, scan.cells[r][c]);
        if (cell.kind === "empty" || !cell.text) continue;
        // I testi che iniziano con "=" non devono diventare formule.
        const text = cell.kind === "text" && /^[=+@-]/.test(cell.text) ? `'${cell.text}` : cell.text;
        model.setUserInput(index, r + 1, c + 1, text);
      }
    }
    index++;
  }
  model.evaluate();
  return model.toBytes();
}

