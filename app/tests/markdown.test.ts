// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { exportDocx } from "../src/doc/docxExport";
import { importDocx } from "../src/doc/docxImport";
import { imageSize } from "../src/doc/imageSize";
import {
  exportMarkdown, exportMarkdownFull, importMarkdown, loadMarkdownImages, markdownLosses, resolveRelative,
} from "../src/doc/markdown";
import { allParagraphs, paragraphText, type DocumentModel, type ImageRun, type Paragraph, type Table } from "../src/doc/model";
import { ensureListNumbering, ensureMarkdownStyles, newDocument } from "../src/doc/styles";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const imp = (s: string) => importMarkdown(enc(s));
const rt = (s: string) => dec(exportMarkdown(imp(s)));
const paras = (d: DocumentModel) => d.blocks.filter((b): b is Paragraph => b.type === "p");

// PNG 30×20 minimo (solo intestazione: basta per le dimensioni)
const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
};
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

const SAMPLE = `---
title: Prova
tags: [a, b]
---

# Titolo *uno*

Paragrafo con **grassetto**, *corsivo*, ***entrambi***, ~~barrato~~, \`codice\`, <u>sottolineato</u>, x<sup>2</sup> e [un link](https://example.it/a_b).
Seconda riga  
con a capo forzato. Caratteri: 1 \\* 2 \\_ snake_case A &amp; B.

## Elenchi

- uno
- due
  - due-a
  - due-b
    1. profondo
    2. profondo
- [ ] da fare
- [x] fatto

3. tre
4. quattro

1) uno
1) due

> Citazione
>
> > Annidata

\`\`\`python
def f(x):
    return x * 2
\`\`\`

---

| Nome | Qta | Prezzo |
|:-----|:---:|-------:|
| Pera | 3 | 1,5 |
| Mela \\| rossa | 10 | **2** |

#hashtag non titolo
`;

describe("Markdown: lettura", () => {
  const doc = imp(SAMPLE);
  const ps = paras(doc);

  test("front matter conservato e non mostrato", () => {
    expect(doc.frontMatter).toBe("---\ntitle: Prova\ntags: [a, b]\n---");
    expect(ps.some((p) => paragraphText(p).includes("title:"))).toBe(false);
  });

  test("titoli, formattazione e collegamenti", () => {
    expect(ps[0].props.style).toBe("Heading1");
    expect(ps[0].runs.map((r) => (r.type ? "" : r.text))).toEqual(["Titolo ", "uno"]);
    const body = ps[1].runs.filter((r) => !r.type) as { text: string; props: Record<string, unknown> }[];
    const by = (t: string) => body.find((r) => r.text === t)!.props;
    expect(by("grassetto").bold).toBe(true);
    expect(by("corsivo").italic).toBe(true);
    expect(by("entrambi")).toMatchObject({ bold: true, italic: true });
    expect(by("barrato").strike).toBe(true);
    expect(by("codice").font).toBe("Consolas");
    expect(by("sottolineato").underline).toBe(true);
    expect(by("2").vertAlign).toBe("superscript");
    expect(by("un link").link).toBe("https://example.it/a_b");
    // a capo "morbido" → spazio; a capo forzato (due spazi) → interruzione di riga; entità decodificate
    const text = paragraphText(ps[1]);
    expect(text).toContain("un link. Seconda riga");
    expect(text).toContain("Seconda riga\ncon a capo forzato");
    expect(text).toContain("1 * 2 _ snake_case A & B.");
  });

  test("elenchi: livelli, numerazione che riparte, caselle", () => {
    const items = ps.filter((p) => p.props.numId !== undefined);
    const texts = items.map((p) => `${p.props.numLevel}:${paragraphText(p)}`);
    expect(texts).toEqual(["0:uno", "0:due", "1:due-a", "1:due-b", "2:profondo", "2:profondo", "0:☐ da fare", "0:☑ fatto", "0:tre", "0:quattro", "0:uno", "0:due"]);
    const num = (t: string) => doc.numbering[items.find((p) => paragraphText(p) === t)!.props.numId!];
    expect(num("uno").levels[0].format).toBe("bullet");
    expect(num("profondo").levels[2].format).toBe("lowerRoman" === num("profondo").levels[2].format ? "lowerRoman" : "decimal");
    expect(num("tre").levels[0]).toMatchObject({ format: "decimal", start: 3 });
    const ids = items.filter((p) => ["tre", "uno"].includes(paragraphText(p))).map((p) => p.props.numId);
    expect(new Set(ids).size).toBeGreaterThan(1); // elenchi diversi → numerazioni diverse
  });

  test("citazioni, codice, linea, tabella", () => {
    expect(ps.find((p) => paragraphText(p) === "Citazione")!.props.style).toBe("BlockQuote");
    expect(ps.find((p) => paragraphText(p) === "Annidata")!.props.indentLeft).toBe(36);
    const code = ps.find((p) => p.props.style === "CodeBlock")!;
    expect(code.props.codeLang).toBe("python");
    expect(paragraphText(code)).toBe("def f(x):\n    return x * 2");
    expect(ps.some((p) => p.props.style === "Rule")).toBe(true);
    const t = doc.blocks.find((b): b is Table => b.type === "table")!;
    expect(t.rows.length).toBe(3);
    expect(t.rows[0].header).toBe(true);
    expect(t.rows[0].cells.map((c) => c.paragraphs[0].props.align)).toEqual([undefined, "center", "right"]);
    expect(paragraphText(t.rows[2].cells[0].paragraphs[0])).toBe("Mela | rossa");
    expect(ps.find((p) => paragraphText(p).startsWith("#hashtag"))!.props.style).toBeUndefined();
  });

  test("HTML: commenti ignorati, <br> e <img>", () => {
    const d = imp("Uno<br>due <!-- no --> tre\n\n<!-- solo commento -->\n\n<img src=\"a.png\" alt=\"A\" width=\"100\">\n");
    expect(paragraphText(paras(d)[0])).toBe("Uno\ndue  tre");
    const im = paras(d).flatMap((p) => p.runs).find((r): r is ImageRun => r.type === "image")!;
    expect(im).toMatchObject({ alt: "A", srcPath: "a.png", width: 75 });
    expect(paras(d).filter((p) => paragraphText(p).includes("commento")).length).toBe(0);
  });

  test("un --- iniziale senza chiavi YAML è una linea, non front matter", () => {
    const d = imp("---\n\nTesto\n\n---\n\nAltro\n");
    expect(d.frontMatter).toBeUndefined();
    expect(paras(d).filter((p) => p.props.style === "Rule").length).toBe(2);
  });
});

describe("Markdown: scrittura e andata e ritorno", () => {
  test("il documento di prova torna uguale e stabile", () => {
    const once = rt(SAMPLE);
    expect(rt(once)).toBe(once);
    expect(once).toContain("# Titolo *uno*");
    expect(once).toContain("```python\ndef f(x):\n    return x * 2\n```");
    expect(once).toContain("- [ ] da fare");
    expect(once).toContain("3) tre\n4) quattro");
    expect(once).toContain("    1. profondo\n    2. profondo");
    expect(once).toContain("| Nome | Qta | Prezzo |\n| --- | :---: | ---: |");
    expect(once).toContain("| Mela \\| rossa | 10 | **2** |");
    expect(once.startsWith("---\ntitle: Prova")).toBe(true);
  });

  test("i paragrafi si separano con una riga vuota (altrimenti si fonderebbero)", () => {
    const d = newDocument();
    d.blocks = ["uno", "due", "tre"].map((t) => ({ type: "p", id: d.nextId++, props: {}, runs: [{ text: t, props: {} }] }));
    const out = dec(exportMarkdown(d));
    expect(out).toBe("uno\n\ndue\n\ntre\n");
    expect(paras(imp(out)).map(paragraphText)).toEqual(["uno", "due", "tre"]);
  });

  test("caratteri speciali nel testo non diventano formattazione", () => {
    const tricky = ["# non titolo", "1. non elenco", "- non punto", "> non citazione", "a * b * c", "snake_case e _solo_", "[x](y)", "<b>tag</b>", "`tick`", "A&amp;B", "~~no~~", "\\ barra"];
    for (const t of tricky) {
      const d = newDocument();
      d.blocks = [{ type: "p", id: 1, props: {}, runs: [{ text: t, props: {} }] }];
      const back = imp(dec(exportMarkdown(d)));
      expect(paragraphText(paras(back)[0])).toBe(t);
      expect(paras(back)[0].props.style).toBeUndefined();
      expect(paras(back)[0].props.numId).toBeUndefined();
    }
  });

  test("spazi ai bordi del grassetto restano fuori dagli asterischi; stili vicini si fondono", () => {
    const d = newDocument();
    d.blocks = [{ type: "p", id: 1, props: {}, runs: [
      { text: "a ", props: {} }, { text: "gras ", props: { bold: true } }, { text: "setto ", props: { bold: true } }, { text: "e corsivo", props: { bold: true, italic: true } }, { text: " fine", props: {} },
    ] }];
    expect(dec(exportMarkdown(d))).toBe("a **gras setto** ***e corsivo*** fine\n");
  });

  test("titoli di Word: livello da stile, grassetto non duplicato; paragrafi vuoti saltati", () => {
    const d = newDocument();
    d.blocks = [
      { type: "p", id: 1, props: { style: "Heading2" }, runs: [{ text: "Sezione", props: { bold: true } }] },
      { type: "p", id: 2, props: {}, runs: [] },
      { type: "p", id: 3, props: {}, runs: [{ text: "Testo", props: {} }] },
    ];
    expect(dec(exportMarkdown(d))).toBe("## Sezione\n\nTesto\n");
  });

  test("elenchi di Word (decimali/lettere, più livelli) escono numerati e annidati bene", () => {
    const d = newDocument();
    const num = ensureListNumbering(d, "number");
    const mk = (t: string, lv: number) => ({ type: "p" as const, id: d.nextId++, props: { numId: num, numLevel: lv }, runs: [{ text: t, props: {} }] });
    d.blocks = [mk("a", 0), mk("a1", 1), mk("a2", 1), mk("b", 0), mk("b1", 1)];
    expect(dec(exportMarkdown(d))).toBe("1. a\n   1. a1\n   2. a2\n2. b\n   1. b1\n");
  });

  test("righe di codice consecutive si uniscono in un solo blocco, con barriera più lunga se serve", () => {
    const d = newDocument();
    d.blocks = ["x = 1", "```", "y = 2"].map((t) => ({ type: "p" as const, id: d.nextId++, props: { style: "CodeBlock" }, runs: [{ text: t, props: {} }] }));
    ensureMarkdownStyles(d);
    const out = dec(exportMarkdown(d));
    expect(out).toBe("````\nx = 1\n```\ny = 2\n````\n");
    expect(paragraphText(paras(imp(out))[0])).toBe("x = 1\n```\ny = 2");
  });

  test("codice in linea con apici dentro", () => {
    const d = newDocument();
    d.blocks = [{ type: "p", id: 1, props: {}, runs: [{ text: "a`b", props: { font: "Courier New" } }] }];
    const out = dec(exportMarkdown(d));
    expect(out).toBe("``a`b``\n");
    expect(paragraphText(paras(imp(out))[0])).toBe("a`b");
  });
});

describe("Markdown: immagini", () => {
  const dataUrl = `data:image/png;base64,${b64(png(30, 20))}`;

  test("dimensioni lette dall'intestazione", () => {
    expect(imageSize(png(30, 20))).toEqual({ w: 30, h: 20 });
    expect(imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5, 0, 7, 0, 0, 0]))).toEqual({ w: 5, h: 7 });
    expect(imageSize(enc('<svg xmlns="x" viewBox="0 0 40 10"></svg>'))).toEqual({ w: 40, h: 10 });
    expect(imageSize(enc("niente"))).toBeNull();
  });

  test("immagine incorporata (data URI): si legge e si riscrive sia in linea sia in una cartella", () => {
    const d = imp(`Testo ![logo](${dataUrl}) fine\n`);
    const im = paras(d)[0].runs.find((r): r is ImageRun => r.type === "image")!;
    expect(im).toMatchObject({ mime: "image/png", width: 22.5, height: 15, alt: "logo" });
    expect(dec(exportMarkdown(d))).toBe(`Testo ![logo](${dataUrl}) fine\n`);
    const full = exportMarkdownFull(d, { assetDir: "nota.assets" });
    expect(full.assets.length).toBe(1);
    expect(full.assets[0].path).toMatch(/^nota\.assets\/img-[0-9a-f]{8}-\w+\.png$/);
    expect(full.assets[0].bytes).toEqual(png(30, 20));
    expect(dec(full.bytes)).toBe(`Testo ![logo](${full.assets[0].path}) fine\n`);
  });

  test("percorsi relativi: caricati dalla cartella, mancanti con segnaposto che non altera il file", async () => {
    const d = imp("![a](img/a%20b.png)\n\n![x](../no.png)\n\n![web](https://example.it/w.png)\n");
    const asked: string[] = [];
    const missing = await loadMarkdownImages(d, "/casa/note", async (p) => {
      asked.push(p);
      if (p.endsWith("a b.png")) return png(200, 100);
      throw new Error("manca");
    });
    expect(asked.sort()).toEqual(["/casa/no.png", "/casa/note/img/a b.png"]);
    expect(missing).toBe(1);
    const ims = [...allParagraphs(d.blocks)].flatMap((p) => p.runs).filter((r): r is ImageRun => r.type === "image");
    expect(ims[0].src.startsWith("data:image/png;base64,")).toBe(true);
    expect(ims[0]).toMatchObject({ width: 150, height: 75 });
    expect(ims[1].missing).toBe(true);
    // Salvando nello stesso posto, i percorsi originali restano; le immagini non si copiano.
    const same = exportMarkdownFull(d, { assetDir: "n.assets", keepPaths: true });
    expect(dec(same.bytes)).toBe("![a](img/a%20b.png)\n\n![x](../no.png)\n\n![web](https://example.it/w.png)\n");
    expect(same.assets.length).toBe(0);
    // Salvando altrove, quella trovata si copia nella cartella e quelle mancanti/online restano com'erano.
    const moved = exportMarkdownFull(d, { assetDir: "n.assets" });
    expect(moved.assets.length).toBe(1);
    expect(dec(moved.bytes)).toContain("![x](../no.png)");
    expect(dec(moved.bytes)).toContain("![web](https://example.it/w.png)");
    expect(dec(moved.bytes)).toContain("![a](n.assets/img-");
  });

  test("percorsi: ./ ../ assoluti e codifica", () => {
    expect(resolveRelative("/a/b", "./c.png")).toBe("/a/b/c.png");
    expect(resolveRelative("/a/b", "../c.png")).toBe("/a/c.png");
    expect(resolveRelative("/a/b", "/x/y.png")).toBe("/x/y.png");
    expect(resolveRelative("/a/b", "d%20e.png?raw=1")).toBe("/a/b/d e.png");
  });
});

describe("Markdown: avvisi e altri formati", () => {
  test("elenca ciò che si perderebbe", () => {
    expect(markdownLosses(imp(SAMPLE))).toEqual([]);
    const d = imp("Testo\n");
    paras(d)[0].runs = [{ text: "rosso", props: { color: "#ff0000", font: "Arial" } }];
    paras(d)[0].props.align = "center";
    d.footer = [{ type: "p", id: 99, props: {}, runs: [{ text: "pagina", props: {} }] }];
    expect(markdownLosses(d)).toEqual([]); // colori, font, allineamento, piè di pagina: ora si salvano (HTML e commento nascosto)
    paras(d)[0].runs = [{ text: "a\tb", props: {} }];
    d.comments = [{ id: 1, author: "x", date: "", text: "t", quote: "q" }];
    expect(markdownLosses(d).sort()).toEqual(["commenti", "tabulazioni"]);
  });

  test("Markdown → .docx → Markdown conserva la struttura", () => {
    const md1 = rt(SAMPLE);
    const viaDocx = importDocx(exportDocx(imp(md1)));
    const md2 = dec(exportMarkdown(viaDocx));
    for (const piece of ["# Titolo *uno*", "## Elenchi", "- uno", "  - due-a", "**grassetto**", "[un link](https://example.it/a_b)", "| Pera | 3 | 1,5 |", "```", "def f(x):", "> Citazione"]) {
      expect(md2, piece).toContain(piece);
    }
  });
});

describe("Markdown: codice dentro gli elenchi", () => {
  test("il blocco resta nella voce e le voci seguenti mantengono il livello", () => {
    const md = "1. Passo\n   - Mostra:\n     ```bash\n     cc --plugin-dir x\n     ```\n   - Oppure copia\n2. Fine\n";
    const out = rt(md);
    expect(out).toBe(md);
    expect(rt(out)).toBe(out);
  });
});

describe("Markdown: voci di elenco con più paragrafi e codice adiacente", () => {
  test("il secondo paragrafo resta nella voce", () => {
    const md = "- Uno\n\n  Altro paragrafo di uno\n\n  - sotto\n- Due\n";
    const out = rt(md);
    expect(out).toBe(md);
    expect(markdownLosses(imp(md))).toEqual([]);
  });

  test("due pezzi di codice vicini non diventano un'unica barriera di apici", () => {
    const out = rt("Vedi `MAP_HUGE_`_`SIZE`_ ora\n");
    expect(out).toBe("Vedi `MAP_HUGE_SIZE` ora\n");
  });
});

test("Markdown: voce-contenitore vuota (- - testo) mantiene il livello", () => {
  const out = rt("- - uno\n  - due\n- tre\n");
  expect(out).toBe("-\n  - uno\n  - due\n- tre\n");
  expect(rt(out)).toBe(out);
});

describe("Markdown: stile completo (HTML e commento nascosto)", () => {
  const styled = () => {
    const d = imp("# Titolo\n\nTesto normale\n\nSecondo\n\n| A | B |\n|---|---|\n| 1 | 2 |\n");
    const [h, p1, p2] = paras(d);
    p1.runs = [
      { text: "rosso ", props: { color: "#ff0000", bold: true } },
      { text: "grande Arial ", props: { size: 18, font: "Arial", color: "#ff0000" } },
      { text: "evidenziato", props: { highlight: "#ffff00", italic: true } },
      { text: " e normale", props: {} },
    ];
    p1.props.align = "center";
    p1.props.indentLeft = 36;
    p1.props.spaceAfter = 20;
    p1.props.line = 1.5; p1.props.lineRule = "auto";
    p1.props.shading = "#eeeeee";
    p2.props.style = "Caption";
    h.props.align = "right";
    d.styles.Heading1 = { ...d.styles.Heading1, run: { ...d.styles.Heading1.run, color: "#aa0000", size: 22 } };
    d.styles.MioStile = { id: "MioStile", name: "Mio stile", type: "paragraph", basedOn: "Normal", run: { color: "#00aa00" } };
    p2.props.style = "MioStile";
    d.page = { ...d.page, marginLeft: 100, marginTop: 30 };
    d.header = [{ type: "p", id: 900, props: {}, runs: [{ text: "Intestazione", props: { bold: true } }] }];
    d.footer = [{ type: "p", id: 901, props: { align: "center" }, runs: [{ text: "Pagina ", props: {} }, { type: "field", field: "PAGE", props: {} }] }];
    d.watermark = "BOZZA";
    const t = d.blocks.find((b): b is Table => b.type === "table")!;
    t.grid = [100, 300];
    t.rows[1].cells[1].shading = "#ccffcc";
    t.borders = null;
    return d;
  };

  test("tutto torna identico dopo salva e riapri", () => {
    const d = styled();
    const out = dec(exportMarkdown(d));
    const back = imp(out);
    const [h, p1, p2] = paras(back);
    const runs = p1.runs.filter((r) => !r.type) as { text: string; props: Record<string, unknown> }[];
    expect(runs.map((r) => r.text).join("")).toBe("rosso grande Arial evidenziato e normale");
    const by = (t: string) => runs.find((r) => r.text.trim() === t)!.props;
    expect(by("rosso")).toMatchObject({ color: "#ff0000", bold: true });
    expect(by("grande Arial")).toMatchObject({ size: 18, font: "Arial", color: "#ff0000" });
    expect(by("evidenziato")).toMatchObject({ highlight: "#ffff00", italic: true });
    expect(runs[runs.length - 1].props).toEqual({});
    expect(p1.props).toMatchObject({ align: "center", indentLeft: 36, spaceAfter: 20, line: 1.5, lineRule: "auto", shading: "#eeeeee" });
    expect(h.props).toMatchObject({ style: "Heading1", align: "right" });
    expect(p2.props.style).toBe("MioStile");
    expect(back.styles.Heading1.run).toMatchObject({ color: "#aa0000", size: 22 });
    expect(back.styles.MioStile.run?.color).toBe("#00aa00");
    expect(back.page).toMatchObject({ marginLeft: 100, marginTop: 30 });
    expect(back.header.map(paragraphText)).toEqual(["Intestazione"]);
    expect(back.footer[0].props.align).toBe("center");
    expect(back.footer[0].runs.some((r) => r.type === "field")).toBe(true);
    expect(back.watermark).toBe("BOZZA");
    const t = back.blocks.find((b): b is Table => b.type === "table")!;
    expect(t.grid).toEqual([100, 300]);
    expect(t.rows[1].cells[1].shading).toBe("#ccffcc");
    expect(t.borders).toBeNull();
    expect(markdownLosses(d)).toEqual([]);
    // dopo la prima normalizzazione, convertire ancora non cambia più nulla
    const out2 = dec(exportMarkdown(back));
    expect(dec(exportMarkdown(imp(out2)))).toBe(out2);
  });

  test("lo stile resta leggibile ad altri programmi: HTML standard, il commento è nascosto", () => {
    const out = dec(exportMarkdown(styled()));
    expect(out).toContain('<span style="color:#ff0000">');
    expect(out).toContain("<div align=\"right\">");
    expect(out).toContain("# Titolo");
    expect(out).toMatch(/\n<!-- zikoffice:\{.*\} -->\n$/);
    expect(out).not.toMatch(/-->[\s\S]*-->/);
  });

  test("un documento senza stili particolari resta Markdown pulito", () => {
    const out = rt(SAMPLE);
    expect(out).not.toContain("<div");
    expect(out).not.toContain("<span");
    expect(out).not.toContain("<!--");
  });

  test("HTML scritto a mano (README di GitHub) si legge: titolo centrato, span colorati, immagine con larghezza", () => {
    const d = imp('<h1 align="center">Progetto</h1>\n\n<div align="center">\n\nTesto <span style="color: rgb(0, 128, 0); font-size: 16px">verde</span> e <font>x</font>\n\n</div>\n\n<p align="right"><img src="a.png" width="120"></p>\n');
    const ps = paras(d);
    expect(ps[0].props).toMatchObject({ style: "Heading1", align: "center" });
    expect(paragraphText(ps[0])).toBe("Progetto");
    expect(ps[1].props.align).toBe("center");
    const green = ps[1].runs.find((r) => !r.type && r.text === "verde") as { props: Record<string, unknown> };
    expect(green.props).toMatchObject({ color: "#008000", size: 12 });
    expect(ps[2].props.align).toBe("right");
    const im = ps[2].runs[0] as ImageRun;
    expect(im).toMatchObject({ type: "image", width: 90 });
  });

  test("immagine ridimensionata → <img width height>; non ridimensionata → sintassi Markdown", () => {
    const url = `data:image/png;base64,${b64(png(200, 100))}`;
    const d = imp(`![x](${url})\n`);
    expect(dec(exportMarkdown(d))).toContain(`![x](${url})`);
    const im = paras(d)[0].runs[0] as ImageRun;
    im.width = 60; im.height = 30;
    const out = dec(exportMarkdown(d));
    expect(out).toContain(`<img src="${url}" alt="x" width="80" height="40">`);
    const back = paras(imp(out))[0].runs[0] as ImageRun;
    expect(back).toMatchObject({ width: 60, height: 30 });
  });

  test("tag HTML dentro frasi non rompono il testo accanto (span annidati e chiusi)", () => {
    const d = imp('a <span style="color:#ff0000">r <b>g</b> r</span> n\n');
    const runs = paras(d)[0].runs.filter((r) => !r.type) as { text: string; props: Record<string, unknown> }[];
    expect(runs.map((r) => [r.text, r.props.color, r.props.bold])).toEqual([["a ", undefined, undefined], ["r ", "#ff0000", undefined], ["g", "#ff0000", true], [" r", "#ff0000", undefined], [" n", undefined, undefined]]);
  });
});

describe("Markdown: vista sorgente", () => {
  const url = `data:image/png;base64,${b64(png(200, 100))}`;

  test("il sorgente non contiene base64 né il commento nascosto, e si rilegge senza perdere immagini e stile", async () => {
    const { markdownSource, markdownFromSource } = await import("../src/doc/markdown");
    const d = imp(`# Titolo\n\nUno ![foto](${url}) due\n`);
    paras(d)[0].props.align = "center";
    d.page = { ...d.page, marginLeft: 99 };
    const src = markdownSource(d);
    expect(src.text).not.toContain("base64");
    expect(src.text).not.toContain("zikoffice:");
    expect(src.text).toContain("![foto](immagini/img-");
    expect(src.text).toContain('<div align="center">');
    const edited = src.text.replace("Uno", "Zero").replace("# Titolo", "## Nuovo titolo");
    const back = markdownFromSource(d, edited, src.images);
    expect(paras(back).map(paragraphText).slice(0, 2)).toEqual(["Nuovo titolo", "Zero ￼ due"]);
    expect(paras(back)[0].props).toMatchObject({ style: "Heading2", align: "center" });
    expect(back.page.marginLeft).toBe(99);
    const im = paras(back)[1].runs.find((r): r is ImageRun => r.type === "image")!;
    expect(im).toMatchObject({ src: url, width: 150, height: 75, alt: "foto" });
  });
});
