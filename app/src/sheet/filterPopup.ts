// Finestrella del filtro di una colonna: ordina, cerca, spunta i valori da mostrare.
import { h } from "../dom";
import { icon } from "../icons";

import { t } from "../i18n";
export const BLANK = "(Vuote)";

export interface FilterPopupOptions {
  /** Valori presenti nella colonna, con quante volte compaiono. */
  values: Map<string, number>;
  /** Valori attualmente mostrati (null = tutti). */
  selected: Set<string> | null;
  onSort: (descending: boolean) => void;
  onApply: (selected: Set<string> | null) => void;
}

let open: { el: HTMLElement; cleanup: () => void } | null = null;

export function closeFilterPopup(): void {
  open?.cleanup();
  open?.el.remove();
  open = null;
}

export function openFilterPopup(at: { x: number; y: number }, opts: FilterPopupOptions): void {
  closeFilterPopup();
  const coll = new Intl.Collator("it", { numeric: true, sensitivity: "base" });
  const all = [...opts.values.keys()].sort((a, b) => (a === BLANK ? 1 : b === BLANK ? -1 : coll.compare(a, b)));
  const checked = new Set(opts.selected ?? all);

  const search = h("input", { class: "find-input", placeholder: "Cerca", spellcheck: "false" });
  const list = h("div", { class: "filter-list" });
  const selectAll = h("input", { type: "checkbox" });

  const visibleValues = () => {
    const q = search.value.trim().toLocaleLowerCase("it");
    return all.filter((v) => !q || v.toLocaleLowerCase("it").includes(q));
  };
  const render = () => {
    const vis = visibleValues();
    selectAll.checked = vis.every((v) => checked.has(v));
    selectAll.indeterminate = !selectAll.checked && vis.some((v) => checked.has(v));
    list.replaceChildren(...vis.slice(0, 1000).map((v) => {
      const cb = h("input", { type: "checkbox" });
      cb.checked = checked.has(v);
      cb.addEventListener("change", () => { if (cb.checked) checked.add(v); else checked.delete(v); render(); });
      return h("label", { class: "filter-item" }, cb, h("span", { class: v === BLANK ? "muted" : "" }, v), h("small", {}, String(opts.values.get(v))));
    }));
    if (vis.length > 1000) list.append(h("p", { class: "muted filter-more" }, t("Altri {0} valori: usa la ricerca", vis.length - 1000)));
    if (!vis.length) list.append(h("p", { class: "muted filter-more" }, "Nessun valore corrisponde"));
  };
  selectAll.addEventListener("change", () => {
    for (const v of visibleValues()) { if (selectAll.checked) checked.add(v); else checked.delete(v); }
    render();
  });
  search.addEventListener("input", render);

  const apply = () => {
    closeFilterPopup();
    opts.onApply(checked.size === all.length ? null : new Set(checked));
  };
  const el = h("div", { class: "menu filter-popup", role: "dialog", "aria-label": "Filtro" },
    h("button", { class: "menu-item", onclick: () => { closeFilterPopup(); opts.onSort(false); } },
      h("span", { class: "menu-icon" }, icon("ArrowDownAZ", 16)), h("span", { class: "menu-label" }, "Ordina dalla A alla Z")),
    h("button", { class: "menu-item", onclick: () => { closeFilterPopup(); opts.onSort(true); } },
      h("span", { class: "menu-icon" }, icon("ArrowDownZA", 16)), h("span", { class: "menu-label" }, "Ordina dalla Z alla A")),
    h("button", { class: "menu-item", disabled: !opts.selected, onclick: () => { closeFilterPopup(); opts.onApply(null); } },
      h("span", { class: "menu-icon" }, icon("FilterX", 16)), h("span", { class: "menu-label" }, "Cancella filtro")),
    h("div", { class: "menu-sep" }),
    h("div", { class: "filter-body" },
      search,
      h("label", { class: "filter-item all" }, selectAll, h("span", {}, "(Seleziona tutto)")),
      list,
      h("div", { class: "dlg-actions" },
        h("button", { class: "dlg-btn", onclick: closeFilterPopup }, "Annulla"),
        h("button", { class: "dlg-btn primary", onclick: apply }, "OK"))));

  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(at.x, innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(at.y, innerHeight - r.height - 8))}px`;
  render();
  search.focus();

  const onDown = (e: Event) => { if (!el.contains(e.target as Node)) closeFilterPopup(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFilterPopup(); }
    if (e.key === "Enter" && e.target === search) { e.preventDefault(); apply(); }
  };
  setTimeout(() => document.addEventListener("pointerdown", onDown, true));
  document.addEventListener("keydown", onKey, true);
  open = {
    el,
    cleanup: () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    },
  };
}
