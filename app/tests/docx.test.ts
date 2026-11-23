// @vitest-environment jsdom
// Test di andata e ritorno .docx: esporta e reimporta un documento con tutte le funzioni principali.
import { describe, expect, test } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { exportDocx } from "../src/doc/docxExport";
import { importDocx } from "../src/doc/docxImport";
import { paragraphText, type Paragraph } from "../src/doc/model";
import * as ops from "../src/doc/ops";
import { newDocument } from "../src/doc/styles";

function sample() {
  const doc = newDocument();
  const p0 = doc.blocks[0] as Paragraph;
  ops.insertText(doc, { pid: p0.id, off: 0 }, "Relazione\nIntroduzione\nTesto con grassetto e un collegamento.\nprima\nseconda\nFine");
  const ps = doc.blocks as Paragraph[];
  const at = (i: number, off = 0) => ({ anchor: { pid: ps[i].id, off }, focus: { pid: ps[i].id, off } });
  ops.setStyle(doc, at(0), "Title");
  ops.setStyle(doc, at(1), "Heading1");
  ops.applyRunProps(doc, { anchor: { pid: ps[2].id, off: 10 }, focus: { pid: ps[2].id, off: 19 } }, { bold: true, color: "#c00000" });
  ops.applyRunProps(doc, { anchor: { pid: ps[2].id, off: 25 }, focus: { pid: ps[2].id, off: 37 } }, { link: "https://example.org" });
  ops.toggleList(doc, { anchor: { pid: ps[3].id, off: 0 }, focus: { pid: ps[4].id, off: 0 } }, "number");
  ops.applyParaProps(doc, at(5), { align: "center" });
  const t = ops.newTable(doc, 2, 2, 400);
  ops.insertBlockAfter(doc, { pid: ps[5].id, off: 4 }, t);
  ops.insertText(doc, { pid: t.rows[0].cells[0].paragraphs[0].id, off: 0 }, "A1");
  ops.insertText(doc, { pid: t.rows[1].cells[1].paragraphs[0].id, off: 0 }, "B2");
  doc.footer.push({ type: "p", id: doc.nextId++, props: { style: "Footer", align: "center" }, runs: [{ type: "field", field: "PAGE", props: {} }] });
  doc.page.width = 841.9; doc.page.height = 595.3; // orizzontale
  return doc;
}

describe("docx", () => {
  test("il file prodotto ha le parti richieste da Word", () => {
    const files = unzipSync(exportDocx(sample()));
    for (const part of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/_rels/document.xml.rels", "word/footer1.xml"]) {
      expect(files[part], part).toBeDefined();
    }
    const xml = strFromU8(files["word/document.xml"]);
    expect(xml).toContain('w:orient="landscape"');
    expect(new DOMParser().parseFromString(xml, "application/xml").getElementsByTagName("parsererror").length).toBe(0);
  });

  test("andata e ritorno conserva testo, stili, elenchi, tabelle, link e pagina", () => {
    const back = importDocx(exportDocx(sample()));
    const paras = back.blocks.filter((b): b is Paragraph => b.type === "p");
    expect(paras.map(paragraphText)).toEqual(["Relazione", "Introduzione", "Testo con grassetto e un collegamento.", "prima", "seconda", "Fine", ""]);
    expect(paras[0].props.style).toBe("Title");
    expect(paras[1].props.style).toBe("Heading1");
    const bold = paras[2].runs.find((r) => r.type !== "image" && r.type !== "field" && r.text === "grassetto");
    expect(bold?.props).toMatchObject({ bold: true, color: "#c00000" });
    expect(paras[2].runs.some((r) => r.props.link === "https://example.org")).toBe(true);
    expect(paras[3].props.numId).toBeDefined();
    expect(back.numbering[paras[3].props.numId!].levels[0].format).toBe("decimal");
    expect(paras[5].props.align).toBe("center");
    const table = back.blocks.find((b) => b.type === "table");
    expect(table?.type).toBe("table");
    if (table?.type === "table") {
      expect(paragraphText(table.rows[0].cells[0].paragraphs[0])).toBe("A1");
      expect(paragraphText(table.rows[1].cells[1].paragraphs[0])).toBe("B2");
    }
    expect(back.footer[0].runs[0]).toMatchObject({ type: "field", field: "PAGE" });
    expect(Math.round(back.page.width)).toBe(842);
  });

  test("gli id degli stili di Word italiano vengono riconosciuti", () => {
    const files = unzipSync(exportDocx(sample()));
    // Simula un file salvato da Word in italiano: lo stile "heading 1" ha id "Titolo1".
    const rename = (s: string) => s.replaceAll('w:styleId="Heading1"', 'w:styleId="Titolo1"').replaceAll('w:val="Heading1"', 'w:val="Titolo1"');
    files["word/styles.xml"] = new TextEncoder().encode(rename(strFromU8(files["word/styles.xml"])));
    files["word/document.xml"] = new TextEncoder().encode(rename(strFromU8(files["word/document.xml"])));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { zipSync } = require("fflate");
    const back = importDocx(zipSync(files));
    const p = back.blocks.find((b) => b.type === "p" && paragraphText(b) === "Introduzione") as Paragraph;
    expect(p.props.style).toBe("Heading1");
  });

  test("un file non valido dà un errore comprensibile", () => {
    expect(() => importDocx(new Uint8Array([1, 2, 3]))).toThrow(/non è un documento/);
  });
});
