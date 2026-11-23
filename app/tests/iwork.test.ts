// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fields, first, float32, ints, iwaDecompress, readObjects, snappyDecompress, str } from "../src/doc/iwork/iwa";
import { decimal128 } from "../src/doc/iwork/tables";
import { fontOf } from "../src/doc/iwork/pages";
import { importIworkDocument } from "../src/doc/iworkImport";
import { Pkg } from "../src/doc/iwork/pkg";
import { readTableInfo } from "../src/doc/iwork/tables";
import { newDocument } from "../src/doc/styles";
import { initSync } from "@ironcalc/wasm";
import { importNumbers } from "../src/sheet/numbersImport";
import { Model } from "../src/sheet/engine";
import { paragraphText } from "../src/doc/model";

const varint = (n: number): number[] => {
  const out: number[] = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};
const utf8 = (s: string) => [...new TextEncoder().encode(s)];
const lenField = (n: number, bytes: number[]) => [...varint(n * 8 + 2), ...varint(bytes.length), ...bytes];
const varField = (n: number, v: number) => [...varint(n * 8), ...varint(v)];

describe("contenitore iWork", () => {
  it("decomprime Snappy con letterali e copie (anche sovrapposte)", () => {
    // "abc" + copia di 9 byte a distanza 3 = "abcabcabcabc"
    const data = new Uint8Array([...varint(12), (3 - 1) << 2, ...utf8("abc"), ((9 - 1) << 2) | 2, 3, 0]);
    expect(new TextDecoder().decode(snappyDecompress(data))).toBe("abcabcabcabc");
  });

  it("rifiuta dati Snappy troncati o con riferimenti impossibili", () => {
    expect(() => snappyDecompress(new Uint8Array([...varint(10), (3 - 1) << 2, ...utf8("ab")]))).toThrow();
    expect(() => snappyDecompress(new Uint8Array([...varint(4), ((4 - 4) << 2) | 1, 9]))).toThrow();
  });

  it("legge i campi protobuf (varint, stringhe, annidati, float, interi impacchettati)", () => {
    const f32 = new Uint8Array(4);
    new DataView(f32.buffer).setFloat32(0, 12.5, true);
    const buf = new Uint8Array([
      ...varField(1, 300), ...lenField(2, utf8("àè")), ...lenField(3, varField(1, 7)),
      ...varint(4 * 8 + 5), ...f32, ...lenField(5, [1, 2, 200, 1]),
    ]);
    const fs = fields(buf);
    expect(first(fs, 1)?.num).toBe(300);
    expect(str(first(fs, 2))).toBe("àè");
    expect(first(fields(first(fs, 3)!.bytes!), 1)?.num).toBe(7);
    expect(float32(first(fs, 4))).toBe(12.5);
    expect(ints(fs, 5)).toEqual([1, 2, 200]);
  });

  it("legge gli oggetti di un file .iwa (intestazione ArchiveInfo + contenuto)", () => {
    const payload = [...varField(1, 42)];
    const info = [...varField(1, 77), ...lenField(2, [...varField(1, 2001), ...varField(3, payload.length)])];
    const stream = new Uint8Array([...varint(info.length), ...info, ...payload]);
    // un blocco IWA: tipo 0 + lunghezza a 3 byte + dati Snappy (solo letterali)
    const lit = [...varint(stream.length), ((stream.length - 1) << 2) | 0, ...stream];
    const iwa = new Uint8Array([0, lit.length & 255, (lit.length >> 8) & 255, 0, ...lit]);
    const objs = readObjects(iwaDecompress(iwa));
    expect(objs).toHaveLength(1);
    expect(objs[0].id).toBe(77);
    expect(objs[0].messages[0].type).toBe(2001);
    expect(first(fields(objs[0].messages[0].data), 1)?.num).toBe(42);
  });

  it("decodifica i decimal128 (BID) dei numeri di Numbers", () => {
    const enc = (coef: bigint, exp: number, neg = false) => {
      let v = coef | (BigInt(exp + 6176) << 113n);
      if (neg) v |= 1n << 127n;
      const b = new Uint8Array(16);
      for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
      return b;
    };
    expect(decimal128(enc(250n, 0))).toBe(250);
    expect(decimal128(enc(202150n, -2))).toBe(2021.5);
    expect(decimal128(enc(5n, 1, true))).toBe(-50);
  });
});

describe("nomi dei font di Apple", () => {
  it("riduce i nomi PostScript a famiglia e stile", () => {
    expect(fontOf("Helvetica-Bold")).toEqual({ family: "Arial", bold: true });
    expect(fontOf("HelveticaNeue-LightItalic")).toEqual({ family: "Arial", italic: true });
    expect(fontOf("TimesNewRomanPS-BoldMT")).toEqual({ family: "Times New Roman", bold: true });
    expect(fontOf("AvenirNext-Regular")).toEqual({ family: "Avenir Next" });
    expect(fontOf("Menlo-Regular").family).toBe("Courier New");
  });
});

describe("file di prova veri (ZIKOFFICE_IWORK_FIXTURES)", () => {
  const dir = process.env.ZIKOFFICE_IWORK_FIXTURES;
  const file = (n: string) => (dir && existsSync(`${dir}/${n}`) ? new Uint8Array(readFileSync(`${dir}/${n}`)) : null);

  it("Pages (formato attuale): testo, pagina A5 e stili", () => {
    const bytes = file("Pages_5.pages");
    if (!bytes) return;
    const doc = importIworkDocument(bytes);
    expect(doc.page.width).toBeCloseTo(420, 0);
    expect(doc.page.height).toBeCloseTo(595, 0);
    expect(doc.page.marginLeft).toBeCloseTo(56.7, 0);
    const p = doc.blocks.filter((b) => b.type === "p");
    expect(paragraphText(p[0] as never)).toBe("A5 page.");
    expect(doc.styles.Normal.run?.font).toBe("Arial");
    expect(doc.styles.Normal.run?.size).toBe(12);
  });

  it("Pages (vecchio formato XML): collegamento e pagina", () => {
    const bytes = file("Pages_4.pages");
    if (!bytes) return;
    const doc = importIworkDocument(bytes);
    const p = doc.blocks[0];
    expect(p.type).toBe("p");
    if (p.type !== "p") return;
    expect(paragraphText(p)).toBe("Document Liberation link.");
    expect(p.runs[0]).toMatchObject({ props: { link: "http://documentliberation.org", underline: true } });
    expect(doc.page.width).toBe(595);
  });

  it("tabelle: date, numeri e testi come nell'anteprima di Numbers", () => {
    const bytes = file("test-2.numbers");
    if (!bytes) return;
    const pkg = new Pkg(Pkg.open(bytes).files);
    const doc = newDocument();
    const t = readTableInfo({ pkg, doc, styleIds: new Map(), nextNum: 1 }, pkg.allOfType(6000)[0])!;
    const text = t.rows.map((r) => r.cells.map((c) => c.paragraphs.map(paragraphText).join(" ")));
    expect(text[0]).toEqual(["Date", "Transaction Details", "Paid In", "Withdrawn", "Balance", "Category"]);
    expect(text[1]).toEqual(["01/05/2020", "Debit to Marlon Computing", "250", "", "2021,5", "Loans"]);
    expect(text[3][1]).toBe("Grant Coffee");
  });

  it("tabelle con elenchi puntati, numerati e con lettere nelle celle", () => {
    const bytes = file("test-bullets.numbers");
    if (!bytes) return;
    const pkg = Pkg.open(bytes);
    const doc = newDocument();
    const t = readTableInfo({ pkg, doc, styleIds: new Map(), nextNum: 1 }, pkg.allOfType(6000)[0])!;
    const fmt = (row: number, col: number) => t.rows[row].cells[col].paragraphs.map((p) => doc.numbering[p.props.numId!]?.levels[0].format ?? "none");
    expect(fmt(0, 1)).toEqual(["bullet", "bullet", "bullet", "bullet"]);
    expect(fmt(1, 1)).toEqual(["decimal", "decimal", "decimal", "decimal"]);
    expect(fmt(2, 1)).toEqual(["upperLetter", "upperLetter", "upperLetter", "upperLetter"]);
    expect(fmt(0, 0)).toEqual(["none", "none", "none"]);
    expect(t.rows[1].cells[1].paragraphs.map(paragraphText)).toEqual(["this", "is some", "numbered", "text"]);
  });

  it("Numbers: ogni tabella diventa un foglio con i valori mostrati", () => {
    const bytes = file("test-2.numbers");
    if (!bytes) return;
    initSync({ module: readFileSync("node_modules/@ironcalc/wasm/wasm_bg.wasm") });
    const model = Model.fromBytes(importNumbers(bytes), "it");
    expect(model.getWorksheetsProperties().map((w: { name: string }) => w.name)).toEqual(["Account"]);
    const cell = (r: number, c: number) => model.getFormattedCellValue(0, r, c);
    expect(cell(1, 1)).toBe("Date");
    expect(cell(2, 2)).toBe("Debit to Marlon Computing");
    expect(cell(2, 3)).toBe("250");
    expect(model.getCellType(0, 2, 3)).toBe(1); // numero vero, non testo
    expect(cell(3, 6)).toBe("Entertainment");
  });
});
