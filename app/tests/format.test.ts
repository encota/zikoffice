// Test delle funzioni di formato. Si eseguono con: npm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { changeDecimals, formatCode, formatLabel, parseDisplayedNumber, shiftFormulaRows } from "../src/sheet/format";

test("le formule si spostano con la riga (riferimenti relativi)", () => {
  const cases: [string, number, string][] = [
    ["=B3*C3", -1, "=B2*C2"],
    ["=$B$3*C3", -1, "=$B$3*C2"],
    ["=B$3+$C3", 2, "=B$3+$C5"],
    ["=SOMMA(A1:A10)", 5, "=SOMMA(A6:A15)"],
    ['=SE(A1>1;"A1 B2";A2)', 1, '=SE(A2>1;"A1 B2";A3)'],
    ["=LOG10(A1)", 1, "=LOG10(A2)"],
    ["=Foglio2!A1+'Mio foglio'!B2", 1, "=Foglio2!A2+'Mio foglio'!B3"],
    ["=A1", -5, "=#RIF!"],
    ["ciao A1", 3, "ciao A1"],
    ['=""""&A1', 1, '=""""&A2'],
    ["=CERCA.VERT(A2;$F$1:$G$9;2;FALSO)", 3, "=CERCA.VERT(A5;$F$1:$G$9;2;FALSO)"],
  ];
  for (const [formula, delta, expected] of cases) assert.equal(shiftFormulaRows(formula, delta), expected, formula);
});

test("aumenta e riduce i decimali", () => {
  assert.equal(changeDecimals("general", 1), "0.0");
  assert.equal(changeDecimals("#,##0.00", 1), "#,##0.000");
  assert.equal(changeDecimals("#,##0.00", -1), "#,##0.0");
  assert.equal(changeDecimals("#,##0.0", -1), "#,##0");
  assert.equal(changeDecimals('#,##0.00 "€"', -1), '#,##0.0 "€"');
  assert.equal(changeDecimals("0.00%", 1), "0.000%");
});

test("legge i numeri mostrati all'italiana", () => {
  assert.equal(parseDisplayedNumber("1.234,50 €"), 1234.5);
  assert.equal(parseDisplayedNumber("12%"), 0.12);
  assert.equal(parseDisplayedNumber("-3,5"), -3.5);
  assert.equal(parseDisplayedNumber("Mele"), null);
  assert.equal(parseDisplayedNumber("20/11/2026"), null);
});

test("nomi dei formati numerici", () => {
  assert.equal(formatLabel("general"), "Generale");
  assert.equal(formatLabel("0.00%"), "Percentuale");
  assert.equal(formatLabel("0.000"), "Personalizzato");
  assert.equal(formatCode("Valuta"), '#,##0.00 "€"');
});
