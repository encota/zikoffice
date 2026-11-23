// Builds the example presentation shipped in examples/zikoffice-demo.pptx and used for the README screenshots.
// Regenerate it with:  cd app && npx vitest run tests/demo-deck.test.ts   (writes ../examples/zikoffice-demo.pptx)
import { newPresentation, newSlide, type ImageItem, type Presentation, type ShapeItem, type TableItem } from "../src/slides/model";
import { themeById } from "../src/slides/themes";

const text = (item: unknown, ...lines: (string | [string, number])[]) => {
  (item as ShapeItem).paras = lines.map((l) => (typeof l === "string" ? { runs: [{ text: l }], level: 0 } : { runs: [{ text: l[0] }], level: l[1] }));
};

export function demoDeck(logo: Uint8Array, logoW: number, logoH: number): Presentation {
  const p = newPresentation(themeById("notte")!);
  p.title = "ZikOffice";
  const s1 = p.slides[0];
  text(s1.items[0], "ZikOffice");
  text(s1.items[1], "A fast, private office suite for Linux");

  const s2 = newSlide(p, "content");
  text(s2.items[0], "One app, four kinds of files");
  text(s2.items[1],
    "Documents — .docx, .odt, .pages, .md",
    ["Real pages, styles, tables, table of contents", 1],
    "Spreadsheets — .xlsx, .ods, .numbers, .csv",
    "Presentations — .pptx",
    "PDF — move and delete objects, OCR");
  const img: ImageItem = { kind: "image", id: p.nextId++, bytes: logo, mime: "image/png", natW: logoW, natH: logoH, alt: "ZikOffice logo" };
  s2.items.push(img);
  s2.notes = "The picture was added last: it placed itself next to the text, keeping its proportions.";
  p.slides.push(s2);

  const s3 = newSlide(p, "section");
  text(s3.items[0], "The theme decides where things go");
  text(s3.items[1], "Add anything — it arranges itself");
  p.slides.push(s3);

  const s4 = newSlide(p, "two");
  text(s4.items[0], "Simpler than pushing boxes around");
  text(s4.items[1], "Fixed places", ["Title and content always start where the theme says", 1], "Pick another theme and every slide follows");
  text(s4.items[2], "Free space is shared", ["One text and one picture split the slide", 1], "Several pictures form a grid", "Text that is too long shrinks to fit");
  p.slides.push(s4);

  const s5 = newSlide(p, "titleOnly");
  text(s5.items[0], "What it opens and saves");
  const cell = (t: string) => ({ paras: [{ runs: [{ text: t }], level: 0 }] });
  const table: TableItem = {
    kind: "table", id: p.nextId++, header: true, cols: [2, 4, 3],
    rows: [["Kind", "Opens", "Saves"], ["Documents", ".docx .odt .rtf .md .txt .pages", ".docx .odt .md .txt"], ["Spreadsheets", ".xlsx .xls .ods .csv .numbers", ".xlsx .ods .csv"], ["Presentations", ".pptx .ppt .odp", ".pptx"], ["PDF", ".pdf", ".pdf"]].map((r) => r.map(cell)),
  };
  s5.items.push(table);
  p.slides.push(s5);
  return p;
}
