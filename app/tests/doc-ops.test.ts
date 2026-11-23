// Test delle operazioni di modifica dell'editor di testo.
import { describe, expect, test } from "vitest";
import { paragraphText, type Paragraph } from "../src/doc/model";
import {
  applyRunProps, changeIndent, deleteRange, insertText, joinWithPrevious, locate, newTable, insertBlockAfter,
  adjacentCell, splitParagraph, toggleList, wordAt, wordBoundary, wordCount, setStyle,
} from "../src/doc/ops";
import { newDocument } from "../src/doc/styles";

const texts = (paras: { type: string }[]) => paras.filter((b): b is Paragraph => b.type === "p").map(paragraphText);

function docWith(...lines: string[]) {
  const doc = newDocument();
  const p0 = doc.blocks[0] as Paragraph;
  insertText(doc, { pid: p0.id, off: 0 }, lines.join("\n"));
  return doc;
}

describe("scrittura", () => {
  test("inserisce testo e divide i paragrafi con a capo", () => {
    const doc = docWith("Ciao mondo", "Seconda riga");
    expect(texts(doc.blocks)).toEqual(["Ciao mondo", "Seconda riga"]);
  });

  test("Invio a metà paragrafo lo divide", () => {
    const doc = docWith("Ciaomondo");
    const p = doc.blocks[0] as Paragraph;
    const pos = splitParagraph(doc, { pid: p.id, off: 4 });
    expect(texts(doc.blocks)).toEqual(["Ciao", "mondo"]);
    expect(pos.off).toBe(0);
  });

  test("dopo un titolo il paragrafo successivo torna Normale", () => {
    const doc = docWith("Introduzione");
    const p = doc.blocks[0] as Paragraph;
    setStyle(doc, { anchor: { pid: p.id, off: 0 }, focus: { pid: p.id, off: 0 } }, "Heading1");
    const pos = splitParagraph(doc, { pid: p.id, off: 12 });
    expect(locate(doc, pos.pid)!.para.props.style).toBeUndefined();
  });

  test("cancella tra paragrafi unendoli", () => {
    const doc = docWith("Prima riga", "Seconda", "Terza riga");
    const [a, , c] = doc.blocks as Paragraph[];
    deleteRange(doc, { pid: a.id, off: 5 }, { pid: c.id, off: 6 });
    expect(texts(doc.blocks)).toEqual(["Primariga"]);
  });

  test("Backspace a inizio paragrafo lo unisce al precedente", () => {
    const doc = docWith("Uno", "Due");
    const [, b] = doc.blocks as Paragraph[];
    const pos = joinWithPrevious(doc, { pid: b.id, off: 0 });
    expect(texts(doc.blocks)).toEqual(["UnoDue"]);
    expect(pos.off).toBe(3);
  });
});

describe("formattazione", () => {
  test("il grassetto divide i run solo dove serve", () => {
    const doc = docWith("abcdef");
    const p = doc.blocks[0] as Paragraph;
    applyRunProps(doc, { anchor: { pid: p.id, off: 2 }, focus: { pid: p.id, off: 4 } }, { bold: true });
    expect(p.runs.map((r) => (r.type === undefined || r.type === "text" ? [r.text, !!r.props.bold] : null))).toEqual([["ab", false], ["cd", true], ["ef", false]]);
    applyRunProps(doc, { anchor: { pid: p.id, off: 0 }, focus: { pid: p.id, off: 6 } }, { bold: undefined });
    expect(p.runs.length).toBe(1);
  });

  test("scrivere dopo un testo in grassetto continua in grassetto", () => {
    const doc = docWith("ab");
    const p = doc.blocks[0] as Paragraph;
    applyRunProps(doc, { anchor: { pid: p.id, off: 0 }, focus: { pid: p.id, off: 2 } }, { bold: true });
    insertText(doc, { pid: p.id, off: 2 }, "c");
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0].props.bold).toBe(true);
  });

  test("elenchi: attivazione, livelli e uscita con Invio su voce vuota", () => {
    const doc = docWith("uno", "due");
    const [a, b] = doc.blocks as Paragraph[];
    const all = { anchor: { pid: a.id, off: 0 }, focus: { pid: b.id, off: 0 } };
    toggleList(doc, all, "number");
    expect(a.props.numId).toBeDefined();
    expect(b.props.numId).toBe(a.props.numId);
    changeIndent(doc, { anchor: { pid: b.id, off: 0 }, focus: { pid: b.id, off: 0 } }, 1);
    expect(b.props.numLevel).toBe(1);
    const pos = splitParagraph(doc, { pid: b.id, off: 3 });
    const empty = locate(doc, pos.pid)!.para;
    expect(empty.props.numId).toBe(a.props.numId);
    splitParagraph(doc, pos); // Invio su voce vuota: sale di livello
    expect(empty.props.numLevel).toBe(0);
    splitParagraph(doc, pos); // di nuovo: esce dall'elenco
    expect(empty.props.numId).toBeUndefined();
    toggleList(doc, all, "number");
    expect(a.props.numId).toBeUndefined();
  });
});

describe("tabelle", () => {
  test("inserimento e Tab tra le celle", () => {
    const doc = docWith("Prima");
    const p = doc.blocks[0] as Paragraph;
    const after = insertBlockAfter(doc, { pid: p.id, off: 5 }, newTable(doc, 2, 3, 450));
    expect(doc.blocks.map((b) => b.type)).toEqual(["p", "table", "p"]);
    expect(after.pid).toBe(doc.blocks[2].id);
    const t = doc.blocks[1];
    if (t.type !== "table") throw new Error();
    const first = t.rows[0].cells[0].paragraphs[0];
    const next = adjacentCell(doc, first.id, 1)!;
    expect(next.pid).toBe(t.rows[0].cells[1].paragraphs[0].id);
    expect(adjacentCell(doc, t.rows[1].cells[2].paragraphs[0].id, 1)).toBeNull();
  });
});

describe("parole", () => {
  test("doppio clic seleziona la parola con lo spazio dopo", () => {
    const doc = docWith("Ciao bel mondo");
    const p = doc.blocks[0] as Paragraph;
    expect(wordAt(p, 6)).toEqual([5, 9]);
    expect(wordBoundary(p, 0, 1)).toBe(5);
    expect(wordBoundary(p, 14, -1)).toBe(9);
    expect(wordCount(doc)).toBe(3);
  });
});
