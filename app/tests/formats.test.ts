// @vitest-environment jsdom
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { exportDocx } from "../src/doc/docxExport";
import { importDocx } from "../src/doc/docxImport";
import { paragraphText, type Paragraph, type Table } from "../src/doc/model";
import { exportOdt } from "../src/doc/odtExport";
import { importOdt } from "../src/doc/odtImport";
import { importRtf } from "../src/doc/rtfImport";
import { exportMarkdown, exportPlainText, importHtml, importMarkdown, importPlainText } from "../src/doc/textImport";
import { ensureListNumbering, newDocument } from "../src/doc/styles";

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG_BYTES = Uint8Array.from(atob(TINY_PNG.split(",")[1]), (c) => c.charCodeAt(0));

describe("DOCX avanzato (Word reale, Strict OOXML, note, AlternateContent)", () => {
  test("gestisce Strict OOXML, BOM UTF-8, vanish, hyperlink complessi, note e caselle di testo", () => {
    const W = "http://purl.oclc.org/ooxml/wordprocessingml/main";
    const R = "http://purl.oclc.org/ooxml/officeDocument/relationships";
    const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
    const docXml = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:mc="${MC}">
        <w:body>
          <w:p>
            <w:r><w:t>Visibile </w:t></w:r>
            <w:r><w:rPr><w:vanish/></w:rPr><w:t>NASCOSTO</w:t></w:r>
            <w:r><w:fldChar w:fldCharType="begin"/></w:r>
            <w:r><w:instrText> HYPERLINK "https://zikoffice.it" </w:instrText></w:r>
            <w:r><w:fldChar w:fldCharType="separate"/></w:r>
            <w:r><w:t>Sito</w:t></w:r>
            <w:r><w:fldChar w:fldCharType="end"/></w:r>
            <w:r><w:footnoteReference w:id="1"/></w:r>
          </w:p>
          <w:p>
            <w:r>
              <mc:AlternateContent>
                <mc:Choice Requires="wps">
                  <w:drawing><w:txbxContent><w:p><w:r><w:t>Dentro casella</w:t></w:r></w:p></w:txbxContent></w:drawing>
                </mc:Choice>
                <mc:Fallback><w:t>Fallback</w:t></mc:Fallback>
              </mc:AlternateContent>
            </w:r>
          </w:p>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
              <w:sdt><w:sdtContent><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:sdtContent></w:sdt>
              <w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
          <w:sectPr><w:pgSz w:w="11906" w:h="16838" w:orient="landscape"/></w:sectPr>
        </w:body>
      </w:document>`;
    const fnXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:footnotes xmlns:w="${W}">
        <w:footnote w:id="1"><w:p><w:r><w:t>Testo della nota italiana.</w:t></w:r></w:p></w:footnote>
      </w:footnotes>`;
    const bytes = zipSync({
      "word/document.xml": strToU8(docXml),
      "word/footnotes.xml": strToU8(fnXml),
    });

    const doc = importDocx(bytes);
    // Orientamento orizzontale corretto anche se w < h nel file
    expect(doc.page.width).toBeGreaterThan(doc.page.height);

    const p0 = doc.blocks[0] as Paragraph;
    const text0 = paragraphText(p0);
    expect(text0).toContain("Visibile ");
    expect(text0).not.toContain("NASCOSTO");
    expect(text0).toContain("Sito");
    expect(text0).toContain("[1]");
    const linkRun = p0.runs.find((r) => !r.type && r.text === "Sito");
    expect(linkRun && !linkRun.type ? linkRun.props.link : "").toBe("https://zikoffice.it");

    // Casella di testo in mc:AlternateContent
    expect(paragraphText(doc.blocks[1] as Paragraph)).toBe("Dentro casella");

    // Tabella senza tblGrid e con cella sdt nel mezzo: ordine A, B, C preservato e colonne ragionevoli
    const tbl = doc.blocks[2] as Table;
    expect(tbl.type).toBe("table");
    expect(tbl.rows[0].cells.map((c) => paragraphText(c.paragraphs[0]))).toEqual(["A", "B", "C"]);
    expect(tbl.grid.length).toBe(3);
    expect(tbl.grid[0]).toBeGreaterThan(100);

    // Nota a piè di pagina aggiunta in fondo
    const allText = doc.blocks.filter((b): b is Paragraph => b.type === "p").map(paragraphText).join("\n");
    expect(allText).toContain("Testo della nota italiana.");
  });

  test("importa immagini VML legacy (<w:pict><v:imagedata>) e colori del tema", () => {
    const docXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                  xmlns:v="urn:schemas-microsoft-com:vml">
        <w:body>
          <w:p>
            <w:r><w:rPr><w:color w:val="auto" w:themeColor="accent1"/></w:rPr><w:t>Blu tema</w:t></w:r>
            <w:r><w:pict><v:shape style="width:120pt;height:60pt"><v:imagedata r:id="rIdImg"/></v:shape></w:pict></w:r>
          </w:p>
        </w:body>
      </w:document>`;
    const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.png"/>
      </Relationships>`;
    const themeXml = `<?xml version="1.0" encoding="UTF-8"?>
      <a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <a:themeElements><a:clrScheme name="Office"><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements>
      </a:theme>`;
    const bytes = zipSync({
      "word/document.xml": strToU8(docXml),
      "word/_rels/document.xml.rels": strToU8(relsXml),
      "word/theme/theme1.xml": strToU8(themeXml),
      "word/media/pic.png": TINY_PNG_BYTES,
    });

    const doc = importDocx(bytes);
    const p = doc.blocks[0] as Paragraph;
    const textRun = p.runs[0];
    expect(!textRun.type && textRun.props.color).toBe("#4472c4");
    const imgRun = p.runs.find((r) => r.type === "image");
    expect(imgRun?.type).toBe("image");
    if (imgRun?.type === "image") {
      expect(imgRun.width).toBeCloseTo(120, 0);
      expect(imgRun.height).toBeCloseTo(60, 0);
    }
  });
});

describe("ODT (OpenDocument Text) esportazione e importazione", () => {
  test("round-trip completo: titoli, stili, elenchi, tabelle, link e immagini", () => {
    const doc = newDocument();
    const bulletId = ensureListNumbering(doc, "bullet");
    doc.blocks = [
      { type: "p", id: 1, props: { style: "Heading1", outlineLevel: 0 }, runs: [{ text: "Relazione annuale", props: {} }] },
      {
        type: "p", id: 2, props: { align: "justify" },
        runs: [
          { text: "Testo ", props: {} },
          { text: "grassetto", props: { bold: true, color: "#cc0000" } },
          { text: " e ", props: {} },
          { text: "link", props: { link: "https://example.org" } },
        ],
      },
      { type: "p", id: 3, props: { numId: bulletId, numLevel: 0 }, runs: [{ text: "Voce elenco", props: {} }] },
      { type: "p", id: 4, props: {}, runs: [{ type: "image", src: TINY_PNG, mime: "image/png", width: 80, height: 40, alt: "Logo", props: {} }] },
      {
        type: "table", id: 5, grid: [150, 150], align: "left",
        rows: [
          { cells: [{ span: 1, paragraphs: [{ type: "p", id: 6, props: {}, runs: [{ text: "Col 1", props: { bold: true } }] }] }, { span: 1, paragraphs: [{ type: "p", id: 7, props: {}, runs: [{ text: "Col 2", props: { bold: true } }] }] }] },
        ],
      },
      { type: "p", id: 8, props: {}, runs: [] },
    ];
    doc.nextId = 20;

    const odtBytes = exportOdt(doc);
    const back = importOdt(odtBytes);

    expect((back.blocks[0] as Paragraph).props.style).toBe("Heading1");
    expect(paragraphText(back.blocks[0] as Paragraph)).toBe("Relazione annuale");
    const p1 = back.blocks[1] as Paragraph;
    expect(p1.props.align).toBe("justify");
    expect(paragraphText(p1)).toBe("Testo grassetto e link");
    const boldRun = p1.runs.find((r) => !r.type && r.text === "grassetto");
    expect(boldRun && !boldRun.type && boldRun.props.bold).toBe(true);
    expect(boldRun && !boldRun.type && boldRun.props.color).toBe("#cc0000");
    const linkRun = p1.runs.find((r) => !r.type && r.text === "link");
    expect(linkRun && !linkRun.type && linkRun.props.link).toBe("https://example.org");
    expect((back.blocks[2] as Paragraph).props.numId).toBeDefined();
    expect((back.blocks[3] as Paragraph).runs[0].type).toBe("image");
    const tbl = back.blocks[4] as Table;
    expect(tbl.type).toBe("table");
    expect(paragraphText(tbl.rows[0].cells[0].paragraphs[0])).toBe("Col 1");
  });
});

describe("RTF, Markdown, HTML e Testo semplice", () => {
  test("importa RTF con accenti italiani, Unicode, formattazione e tabelle", () => {
    const rtf = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Arial;}}{\colortbl;\red200\green0\blue0;}{\info{\author Ignora}}`
      + String.raw`\qc\b\fs32 Citt\'e0 e caff\'e8 \u8364?10\b0\par`
      + String.raw`\pard\ql\cf1\i Nota in rosso\i0\par`
      + String.raw`\trowd\intbl A1\cell B1\cell\row}`;
    const doc = importRtf(new TextEncoder().encode(rtf));
    const p0 = doc.blocks[0] as Paragraph;
    expect(p0.props.align).toBe("center");
    expect(paragraphText(p0)).toBe("Città e caffè €10");
    expect(!p0.runs[0].type && p0.runs[0].props.bold).toBe(true);
    expect(!p0.runs[0].type && p0.runs[0].props.size).toBe(16);

    const p1 = doc.blocks[1] as Paragraph;
    expect(paragraphText(p1)).toBe("Nota in rosso");
    expect(!p1.runs[0].type && p1.runs[0].props.color).toBe("#c80000");
    expect(!p1.runs[0].type && p1.runs[0].props.italic).toBe(true);

    const tbl = doc.blocks[2] as Table;
    expect(tbl.type).toBe("table");
    expect(tbl.rows[0].cells.map((c) => paragraphText(c.paragraphs[0]))).toEqual(["A1", "B1"]);
  });

  test("importa ed esporta Markdown con titoli, elenchi, formattazione e tabelle", () => {
    const md = `# Titolo\n\nTesto **grassetto**, *corsivo* e [link](https://example.it).\n\n- Uno\n- Due\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n`;
    const doc = importMarkdown(new TextEncoder().encode(md));
    expect((doc.blocks[0] as Paragraph).props.style).toBe("Heading1");
    expect(paragraphText(doc.blocks[0] as Paragraph)).toBe("Titolo");
    const tbl = doc.blocks.find((b): b is Table => b.type === "table");
    expect(tbl?.rows.length).toBe(2);
    const out = new TextDecoder().decode(exportMarkdown(doc));
    expect(out).toContain("# Titolo");
    expect(out).toContain("**grassetto**");
    expect(out).toContain("| A | B |\n| --- | --- |");
  });

  test("importa HTML e testo semplice (anche Windows-1252)", () => {
    const html = `<html><body><h1>Titolo HTML</h1><p>Ciao <b>mondo</b> <a href="https://a.it">qui</a></p><table><tr><th>K</th><th>V</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>`;
    const doc = importHtml(new TextEncoder().encode(html));
    expect(paragraphText(doc.blocks[0] as Paragraph)).toBe("Titolo HTML");
    expect(doc.blocks.some((b) => b.type === "table")).toBe(true);

    // Windows-1252: "perché €"
    const win1252 = new Uint8Array([112, 101, 114, 99, 104, 0xe9, 32, 0x80]);
    const txtDoc = importPlainText(win1252);
    expect(paragraphText(txtDoc.blocks[0] as Paragraph)).toBe("perché €");
    expect(new TextDecoder().decode(exportPlainText(txtDoc)).trim()).toBe("perché €");

    // Verifica anche exportDocx su un documento importato da ODT/RTF/MD
    const docx = exportDocx(doc);
    const reopened = importDocx(docx);
    expect(paragraphText(reopened.blocks[0] as Paragraph)).toBe("Titolo HTML");
  });
});
