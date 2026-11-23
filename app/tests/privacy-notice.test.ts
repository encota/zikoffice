// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from "vitest";
import { buildNotice, dismissNotice, resetNoticeSession, shouldShowNotice } from "../src/privacyNotice";

function fakeStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("avviso sui dati che escono dal computer", () => {
  beforeEach(() => resetNoticeSession());

  test("si mostra per default", () => {
    expect(shouldShowNotice("0.1.0", fakeStore())).toBe(true);
  });

  test("chiuso senza la casella: nascosto solo in questa sessione, poi ricompare", () => {
    const s = fakeStore();
    dismissNotice("0.1.0", false, s);
    expect(shouldShowNotice("0.1.0", s)).toBe(false);
    resetNoticeSession(); // nuovo avvio
    expect(shouldShowNotice("0.1.0", s)).toBe(true);
  });

  test("con «non mostrare più»: resta nascosto agli avvii successivi", () => {
    const s = fakeStore();
    dismissNotice("0.1.0", true, s);
    resetNoticeSession();
    expect(shouldShowNotice("0.1.0", s)).toBe(false);
  });

  test("dopo un aggiornamento (versione diversa) ricompare", () => {
    const s = fakeStore();
    dismissNotice("0.1.0", true, s);
    resetNoticeSession();
    expect(shouldShowNotice("0.2.0", s)).toBe(true);
  });

  test("senza archivio locale non si rompe", () => {
    expect(shouldShowNotice("0.1.0", null)).toBe(true);
    expect(() => dismissNotice("0.1.0", true, null)).not.toThrow();
  });

  test("il pulsante e la casella funzionano", () => {
    let done = 0;
    const el = buildNotice("0.1.0", () => done++);
    document.body.append(el);
    (el.querySelector("input[type=checkbox]") as HTMLInputElement).checked = true;
    (el.querySelector("button") as HTMLButtonElement).click();
    expect(done).toBe(1);
    expect(shouldShowNotice("0.1.0", { getItem: () => "0.1.0" })).toBe(false);
  });
});
