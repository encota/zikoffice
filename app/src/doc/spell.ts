// Controllo ortografico multilingua: chiede al lato Rust (Hunspell) quali parole sono sbagliate,
// tenendo in memoria i risultati. Le richieste sono raggruppate e fatte in differita.
import { inTauri } from "../files";
import { loadPrefs } from "../prefs";

const LANG_LABELS: Record<string, string> = {
  it_IT: "Italiano (Italia)",
  en_US: "English (US)",
  en_GB: "English (UK)",
  fr_FR: "Français (France)",
  de_DE: "Deutsch (Deutschland)",
  es_ES: "Español (España)",
  pt_BR: "Português (Brasil)",
  pt_PT: "Português (Portugal)",
};

export function langLabel(code: string): string {
  return LANG_LABELS[code] ?? code;
}

/** Parole di un testo, con posizione. Le elisioni restano unite ("dell'acqua"), come le vuole il dizionario. */
export function wordsIn(text: string): { word: string; start: number; end: number }[] {
  const out: { word: string; start: number; end: number }[] = [];
  const re = /\p{L}+(?:['’]\p{L}+)*/gu;
  for (let m; (m = re.exec(text));) {
    out.push({ word: m[0].replace(/’/g, "'"), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Parole da non controllare: sigle tutte maiuscole, parole con una sola lettera. */
export function shouldCheck(word: string): boolean {
  if (word.length < 2) return false;
  if (word === word.toUpperCase() && word.length > 1) return false;
  return true;
}

export class SpellChecker {
  private known = new Map<string, boolean>();
  private queue = new Set<string>();
  private timer = 0;
  private ignored = new Set<string>();
  enabled = inTauri;
  lang = loadPrefs().spellLang;

  constructor(private onUpdate: () => void) {
    // Il lato Rust parte con l'italiano: se la lingua scelta è un'altra la si carica; senza dizionario il controllo si spegne.
    if (inTauri && this.lang !== "it_IT") void this.setLang(this.lang).catch(() => { this.enabled = false; });
  }

  /** true = sbagliata, false = corretta, undefined = non ancora controllata (richiesta in coda). */
  isWrong(word: string): boolean | undefined {
    if (!this.enabled || !shouldCheck(word) || this.ignored.has(word)) return false;
    const v = this.known.get(word);
    if (v === undefined) { this.request(word); return undefined; }
    return !v;
  }

  private request(word: string): void {
    this.queue.add(word);
    if (this.timer) return;
    this.timer = window.setTimeout(() => void this.flush(), 250);
  }

  private async flush(): Promise<void> {
    this.timer = 0;
    const words = [...this.queue].slice(0, 2000);
    words.forEach((w) => this.queue.delete(w));
    if (!words.length) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<boolean[]>("spell_check", { words });
      words.forEach((w, i) => this.known.set(w, res[i]));
      this.onUpdate();
    } catch {
      // Dizionario non disponibile: il controllo si disattiva senza disturbare.
      this.enabled = false;
    }
    if (this.queue.size) this.request([...this.queue][0]);
  }

  async listLangs(): Promise<string[]> {
    if (!inTauri) return ["it_IT", "en_US"];
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string[]>("spell_list_langs");
    } catch {
      return ["it_IT"];
    }
  }

  async setLang(code: string): Promise<void> {
    if (inTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("spell_set_lang", { lang: code });
    }
    this.lang = code;
    this.known.clear();
    this.queue.clear();
    this.enabled = inTauri;
    this.onUpdate();
  }

  async suggest(word: string): Promise<string[]> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<string[]>("spell_suggest", { word });
    } catch {
      return [];
    }
  }

  ignore(word: string): void {
    this.ignored.add(word);
    this.onUpdate();
  }

  async add(word: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("spell_add", { word });
    this.known.set(word, true);
    this.onUpdate();
  }
}
