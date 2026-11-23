import { expect, test } from "vitest";
import { bboxToView, deltaToPdf, fromView, scaleMatrix, toView, type PageGeo } from "../src/pdf/geometry";

const geo = (rotate: number): PageGeo => {
  const bbox: [number, number, number, number] = [10, 20, 310, 420]; // 300 × 400 pt con origine non nulla
  return { bbox, rotate, width: rotate % 180 ? 400 : 300, height: rotate % 180 ? 300 : 400 };
};

test("angoli della pagina: in alto a sinistra a video corrisponde all'angolo giusto del PDF", () => {
  // Pagina non ruotata: l'angolo in alto a sinistra è (x0, y1)
  expect(toView(geo(0), 10, 420)).toEqual({ x: 0, y: 0 });
  // Ruotata di 90° in senso orario: l'angolo PDF in basso a sinistra va in alto a sinistra
  expect(toView(geo(90), 10, 20)).toEqual({ x: 0, y: 0 });
  // 180°: l'angolo PDF in basso a destra va in alto a sinistra
  expect(toView(geo(180), 310, 20)).toEqual({ x: 0, y: 0 });
  // 270° (90° antiorari): l'angolo PDF in alto a destra va in alto a sinistra
  expect(toView(geo(270), 310, 420)).toEqual({ x: 0, y: 0 });
});

test("fromView è l'inverso di toView per ogni rotazione", () => {
  for (const r of [0, 90, 180, 270]) {
    const g = geo(r);
    for (const [x, y] of [[10, 20], [310, 420], [123.5, 77.25], [200, 400]]) {
      const v = toView(g, x, y);
      const back = fromView(g, v.x, v.y);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
    }
  }
});

test("lo spostamento a video diventa quello giusto nel PDF", () => {
  for (const r of [0, 90, 180, 270]) {
    const g = geo(r);
    const p = { x: 100, y: 200 };
    const a = toView(g, p.x, p.y);
    const d = deltaToPdf(g, 15, -8); // 15 verso destra, 8 verso l'alto a video
    const b = toView(g, p.x + d.x, p.y + d.y);
    expect(b.x - a.x).toBeCloseTo(15, 9);
    expect(b.y - a.y).toBeCloseTo(-8, 9);
  }
});

test("un ingombro diventa un rettangolo ordinato a video", () => {
  const b = bboxToView(geo(90), [50, 60, 150, 100]);
  expect(b.x1).toBeGreaterThan(b.x0);
  expect(b.y1).toBeGreaterThan(b.y0);
  expect([b.x1 - b.x0, b.y1 - b.y0]).toEqual([40, 100]); // larghezza e altezza si scambiano
});

test("l'ingrandimento attorno a un punto lo lascia fermo", () => {
  const [a, , , d, e, f] = scaleMatrix(2, 300, 300);
  expect(a * 300 + e).toBe(300);
  expect(d * 300 + f).toBe(300);
  expect(a * 400 + e).toBe(500);
});
