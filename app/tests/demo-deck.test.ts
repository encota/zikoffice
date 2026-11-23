// @vitest-environment jsdom
// Writes examples/zikoffice-demo.pptx (only when ZIK_WRITE_DEMO=1) and checks that the demo deck survives a round trip.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { demoDeck } from "../scripts/demo-deck";
import { exportPptx } from "../src/slides/pptxExport";
import { importPptx } from "../src/slides/pptxImport";

test("demo deck", () => {
  const logo = new Uint8Array(readFileSync(`${process.cwd()}/../brand/zikoffice-mark-256.png`));
  const bytes = exportPptx(demoDeck(logo, 256, 256));
  expect(importPptx(bytes).slides).toHaveLength(5);
  if (process.env.ZIK_WRITE_DEMO) writeFileSync(`${process.cwd()}/../examples/zikoffice-demo.pptx`, bytes);
});
