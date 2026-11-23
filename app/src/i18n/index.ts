// Traduzione dell'interfaccia. Il testo italiano è la chiave: `t("Incolla")` restituisce la
// stringa nella lingua scelta, o lo stesso testo italiano se manca la traduzione (così una
// frase dimenticata resta leggibile e `npm run i18n` la segnala).
//
// - I segnaposto sono {0}, {1}…: `t("Pagina {0} di {1}", a, b)`.
// - Una chiave con segnaposto funziona anche al contrario: se un testo già composto
//   ("Pagina 2 di 5", per esempio un errore arrivato da Rust) corrisponde allo schema,
//   viene tradotto lo stesso (`tr`).
// - Le tabelle sono in tables/*.ts: una riga per frase, [it, en, es, fr, de, pt].

import { ROWS } from "./tables";

export type Lang = "it" | "en" | "es" | "fr" | "de" | "pt";

export interface LangInfo {
  id: Lang;
  /** Nome nella lingua stessa. */
  name: string;
  /** Tag BCP 47 per date e numeri. */
  tag: string;
  /** Lingua delle formule e impostazioni regionali del motore di calcolo (IronCalc). */
  sheetLanguage: string;
  sheetLocale: string;
  /** Dizionario di correzione ortografica predefinito. */
  spell: string;
  /** Tasti nei nomi delle scorciatoie. */
  keys: { ctrl: string; shift: string; enter: string; del: string };
}

export const LANGS: readonly LangInfo[] = [
  { id: "it", name: "Italiano", tag: "it-IT", sheetLanguage: "it", sheetLocale: "it", spell: "it_IT", keys: { ctrl: "Ctrl", shift: "Maiusc", enter: "Invio", del: "Canc" } },
  { id: "en", name: "English", tag: "en-US", sheetLanguage: "en", sheetLocale: "en", spell: "en_US", keys: { ctrl: "Ctrl", shift: "Shift", enter: "Enter", del: "Del" } },
  { id: "es", name: "Español", tag: "es-ES", sheetLanguage: "es", sheetLocale: "es", spell: "es_ES", keys: { ctrl: "Ctrl", shift: "Mayús", enter: "Intro", del: "Supr" } },
  { id: "fr", name: "Français", tag: "fr-FR", sheetLanguage: "fr", sheetLocale: "fr", spell: "fr_FR", keys: { ctrl: "Ctrl", shift: "Maj", enter: "Entrée", del: "Suppr" } },
  { id: "de", name: "Deutsch", tag: "de-DE", sheetLanguage: "de", sheetLocale: "de", spell: "de_DE", keys: { ctrl: "Strg", shift: "Umschalt", enter: "Eingabe", del: "Entf" } },
  // IronCalc non ha ancora i nomi delle funzioni in portoghese: nomi inglesi con la
  // punteggiatura (; e virgola decimale) usata anche in Brasile e Portogallo.
  { id: "pt", name: "Português", tag: "pt-BR", sheetLanguage: "en", sheetLocale: "es", spell: "pt_BR", keys: { ctrl: "Ctrl", shift: "Shift", enter: "Enter", del: "Del" } },
];

const KEY = "zikoffice.lang";

function isLang(v: unknown): v is Lang {
  return typeof v === "string" && LANGS.some((l) => l.id === v);
}

/** Lingua del sistema, se supportata; altrimenti inglese. */
export function systemLang(): Lang {
  const list = typeof navigator !== "undefined" ? [...(navigator.languages ?? []), navigator.language] : [];
  for (const l of list) {
    const short = String(l ?? "").toLowerCase().slice(0, 2);
    if (isLang(short)) return short;
  }
  return "en";
}

function detect(): Lang {
  // Nei test la lingua è sempre l'italiano, a meno che il test non la cambi.
  if (typeof import.meta !== "undefined" && import.meta.env?.MODE === "test") return "it";
  try {
    const saved = localStorage.getItem(KEY);
    if (isLang(saved)) return saved;
  } catch { /* nessun archivio */ }
  return systemLang();
}

let current: Lang = detect();
let exact = new Map<string, string>();
let patterns: { re: RegExp; out: string }[] = [];
let cache = new Map<string, string>();
const listeners = new Set<() => void>();

function build(): void {
  exact = new Map();
  patterns = [];
  cache = new Map();
  if (current === "it") return;
  const col = LANGS.findIndex((l) => l.id === current);
  for (const row of ROWS) {
    const to = row[col];
    if (!to) continue;
    exact.set(row[0], to);
    if (/\{\d\}/.test(row[0])) {
      const src = row[0].split(/(\{\d\})/).map((p, i) => (i % 2 ? "(.+?)" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
      patterns.push({ re: new RegExp(`^${src}$`, "s"), out: to });
    }
  }
  // Gli schemi più lunghi (più specifici) hanno la precedenza.
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);
}
build();
if (typeof document !== "undefined") document.documentElement.lang = LANGS.find((l) => l.id === current)!.tag.slice(0, 2);

export function lang(): Lang { return current; }
export function langInfo(): LangInfo { return LANGS.find((l) => l.id === current)!; }
/** Tag BCP 47 per `toLocaleString` e simili (sostituisce "it-IT"). */
export function localeTag(): string { return langInfo().tag; }

/** Cambia lingua. L'interfaccia si ricostruisce da zero (`reload`), perché ribbon e menu sono già disegnati. */
export function setLang(l: Lang, reload = true): void {
  if (!isLang(l) || l === current) return;
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* ignora */ }
  build();
  if (typeof document !== "undefined") document.documentElement.lang = langInfo().tag.slice(0, 2);
  for (const f of listeners) f();
  if (reload && typeof location !== "undefined") location.reload();
}

export function onLangChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Memorizza la scelta fatta dall'utente senza ricaricare (per i test e per l'avvio). */
export function hasSavedLang(): boolean {
  try { return isLang(localStorage.getItem(KEY)); } catch { return false; }
}

function fill(s: string, args: readonly unknown[]): string {
  return args.length ? s.replace(/\{(\d)\}/g, (m, i: string) => { const a = args[+i]; return a === undefined ? m : typeof a === "string" ? tr(a) : String(a); }) : s;
}

/** Traduce un testo già composto (cerca la frase esatta, poi gli schemi con segnaposto). */
export function tr(text: string): string {
  if (current === "it" || !text) return text;
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out = exact.get(text);
  if (out === undefined) {
    for (const p of patterns) {
      const m = p.re.exec(text);
      if (m) { out = p.out.replace(/\{(\d)\}/g, (_x, i: string) => tr(m[+i + 1] ?? "")); break; }
    }
  }
  const res = out ?? text;
  if (cache.size > 4000) cache.clear();
  cache.set(text, res);
  return res;
}

/** Traduce una frase italiana e ne riempie i segnaposto. */
export function t(key: string, ...args: unknown[]): string {
  if (current === "it") return fill(key, args);
  const direct = exact.get(key);
  return fill(direct ?? key, args);
}

/** Nome di una scorciatoia ("Ctrl+Maiusc+S") nei tasti della lingua. */
export function shortcut(s: string): string {
  const k = langInfo().keys;
  return s.replace(/\bCtrl\b/g, k.ctrl).replace(/Maiusc/g, k.shift).replace(/Invio/g, k.enter).replace(/\bCanc\b/g, k.del);
}

/** Cerca "Maiusc" ecc. dentro un testo già composto, tra parentesi (per i suggerimenti). */
export function trKeys(s: string): string {
  return /Ctrl|Maiusc|Invio|Canc/.test(s) ? shortcut(s) : s;
}

