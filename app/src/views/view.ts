import type { DocKind } from "../ribbon/types";

/**
 * Stato dei comandi del ribbon per un documento aperto: pulsanti premuti,
 * gruppi radio (es. allineamento) e valori dei menu a tendina.
 */
export class CommandState {
  private toggles = new Set<string>();
  private radios = new Map<string, string>();
  private selects = new Map<string, string>();

  constructor(init: { toggles?: string[]; radios?: Record<string, string>; selects?: Record<string, string> } = {}) {
    init.toggles?.forEach((t) => this.toggles.add(t));
    Object.entries(init.radios ?? {}).forEach(([g, id]) => this.radios.set(g, id));
    Object.entries(init.selects ?? {}).forEach(([k, v]) => this.selects.set(k, v));
  }

  isOn(id: string): boolean {
    return this.toggles.has(id) || [...this.radios.values()].includes(id);
  }

  flip(id: string): void {
    if (this.toggles.has(id)) this.toggles.delete(id);
    else this.toggles.add(id);
  }

  /** In un gruppo radio: premere il pulsante attivo lo spegne solo se `allowNone`. */
  choose(group: string, id: string, allowNone: boolean): void {
    if (this.radios.get(group) === id && allowNone) this.radios.delete(group);
    else this.radios.set(group, id);
  }

  radio(group: string): string | undefined {
    return this.radios.get(group);
  }

  get(key: string): string | undefined {
    return this.selects.get(key);
  }

  set(key: string, value: string): void {
    this.selects.set(key, value);
  }
}

/** Una vista di documento (testo o foglio) montata nell'area di lavoro. */
export interface DocumentView {
  readonly kind: DocKind;
  readonly el: HTMLElement;
  /** Ci sono modifiche non salvate. */
  readonly dirty?: boolean;
  /** Testi per la parte sinistra della barra di stato. */
  status(): string[];
  setZoom(zoom: number): void;
  /**
   * Esegue un comando del ribbon. `anchor` è il pulsante premuto, per aprire un menu sotto di esso.
   * Restituisce true se la vista l'ha gestito.
   */
  handle(id: string, anchor?: HTMLElement): boolean;
  /** Stato premuto di un pulsante, se dipende dal contenuto (es. Grassetto della cella attiva). */
  isActive?(id: string): boolean | undefined;
  /** Valore di un menu a tendina, se dipende dal contenuto (es. font della cella attiva). */
  selectValue?(id: string): string | undefined;
  setSelect?(id: string, value: string): boolean;
  /** Chiamato quando la vista diventa visibile o cambia dimensione. */
  shown(): void;
  focus(): void;
}
