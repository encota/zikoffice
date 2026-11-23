// Modelli professionali pronti all'uso per documenti e fogli di calcolo.
import type { DocumentModel } from "./doc/model";
import { ensureListNumbering, newDocument } from "./doc/styles";
import { newModel } from "./sheet/engine";

import { localeTag, t } from "./i18n";
import { fn, num } from "./sheet/functions";
export interface TemplateDef {
  id: string;
  kind: "doc" | "sheet";
  title: string;
  desc: string;
  create: () => DocumentModel | Uint8Array;
}

function todayIt(): string {
  return new Date().toLocaleDateString(localeTag(), { day: "numeric", month: "long", year: "numeric" });
}

function createLettera(): DocumentModel {
  const doc = newDocument();
  const id = () => doc.nextId++;
  doc.blocks = [
    { type: "p", id: id(), props: { spaceAfter: 2 }, runs: [{ text: t("NOME AZIENDA S.r.l."), props: { bold: true, size: 14, color: "#1F3763" } }] },
    { type: "p", id: id(), props: { spaceAfter: 16 }, runs: [{ text: t("Via Roma 10, 20121 Milano (MI) — P.IVA 01234567890 — info@azienda.it"), props: { size: 9, color: "#5A5A5A" } }] },
    { type: "p", id: id(), props: { align: "right", spaceAfter: 14 }, runs: [{ text: t("Milano, {0}", todayIt()), props: {} }] },
    { type: "p", id: id(), props: { spaceAfter: 2 }, runs: [{ text: t("Spett.le"), props: { italic: true } }] },
    { type: "p", id: id(), props: { spaceAfter: 2 }, runs: [{ text: t("Destinatario S.p.A."), props: { bold: true } }] },
    { type: "p", id: id(), props: { spaceAfter: 16 }, runs: [{ text: t("Alla c.a. della Direzione"), props: {} }] },
    { type: "p", id: id(), props: { spaceAfter: 12 }, runs: [{ text: t("Oggetto: "), props: { bold: true } }, { text: t("Proposta di collaborazione / Comunicazione formale"), props: { bold: true, color: "#1F3763" } }] },
    { type: "p", id: id(), props: { spaceAfter: 8 }, runs: [{ text: t("Gentili Signori,"), props: {} }] },
    { type: "p", id: id(), props: { align: "justify", spaceAfter: 8 }, runs: [{ text: t("con la presente sottoponiamo alla Vostra cortese attenzione i dettagli relativi alla nostra proposta operativa. Restiamo a completa disposizione per eventuali chiarimenti o per fissare un incontro di approfondimento."), props: {} }] },
    { type: "p", id: id(), props: { spaceAfter: 18 }, runs: [{ text: t("Cordiali saluti,"), props: {} }] },
    { type: "p", id: id(), props: { spaceAfter: 2 }, runs: [{ text: t("Il Responsabile"), props: { bold: true } }] },
    { type: "p", id: id(), props: {}, runs: [{ text: t("Nome Cognome"), props: { color: "#5A5A5A" } }] },
  ];
  return doc;
}

function createVerbale(): DocumentModel {
  const doc = newDocument();
  const id = () => doc.nextId++;
  const bullet = ensureListNumbering(doc, "bullet");
  const num = ensureListNumbering(doc, "number");
  doc.blocks = [
    { type: "p", id: id(), props: { style: "Title" }, runs: [{ text: t("Verbale di riunione"), props: {} }] },
    { type: "p", id: id(), props: { style: "Subtitle", spaceAfter: 14 }, runs: [{ text: t("Data: {0} — Luogo: Sede operativa / Videoconferenza", todayIt()), props: {} }] },
    { type: "p", id: id(), props: { style: "Heading1", outlineLevel: 0 }, runs: [{ text: t("1. Partecipanti"), props: {} }] },
    {
      type: "table", id: id(), grid: [160, 150, 140], align: "left",
      borders: { width: 0.5, color: "#c4c9d4", style: "single" },
      rows: [
        {
          header: true,
          cells: [
            { span: 1, shading: "#eef2f8", paragraphs: [{ type: "p", id: id(), props: {}, runs: [{ text: t("Nome"), props: { bold: true } }] }] },
            { span: 1, shading: "#eef2f8", paragraphs: [{ type: "p", id: id(), props: {}, runs: [{ text: t("Ruolo"), props: { bold: true } }] }] },
            { span: 1, shading: "#eef2f8", paragraphs: [{ type: "p", id: id(), props: {}, runs: [{ text: t("Presenza"), props: { bold: true } }] }] },
          ],
        },
        {
          cells: [
            { span: 1, paragraphs: [{ type: "p", id: id(), props: {}, runs: [{ text: t("Mario Rossi"), props: {} }] }] },
            { span: 1, paragraphs: [{ type: "p", id: id(), props: {}, runs: [{ text: t("Responsabile progetto"), props: {} }] }] },
            { span: 1, paragraphs: [{ type: "p", id: id(), props: {}, runs: [{ text: t("Presente"), props: {} }] }] },
          ],
        },
      ],
    },
    { type: "p", id: id(), props: { style: "Heading1", outlineLevel: 0 }, runs: [{ text: t("2. Ordine del giorno"), props: {} }] },
    { type: "p", id: id(), props: { numId: num, numLevel: 0 }, runs: [{ text: t("Stato di avanzamento attività"), props: {} }] },
    { type: "p", id: id(), props: { numId: num, numLevel: 0 }, runs: [{ text: t("Criticità emerse e decisioni operative"), props: {} }] },
    { type: "p", id: id(), props: { style: "Heading1", outlineLevel: 0 }, runs: [{ text: t("3. Azioni concordate"), props: {} }] },
    { type: "p", id: id(), props: { numId: bullet, numLevel: 0 }, runs: [{ text: t("Completare la revisione documentale entro venerdì — "), props: {} }, { text: t("Responsabile: Mario Rossi"), props: { bold: true } }] },
    { type: "p", id: id(), props: {}, runs: [] },
  ];
  return doc;
}

function createRelazione(): DocumentModel {
  const doc = newDocument();
  const id = () => doc.nextId++;
  doc.header = [{ type: "p", id: id(), props: { style: "Header", align: "right" }, runs: [{ text: t("Relazione tecnica — Riservato"), props: { size: 9, color: "#666666" } }] }];
  doc.footer = [{ type: "p", id: id(), props: { style: "Footer", align: "center" }, runs: [{ text: t("Pagina "), props: { size: 9 } }, { type: "field", field: "PAGE", props: { size: 9 } }, { text: t(" di "), props: { size: 9 } }, { type: "field", field: "NUMPAGES", props: { size: 9 } }] }];
  doc.blocks = [
    { type: "p", id: id(), props: { style: "Title" }, runs: [{ text: t("Relazione Tecnica"), props: {} }] },
    { type: "p", id: id(), props: { style: "Subtitle", spaceAfter: 16 }, runs: [{ text: t("Redatta il {0}", todayIt()), props: {} }] },
    { type: "toc", id: id(), maxLevel: 3, title: t("Sommario") },
    { type: "p", id: id(), props: { style: "Heading1", outlineLevel: 0 }, runs: [{ text: t("1. Sintesi esecutiva"), props: {} }] },
    { type: "p", id: id(), props: { align: "justify" }, runs: [{ text: t("Questo documento riassume gli obiettivi, i risultati ottenuti e le raccomandazioni operative per la fase successiva."), props: {} }] },
    { type: "p", id: id(), props: { style: "Heading1", outlineLevel: 0 }, runs: [{ text: t("2. Analisi e risultati"), props: {} }] },
    { type: "p", id: id(), props: { align: "justify" }, runs: [{ text: t("Inserisci qui i dati rilevati, le tabelle di confronto e i grafici di supporto."), props: {} }] },
    { type: "p", id: id(), props: { style: "Heading1", outlineLevel: 0 }, runs: [{ text: t("3. Conclusioni"), props: {} }] },
    { type: "p", id: id(), props: {}, runs: [{ text: "", props: {} }] },
  ];
  return doc;
}

/** Larghezze delle colonne come multipli di quella predefinita: i testi dei modelli (in qualunque lingua) devono starci. */
function widen(m: ReturnType<typeof newModel>, cols: [number, number][]): void {
  const base = m.getColumnWidth(0, 1);
  for (const [col, k] of cols) m.setColumnsWidth(0, col, col, base * k);
}

function createFattura(): Uint8Array {
  const m = newModel("Fattura");
  m.setUserInput(0, 1, 1, t("PREVENTIVO / FATTURA N. 01/2026"));
  m.setUserInput(0, 2, 1, t("Data: {0}", todayIt()));
  m.setUserInput(0, 4, 1, t("Descrizione"));
  m.setUserInput(0, 4, 2, t("Quantità"));
  m.setUserInput(0, 4, 3, t("Prezzo unit."));
  m.setUserInput(0, 4, 4, t("Importo"));
  m.setUserInput(0, 5, 1, t("Consulenza tecnica"));
  m.setUserInput(0, 5, 2, "8");
  m.setUserInput(0, 5, 3, "75");
  m.setUserInput(0, 5, 4, "=B5*C5");
  m.setUserInput(0, 6, 1, t("Sviluppo e configurazione"));
  m.setUserInput(0, 6, 2, "1");
  m.setUserInput(0, 6, 3, "450");
  m.setUserInput(0, 6, 4, "=B6*C6");
  m.setUserInput(0, 8, 3, t("Imponibile"));
  m.setUserInput(0, 8, 4, `=${fn("SOMMA")}(D5:D6)`);
  m.setUserInput(0, 9, 3, t("IVA 22%"));
  m.setUserInput(0, 9, 4, `=D8*${num(0.22)}`);
  m.setUserInput(0, 10, 3, t("TOTALE"));
  m.setUserInput(0, 10, 4, "=D8+D9");
  widen(m, [[1, 3.2], [2, 1.2], [3, 1.4], [4, 1.4]]);
  m.evaluate();
  return m.toBytes();
}

function createPrimaNota(): Uint8Array {
  const m = newModel("Prima Nota");
  m.setUserInput(0, 1, 1, t("Data"));
  m.setUserInput(0, 1, 2, t("Descrizione"));
  m.setUserInput(0, 1, 3, t("Categoria"));
  m.setUserInput(0, 1, 4, t("Entrate"));
  m.setUserInput(0, 1, 5, t("Uscite"));
  m.setUserInput(0, 1, 6, t("Saldo"));
  m.setUserInput(0, 2, 1, "01/01/2026");
  m.setUserInput(0, 2, 2, t("Saldo iniziale"));
  m.setUserInput(0, 2, 3, t("Cassa"));
  m.setUserInput(0, 2, 4, "2500");
  m.setUserInput(0, 2, 5, "0");
  m.setUserInput(0, 2, 6, "=D2-E2");
  m.setUserInput(0, 3, 1, "05/01/2026");
  m.setUserInput(0, 3, 2, t("Incasso fattura cliente"));
  m.setUserInput(0, 3, 3, t("Ricavi"));
  m.setUserInput(0, 3, 4, "1200");
  m.setUserInput(0, 3, 5, "0");
  m.setUserInput(0, 3, 6, "=F2+D3-E3");
  m.setUserInput(0, 4, 1, "10/01/2026");
  m.setUserInput(0, 4, 2, t("Canone ufficio"));
  m.setUserInput(0, 4, 3, t("Spese fisse"));
  m.setUserInput(0, 4, 4, "0");
  m.setUserInput(0, 4, 5, "650");
  m.setUserInput(0, 4, 6, "=F3+D4-E4");
  m.setUserInput(0, 6, 3, t("TOTALI"));
  m.setUserInput(0, 6, 4, `=${fn("SOMMA")}(D2:D4)`);
  m.setUserInput(0, 6, 5, `=${fn("SOMMA")}(E2:E4)`);
  m.setUserInput(0, 6, 6, "=D6-E6");
  widen(m, [[1, 1.2], [2, 3], [3, 1.6], [4, 1.2], [5, 1.2], [6, 1.2]]);
  m.evaluate();
  return m.toBytes();
}

export const TEMPLATES: TemplateDef[] = [
  { id: "lettera", kind: "doc", title: t("Lettera aziendale"), desc: t("Intestazione, oggetto e firma"), create: createLettera },
  { id: "verbale", kind: "doc", title: t("Verbale di riunione"), desc: t("Partecipanti, OdG e azioni"), create: createVerbale },
  { id: "relazione", kind: "doc", title: t("Relazione tecnica"), desc: t("Sommario automatico e pagine"), create: createRelazione },
  { id: "fattura", kind: "sheet", title: t("Preventivo / Fattura"), desc: t("Calcolo imponibile e IVA 22%"), create: createFattura },
  { id: "primanota", kind: "sheet", title: t("Prima nota"), desc: t("Entrate, uscite e saldo progressivo"), create: createPrimaNota },
];
