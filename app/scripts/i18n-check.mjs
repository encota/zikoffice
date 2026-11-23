// Cerca nel codice frasi italiane per l'utente che non hanno traduzione.
// Uso: npm run i18n          (elenca le frasi mancanti; esce con 1 se ce ne sono)
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { scan } from "./i18n-scan.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); f.isDirectory() ? walk(p) : /\.ts$/.test(p) && files.push(p); } })(root);

// Chiavi presenti nelle tabelle (il primo elemento di ogni riga).
const known = new Set();
for (const f of files.filter((f) => f.includes(path.join("i18n", "tables")))) {
  for (const e of scan(fs.readFileSync(f, "utf8"))) if (e.kind === "str") known.add(e.v);
}
// Rows are arrays: the first string of each row is the key; the others are noise but harmless here.

const it = /[À-ù]|\b(il|la|le|lo|di|del|della|dei|per|con|non|che|una|un|nel|nella|sul|da|in|come|solo|stato|nome|file|foglio|documento|cella|celle|riga|righe|colonna|colonne|apri|salva|chiudi|elimina|inserisci|scegli|tutti|tutto|nessun|nessuna|errore|impossibile|pagina|pagine|testo|immagine|tabella|stile|stili|carattere|paragrafo|annulla|ripeti|copia|incolla|taglia|trova|sostituisci|parole|oggi|ieri)\b/i;
const ignoreFile = /selftest|functions\.ts|[\\/]i18n[\\/]/;
// Nomi di icone e parole tecniche: non sono testo per l'utente.
const icons = new Set([...fs.readFileSync(path.join(root, "icons.ts"), "utf8").matchAll(/\b([A-Z][A-Za-z0-9]+)\b/g)].map((m) => m[1]));
const tech = new Set(["Calibri", "Consolas", "Claude", "Enter", "Tab", "Escape", "Arial", "Carlito", "Caladea", "Ubuntu", "Cambria", "Georgia", "Verdana", "Antigravity", "Markdown", "Excel", "Word", "Pages", "Numbers", "Tesseract", "ZikOffice", "OK"]);
const missing = new Map();
for (const f of files) {
  if (ignoreFile.test(f)) continue;
  const rel = path.relative(root, f);
  for (const e of scan(fs.readFileSync(f, "utf8"))) {
    const vs = e.kind === "str" ? [e.v] : e.parts.length === 1 ? [e.parts[0]] : [e.parts.map((p, i) => p + (i < e.parts.length - 1 ? `{${i}}` : "")).join("")];
    for (const v of vs) {
      if (!v || v.length < 3 || !/[A-Za-zÀ-ù]{3}/.test(v) || known.has(v)) continue;
      if (/^[a-z0-9_.\-:/#@%+]+$/.test(v) || /^[<.#]/.test(v) && /[<>{};]/.test(v)) continue;
      if (/^[A-Z][A-Za-z0-9]+$/.test(v) && (icons.has(v) || tech.has(v))) continue;
      if (!it.test(v) && !/^[A-ZÀ-Ù][A-Za-zà-ù]+( [A-Za-zà-ù0-9./]+)*[….:?]?$/.test(v)) continue;
      if (!missing.has(v)) missing.set(v, new Set());
      missing.get(v).add(rel);
    }
  }
}
for (const [v, fs_] of missing) console.log(`${[...fs_][0]}: ${JSON.stringify(v).slice(0, 150)}`);
console.log(`\n${missing.size} frasi senza traduzione (alcune sono nomi tecnici o prompt, da ignorare).`);
process.exit(missing.size ? 1 : 0);
