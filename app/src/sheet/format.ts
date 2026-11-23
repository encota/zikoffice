// Formati numerici e font: corrispondenze tra nomi mostrati, codici Excel e font Linux.

/** Formati del menu "Numeri", con il codice Excel corrispondente. */
export const NUMBER_FORMATS: [label: string, code: string][] = [
  ["Generale", "general"],
  ["Numero", "#,##0.00"],
  ["Valuta", '#,##0.00 "€"'],
  ["Contabilità", '_-#,##0.00 "€"_-;-#,##0.00 "€"_-;_-"-"?? "€"_-;_-@_-'],
  ["Data breve", "dd/mm/yyyy"],
  ["Data estesa", "dddd d mmmm yyyy"],
  ["Ora", "hh:mm:ss"],
  ["Percentuale", "0.00%"],
  ["Frazione", "# ?/?"],
  ["Scientifico", "0.00E+00"],
  ["Testo", "@"],
];

export function formatLabel(code: string): string {
  const found = NUMBER_FORMATS.find(([, c]) => c.toLowerCase() === code.toLowerCase());
  return found ? found[0] : "Personalizzato";
}

export function formatCode(label: string): string | undefined {
  return NUMBER_FORMATS.find(([l]) => l === label)?.[1];
}

/** Aggiunge o toglie una cifra decimale a ogni sezione di un formato. */
export function changeDecimals(code: string, delta: 1 | -1): string {
  if (code.toLowerCase() === "general") return delta > 0 ? "0.0" : "0";
  return code.split(";").map((section) => {
    // Lavora sulla prima sequenza numerica della sezione (es. "#,##0.00").
    return section.replace(/([#0?,]*0)(\.0*)?/, (_m, int: string, dec: string | undefined) => {
      const places = dec ? dec.length - 1 : 0;
      const next = Math.max(0, places + delta);
      return next === 0 ? int : `${int}.${"0".repeat(next)}`;
    });
  }).join(";");
}

// Font di Office sostituiti dai loro equivalenti metrici liberi: il testo occupa
// esattamente lo stesso spazio, quindi colonne e a-capo restano identici a Excel.
const FONT_ALIASES: Record<string, string> = {
  calibri: '"Carlito", "Calibri"',
  "calibri light": '"Carlito", "Calibri Light", "Calibri"',
  aptos: '"Carlito", "Aptos"',
  "segoe ui": '"Noto Sans", "Segoe UI"',
  georgia: '"Caladea", "Georgia"',
  verdana: '"DejaVu Sans", "Verdana"',
  symbol: '"Carlito"',
  cambria: '"Caladea", "Cambria"',
  arial: '"Liberation Sans", "Arial"',
  "times new roman": '"Liberation Serif", "Times New Roman"',
  "courier new": '"Liberation Mono", "Courier New"',
  consolas: '"Liberation Mono", "DejaVu Sans Mono", "Consolas", monospace',
  monospace: '"Liberation Mono", "DejaVu Sans Mono", monospace',
  helvetica: '"Liberation Sans", "Helvetica"',
  inter: '"Inter", "Carlito"',
};

export function cssFontFamily(name: string | undefined): string {
  const n = (name ?? "").trim();
  const alias = FONT_ALIASES[n.toLowerCase()];
  return `${alias ?? `"${n}"`}, "Carlito", "Liberation Sans", sans-serif`;
}

export const SHEET_FONTS = [
  "Calibri", "Cambria", "Arial", "Times New Roman", "Courier New", "Inter",
  "Noto Sans", "Noto Serif", "DejaVu Sans", "Ubuntu",
];

/**
 * Converte un valore mostrato (formattato all'italiana) in numero,
 * per somma e media nella barra di stato. Es. "1.234,50 €" → 1234.5, "12%" → 0.12.
 */
export function parseDisplayedNumber(text: string): number | null {
  let t = text.trim().replace(/[€$£\s ]/g, "");
  const percent = t.endsWith("%");
  if (percent) t = t.slice(0, -1);
  if (!/^[-+]?[\d.]*,?\d+(E[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return percent ? n / 100 : n;
}

/**
 * Sposta di `delta` righe i riferimenti relativi di una formula (A1 → A3 con delta 2;
 * $A$1 e A$1 restano fermi), come fa Excel quando una formula si sposta con la sua riga.
 * Ignora testi tra virgolette e nomi di funzione (es. LOG10(…)).
 */
export function shiftFormulaRows(formula: string, delta: number): string {
  if (!formula.startsWith("=") || delta === 0) return formula;
  let out = "";
  let i = 0;
  const ref = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\w(.])/;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"') {
      // stringa: copia fino alla virgoletta di chiusura ("" è una virgoletta escapata)
      let j = i + 1;
      while (j < formula.length && !(formula[j] === '"' && formula[j + 1] !== '"')) j += formula[j] === '"' ? 2 : 1;
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      // nome di foglio tra apici: copia così com'è
      const j = formula.indexOf("'", i + 1);
      out += formula.slice(i, j < 0 ? undefined : j + 1);
      i = j < 0 ? formula.length : j + 1;
      continue;
    }
    const prev = formula[i - 1] ?? "";
    if (/[A-Za-z$]/.test(ch) && !/[\w.$]/.test(prev)) {
      const m = ref.exec(formula.slice(i));
      if (m) {
        const [all, colAbs, col, rowAbs, row] = m;
        const n = rowAbs ? Number(row) : Number(row) + delta;
        out += n >= 1 && n <= 1_048_576 ? `${colAbs}${col}${rowAbs}${n}` : "#RIF!";
        i += all.length;
        continue;
      }
      // altra parola (funzione, nome, foglio): copiala per intero
      const word = /^[\w.$]+/.exec(formula.slice(i))![0];
      out += word;
      i += word.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
