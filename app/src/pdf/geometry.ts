// Corrispondenza tra lo spazio del PDF (origine in basso a sinistra, y verso l'alto, pagina non ruotata)
// e la pagina come si vede (origine in alto a sinistra, y verso il basso, dopo la rotazione della pagina).
// Tutte le misure sono in punti (1/72 di pollice).

export interface PageGeo {
  /** Riquadro visibile in coordinate PDF [x0 y0 x1 y1]. */
  bbox: [number, number, number, number];
  /** Rotazione oraria della pagina: 0, 90, 180 o 270. */
  rotate: number;
  /** Dimensioni a video (già ruotate). */
  width: number;
  height: number;
}

export interface Pt { x: number; y: number }

/** Punto PDF → punto sulla pagina visibile (x = verso destra, y = verso il basso). */
export function toView(g: PageGeo, x: number, y: number): Pt {
  const [x0, y0, x1, y1] = g.bbox;
  switch (g.rotate) {
    case 90: return { x: y - y0, y: x - x0 };
    case 180: return { x: x1 - x, y: y - y0 };
    case 270: return { x: y1 - y, y: x1 - x };
    default: return { x: x - x0, y: y1 - y };
  }
}

/** Punto sulla pagina visibile → punto PDF. */
export function fromView(g: PageGeo, u: number, v: number): Pt {
  const [x0, y0, x1, y1] = g.bbox;
  switch (g.rotate) {
    case 90: return { x: x0 + v, y: y0 + u };
    case 180: return { x: x1 - u, y: y0 + v };
    case 270: return { x: x1 - v, y: y1 - u };
    default: return { x: x0 + u, y: y1 - v };
  }
}

/** Spostamento visibile (du verso destra, dv verso il basso) → spostamento nello spazio PDF. */
export function deltaToPdf(g: PageGeo, du: number, dv: number): Pt {
  switch (g.rotate) {
    case 90: return { x: dv, y: du };
    case 180: return { x: -du, y: dv };
    case 270: return { x: -dv, y: -du };
    default: return { x: du, y: -dv };
  }
}

export interface Box { x0: number; y0: number; x1: number; y1: number }

/** Ingombro PDF [x0 y0 x1 y1] → rettangolo sulla pagina visibile. */
export function bboxToView(g: PageGeo, b: [number, number, number, number]): Box {
  const a = toView(g, b[0], b[1]);
  const c = toView(g, b[2], b[3]);
  return { x0: Math.min(a.x, c.x), y0: Math.min(a.y, c.y), x1: Math.max(a.x, c.x), y1: Math.max(a.y, c.y) };
}

/** Matrice affine PDF [a b c d e f] di uno spostamento. */
export function translateMatrix(dx: number, dy: number): [number, number, number, number, number, number] {
  return [1, 0, 0, 1, dx, dy];
}

/** Matrice di un ingrandimento uniforme `s` attorno al punto PDF (ax, ay). */
export function scaleMatrix(s: number, ax: number, ay: number): [number, number, number, number, number, number] {
  return [s, 0, 0, s, ax - s * ax, ay - s * ay];
}
