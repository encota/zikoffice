import type { IconName } from "../icons";

export type DocKind = "doc" | "sheet" | "pdf" | "slides";

/** Un comando del ribbon. Lo stesso id è usato da pulsanti, scorciatoie e palette comandi. */
export interface Command {
  id: string;
  label: string;
  icon: IconName;
  /** Testo lungo del tooltip, se diverso dall'etichetta. */
  tip?: string;
  shortcut?: string;
  /** Pulsante che resta premuto (es. Grassetto). */
  toggle?: boolean;
  /** Pulsanti dello stesso gruppo radio si escludono a vicenda (es. allineamento). */
  radio?: string;
  /** Mostra la freccia di menu. */
  menu?: boolean;
  /** Pulsante doppio: il clic esegue il comando, la freccia apre il menu. */
  split?: boolean;
}

export interface SelectControl {
  kind: "select";
  id: string;
  label: string;
  options: string[];
  value: string;
  width: number;
}

export type RowControl = { kind: "icon"; cmd: Command } | SelectControl | { kind: "sep" };

export interface GalleryItem {
  id: string;
  label: string;
  /** CSS applicato all'anteprima "AaBbCc". */
  preview: string;
}

export type GroupItem =
  | { kind: "large"; cmd: Command }
  /** Colonna di 2-3 pulsanti piccoli con etichetta. */
  | { kind: "stack"; cmds: Command[] }
  /** Righe di controlli compatti (solo icona o menu a tendina). */
  | { kind: "rows"; rows: RowControl[][] }
  | { kind: "gallery"; id: string; items: GalleryItem[] };

export interface RibbonGroup {
  label: string;
  items: GroupItem[];
}

export interface RibbonTab {
  id: string;
  label: string;
  groups: RibbonGroup[];
}
