// @vitest-environment jsdom
import { expect, test } from "vitest";
import { shouldCheck, wordsIn } from "../src/doc/spell";

test("le parole si dividono tenendo unite le elisioni", () => {
  expect(wordsIn("Dell'acqua, un’altra prova: perché? 42 euro").map((w) => w.word))
    .toEqual(["Dell'acqua", "un'altra", "prova", "perché", "euro"]);
  const [w] = wordsIn("  ciao");
  expect([w.start, w.end]).toEqual([2, 6]);
});

test("sigle e lettere singole non si controllano", () => {
  expect(shouldCheck("ONU")).toBe(false);
  expect(shouldCheck("a")).toBe(false);
  expect(shouldCheck("casa")).toBe(true);
});
