// Grafici interattivi (Colonne, Linee, Torta) sopra il foglio di calcolo, con esportazione SVG per stampa/PDF.
import { localeTag } from "../i18n";
import { h } from "../dom";
import type { Model } from "./engine";

export type ChartType = "column" | "line" | "pie";

export interface ChartSpec {
  id: number;
  sheet: number;
  type: ChartType;
  title: string;
  range: { r0: number; c0: number; r1: number; c1: number };
  x: number;
  y: number;
  w: number;
  h: number;
}

const PALETTE = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#0891b2", "#dc2626", "#ca8a04", "#4f46e5"];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parseNum(s: string): number {
  const cleaned = s.replace(/[€$£%\s]/g, "").replace(/\.(?=\d{3}(?:[,\s]|$))/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

interface SeriesData {
  labels: string[];
  series: { name: string; values: number[] }[];
}

export function extractChartData(model: Model, spec: ChartSpec): SeriesData {
  const { r0, c0, r1, c1 } = spec.range;
  const rows = r1 - r0 + 1, cols = c1 - c0 + 1;
  const cell = (r: number, c: number) => model.getFormattedCellValue(spec.sheet, r, c).trim();

  // Se la prima riga contiene testo (intestazioni) e ci sono almeno 2 righe, la usiamo come nomi delle serie.
  const firstRowText = rows > 1 && Array.from({ length: Math.max(1, cols - 1) }, (_, i) => cell(r0, c0 + (cols > 1 ? i + 1 : 0)))
    .some((v) => v !== "" && Number.isNaN(Number(v.replace(",", "."))));
  const dataStart = firstRowText ? r0 + 1 : r0;

  if (cols === 1) {
    const labels: string[] = [];
    const values: number[] = [];
    for (let r = dataStart; r <= r1; r++) {
      labels.push(String(r - dataStart + 1));
      values.push(parseNum(cell(r, c0)));
    }
    return { labels, series: [{ name: firstRowText ? cell(r0, c0) || "Valori" : "Valori", values }] };
  }

  const labels: string[] = [];
  for (let r = dataStart; r <= r1; r++) labels.push(cell(r, c0) || String(r - dataStart + 1));

  const series: { name: string; values: number[] }[] = [];
  for (let c = c0 + 1; c <= c1; c++) {
    const name = firstRowText ? (cell(r0, c) || `Serie ${c - c0}`) : `Serie ${c - c0}`;
    const values: number[] = [];
    for (let r = dataStart; r <= r1; r++) values.push(parseNum(cell(r, c)));
    series.push({ name, values });
  }
  return { labels, series };
}

export function renderChartSvg(model: Model, spec: ChartSpec, width = spec.w - 16, height = spec.h - 42): string {
  const W = Math.max(180, width), H = Math.max(120, height);
  const { labels, series } = extractChartData(model, spec);
  if (!labels.length || !series.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#6b7280" font-size="12">Seleziona un intervallo di dati</text></svg>`;
  }

  if (spec.type === "pie") {
    const vals = series[0].values.map((v) => Math.max(0, v));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = W * 0.36, cy = H * 0.52, radius = Math.max(24, Math.min(cx - 14, cy - 14));
    let angle = -Math.PI / 2;
    let paths = "";
    let legend = "";
    vals.forEach((v, i) => {
      const slice = (v / total) * Math.PI * 2;
      const color = PALETTE[i % PALETTE.length];
      if (slice > 0.001) {
        const x1 = cx + Math.cos(angle) * radius, y1 = cy + Math.sin(angle) * radius;
        const x2 = cx + Math.cos(angle + slice) * radius, y2 = cy + Math.sin(angle + slice) * radius;
        const large = slice > Math.PI ? 1 : 0;
        paths += slice >= Math.PI * 1.999
          ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"/>`
          : `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${radius},${radius} 0 ${large},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${color}" stroke="#fff" stroke-width="1"><title>${esc(labels[i])}: ${v.toLocaleString(localeTag())} (${Math.round((v / total) * 100)}%)</title></path>`;
      }
      angle += slice;
      const ly = 18 + i * 16;
      if (ly < H - 6) {
        const lx = W * 0.68;
        legend += `<rect x="${lx}" y="${ly - 8}" width="9" height="9" rx="2" fill="${color}"/><text x="${lx + 13}" y="${ly}" font-size="10" fill="#374151">${esc(labels[i].slice(0, 14))} (${Math.round((v / total) * 100)}%)</text>`;
      }
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="font-family:sans-serif">${paths}${legend}</svg>`;
  }

  const padL = 44, padR = 14, padT = 14, padB = series.length > 1 ? 42 : 26;
  const plotW = Math.max(60, W - padL - padR), plotH = Math.max(40, H - padT - padB);
  const allVals = series.flatMap((s) => s.values);
  const minV = Math.min(0, ...allVals), maxV = Math.max(1, ...allVals);
  const span = maxV - minV || 1;
  const yOf = (v: number) => padT + plotH - ((v - minV) / span) * plotH;

  let grid = "";
  for (let t = 0; t <= 4; t++) {
    const val = minV + (span * t) / 4;
    const y = yOf(val);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`;
    grid += `<text x="${padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#6b7280">${Math.round(val * 100) / 100}</text>`;
  }

  let body = "";
  const stepX = plotW / Math.max(1, labels.length);
  if (spec.type === "column") {
    const groupW = stepX * 0.72;
    const barW = Math.max(3, groupW / series.length);
    const y0 = yOf(0);
    labels.forEach((lbl, i) => {
      const gx = padL + i * stepX + (stepX - groupW) / 2;
      series.forEach((s, si) => {
        const v = s.values[i] ?? 0;
        const y = yOf(v);
        const hBar = Math.max(1, Math.abs(y - y0));
        const top = Math.min(y, y0);
        body += `<rect x="${(gx + si * barW).toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(2, barW - 1).toFixed(1)}" height="${hBar.toFixed(1)}" rx="2" fill="${PALETTE[si % PALETTE.length]}"><title>${esc(lbl)} · ${esc(s.name)}: ${v.toLocaleString(localeTag())}</title></rect>`;
      });
      if (labels.length <= 14 || i % Math.ceil(labels.length / 10) === 0) {
        body += `<text x="${(padL + i * stepX + stepX / 2).toFixed(1)}" y="${padT + plotH + 13}" text-anchor="middle" font-size="9" fill="#4b5563">${esc(lbl.slice(0, 10))}</text>`;
      }
    });
  } else {
    // Linee
    series.forEach((s, si) => {
      const color = PALETTE[si % PALETTE.length];
      const pts = labels.map((_, i) => [padL + i * stepX + stepX / 2, yOf(s.values[i] ?? 0)] as const);
      const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
      body += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`;
      pts.forEach(([x, y], i) => {
        body += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}"><title>${esc(labels[i])} · ${esc(s.name)}: ${(s.values[i] ?? 0).toLocaleString(localeTag())}</title></circle>`;
      });
    });
    labels.forEach((lbl, i) => {
      if (labels.length <= 14 || i % Math.ceil(labels.length / 10) === 0) {
        body += `<text x="${(padL + i * stepX + stepX / 2).toFixed(1)}" y="${padT + plotH + 13}" text-anchor="middle" font-size="9" fill="#4b5563">${esc(lbl.slice(0, 10))}</text>`;
      }
    });
  }

  let legend = "";
  if (series.length > 1) {
    series.forEach((s, si) => {
      const lx = padL + si * 90;
      if (lx < W - 40) {
        legend += `<rect x="${lx}" y="${H - 12}" width="8" height="8" rx="2" fill="${PALETTE[si % PALETTE.length]}"/><text x="${lx + 11}" y="${H - 5}" font-size="9" fill="#374151">${esc(s.name.slice(0, 12))}</text>`;
      }
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="font-family:sans-serif">${grid}${body}${legend}</svg>`;
}

export class ChartLayer {
  readonly el = h("div", { style: "position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden" });
  readonly charts: ChartSpec[] = [];
  private nextId = 1;

  constructor(private model: Model, private activeSheet: () => number, private onChange: () => void) {}

  add(type: ChartType, range: { r0: number; c0: number; r1: number; c1: number }, title?: string): ChartSpec {
    const offset = (this.charts.filter((c) => c.sheet === this.activeSheet()).length % 5) * 24;
    const spec: ChartSpec = {
      id: this.nextId++,
      sheet: this.activeSheet(),
      type,
      title: title ?? (type === "column" ? "Grafico a colonne" : type === "line" ? "Grafico a linee" : "Grafico a torta"),
      range,
      x: 120 + offset,
      y: 70 + offset,
      w: 380,
      h: 240,
    };
    this.charts.push(spec);
    this.render();
    this.onChange();
    return spec;
  }

  forSheet(sheet: number): ChartSpec[] {
    return this.charts.filter((c) => c.sheet === sheet);
  }

  render(): void {
    this.el.replaceChildren();
    const sheet = this.activeSheet();
    for (const spec of this.charts) {
      if (spec.sheet !== sheet) continue;
      const card = h("div", {
        style: `position:absolute;left:${spec.x}px;top:${spec.y}px;width:${spec.w}px;height:${spec.h}px;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.12);pointer-events:auto;display:flex;flex-direction:column;user-select:none;color:#111827`,
      });
      const titleSpan = h("span", { style: "font-size:12px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text" }, spec.title);
      titleSpan.ondblclick = (e) => {
        e.stopPropagation();
        const next = window.prompt("Titolo del grafico:", spec.title);
        if (next !== null && next.trim()) { spec.title = next.trim(); this.render(); }
      };
      const delBtn = h("button", {
        title: "Elimina grafico",
        style: "border:none;background:transparent;cursor:pointer;color:#64748b;font-size:14px;line-height:1;padding:2px 4px",
        onclick: (e: Event) => {
          e.stopPropagation();
          const idx = this.charts.indexOf(spec);
          if (idx >= 0) this.charts.splice(idx, 1);
          this.render();
          this.onChange();
        },
      }, "×");
      const header = h("div", { style: "display:flex;align-items:center;padding:6px 8px 2px;cursor:move;gap:6px;border-bottom:1px solid #f1f5f9" }, titleSpan, delBtn);
      header.onpointerdown = (e) => {
        if (e.target === delBtn) return;
        e.preventDefault();
        const x0 = e.clientX - spec.x, y0 = e.clientY - spec.y;
        const move = (ev: PointerEvent) => { spec.x = Math.max(0, ev.clientX - x0); spec.y = Math.max(0, ev.clientY - y0); card.style.left = `${spec.x}px`; card.style.top = `${spec.y}px`; };
        const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      };
      const body = h("div", { style: "flex:1;padding:4px 8px;overflow:hidden" });
      body.innerHTML = renderChartSvg(this.model, spec);

      const handle = h("div", { style: "position:absolute;right:0;bottom:0;width:12px;height:12px;cursor:nwse-resize" });
      handle.onpointerdown = (e) => {
        e.stopPropagation(); e.preventDefault();
        const x0 = e.clientX, y0 = e.clientY, w0 = spec.w, h0 = spec.h;
        const move = (ev: PointerEvent) => {
          spec.w = Math.max(220, w0 + ev.clientX - x0);
          spec.h = Math.max(150, h0 + ev.clientY - y0);
          card.style.width = `${spec.w}px`; card.style.height = `${spec.h}px`;
          body.innerHTML = renderChartSvg(this.model, spec);
        };
        const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      };

      card.append(header, body, handle);
      this.el.append(card);
    }
  }
}
