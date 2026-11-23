// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { exportDocx } from "../src/doc/docxExport";
import { importDocx } from "../src/doc/docxImport";
import { parseCsvRecords, runMailMerge } from "../src/doc/mailMerge";
import { paragraphText, type Paragraph } from "../src/doc/model";
import { langLabel } from "../src/doc/spell";
import { newDocument } from "../src/doc/styles";
import { pageSvg } from "../src/print";
import { loadPrefs, savePrefs } from "../src/prefs";
import { renderChartSvg, type ChartSpec } from "../src/sheet/charts";
import { evalCondFormat, type CondRule } from "../src/sheet/enterprise";
import { computePivot } from "../src/sheet/pivot";
import { TEMPLATES } from "../src/templates";

/** Modello minimo per testare grafici e formattazione condizionale senza caricare WASM. */
function fakeModel(grid: string[][]) {
  return {
    getFormattedCellValue(_s: number, r: number, c: number) {
      return grid[r - 1]?.[c - 1] ?? "";
    },
  } as unknown as Parameters<typeof renderChartSvg>[0];
}

describe("Funzionalità Enterprise", () => {
  test("grafici SVG: colonne, linee e torta", () => {
    const m = fakeModel([
      ["Mese", "Entrate", "Uscite"],
      ["Gen", "1200", "800"],
      ["Feb", "1500", "900"],
      ["Mar", "1100", "700"],
    ]);
    for (const type of ["column", "line", "pie"] as const) {
      const spec: ChartSpec = { id: 1, sheet: 0, type, title: "Test", range: { r0: 1, c0: 1, r1: 4, c1: 3 }, x: 0, y: 0, w: 360, h: 220 };
      const svg = renderChartSvg(m, spec);
      expect(svg).toContain("<svg");
      expect(svg).toContain("Gen");
    }
  });

  test("formattazione condizionale: soglie, duplicati, barre dati e scala colori", () => {
    const m = fakeModel([["10"], ["50"], ["100"], ["50"]]);
    const rGt: CondRule[] = [{ sheet: 0, range: { r0: 1, c0: 1, r1: 4, c1: 1 }, kind: "gt", value: "60" }];
    expect(evalCondFormat(m, rGt, 0, 3, 1)?.bg).toBe("#dcfce7");
    expect(evalCondFormat(m, rGt, 0, 1, 1)).toBeNull();

    const rDup: CondRule[] = [{ sheet: 0, range: { r0: 1, c0: 1, r1: 4, c1: 1 }, kind: "duplicates" }];
    expect(evalCondFormat(m, rDup, 0, 2, 1)?.bg).toBe("#fee2e2");
    expect(evalCondFormat(m, rDup, 0, 1, 1)).toBeNull();

    const rBar: CondRule[] = [{ sheet: 0, range: { r0: 1, c0: 1, r1: 4, c1: 1 }, kind: "databar" }];
    expect(evalCondFormat(m, rBar, 0, 3, 1)?.bar?.pct).toBe(1);
    expect(evalCondFormat(m, rBar, 0, 1, 1)?.bar?.pct).toBe(0);

    const rScale: CondRule[] = [{ sheet: 0, range: { r0: 1, c0: 1, r1: 4, c1: 1 }, kind: "colorscale" }];
    expect(evalCondFormat(m, rScale, 0, 2, 1)?.bg).toMatch(/^rgb\(/);
  });

  test("commenti a margine: round-trip in word/comments.xml nel .docx", () => {
    const doc = newDocument();
    doc.blocks = [{ type: "p", id: 1, props: {}, runs: [{ text: "Clausola contrattuale.", props: {} }] }];
    doc.comments = [{ id: 1, author: "Marco", date: "2026-11-20T10:00:00Z", text: "Verificare scadenza", quote: "Clausola" }];
    const back = importDocx(exportDocx(doc));
    expect(back.comments?.length).toBe(1);
    expect(back.comments?.[0].author).toBe("Marco");
    expect(back.comments?.[0].text).toBe("Verificare scadenza");
  });

  test("modelli documento pronti all'uso e etichette lingue ortografia", () => {
    const docTemplates = TEMPLATES.filter((t) => t.kind === "doc");
    expect(docTemplates.length).toBeGreaterThanOrEqual(3);
    for (const t of docTemplates) {
      const d = t.create();
      expect("blocks" in d && d.blocks.length).toBeGreaterThan(2);
    }
    expect(langLabel("it_IT")).toBe("Italiano (Italia)");
    expect(langLabel("en_US")).toBe("English (US)");
  });

  test("tabella Pivot: raggruppa e aggrega (somma, media, conteggio)", () => {
    const m = fakeModel([
      ["Categoria", "Importo"],
      ["Affitto", "800"],
      ["Spesa", "120,50"],
      ["Spesa", "79,50"],
      ["Affitto", "800"],
    ]);
    const sum = computePivot(m, 0, { r0: 1, c0: 1, r1: 5, c1: 2 }, 0, 1, "sum");
    expect(sum.rows.map((r) => [r.key, r.value])).toEqual([["Affitto", 1600], ["Spesa", 200]]);
    expect(sum.total).toBe(1800);

    const avg = computePivot(m, 0, { r0: 1, c0: 1, r1: 5, c1: 2 }, 0, 1, "avg");
    expect(avg.rows.find((r) => r.key === "Spesa")?.value).toBe(100);
  });

  test("stampa unione (Mail Merge), filigrana SVG e preferenze persistenti", () => {
    const recs = parseCsvRecords("Nome;Importo\nMario Rossi;150 €\nLucia Bianchi;220 €");
    expect(recs.length).toBe(2);
    const tpl = newDocument();
    tpl.blocks = [{ type: "p", id: 1, props: {}, runs: [{ text: "Gentile {{Nome}}, totale {{Importo}}.", props: {} }] }];
    const merged = runMailMerge(tpl, recs);
    expect(merged.blocks.length).toBe(2);
    expect(paragraphText(merged.blocks[0] as Paragraph)).toBe("Gentile Mario Rossi, totale 150 €.");
    expect(paragraphText(merged.blocks[1] as Paragraph)).toBe("Gentile Lucia Bianchi, totale 220 €.");
    expect((merged.blocks[1] as Paragraph).props.pageBreakBefore).toBe(true);

    const svg = pageSvg({ index: 0, lines: [], fills: [], borders: [] }, 595, 842, "RISERVATO");
    expect(svg).toContain("RISERVATO");

    savePrefs({ defaultFont: "Carlito", defaultFontSize: 12, spellLang: "en_US", autoSaveMinutes: 5 });
    expect(loadPrefs().defaultFont).toBe("Carlito");
    expect(loadPrefs().defaultFontSize).toBe(12);
  });
});
