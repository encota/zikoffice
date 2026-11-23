// Strumento di sviluppo: unisce i file di traduzione di lavoro (indice ¦ en ¦ es ¦ fr ¦ de ¦ pt) alle
// chiavi italiane e scrive src/i18n/tables/*.ts. Non serve per compilare l'applicazione.
// Uso: node scripts/i18n-merge.mjs <cartella-con-master.json-e-tr/>
import fs from "node:fs"; import path from "node:path";
const dir = process.argv[2];
const master = JSON.parse(fs.readFileSync(path.join(dir, "master.frozen.json"), "utf8")).map((r) => r[0]);
const SEP = " ¦ ";
const fix = (s) => s.replace(/\\n/g, "\n");
const holes = (s) => (s.match(/\{\d\}/g) ?? []).sort().join("");
function load(file, explicit) {
  const rows = [];
  for (const line of fs.readFileSync(path.join(dir, "tr", file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(SEP);
    if (parts.length !== 6) { console.error("righe malformate in", file, ":", line.slice(0, 80), parts.length); process.exit(1); }
    let key = fix(parts[0]);
    if (!explicit) { const i = Number(parts[0]); if (!Number.isInteger(i) || i >= master.length) { console.error("indice errato", parts[0]); process.exit(1); } key = master[i]; }
    const tr = parts.slice(1).map(fix);
    if (explicit === false || true) {
      for (let l = 0; l < 5; l++) if (holes(key) !== holes(tr[l]) ) console.error(`segnaposto diversi [${["en","es","fr","de","pt"][l]}]: ${JSON.stringify(key).slice(0, 60)} -> ${JSON.stringify(tr[l]).slice(0, 60)}`);
    }
    rows.push([key, ...tr]);
  }
  return rows;
}
const out = (name, rows, header) => {
  const body = rows.map((r) => "  " + JSON.stringify(r) + ",").join("\n");
  fs.writeFileSync(path.join("src/i18n/tables", name + ".ts"), `// ${header}\n// [it, en, es, fr, de, pt]\nimport type { Row } from "./index";\n\nexport const ${name.toUpperCase()}: readonly Row[] = [\n${body}\n];\n`);
  console.log(name, rows.length);
};
const ui = ["a.txt", "b.txt", "c.txt", "d.txt"].flatMap((f) => load(f, false));
out("ui", ui, "Interfaccia: ribbon, menu, finestre, messaggi.");
out("content", [...load("e.txt", true), ...load("h.txt", true), ...load("i.txt", true), ...load("j.txt", true), ...load("k.txt", true)], "Modelli di documento, tooltip e testi aggiunti in seguito.");
out("functions", [...load("f.txt", true), ...load("g.txt", true)], "Foglio di calcolo: parole degli argomenti (fx:) e descrizioni delle funzioni.");
if (process.argv[3] === "sample") { for (const r of ui.filter((_, i) => i % 23 === 0)) console.log(r[0].slice(0, 50).padEnd(52), "|", r[1].slice(0, 50)); }
