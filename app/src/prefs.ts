// Preferenze utente persistenti in localStorage.
import { langInfo } from "./i18n";

export interface UserPrefs {
  defaultFont: string;
  defaultFontSize: number;
  spellLang: string;
  autoSaveMinutes: number; // 0 = disattivato
}

const KEY = "zikoffice.prefs";

const DEFAULTS: UserPrefs = {
  defaultFont: "Calibri",
  defaultFontSize: 11,
  spellLang: "",
  autoSaveMinutes: 0,
};

export function loadPrefs(): UserPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      defaultFont: typeof raw.defaultFont === "string" && raw.defaultFont ? raw.defaultFont : DEFAULTS.defaultFont,
      defaultFontSize: typeof raw.defaultFontSize === "number" && raw.defaultFontSize >= 6 && raw.defaultFontSize <= 72 ? raw.defaultFontSize : DEFAULTS.defaultFontSize,
      spellLang: typeof raw.spellLang === "string" && raw.spellLang ? raw.spellLang : langInfo().spell,
      autoSaveMinutes: typeof raw.autoSaveMinutes === "number" && raw.autoSaveMinutes >= 0 ? raw.autoSaveMinutes : DEFAULTS.autoSaveMinutes,
    };
  } catch {
    return { ...DEFAULTS, spellLang: langInfo().spell };
  }
}

export function savePrefs(p: UserPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch { /* ignora */ }
}
