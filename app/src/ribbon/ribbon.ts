import { clear, h } from "../dom";
import { shortcut, tr } from "../i18n";
import { icon } from "../icons";
import { ribbonFor } from "./definitions";
import type { Command, DocKind, GroupItem, RibbonGroup, RowControl, SelectControl } from "./types";

/** Ciò che il ribbon chiede all'applicazione: eseguire comandi e conoscerne lo stato. */
export interface RibbonHost {
  execute(id: string, anchor?: HTMLElement): void;
  isActive(id: string): boolean;
  selectValue(id: string): string | undefined;
  setSelect(id: string, value: string): void;
  openBackstage(): void;
}

function tooltip(cmd: Command): string {
  const base = tr(cmd.tip ?? cmd.label);
  return cmd.shortcut ? `${base} (${shortcut(cmd.shortcut)})` : base;
}

export class Ribbon {
  readonly el: HTMLElement;
  private tabsEl: HTMLElement;
  private panelEl: HTMLElement;
  private kind: DocKind | null = null;
  private activeTab = "home";
  private collapsed = false;

  constructor(private host: RibbonHost) {
    this.tabsEl = h("div", { class: "ribbon-tabs", role: "tablist" });
    this.panelEl = h("div", { class: "ribbon-panel", role: "toolbar" });
    this.el = h("section", { class: "ribbon" }, this.tabsEl, this.panelEl);
    // Come in Office: cliccare il ribbon non toglie il cursore dal documento.
    this.el.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest("select, input")) e.preventDefault();
    });
  }

  setKind(kind: DocKind | null): void {
    if (kind !== this.kind) {
      this.kind = kind;
      // Se la scheda attiva non esiste nel nuovo tipo (es. "Formule" nel testo), torna a Home.
      if (kind && !ribbonFor(kind).some((t) => t.id === this.activeTab)) this.activeTab = "home";
    }
    this.render();
  }

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.render();
  }

  /** Aggiorna lo stato premuto/non premuto e i valori dei menu, senza ricostruire il DOM. */
  refresh(): void {
    for (const btn of this.panelEl.querySelectorAll<HTMLButtonElement>("[data-toggle]")) {
      btn.setAttribute("aria-pressed", String(this.host.isActive(btn.dataset.cmd!)));
    }
    for (const s of this.panelEl.querySelectorAll<HTMLSelectElement>("select[data-select]")) {
      const v = this.host.selectValue(s.dataset.select!);
      if (v === undefined) continue;
      // Un font o una dimensione non in elenco (es. da un file aperto) viene aggiunto.
      if (![...s.options].some((o) => o.value === v)) s.append(h("option", { value: v, class: "extra" }, v));
      s.value = v;
    }
  }

  private render(): void {
    clear(this.tabsEl);
    clear(this.panelEl);

    const fileTab = h("button", {
      class: "ribbon-tab file-tab", role: "tab",
      onclick: () => this.host.openBackstage(),
    }, "File");
    this.tabsEl.append(fileTab);

    if (!this.kind) {
      this.el.classList.add("is-empty");
      return;
    }
    this.el.classList.remove("is-empty");
    this.el.classList.toggle("collapsed", this.collapsed);

    const tabs = ribbonFor(this.kind);
    for (const tab of tabs) {
      const selected = tab.id === this.activeTab;
      this.tabsEl.append(h("button", {
        class: "ribbon-tab", role: "tab", "aria-selected": String(selected && !this.collapsed),
        onclick: () => {
          this.activeTab = tab.id;
          if (this.collapsed) this.collapsed = false;
          this.render();
        },
        ondblclick: () => this.toggleCollapsed(),
      }, tab.label));
    }

    this.tabsEl.append(
      h("div", { class: "spacer" }),
      h("button", {
        class: "icon-btn ribbon-collapse",
        title: this.collapsed ? "Mostra il ribbon (Ctrl+F1)" : "Comprimi il ribbon (Ctrl+F1)",
        onclick: () => this.toggleCollapsed(),
      }, icon(this.collapsed ? "ChevronDown" : "ChevronUp")),
    );

    if (this.collapsed) return;

    const tab = tabs.find((t) => t.id === this.activeTab)!;
    for (const g of tab.groups) this.panelEl.append(this.renderGroup(g));
    this.refresh();
  }

  private renderGroup(g: RibbonGroup): HTMLElement {
    const body = h("div", { class: "group-body" });
    for (const item of g.items) body.append(this.renderItem(item));
    return h("div", { class: "ribbon-group", role: "group", "aria-label": g.label },
      body, h("div", { class: "group-label" }, g.label));
  }

  private renderItem(item: GroupItem): HTMLElement {
    switch (item.kind) {
      case "large":
        return this.button(item.cmd, "large");
      case "stack":
        return h("div", { class: "stack" }, ...item.cmds.map((c) => this.button(c, "small")));
      case "rows":
        return h("div", { class: "rows" }, ...item.rows.map((r) => h("div", { class: "row" }, ...r.map((ctl) => this.rowControl(ctl)))));
      case "gallery": {
        const list = h("div", { class: "gallery-items" },
          ...item.items.map((s) => h("button", {
            class: "gallery-item", "data-cmd": s.id, "data-toggle": "", title: s.label,
            onclick: () => this.host.execute(s.id),
          }, h("span", { class: "preview", style: s.preview }, "AaBbCc"), h("span", { class: "name" }, s.label))));
        const scroll = (dir: number) => list.scrollBy({ top: dir * list.clientHeight, behavior: "smooth" });
        return h("div", { class: "gallery" }, list,
          h("div", { class: "gallery-nav" },
            h("button", { class: "icon-btn", title: "Riga precedente", onclick: () => scroll(-1) }, icon("ChevronUp", 14)),
            h("button", { class: "icon-btn", title: "Riga successiva", onclick: () => scroll(1) }, icon("ChevronDown", 14))));
      }
    }
  }

  private rowControl(ctl: RowControl): HTMLElement {
    if (ctl.kind === "sep") return h("span", { class: "row-sep" });
    if (ctl.kind === "select") return this.select(ctl);
    return this.button(ctl.cmd, "icon");
  }

  private select(s: SelectControl): HTMLElement {
    const el = h("select", {
      class: "ribbon-select", "data-select": s.id, title: s.label, "aria-label": s.label,
      style: `width:${s.width}px`,
      onchange: (e: Event) => this.host.setSelect(s.id, (e.target as HTMLSelectElement).value),
    }, ...s.options.map((o) => h("option", { value: o }, o)));
    el.value = s.value;
    if (s.id === "fontName") {
      for (const opt of el.options) opt.style.fontFamily = `"${opt.value}"`;
    }
    return el;
  }

  private button(cmd: Command, size: "large" | "small" | "icon"): HTMLElement {
    const iconSize = size === "large" ? 26 : 16;
    const btn = h("button", {
      class: `rb rb-${size}${cmd.menu ? " has-menu" : ""}`,
      "data-cmd": cmd.id,
      "data-toggle": cmd.toggle ? "" : undefined,
      title: tooltip(cmd),
      "aria-label": cmd.label,
      onclick: (e: MouseEvent) => {
        // Nei pulsanti doppi il menu si apre solo dalla freccetta.
        const onArrow = !!(e.target as Element).closest(".chev");
        this.host.execute(cmd.id, cmd.menu && (!cmd.split || onArrow) ? btn : undefined);
      },
    }, icon(cmd.icon, iconSize, size === "large" ? 1.5 : 1.75));
    if (size !== "icon") btn.append(h("span", { class: "rb-label" }, cmd.label));
    if (cmd.menu) {
      const chev = h("span", { class: `chev${cmd.split ? " split" : ""}` }, icon("ChevronDown", 10, 2));
      btn.append(chev);
    }
    return btn;
  }
}
