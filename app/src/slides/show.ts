// Presentazione a schermo intero: frecce, spazio e clic avanzano, Esc esce.
import { inTauri } from "../files";
import { tr } from "../i18n";
import type { Presentation } from "./model";
import { fitText, renderSlide } from "./render";

async function setFullscreen(on: boolean): Promise<void> {
  try {
    if (inTauri) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFullscreen(on);
    } else if (on) await document.documentElement.requestFullscreen?.();
    else if (document.fullscreenElement) await document.exitFullscreen();
  } catch { /* si resta nella finestra */ }
}

/** Avvia la presentazione dalla diapositiva `start`; `done` riceve l'ultima mostrata. */
export function startSlideshow(p: Presentation, start: number, done: (last: number) => void): void {
  const order = p.slides.map((s, i) => (s.hidden && i !== start ? -1 : i)).filter((i) => i >= 0);
  if (!order.length) return;
  let pos = Math.max(0, order.indexOf(start));
  let blank: "" | "black" | "white" = "";
  let notesOn = false;
  const stage = document.createElement("div");
  stage.className = "show-stage";
  const counter = document.createElement("div");
  counter.className = "show-counter";
  const notes = document.createElement("div");
  notes.className = "show-notes";
  const overlay = document.createElement("div");
  overlay.className = "show-overlay";
  overlay.tabIndex = 0;
  overlay.append(stage, notes, counter);
  document.body.append(overlay);

  const draw = () => {
    const slide = p.slides[order[pos]];
    const el = renderSlide(p, slide, "show");
    const scale = Math.min(innerWidth / p.width, innerHeight / p.height);
    el.style.transform = `scale(${scale})`;
    el.style.left = `${(innerWidth - p.width * scale) / 2}px`;
    el.style.top = `${(innerHeight - p.height * scale) / 2}px`;
    stage.replaceChildren(el);
    fitText(el, slide);
    stage.style.visibility = blank ? "hidden" : "visible";
    overlay.dataset.blank = blank;
    counter.textContent = `${pos + 1} / ${order.length}`;
    notes.textContent = slide.notes || tr("Nessuna nota per questa diapositiva");
    notes.hidden = !notesOn;
  };
  const go = (d: number) => {
    if (blank) { blank = ""; draw(); return; }
    const next = pos + d;
    if (next >= order.length) { close(); return; }
    pos = Math.max(0, next);
    draw();
  };
  const close = () => {
    removeEventListener("keydown", onKey, true);
    removeEventListener("resize", draw);
    overlay.remove();
    void setFullscreen(false);
    done(order[pos]);
  };
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    switch (e.key) {
      case "Escape": close(); return;
      case "ArrowRight": case "ArrowDown": case "PageDown": case " ": case "Enter": case "n": case "N":
        if (e.key.toLowerCase() === "n" && e.shiftKey) { notesOn = !notesOn; draw(); return; }
        go(1); return;
      case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace": case "p": case "P": go(-1); return;
      case "Home": pos = 0; blank = ""; draw(); return;
      case "End": pos = order.length - 1; blank = ""; draw(); return;
      case "b": case "B": case ".": blank = blank === "black" ? "" : "black"; draw(); return;
      case "w": case "W": case ",": blank = blank === "white" ? "" : "white"; draw(); return;
      case "s": case "S": notesOn = !notesOn; draw(); return;
    }
  };
  overlay.addEventListener("click", (e) => { if (e.button === 0) go(1); });
  overlay.addEventListener("contextmenu", (e) => { e.preventDefault(); go(-1); });
  addEventListener("keydown", onKey, true);
  addEventListener("resize", draw);
  void setFullscreen(true).then(() => setTimeout(draw, 120));
  draw();
  overlay.focus();
}
