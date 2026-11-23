// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { getOffsets, runsInRange, setOffsets, wordAround } from "../src/slides/edit";
import { placeItems, layoutBoxes } from "../src/slides/layout";
import { deserializePresentation, newPresentation, newSlide, paraText, serializePresentation, type ImageItem, type Presentation, type ShapeItem, type TableItem } from "../src/slides/model";
import { exportPptx } from "../src/slides/pptxExport";
import { importPptx } from "../src/slides/pptxImport";
import { fillText, readText } from "../src/slides/text";
import { DEFAULT_THEME, THEMES } from "../src/slides/themes";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNk+M9Qz8DAwAAAEIwB/0y0u4EAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

function body(p: Presentation, slideIndex = 0): ShapeItem {
  return p.slides[slideIndex].items.find((i): i is ShapeItem => i.kind === "shape" && i.role === "body")!;
}

function sampleDeck(): Presentation {
  const p = newPresentation(DEFAULT_THEME);
  const title = p.slides[0].items[0] as ShapeItem;
  title.paras = [{ runs: [{ text: "Bilancio 2026 & <prove>" }], level: 0 }];
  (p.slides[0].items[1] as ShapeItem).paras = [{ runs: [{ text: "Sottotitolo" }], level: 0 }];
  const s = newSlide(p, "content");
  p.slides.push(s);
  (s.items[0] as ShapeItem).paras = [{ runs: [{ text: "Risultati" }], level: 0 }];
  body(p, 1).paras = [
    { runs: [{ text: "Ricavi " }, { text: "+12%", b: true, color: "#c00000" }], level: 0 },
    { runs: [{ text: "Italia" }], level: 1 },
    { runs: [{ text: "Riga\nspezzata" }], level: 0, bullet: "number", align: "ctr" },
  ];
  s.items.push({ kind: "image", id: p.nextId++, bytes: PNG, mime: "image/png", natW: 2, natH: 1, alt: "grafico" });
  s.notes = "Ricordarsi di citare il trimestre";
  const t = newSlide(p, "titleOnly");
  t.hidden = true;
  const table: TableItem = { kind: "table", id: p.nextId++, header: true, rows: [[{ paras: [{ runs: [{ text: "A" }], level: 0 }] }, { paras: [{ runs: [{ text: "B" }], level: 0 }] }], [{ paras: [{ runs: [{ text: "1" }], level: 0 }] }, { paras: [{ runs: [{ text: "2" }], level: 0 }] }]] };
  t.items.push(table, { kind: "shape", id: p.nextId++, role: "text", geom: "ellipse", fill: "#2f6fd6", line: null, frame: { x: 100, y: 300, w: 120, h: 80 }, paras: [{ runs: [{ text: "Forma" }], level: 0 }] });
  p.slides.push(t);
  return p;
}

describe("disposizione automatica", () => {
  test("titolo e contenuto stanno nei posti del tema", () => {
    const p = newPresentation(DEFAULT_THEME);
    const s = newSlide(p, "content");
    const placed = placeItems(p, s);
    const boxes = layoutBoxes(p, "content");
    expect(placed[0].frame).toEqual(boxes.title);
    expect(placed[1].frame).toEqual(boxes.body);
  });

  test("un testo e un'immagine si dividono lo spazio; l'immagine mantiene le proporzioni", () => {
    const p = newPresentation(DEFAULT_THEME);
    const s = newSlide(p, "content");
    (s.items[1] as ShapeItem).paras = [{ runs: [{ text: "Punto" }], level: 0 }];
    s.items.push({ kind: "image", id: 99, bytes: PNG, mime: "image/png", natW: 400, natH: 200 });
    const [, text, img] = placeItems(p, s);
    const area = layoutBoxes(p, "content").body!;
    expect(text.frame.x).toBeCloseTo(area.x);
    expect(text.frame.w).toBeLessThan(area.w / 2);
    expect(img.frame.x).toBeGreaterThan(text.frame.x + text.frame.w);
    expect(img.frame.w / img.frame.h).toBeCloseTo(2);
    expect(img.frame.x + img.frame.w).toBeLessThanOrEqual(area.x + area.w + 0.01);
  });

  test("più immagini vanno in griglia dentro la zona del contenuto", () => {
    const p = newPresentation(DEFAULT_THEME);
    const s = newSlide(p, "titleOnly");
    for (let i = 0; i < 4; i++) s.items.push({ kind: "image", id: 100 + i, bytes: PNG, mime: "image/png", natW: 300, natH: 300 });
    const area = layoutBoxes(p, "titleOnly").body!;
    const frames = placeItems(p, s).slice(1).map((pl) => pl.frame);
    for (const f of frames) {
      expect(f.x).toBeGreaterThanOrEqual(area.x - 0.01);
      expect(f.y).toBeGreaterThanOrEqual(area.y - 0.01);
      expect(f.x + f.w).toBeLessThanOrEqual(area.x + area.w + 0.01);
      expect(f.y + f.h).toBeLessThanOrEqual(area.y + area.h + 0.01);
    }
    // Nessuna sovrapposizione
    for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) {
      const a = frames[i], b = frames[j];
      expect(a.x + a.w <= b.x + 0.01 || b.x + b.w <= a.x + 0.01 || a.y + a.h <= b.y + 0.01 || b.y + b.h <= a.y + 0.01).toBe(true);
    }
  });

  test("un elemento spostato a mano resta dov'è", () => {
    const p = newPresentation(DEFAULT_THEME);
    const s = newSlide(p, "content");
    s.items[1].frame = { x: 10, y: 20, w: 30, h: 40 };
    expect(placeItems(p, s)[1]).toMatchObject({ frame: { x: 10, y: 20, w: 30, h: 40 }, auto: false });
  });
});

describe("testo dei riquadri", () => {
  test("dal modello al DOM e ritorno, con formattazione", () => {
    const box = document.createElement("div");
    const paras = [
      { runs: [{ text: "Uno " }, { text: "due", b: true, color: "#ff0000", size: 30 }], level: 0 },
      { runs: [{ text: "a\ncapo" }], level: 2, bullet: "number" as const },
      { runs: [], level: 0 },
    ];
    fillText(box, paras, "body", { size: 24, color: "#000", font: "Calibri", bold: false, align: "l", anchor: "t", bullets: true });
    document.body.append(box);
    const back = readText(box);
    expect(back).toHaveLength(3);
    expect(back[0].runs).toEqual([{ text: "Uno " }, { text: "due", b: true, color: "#ff0000", size: 30 }]);
    expect(back[1]).toMatchObject({ level: 2, bullet: "number", runs: [{ text: "a\ncapo" }] });
    expect(back[2].runs).toEqual([]);
    // Selezione ↔ posizione nel testo
    setOffsets(box, 6, 9);
    expect(getOffsets(box)).toEqual({ start: 6, end: 9 });
    setOffsets(box, 10);
    expect(getOffsets(box)).toEqual({ start: 10, end: 10 });
    box.remove();
  });

  test("formattazione per intervalli e parola sotto il cursore", () => {
    const paras = [{ runs: [{ text: "ciao mondo" }], level: 0 }, { runs: [{ text: "altro" }], level: 0 }];
    for (const r of runsInRange(paras, 5, 13)) r.b = true;
    expect(paras[0].runs).toEqual([{ text: "ciao " }, { text: "mondo", b: true }]);
    expect(paras[1].runs).toEqual([{ text: "al", b: true }, { text: "tro" }]);
    expect(wordAround(paras, 7)).toEqual([5, 10]);
  });
});

function partsOf(bytes: Uint8Array): Record<string, string> {
  const z = unzipSync(bytes);
  return Object.fromEntries(Object.entries(z).filter(([k]) => /\.(xml|rels)$/.test(k)).map(([k, v]) => [k, strFromU8(v)]));
}

describe("salvataggio .pptx", () => {
  test("il pacchetto è coerente: XML valido, tipi e relazioni per ogni parte", () => {
    const bytes = exportPptx(sampleDeck());
    const zip = unzipSync(bytes);
    const xml = partsOf(bytes);
    for (const [name, text] of Object.entries(xml)) {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      expect(doc.getElementsByTagName("parsererror").length, name).toBe(0);
    }
    const ct = new DOMParser().parseFromString(xml["[Content_Types].xml"], "application/xml");
    const overrides = new Set([...ct.getElementsByTagName("Override")].map((o) => o.getAttribute("PartName")!.slice(1)));
    const defaults = new Set([...ct.getElementsByTagName("Default")].map((o) => o.getAttribute("Extension")!));
    for (const name of Object.keys(zip)) {
      if (name === "[Content_Types].xml") continue;
      expect(overrides.has(name) || defaults.has(name.split(".").pop()!), name).toBe(true);
    }
    for (const o of overrides) expect(zip[o], o).toBeDefined();
    // Ogni relazione interna punta a una parte esistente.
    for (const [name, text] of Object.entries(xml)) {
      if (!name.endsWith(".rels")) continue;
      const base = name.replace(/_rels\/[^/]*\.rels$/, "");
      for (const r of new DOMParser().parseFromString(text, "application/xml").getElementsByTagName("Relationship")) {
        if (r.getAttribute("TargetMode") === "External") continue;
        const parts = (base + r.getAttribute("Target")!).split("/");
        const out: string[] = [];
        for (const seg of parts) { if (seg === "..") out.pop(); else if (seg && seg !== ".") out.push(seg); }
        expect(zip[out.join("/")], `${name} → ${r.getAttribute("Target")}`).toBeDefined();
      }
    }
    // Gli id delle forme non si ripetono in una diapositiva.
    for (const [name, text] of Object.entries(xml)) {
      if (!/ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
      const ids = [...text.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size, name).toBe(ids.length);
    }
    expect(xml["ppt/presentation.xml"]).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
    expect(xml["ppt/slides/slide1.xml"]).toContain("Bilancio 2026 &amp; &lt;prove&gt;");
    expect(xml["ppt/slides/slide1.xml"]).toContain('<p:ph type="ctrTitle"/>');
    expect(xml["ppt/slides/slide3.xml"]).toContain('show="0"');
  });

  test("salva e riapre: testo, livelli, formato, immagini, tabelle, note, diapositive nascoste", () => {
    const p = sampleDeck();
    const back = importPptx(exportPptx(p));
    expect(back.slides).toHaveLength(3);
    expect(back.width).toBeCloseTo(960);
    expect(back.height).toBeCloseTo(540);
    expect(back.slides.map((s) => s.layout)).toEqual(["title", "content", "titleOnly"]);
    const t = back.slides[0].items.find((i): i is ShapeItem => i.kind === "shape" && i.role === "title")!;
    expect(paraText(t.paras[0])).toBe("Bilancio 2026 & <prove>");
    const b = body(back, 1);
    expect(b.paras.map((q) => [paraText(q), q.level, q.bullet])).toEqual([["Ricavi +12%", 0, "bullet"], ["Italia", 1, "bullet"], ["Riga\nspezzata", 0, "number"]]);
    expect(b.paras[0].runs[1]).toMatchObject({ text: "+12%", b: true, color: "#c00000" });
    expect(b.paras[2].align).toBe("ctr");
    const img = back.slides[1].items.find((i): i is ImageItem => i.kind === "image")!;
    expect([...img.bytes]).toEqual([...PNG]);
    expect(img.alt).toBe("grafico");
    expect(back.slides[1].notes).toBe("Ricordarsi di citare il trimestre");
    expect(back.slides[2].hidden).toBe(true);
    const tb = back.slides[2].items.find((i): i is TableItem => i.kind === "table")!;
    expect(tb.rows.map((r) => r.map((c) => paraText(c.paras[0])))).toEqual([["A", "B"], ["1", "2"]]);
    expect(tb.header).toBe(true);
    const shape = back.slides[2].items.find((i): i is ShapeItem => i.kind === "shape" && i.geom === "ellipse")!;
    expect(shape.fill).toBe("#2f6fd6");
    expect(shape.frame).toMatchObject({ x: 100, y: 300, w: 120, h: 80 });
    // Il tema torna con colori e font
    expect(back.theme.accent).toBe(DEFAULT_THEME.accent);
    expect(back.theme.headingFont).toBe(DEFAULT_THEME.headingFont);
  });

  test("tutti i temi e le dimensioni 4:3 producono un file valido", () => {
    for (const th of THEMES) {
      const p = sampleDeck();
      p.theme = { ...th };
      p.width = 720;
      const xml = partsOf(exportPptx(p));
      expect(xml["ppt/presentation.xml"]).toContain('type="screen4x3"');
      for (const [name, text] of Object.entries(xml)) {
        expect(new DOMParser().parseFromString(text, "application/xml").getElementsByTagName("parsererror").length, `${th.id} ${name}`).toBe(0);
      }
    }
  });

  test("gli elementi non modificabili (grafici) tornano nel file con le loro parti", () => {
    const p = sampleDeck();
    const chartXml = '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>';
    p.parts["ppt/charts/chart7.xml"] = { bytes: new TextEncoder().encode(chartXml), type: "application/vnd.openxmlformats-officedocument.drawingml.chart+xml" };
    p.slides[1].items.push({
      kind: "raw", id: p.nextId++, frame: { x: 0, y: 0, w: 100, h: 100 }, label: "Grafico",
      xml: '<p:graphicFrame xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:nvGraphicFramePr><p:cNvPr id="44" name="Grafico"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>',
      parts: { rId9: { type: "chart", path: "ppt/charts/chart7.xml" } }, closure: ["ppt/charts/chart7.xml"],
    });
    const bytes = exportPptx(p);
    const xml = partsOf(bytes);
    expect(xml["ppt/charts/chart7.xml"]).toBe(chartXml);
    expect(xml["[Content_Types].xml"]).toContain('PartName="/ppt/charts/chart7.xml"');
    const slide = xml["ppt/slides/slide2.xml"];
    const rid = slide.match(/<c:chart [^>]*r:id="(rId\d+)"/)![1];
    expect(xml["ppt/slides/_rels/slide2.xml.rels"]).toMatch(new RegExp(`Id="${rid}"[^>]*Target="../charts/chart7.xml"`));
    // E si riapre come elemento conservato.
    const back = importPptx(bytes);
    const raw = back.slides[1].items.find((i) => i.kind === "raw");
    expect(raw).toBeDefined();
    expect(back.parts["ppt/charts/chart7.xml"]).toBeDefined();
  });

  test("copia di recupero: JSON con le immagini", () => {
    const p = sampleDeck();
    const back = deserializePresentation(serializePresentation(p));
    const img = back.slides[1].items.find((i): i is ImageItem => i.kind === "image")!;
    expect(img.bytes).toBeInstanceOf(Uint8Array);
    expect([...img.bytes]).toEqual([...PNG]);
  });
});

// Presentazioni vere (non nel repository): PPTX_SAMPLES=cartella npx vitest run tests/slides.test.ts
const SAMPLES = process.env.PPTX_SAMPLES;
describe.skipIf(!SAMPLES || !existsSync(SAMPLES))("presentazioni reali", () => {
  const files = SAMPLES && existsSync(SAMPLES) ? readdirSync(SAMPLES).filter((f) => /\.pptx$/i.test(f)) : [];
  test.each(files)("%s si apre, si salva e si riapre uguale", { timeout: 60000 }, (f) => {
    const p = importPptx(new Uint8Array(readFileSync(`${SAMPLES}/${f}`)));
    expect(p.slides.length).toBeGreaterThan(0);
    const texts = (q: Presentation) => q.slides.map((s) => s.items.filter((i): i is ShapeItem => i.kind === "shape").map((i) => i.paras.map(paraText).join("\n")).join("|"));
    const back = importPptx(exportPptx(p));
    expect(texts(back)).toEqual(texts(p));
    expect(back.slides.map((s) => s.items.length)).toEqual(p.slides.map((s) => s.items.length));
  });
});
