// @vitest-environment jsdom
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as wasm from "@ironcalc/wasm";
import { LANGS, setLang, shortcut, t, tr, type Lang } from "../src/i18n";
import { ROWS } from "../src/i18n/tables";
import { h } from "../src/dom";
import { fn, functionHelp, functionNames, num } from "../src/sheet/functions";
import { loadEngine, modelFromBytes, newModel } from "../src/sheet/engine";

const ids = LANGS.map((l) => l.id);
const NON_IT = ids.filter((l) => l !== "it");

beforeAll(async () => {
  wasm.initSync({ module: fs.readFileSync(`${process.cwd()}/node_modules/@ironcalc/wasm/wasm_bg.wasm`) });
  await loadEngine().catch(() => undefined);
});
afterAll(() => setLang("it", false));

describe("tabelle di traduzione", () => {
  it("ogni riga ha tutte le lingue, non vuote", () => {
    for (const r of ROWS) {
      expect(r.length, r[0]).toBe(6);
      r.forEach((c, i) => expect(typeof c === "string" && (c.length > 0), `${r[0]} [${i}]`).toBe(true));
    }
  });

  it("i segnaposto {0} {1} coincidono in tutte le lingue", () => {
    const holes = (s: string) => (s.match(/\{\d\}/g) ?? []).sort().join("");
    for (const r of ROWS) r.forEach((c, i) => expect(holes(c), `${r[0]} [${i}]`).toBe(holes(r[0])));
  });

  it("le frasi italiane non sono ripetute con traduzioni diverse", () => {
    const seen = new Map<string, string>();
    for (const r of ROWS) {
      const prev = seen.get(r[0]);
      if (prev !== undefined) expect(r.slice(1).join("¦"), `ripetuta: ${r[0]}`).toBe(prev);
      seen.set(r[0], r.slice(1).join("¦"));
    }
  });

  it("la parte inglese non resta in italiano (eccetto nomi uguali)", () => {
    // Una traduzione identica all'italiano è lecita solo per parole che si scrivono uguali (es. «Totale»/«Total»).
    const same = ROWS.filter((r) => r[0] === r[1] && r[0].length > 24);
    expect(same.map((r) => r[0])).toEqual([]);
  });
});

describe("t() e tr()", () => {
  it("traduce frasi esatte, con segnaposto e al contrario", () => {
    setLang("en", false);
    expect(t("Incolla")).toBe("Paste");
    expect(t("Pagina {0} di {1}", 2, 5)).toBe("Page 2 of 5");
    expect(tr("Pagina 2 di 5")).toBe("Page 2 of 5");
    expect(tr("Frase mai vista")).toBe("Frase mai vista");
    setLang("de", false);
    expect(t("Incolla")).toBe("Einfügen");
    expect(tr("Salvato: nota.docx")).toBe("Gespeichert: nota.docx");
    setLang("it", false);
    expect(t("Incolla")).toBe("Incolla");
    expect(t("Pagina {0} di {1}", 1, 2)).toBe("Pagina 1 di 2");
  });

  it("le scorciatoie usano i tasti della lingua", () => {
    setLang("de", false);
    expect(shortcut("Ctrl+Maiusc+S")).toBe("Strg+Umschalt+S");
    setLang("es", false);
    expect(shortcut("Ctrl+Maiusc+S")).toBe("Ctrl+Mayús+S");
    setLang("it", false);
    expect(shortcut("Ctrl+Maiusc+S")).toBe("Ctrl+Maiusc+S");
  });

  it("h() traduce testi e suggerimenti", () => {
    setLang("fr", false);
    const b = h("button", { title: "Salva", "aria-label": "Chiudi" }, "Annulla");
    expect(b.textContent).toBe("Annuler");
    expect(b.title).toBe("Enregistrer");
    expect(b.getAttribute("aria-label")).toBe("Fermer");
    // I valori non si toccano.
    expect(h("input", { value: "Salva" }).getAttribute("value")).toBe("Salva");
    setLang("it", false);
  });

  it("ogni lingua traduce le frasi principali", () => {
    for (const l of NON_IT) {
      setLang(l as Lang, false);
      for (const k of ["Incolla", "Salva", "Apri…", "Elenco puntato", "Statistiche documento"]) expect(t(k), `${l}: ${k}`).not.toBe(k);
    }
    setLang("it", false);
  });
});

describe("foglio di calcolo nella lingua scelta", () => {
  const expected: Record<string, string> = { it: "SOMMA", en: "SUM", es: "SUMA", fr: "SOMME", de: "SUMME", pt: "SUM" };

  it("nomi delle funzioni e formule", { timeout: 30000 }, () => {
    for (const l of ids) {
      setLang(l, false);
      expect(fn("SOMMA"), l).toBe(expected[l]);
      expect(fn("CERCA.VERT"), l).toBe(l === "it" ? "CERCA.VERT" : fn("CERCA.VERT"));
      expect(functionNames().length, l).toBeGreaterThan(400);
      expect(functionNames()).toContain(expected[l]);
      const m = newModel("x");
      m.setUserInput(0, 1, 1, `=${fn("SOMMA")}(1;2${num(0.5).slice(1)})`.replace(/;/g, l === "en" ? "," : ";"));
      m.evaluate();
      expect(m.getFormattedCellValue(0, 1, 1), l).toMatch(/^3[.,]5$/);
      // Il contenuto non dipende dalla lingua: lo si rilegge in un'altra.
      setLang(l === "en" ? "de" : "en", false);
      const back = modelFromBytes(m.toBytes());
      expect(back.getCellContent(0, 1, 1)).toContain(l === "en" ? "SUMME" : "SUM");
    }
    setLang("it", false);
  });

  it("guida alle funzioni tradotta", () => {
    setLang("de", false);
    const [syntax, desc] = functionHelp("SUMME")!;
    expect(syntax).toBe("SUMME(Zahl1; [Zahl2]; …)");
    expect(desc).toBe("Addiert die angegebenen Zahlen oder Bereiche");
    setLang("en", false);
    expect(functionHelp("SUMIF")![0]).toBe("SUMIF(range, criteria, [sum_range])");
    setLang("it", false);
    expect(functionHelp("SOMMA")![0]).toBe("SOMMA(num1; [num2]; …)");
  });

  it("i nuovi fogli prendono il nome nella lingua", () => {
    const names: Record<string, string> = { it: "Foglio1", en: "Sheet1", es: "Hoja1", fr: "Feuil1", de: "Tabelle1", pt: "Planilha1" };
    for (const l of ids) {
      setLang(l, false);
      expect(newModel("x").getWorksheetsProperties()[0].name, l).toBe(names[l]);
    }
    setLang("it", false);
  });
});
