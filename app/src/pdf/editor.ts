// Editor di PDF: le pagine sono disegnate dal lato Rust (immagine), sopra c'è uno strato che
// conosce gli oggetti di ogni pagina (testo, immagini, grafica) e permette di selezionarli,
// spostarli, ridimensionarli ed eliminarli. L'OCR aggiunge uno strato di testo invisibile.
import { h, toast } from "../dom";
import { alertError, choose, prompt } from "../ui/dialog";
import type { CommandState, DocumentView } from "../views/view";
import * as api from "./api";
import { bboxToView, deltaToPdf, fromView, scaleMatrix, translateMatrix, type Box } from "./geometry";

import { localeTag, t, tr } from "../i18n";
const PT_TO_CSS = 96 / 72;
const GAP = 16;
const OCR_LANG_KEY = "zikoffice.ocrLang";

export interface PdfHost {
  changed(): void;
  selectionChanged(): void;
  /** Il testo del PDF va aperto come documento. */
  extractText(pages: string[]): void;
}

/** Ciò che si seleziona con un clic: un oggetto, oppure una riga di testo fatta di più oggetti vicini. */
interface Unit {
  ids: number[];
  kind: api.ObjKind;
  box: Box;
  text: string | null;
}

interface PageView {
  geo: api.PdfPage;
  wrap: HTMLElement;
  img: HTMLImageElement;
  canvas: HTMLCanvasElement;
  note: HTMLElement;
  objects: api.PdfObject[] | null;
  boxes: Map<number, Box>;
  units: Unit[];
  url: string | null;
  dpi: number;
  loading: boolean;
  /** Serve ridisegnare l'immagine appena la pagina torna disponibile. */
  stale: boolean;
  near: boolean;
}

type Drag =
  | { mode: "move"; page: PageView; u0: number; v0: number; du: number; dv: number; moved: boolean; collapseTo: number[] | null; pxStart: { x: number; y: number } }
  | { mode: "resize"; page: PageView; u0: number; v0: number; scale: number; group: Box }
  | { mode: "band"; page: PageView; u0: number; v0: number; u1: number; v1: number; add: boolean };

export class PdfEditor implements DocumentView {
  readonly kind = "pdf" as const;
  readonly el: HTMLElement;
  dirty = false;

  private scroller: HTMLElement;
  private pagesEl: HTMLElement;
  private banner: HTMLElement;
  private pages: PageView[] = [];
  private zoom = 1;
  private selected: { page: number; ids: Set<number> } | null = null;
  private hover: { page: number; id: number } | null = null;
  private drag: Drag | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private nearObs: IntersectionObserver;
  private farObs: IntersectionObserver;
  private zoomTimer = 0;
  private ocrCancel = false;
  private ocrRunning = false;
  /** Quali tipi di oggetto si possono selezionare. */
  private visible: Record<string, boolean> = { text: true, image: true, path: true, form: true, hidden: false };
  private showBoxes = false;
  /** Il testo vicino sulla stessa riga si seleziona insieme (utile quando ogni lettera è un oggetto a sé). */
  private groupLines = true;
  private canUndo = false;
  private canRedo = false;

  constructor(readonly sessionId: number, pages: api.PdfPage[], _state: CommandState, private host: PdfHost) {
    this.pagesEl = h("div", { class: "pdf-pages" });
    this.scroller = h("div", { class: "pdf-scroller", tabindex: "0", "aria-label": "Pagine del PDF" }, this.pagesEl);
    this.banner = h("div", { class: "pdf-banner", hidden: true });
    this.el = h("div", { class: "pdf-view" }, this.banner, this.scroller);

    // Pagine vicine alla zona visibile: si disegnano; quelle molto lontane si liberano.
    this.nearObs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const p = this.pages[Number((e.target as HTMLElement).dataset.page)];
        p.near = e.isIntersecting;
        if (e.isIntersecting) void this.load(p);
      }
    }, { root: this.scroller, rootMargin: "700px 0px" });
    this.farObs = new IntersectionObserver((entries) => {
      for (const e of entries) if (!e.isIntersecting) this.unload(this.pages[Number((e.target as HTMLElement).dataset.page)]);
    }, { root: this.scroller, rootMargin: "3500px 0px" });

    this.buildPages(pages);
    this.scroller.addEventListener("keydown", (e) => this.onKey(e));
    this.scroller.addEventListener("scroll", () => this.host.selectionChanged());
    void this.refreshUndoState();
  }

  /** (Ri)crea le pagine dal loro elenco: all'apertura e quando se ne cambia il numero, l'ordine o la rotazione. */
  private buildPages(pages: api.PdfPage[]): void {
    for (const p of this.pages) {
      this.nearObs.unobserve(p.wrap);
      this.farObs.unobserve(p.wrap);
      if (p.url) URL.revokeObjectURL(p.url);
    }
    this.pages = [];
    this.pagesEl.replaceChildren();
    this.selected = null;
    this.hover = null;
    for (const geo of pages) {
      const img = h("img", { class: "pdf-img", alt: t("Pagina {0}", geo.index + 1), draggable: "false" });
      const canvas = h("canvas", { class: "pdf-overlay" });
      const note = h("div", { class: "pdf-note" }, t("Pagina {0}", geo.index + 1));
      const wrap = h("div", { class: "pdf-page", "data-page": String(geo.index) }, img, canvas, note);
      const view: PageView = { geo, wrap, img, canvas, note, objects: null, boxes: new Map(), units: [], url: null, dpi: 0, loading: false, stale: false, near: false };
      this.pages.push(view);
      this.pagesEl.append(wrap);
      this.bindPage(view);
      this.nearObs.observe(wrap);
      this.farObs.observe(wrap);
    }
    this.updateSizes();
  }

  /** Esegue un'operazione sulle pagine (ruota, elimina, sposta) e ricostruisce la vista. */
  private pageOp(run: () => Promise<api.PdfPage[]>, focusIndex?: number): Promise<void> {
    const task = this.chain.then(async () => {
      try {
        const pages = await run();
        const top = this.scroller.scrollTop;
        this.buildPages(pages);
        this.dirty = true;
        this.scroller.scrollTop = top;
        if (focusIndex !== undefined) this.scrollToPage(Math.min(focusIndex, this.pages.length - 1));
        this.host.changed();
        await this.refreshUndoState();
      } catch (e) {
        toast(String(e).replace(/^Error:\s*/, ""));
      }
    });
    this.chain = task.catch(() => undefined);
    return task;
  }

  private scrollToPage(index: number): void {
    const p = this.pages[index];
    if (!p) return;
    this.scroller.scrollTop += p.wrap.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - GAP;
  }

  // ---------- dimensioni e disegno delle pagine ----------

  private get scale(): number { return PT_TO_CSS * this.zoom; }

  private updateSizes(): void {
    for (const p of this.pages) {
      p.wrap.style.width = `${p.geo.width * this.scale}px`;
      p.wrap.style.height = `${p.geo.height * this.scale}px`;
      this.sizeCanvas(p);
      this.drawOverlay(p);
    }
    this.pagesEl.style.setProperty("--gap", `${GAP}px`);
  }

  private sizeCanvas(p: PageView): void {
    const dpr = window.devicePixelRatio || 1;
    const w = p.geo.width * this.scale, hgt = p.geo.height * this.scale;
    p.canvas.width = Math.round(w * dpr);
    p.canvas.height = Math.round(hgt * dpr);
    p.canvas.style.width = `${w}px`;
    p.canvas.style.height = `${hgt}px`;
  }

  /** Risoluzione dell'immagine in base allo zoom e allo schermo. */
  private wantedDpi(): number {
    return Math.max(72, Math.min(300, Math.round(96 * this.zoom * (window.devicePixelRatio || 1))));
  }

  private async load(p: PageView, force = false): Promise<void> {
    if (p.loading) { p.stale = true; return; }
    const dpi = this.wantedDpi();
    if (!force && p.url && p.dpi >= dpi && p.objects) return;
    p.loading = true;
    try {
      const wantObjects = force || !p.objects;
      const [blob, objects] = await Promise.all([
        api.pdfRender(this.sessionId, p.geo.index, dpi),
        wantObjects ? api.pdfObjects(this.sessionId, p.geo.index) : Promise.resolve(p.objects!),
      ]);
      const url = URL.createObjectURL(blob);
      const old = p.url;
      await new Promise<void>((resolve) => { p.img.onload = p.img.onerror = () => resolve(); p.img.src = url; });
      p.url = url;
      if (old) URL.revokeObjectURL(old);
      p.dpi = dpi;
      p.note.hidden = true;
      this.setObjects(p, objects);
    } catch (e) {
      p.note.hidden = false;
      p.note.textContent = tr(String(e).replace(/^Error:\s*/, ""));
      p.note.classList.add("error");
    } finally {
      p.loading = false;
      if (p.stale) { p.stale = false; if (p.near) void this.load(p); }
    }
  }

  private unload(p: PageView): void {
    if (p.loading || !p.url) return;
    URL.revokeObjectURL(p.url);
    p.url = null;
    p.img.removeAttribute("src");
    p.dpi = 0;
    p.note.hidden = false;
    p.note.classList.remove("error");
    p.note.textContent = t("Pagina {0}", p.geo.index + 1);
    if (this.selected?.page === p.geo.index) this.selected = null;
  }

  private setObjects(p: PageView, objects: api.PdfObject[]): void {
    p.objects = objects;
    p.boxes = new Map(objects.map((o) => [o.id, bboxToView(p.geo, o.bbox)]));
    this.buildUnits(p);
    this.drawOverlay(p);
  }

  /** Raggruppa gli oggetti di testo consecutivi che stanno sulla stessa riga e a poca distanza. */
  private buildUnits(p: PageView): void {
    const units: Unit[] = [];
    let cur: Unit | null = null;
    const flush = () => { if (cur) units.push(cur); cur = null; };
    for (const o of p.objects ?? []) {
      const b = p.boxes.get(o.id)!;
      const isText = o.kind === "text" || o.kind === "hidden";
      if (!isText || !this.groupLines) {
        flush();
        units.push({ ids: [o.id], kind: o.kind, box: { ...b }, text: o.text });
        continue;
      }
      if (cur && cur.kind === o.kind) {
        const last = p.boxes.get(cur.ids[cur.ids.length - 1])!;
        const hA = last.y1 - last.y0, hB = b.y1 - b.y0;
        const overlapY = Math.min(last.y1, b.y1) - Math.max(last.y0, b.y0);
        const gap = b.x0 - last.x1;
        const sameLine = overlapY >= 0.6 * Math.min(hA, hB) && hB / Math.max(hA, 0.01) > 0.6 && hB / Math.max(hA, 0.01) < 1.7;
        if (sameLine && gap >= -0.6 * hA && gap <= 1.2 * hA) {
          cur.ids.push(o.id);
          cur.box = { x0: Math.min(cur.box.x0, b.x0), y0: Math.min(cur.box.y0, b.y0), x1: Math.max(cur.box.x1, b.x1), y1: Math.max(cur.box.y1, b.y1) };
          cur.text = `${cur.text ?? ""}${o.text ?? ""}`;
          continue;
        }
      }
      flush();
      cur = { ids: [o.id], kind: o.kind, box: { ...b }, text: o.text };
    }
    flush();
    p.units = units;
  }

  private unitOf(p: PageView, id: number): Unit | undefined {
    return p.units.find((u) => u.ids.includes(id));
  }

  private async reloadPage(index: number): Promise<void> {
    const p = this.pages[index];
    if (!p) return;
    if (p.near || p.url) await this.load(p, true);
    else p.objects = null;
  }

  // ---------- disegno dello strato di selezione ----------

  private kindOn(kind: string): boolean {
    return this.visible[kind] ?? true;
  }

  private isBackground(p: PageView, u: Unit): boolean {
    return u.kind === "path" && (u.box.x1 - u.box.x0) * (u.box.y1 - u.box.y0) > 0.8 * p.geo.width * p.geo.height;
  }

  private groupBox(p: PageView): Box | null {
    if (this.selected?.page !== p.geo.index) return null;
    let g: Box | null = null;
    for (const id of this.selected.ids) {
      const b = p.boxes.get(id);
      if (!b) continue;
      g = g ? { x0: Math.min(g.x0, b.x0), y0: Math.min(g.y0, b.y0), x1: Math.max(g.x1, b.x1), y1: Math.max(g.y1, b.y1) } : { ...b };
    }
    return g;
  }

  private drawOverlay(p: PageView): void {
    const ctx = p.canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const s = this.scale;
    const cs = getComputedStyle(this.el);
    const accent = cs.getPropertyValue("--accent").trim() || "#c8402f";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
    if (!p.objects) return;
    const rect = (b: Box, dx = 0, dy = 0) => [b.x0 * s + dx * s, b.y0 * s + dy * s, (b.x1 - b.x0) * s, (b.y1 - b.y0) * s] as const;

    if (this.showBoxes) {
      const colors: Record<string, string> = { text: "#2f6fe0", hidden: "#8a8f98", image: "#1b9a5a", form: "#8f4fd6", path: "#e08a1e" };
      ctx.lineWidth = 1;
      for (const u of p.units) {
        if (!this.kindOn(u.kind) || this.isBackground(p, u)) continue;
        ctx.strokeStyle = colors[u.kind] ?? "#888";
        ctx.globalAlpha = 0.55;
        ctx.setLineDash(u.kind === "hidden" ? [3, 2] : []);
        ctx.strokeRect(...rect(u.box));
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }

    // Oggetto sotto il puntatore
    if (this.hover?.page === p.geo.index && !this.drag) {
      const hu = this.unitOf(p, this.hover.id);
      const b = hu?.box;
      if (b && !this.selected?.ids.has(this.hover.id)) {
        ctx.fillStyle = "rgba(47, 91, 211, 0.10)";
        ctx.strokeStyle = "rgba(47, 91, 211, 0.75)";
        ctx.lineWidth = 1;
        ctx.fillRect(...rect(b));
        ctx.strokeRect(...rect(b));
      }
    }

    // Selezione (con l'anteprima dello spostamento o dell'ingrandimento mentre si trascina)
    const sel = this.selected?.page === p.geo.index ? this.selected : null;
    if (sel) {
      let dx = 0, dy = 0, k = 1;
      const g = this.groupBox(p);
      if (this.drag?.page === p && this.drag.mode === "move") { dx = this.drag.du; dy = this.drag.dv; }
      const resizing = this.drag?.page === p && this.drag.mode === "resize" ? this.drag : null;
      if (resizing) k = resizing.scale;
      ctx.lineWidth = 1.5;
      // Le righe selezionate per intero si disegnano come un unico riquadro; gli altri oggetti uno per uno.
      const drawn: Box[] = [];
      for (const u of p.units) {
        const members = u.ids.filter((i) => sel.ids.has(i));
        if (members.length === u.ids.length) drawn.push(u.box);
        else for (const i of members) { const mb = p.boxes.get(i); if (mb) drawn.push(mb); }
      }
      for (const b of drawn) {
        const nb: Box = resizing && g
          ? { x0: g.x0 + (b.x0 - g.x0) * k, y0: g.y0 + (b.y0 - g.y0) * k, x1: g.x0 + (b.x1 - g.x0) * k, y1: g.y0 + (b.y1 - g.y0) * k }
          : b;
        ctx.fillStyle = "rgba(200, 64, 47, 0.12)";
        ctx.strokeStyle = accent;
        ctx.fillRect(...rect(nb, dx, dy));
        ctx.strokeRect(...rect(nb, dx, dy));
      }
      if (g) {
        const ng: Box = resizing ? { x0: g.x0, y0: g.y0, x1: g.x0 + (g.x1 - g.x0) * k, y1: g.y0 + (g.y1 - g.y0) * k } : g;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(...rect(ng, dx, dy));
        ctx.setLineDash([]);
        // Maniglia per ridimensionare, in basso a destra
        const hx = (ng.x1 + dx) * s, hy = (ng.y1 + dy) * s;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.rect(hx - 5, hy - 5, 10, 10);
        ctx.fill();
        ctx.stroke();
      }
    }

    if (this.drag?.mode === "band" && this.drag.page === p) {
      const d = this.drag;
      ctx.fillStyle = "rgba(47, 91, 211, 0.12)";
      ctx.strokeStyle = "rgba(47, 91, 211, 0.9)";
      ctx.lineWidth = 1;
      const x = Math.min(d.u0, d.u1) * s, y = Math.min(d.v0, d.v1) * s;
      ctx.fillRect(x, y, Math.abs(d.u1 - d.u0) * s, Math.abs(d.v1 - d.v0) * s);
      ctx.strokeRect(x, y, Math.abs(d.u1 - d.u0) * s, Math.abs(d.v1 - d.v0) * s);
    }
  }

  private redrawAll(): void {
    for (const p of this.pages) if (p.objects) this.drawOverlay(p);
  }

  // ---------- puntatore ----------

  private toPoints(p: PageView, e: PointerEvent | MouseEvent): { u: number; v: number } {
    const r = p.wrap.getBoundingClientRect();
    return { u: (e.clientX - r.left) / this.scale, v: (e.clientY - r.top) / this.scale };
  }

  private pick(p: PageView, u: number, v: number): Unit | null {
    let best: Unit | null = null;
    let bestArea = Infinity;
    for (const c of p.units) {
      if (!this.kindOn(c.kind) || this.isBackground(p, c)) continue;
      const b = c.box;
      if (u < b.x0 - 1 || u > b.x1 + 1 || v < b.y0 - 1 || v > b.y1 + 1) continue;
      const area = (b.x1 - b.x0) * (b.y1 - b.y0);
      if (area <= bestArea) { best = c; bestArea = area; } // a parità, vince l'oggetto disegnato per ultimo (sopra)
    }
    return best;
  }

  private onHandle(p: PageView, u: number, v: number): boolean {
    const g = this.groupBox(p);
    return !!g && Math.abs(u - g.x1) * this.scale <= 8 && Math.abs(v - g.y1) * this.scale <= 8;
  }

  private bindPage(p: PageView): void {
    p.wrap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !p.objects) return;
      e.preventDefault();
      this.scroller.focus({ preventScroll: true });
      const { u, v } = this.toPoints(p, e);
      if (this.onHandle(p, u, v)) {
        const group = this.groupBox(p)!;
        this.drag = { mode: "resize", page: p, u0: u, v0: v, scale: 1, group };
        p.wrap.setPointerCapture(e.pointerId);
        return;
      }
      const o = this.pick(p, u, v);
      if (o) {
        const same = this.selected?.page === p.geo.index;
        const already = same && o.ids.every((i) => this.selected!.ids.has(i));
        let collapseTo: number[] | null = null;
        if (e.shiftKey) {
          const ids = same ? new Set(this.selected!.ids) : new Set<number>();
          for (const i of o.ids) { if (already) ids.delete(i); else ids.add(i); }
          this.selected = ids.size ? { page: p.geo.index, ids } : null;
        } else if (!already) {
          this.selected = { page: p.geo.index, ids: new Set(o.ids) };
        } else if (this.selected!.ids.size > o.ids.length) {
          collapseTo = o.ids; // clic semplice su una selezione multipla: resta solo questo (se non si trascina)
        }
        this.drag = this.selected ? { mode: "move", page: p, u0: u, v0: v, du: 0, dv: 0, moved: false, collapseTo, pxStart: { x: e.clientX, y: e.clientY } } : null;
      } else {
        if (!e.shiftKey) this.selected = null;
        this.drag = { mode: "band", page: p, u0: u, v0: v, u1: u, v1: v, add: e.shiftKey };
      }
      p.wrap.setPointerCapture(e.pointerId);
      this.redrawAll();
      this.host.selectionChanged();
    });

    p.wrap.addEventListener("pointermove", (e) => {
      const { u, v } = this.toPoints(p, e);
      const d = this.drag;
      if (!d) {
        const o = p.objects ? this.pick(p, u, v) : null;
        const next = o ? { page: p.geo.index, id: o.ids[0] } : null;
        if (next?.id !== this.hover?.id || next?.page !== this.hover?.page) {
          const prev = this.hover;
          this.hover = next;
          if (prev) this.drawOverlay(this.pages[prev.page]);
          this.drawOverlay(p);
        }
        p.wrap.style.cursor = this.onHandle(p, u, v) ? "nwse-resize" : o ? "move" : "default";
        return;
      }
      if (d.page !== p) return;
      if (d.mode === "move") {
        if (!d.moved && Math.hypot(e.clientX - d.pxStart.x, e.clientY - d.pxStart.y) < 3) return;
        d.moved = true;
        d.du = u - d.u0;
        d.dv = v - d.v0;
        if (e.shiftKey) { if (Math.abs(d.du) > Math.abs(d.dv)) d.dv = 0; else d.du = 0; }
      } else if (d.mode === "resize") {
        const w = d.group.x1 - d.group.x0;
        d.scale = Math.max(0.05, Math.min(20, (u - d.group.x0) / Math.max(1, w)));
      } else {
        d.u1 = u;
        d.v1 = v;
      }
      this.drawOverlay(p);
    });

    p.wrap.addEventListener("pointerup", () => void this.finishDrag());
    p.wrap.addEventListener("pointercancel", () => { this.drag = null; this.redrawAll(); });
    p.wrap.addEventListener("pointerleave", () => {
      if (!this.drag && this.hover) { const prev = this.hover; this.hover = null; this.drawOverlay(this.pages[prev.page]); }
    });
  }

  private async finishDrag(): Promise<void> {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const p = d.page;
    if (d.mode === "band") {
      const [a0, a1] = [Math.min(d.u0, d.u1), Math.max(d.u0, d.u1)];
      const [b0, b1] = [Math.min(d.v0, d.v1), Math.max(d.v0, d.v1)];
      if ((a1 - a0) * this.scale > 3 || (b1 - b0) * this.scale > 3) {
        const ids = new Set(d.add && this.selected?.page === p.geo.index ? this.selected.ids : []);
        for (const c of p.units) {
          const b = c.box;
          if (!this.kindOn(c.kind) || this.isBackground(p, c)) continue;
          // Basta che il rettangolo ne copra almeno la metà: un bordo appena fuori non deve escluderlo.
          const ow = Math.min(b.x1, a1) - Math.max(b.x0, a0), oh = Math.min(b.y1, b1) - Math.max(b.y0, b0);
          const area = Math.max(1e-6, (b.x1 - b.x0) * (b.y1 - b.y0));
          if (ow > 0 && oh > 0 && (ow * oh) / area >= 0.5) c.ids.forEach((i) => ids.add(i));
        }
        this.selected = ids.size ? { page: p.geo.index, ids } : null;
      }
      this.redrawAll();
      this.host.selectionChanged();
      return;
    }
    if (!this.selected) { this.redrawAll(); return; }
    const ids = [...this.selected.ids];
    if (d.mode === "move") {
      if (!d.moved) {
        if (d.collapseTo !== null) this.selected = { page: p.geo.index, ids: new Set(d.collapseTo) };
        this.redrawAll();
        this.host.selectionChanged();
        return;
      }
      const delta = deltaToPdf(p.geo, d.du, d.dv);
      if (Math.abs(delta.x) < 0.01 && Math.abs(delta.y) < 0.01) { this.redrawAll(); return; }
      await this.edit(p, () => api.pdfTransformObjects(this.sessionId, p.geo.index, ids, translateMatrix(delta.x, delta.y)), true);
    } else {
      if (Math.abs(d.scale - 1) < 0.005) { this.redrawAll(); return; }
      // Ingrandimento attorno all'angolo in alto a sinistra del gruppo (a video)
      const anchor = fromView(p.geo, d.group.x0, d.group.y0);
      await this.edit(p, () => api.pdfTransformObjects(this.sessionId, p.geo.index, ids, scaleMatrix(d.scale, anchor.x, anchor.y)), true);
    }
  }

  // ---------- modifiche ----------

  /** Esegue una modifica una alla volta, aggiorna gli oggetti e ridisegna la pagina. */
  private edit(p: PageView, run: () => Promise<api.ApplyResult>, keepSelection: boolean): Promise<void> {
    const task = this.chain.then(async () => {
      try {
        const res = await run();
        this.setObjects(p, res.objects);
        this.selected = keepSelection && res.new_ids.length ? { page: p.geo.index, ids: new Set(res.new_ids) } : null;
        this.dirty = true;
        this.drawOverlay(p);
        this.host.changed();
        await this.refreshUndoState();
        await this.load(p, true);
      } catch (e) {
        this.redrawAll();
        toast(String(e).replace(/^Error:\s*/, ""));
      }
    });
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async refreshUndoState(): Promise<void> {
    try {
      [this.canUndo, this.canRedo] = await api.pdfCanUndo(this.sessionId);
    } catch { /* la sessione potrebbe essere già chiusa */ }
    this.host.selectionChanged();
  }

  private selectionPage(): PageView | null {
    return this.selected ? this.pages[this.selected.page] : null;
  }

  deleteSelection(): void {
    const p = this.selectionPage();
    if (!p || !this.selected) { toast("Seleziona prima un oggetto da eliminare"); return; }
    const ids = [...this.selected.ids];
    void this.edit(p, () => api.pdfDeleteObjects(this.sessionId, p.geo.index, ids), false);
  }

  private nudge(du: number, dv: number): void {
    const p = this.selectionPage();
    if (!p || !this.selected) return;
    const d = deltaToPdf(p.geo, du, dv);
    const ids = [...this.selected.ids];
    void this.edit(p, () => api.pdfTransformObjects(this.sessionId, p.geo.index, ids, translateMatrix(d.x, d.y)), true);
  }

  selectAll(): void {
    const p = this.currentPage();
    if (!p.objects) return;
    const ids = new Set(p.units.filter((c) => this.kindOn(c.kind) && !this.isBackground(p, c)).flatMap((c) => c.ids));
    this.selected = ids.size ? { page: p.geo.index, ids } : null;
    this.redrawAll();
    this.host.selectionChanged();
  }

  private async applyUndo(res: api.UndoOut | null, empty: string): Promise<void> {
    if (!res) { toast(empty); return; }
    this.dirty = true;
    if (res.pages) {
      const keep = this.currentPage().geo.index;
      this.buildPages(res.pages);
      this.scrollToPage(Math.min(keep, this.pages.length - 1));
    } else {
      this.selected = null;
      if (res.page !== null) await this.reloadPage(res.page);
    }
    await this.refreshUndoState();
    this.host.changed();
  }

  async undo(): Promise<void> {
    await this.chain;
    await this.applyUndo(await api.pdfUndo(this.sessionId), "Niente da annullare");
  }

  async redo(): Promise<void> {
    await this.chain;
    await this.applyUndo(await api.pdfRedo(this.sessionId), "Niente da ripetere");
  }

  private onKey(e: KeyboardEvent): void {
    const step = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case "Delete": case "Backspace": e.preventDefault(); this.deleteSelection(); return;
      case "ArrowLeft": if (this.selected) { e.preventDefault(); this.nudge(-step, 0); } return;
      case "ArrowRight": if (this.selected) { e.preventDefault(); this.nudge(step, 0); } return;
      case "ArrowUp": if (this.selected) { e.preventDefault(); this.nudge(0, -step); } return;
      case "ArrowDown": if (this.selected) { e.preventDefault(); this.nudge(0, step); } return;
      case "Escape": this.selected = null; this.redrawAll(); this.host.selectionChanged(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); this.selectAll(); }
  }

  // ---------- OCR ----------

  private ocrLang(): string {
    try { return localStorage.getItem(OCR_LANG_KEY) || "ita+eng"; } catch { return "ita+eng"; }
  }

  private async askOcrLang(): Promise<void> {
    const status = await api.pdfOcrStatus();
    const hint = status.available ? t("Lingue installate: {0}", status.languages.join(", ")) : t("Tesseract non è installato.");
    const value = await prompt("Lingua del riconoscimento", t("Codici separati da + (es. ita+eng). {0}", hint), this.ocrLang());
    if (value?.trim()) { try { localStorage.setItem(OCR_LANG_KEY, value.trim()); } catch { /* ignora */ } toast(t("Lingua OCR: {0}", value.trim())); }
  }

  /** Riconosce il testo delle pagine indicate (indici da 0). */
  async runOcr(indices: number[]): Promise<void> {
    if (this.ocrRunning) { toast("Il riconoscimento è già in corso"); return; }
    const status = await api.pdfOcrStatus();
    if (!status.available) {
      await alertError("OCR non disponibile", "Per riconoscere il testo serve Tesseract. Installalo con:\n\nsudo apt install tesseract-ocr tesseract-ocr-ita\n\nPoi riprova.");
      return;
    }
    const wanted = this.ocrLang().split("+").filter(Boolean);
    const usable = wanted.filter((l) => status.languages.includes(l));
    if (!usable.length) {
      await alertError("Lingua OCR non installata", t("La lingua «{0}» non è installata.\nLingue disponibili: {1}.\n\nPer l'italiano: sudo apt install tesseract-ocr-ita", this.ocrLang(), status.languages.join(", ") || t("nessuna")));
      return;
    }
    // Pagine che hanno già testo visibile: non si ripete l'OCR senza chiedere.
    const withText: number[] = [];
    for (const i of indices) {
      const p = this.pages[i];
      const objs = p.objects ?? await api.pdfObjects(this.sessionId, i);
      if (objs.some((o) => o.kind === "text")) withText.push(i);
    }
    if (withText.length) {
      const answer = await choose("Alcune pagine hanno già del testo",
        t(withText.length === 1
          ? "La pagina {0} contiene già testo selezionabile. Il riconoscimento serve per le pagine scansionate."
          : "Le pagine {0} contengono già testo selezionabile. Il riconoscimento serve per le pagine scansionate.",
        withText.slice(0, 8).map((i) => i + 1).join(", ") + (withText.length > 8 ? "…" : "")),
        [{ id: "skip", label: "Salta quelle con testo", primary: true }, { id: "all", label: "Riconosci comunque" }, { id: "cancel", label: "Annulla" }]);
      if (answer === "cancel") return;
      if (answer === "skip") indices = indices.filter((i) => !withText.includes(i));
    }
    if (!indices.length) { toast("Nessuna pagina da riconoscere"); return; }

    this.ocrRunning = true;
    this.ocrCancel = false;
    const lang = usable.join("+");
    let words = 0, done = 0;
    const cancel = h("button", { class: "dlg-btn", onclick: () => { this.ocrCancel = true; } }, "Annulla");
    const label = h("span", {});
    this.banner.replaceChildren(h("span", { class: "spinner" }), label, cancel);
    this.banner.hidden = false;
    try {
      for (const i of indices) {
        if (this.ocrCancel) break;
        label.textContent = t("Riconoscimento del testo: pagina {0} ({1} di {2})…", i + 1, done + 1, indices.length);
        await this.chain;
        words += await api.pdfOcrPage(this.sessionId, i, lang, 300);
        done++;
        this.dirty = true;
        await this.reloadPage(i);
        this.host.changed();
      }
    } catch (e) {
      await alertError("Riconoscimento non riuscito", String(e).replace(/^Error:\s*/, ""));
    } finally {
      this.ocrRunning = false;
      this.banner.hidden = true;
      await this.refreshUndoState();
    }
    if (done) {
      this.visible.hidden = true; // si vedono le parole riconosciute
      this.showBoxes = true;
      this.redrawAll();
      toast(done === 1 ? t("{0} parole riconosciute in 1 pagina. Ora il testo è selezionabile e ricercabile", words.toLocaleString(localeTag())) : t("{0} parole riconosciute in {1} pagine. Ora il testo è selezionabile e ricercabile", words.toLocaleString(localeTag()), done));
    }
  }

  // ---------- DocumentView ----------

  /** Pagina più visibile (per i comandi che agiscono su "questa pagina"). */
  currentPage(): PageView {
    const mid = this.scroller.getBoundingClientRect().top + this.scroller.clientHeight / 2;
    let best = this.pages[0], bestDist = Infinity;
    for (const p of this.pages) {
      const r = p.wrap.getBoundingClientRect();
      const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (d < bestDist) { best = p; bestDist = d; }
    }
    return best;
  }

  status(): string[] {
    const cur = this.currentPage().geo.index + 1;
    const out = [t("Pagina {0} di {1}", cur, this.pages.length)];
    if (this.selected) {
      const p = this.selectionPage()!;
      const chosen = p.units.filter((c) => c.ids.some((i) => this.selected!.ids.has(i)));
      if (chosen.length === 1) {
        const o = chosen[0];
        const names: Record<string, string> = { text: "Testo", hidden: "Testo nascosto", image: "Immagine", form: "Gruppo di oggetti", path: "Grafica" };
        const txt = o.text?.trim();
        out.push(`${tr(names[o.kind])}${txt ? `: «${txt.length > 40 ? `${txt.slice(0, 40)}…` : txt}»` : ""}`);
      } else out.push(t("{0} elementi selezionati", chosen.length));
    } else {
      out.push("Clicca un oggetto per selezionarlo, trascina per spostarlo");
    }
    return out;
  }

  setZoom(zoom: number): void {
    this.zoom = zoom;
    this.updateSizes();
    clearTimeout(this.zoomTimer);
    // Dopo una pausa, le pagine visibili si ridisegnano alla nuova risoluzione.
    this.zoomTimer = window.setTimeout(() => { for (const p of this.pages) if (p.near) void this.load(p); }, 250);
  }

  fitWidthZoom(): number {
    const maxW = Math.max(...this.pages.map((p) => p.geo.width));
    return Math.max(0.25, (this.scroller.clientWidth - 2 * GAP - 20) / (maxW * PT_TO_CSS));
  }

  handle(id: string): boolean {
    switch (id) {
      case "undo": void this.undo(); return true;
      case "redo": void this.redo(); return true;
      case "pdfDelete": this.deleteSelection(); return true;
      case "pdfSelectAll": this.selectAll(); return true;
      case "pdfShowText": this.visible.text = !this.visible.text; break;
      case "pdfShowImages": this.visible.image = !this.visible.image; this.visible.form = this.visible.image; break;
      case "pdfShowGraphics": this.visible.path = !this.visible.path; break;
      case "pdfShowHidden": this.visible.hidden = !this.visible.hidden; break;
      case "pdfShowBoxes": this.showBoxes = !this.showBoxes; break;
      case "pdfGroupLines":
        this.groupLines = !this.groupLines;
        this.selected = null;
        for (const pg of this.pages) if (pg.objects) this.buildUnits(pg);
        break;
      case "pdfRotateLeft": case "pdfRotateRight": {
        const i = this.currentPage().geo.index;
        void this.pageOp(() => api.pdfRotatePage(this.sessionId, i, id === "pdfRotateLeft" ? -90 : 90), i);
        return true;
      }
      case "pdfDeletePage": {
        const i = this.currentPage().geo.index;
        if (this.pages.length < 2) { toast("Un PDF deve avere almeno una pagina"); return true; }
        void this.pageOp(() => api.pdfDeletePage(this.sessionId, i), i);
        return true;
      }
      case "pdfMoveUp": case "pdfMoveDown": {
        const i = this.currentPage().geo.index;
        const to = id === "pdfMoveUp" ? i - 1 : i + 1;
        if (to < 0 || to >= this.pages.length) { toast(id === "pdfMoveUp" ? "È già la prima pagina" : "È già l'ultima pagina"); return true; }
        void this.pageOp(() => api.pdfMovePage(this.sessionId, i, to), to);
        return true;
      }
      case "pdfOcrPage": void this.runOcr([this.currentPage().geo.index]); return true;
      case "pdfOcrAll": void this.runOcr(this.pages.map((p) => p.geo.index)); return true;
      case "pdfOcrLang": void this.askOcrLang(); return true;
      case "pdfExtractText":
        void api.pdfText(this.sessionId).then((pages) => this.host.extractText(pages)).catch((e) => toast(String(e)));
        return true;
      default: return false;
    }
    // Se la selezione contiene tipi ormai non selezionabili, si toglie.
    if (this.selected) {
      const p = this.selectionPage()!;
      const keep = new Set([...this.selected.ids].filter((i) => { const o = p.objects?.find((x) => x.id === i); return o && this.kindOn(o.kind); }));
      this.selected = keep.size ? { page: p.geo.index, ids: keep } : null;
    }
    this.redrawAll();
    this.host.selectionChanged();
    return true;
  }

  isActive(id: string): boolean | undefined {
    switch (id) {
      case "pdfShowText": return this.visible.text;
      case "pdfShowImages": return this.visible.image;
      case "pdfShowGraphics": return this.visible.path;
      case "pdfShowHidden": return this.visible.hidden;
      case "pdfShowBoxes": return this.showBoxes;
      case "pdfGroupLines": return this.groupLines;
      default: return undefined;
    }
  }

  shown(): void {
    this.updateSizes();
    for (const p of this.pages) if (p.near) void this.load(p);
  }

  focus(): void {
    this.scroller.focus({ preventScroll: true });
  }

  markSaved(): void {
    this.dirty = false;
  }

  get canUndoNow(): boolean { return this.canUndo; }
  get canRedoNow(): boolean { return this.canRedo; }

  /** Pagine come immagini, per la stampa. `done` libera le risorse. */
  async printImages(dpi = 150): Promise<{ html: string; width: number; height: number; done: () => void }> {
    const urls: string[] = [];
    let html = "";
    for (const p of this.pages) {
      const blob = await api.pdfRender(this.sessionId, p.geo.index, dpi);
      const url = URL.createObjectURL(blob);
      urls.push(url);
      html += `<div class="print-page" style="width:${p.geo.width}pt;height:${p.geo.height - 1}pt;overflow:hidden"><img src="${url}" style="width:${p.geo.width}pt;height:${p.geo.height}pt;display:block"></div>`;
    }
    const first = this.pages[0].geo;
    return { html, width: first.width, height: first.height, done: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
  }

  dispose(): void {
    this.nearObs.disconnect();
    this.farObs.disconnect();
    for (const p of this.pages) if (p.url) URL.revokeObjectURL(p.url);
  }
}
