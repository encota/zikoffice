// Motore di calcolo: IronCalc compilato in WebAssembly.
// Le formule seguono la lingua dell'interfaccia: SOMMA/SUM/SUMA/SOMME/SUMME…, con separatori e
// decimali della lingua (i file .xlsx contengono sempre la forma inglese, quindi si aprono ovunque).
import init, { Model } from "@ironcalc/wasm";
import { langInfo } from "../i18n";

export { Model };
export type {
  Area, CellStyle, Clipboard, MergedCell, WorksheetProperties, Color,
} from "@ironcalc/wasm";

/** Impostazioni regionali e lingua delle formule: seguono la lingua scelta. */
export const locale = (): string => langInfo().sheetLocale;
export const language = (): string => langInfo().sheetLanguage;
export const TIMEZONE = "Europe/Rome";

let ready: Promise<void> | null = null;

/** Carica il modulo WebAssembly (una sola volta). */
export function loadEngine(): Promise<void> {
  ready ??= init().then(() => undefined);
  return ready;
}

export function newModel(name: string): Model {
  const model = new Model(name, locale(), TIMEZONE, language());
  // IronCalc non ha il nome portoghese del primo foglio.
  if (langInfo().id === "pt") { try { model.renameSheet(0, "Planilha1"); } catch { /* ignora */ } }
  return model;
}

export function modelFromBytes(bytes: Uint8Array): Model {
  // Il contenuto del file non dipende dalla lingua: la scelta riguarda solo come si mostra e si scrive.
  const model = Model.fromBytes(bytes, language());
  try { model.setLocale(locale()); } catch { /* impostazioni regionali non disponibili: restano quelle del file */ }
  model.evaluate(); // per sicurezza: i valori mostrati sono sempre aggiornati
  return model;
}
