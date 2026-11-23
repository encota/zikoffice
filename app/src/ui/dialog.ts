// Finestre di dialogo modali, coerenti con il resto dell'interfaccia.
import { h } from "../dom";

export interface DialogButton<T extends string> {
  id: T;
  label: string;
  primary?: boolean;
}

/** Mostra un messaggio con dei pulsanti e restituisce l'id di quello scelto (Esc = l'ultimo). */
export function choose<T extends string>(title: string, message: string, buttons: DialogButton<T>[]): Promise<T> {
  return new Promise((resolve) => {
    const restore = document.activeElement;
    const done = (id: T) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      if (restore instanceof HTMLElement) restore.focus();
      resolve(id);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(buttons[buttons.length - 1].id); }
    };
    const btns = buttons.map((b) => h("button", { class: `dlg-btn${b.primary ? " primary" : ""}`, onclick: () => done(b.id) }, b.label));
    const overlay = h("div", { class: "dlg-overlay" },
      h("div", { class: "dlg", role: "alertdialog", "aria-modal": "true", "aria-label": title },
        h("h2", {}, title),
        h("p", {}, message),
        h("div", { class: "dlg-actions" }, ...btns)));
    document.body.append(overlay);
    document.addEventListener("keydown", onKey, true);
    (btns.find((_, i) => buttons[i].primary) ?? btns[0]).focus();
  });
}

export function alertError(title: string, message: string): Promise<"ok"> {
  return choose(title, message, [{ id: "ok", label: "OK", primary: true }]);
}

/** Chiede un testo all'utente. Restituisce null se annulla. */
export function prompt(title: string, label: string, initial = "", placeholder = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const restore = document.activeElement;
    const input = h("input", { class: "find-input dlg-input", value: initial, placeholder, spellcheck: "false" });
    const done = (value: string | null) => {
      overlay.remove();
      if (restore instanceof HTMLElement) restore.focus();
      resolve(value);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(input.value); }
      if (e.key === "Escape") { e.preventDefault(); done(null); }
      e.stopPropagation();
    });
    const overlay = h("div", { class: "dlg-overlay" },
      h("div", { class: "dlg", role: "dialog", "aria-modal": "true", "aria-label": title },
        h("h2", {}, title),
        h("label", { class: "dlg-label" }, label, input),
        h("div", { class: "dlg-actions" },
          h("button", { class: "dlg-btn", onclick: () => done(null) }, "Annulla"),
          h("button", { class: "dlg-btn primary", onclick: () => done(input.value) }, "OK"))));
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}
