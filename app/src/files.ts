// Apertura e salvataggio dei file tramite il lato Rust (solo nell'app desktop).
import type { DocKind } from "./ribbon/types";

export const inTauri = "__TAURI_INTERNALS__" in window;

const XLSX_FILTER = { name: "Cartella di lavoro Excel (.xlsx)", extensions: ["xlsx"] };
const ODS_FILTER = { name: "Foglio di calcolo OpenDocument (.ods)", extensions: ["ods"] };
const CSV_FILTER = { name: "CSV (separato da punto e virgola)", extensions: ["csv"] };
const SHEET_FILES = { name: "Fogli di calcolo", extensions: ["xlsx", "xlsm", "xls", "xlsb", "numbers", "ods", "csv", "tsv"] };
const DOCX_FILTER = { name: "Documento di Word (.docx)", extensions: ["docx"] };
const ODT_FILTER = { name: "Documento OpenDocument (.odt)", extensions: ["odt"] };
const MD_FILTER = { name: "Documento Markdown (.md)", extensions: ["md"] };
const TXT_FILTER = { name: "Testo semplice (.txt)", extensions: ["txt"] };
const DOC_FILES = { name: "Documenti di testo e PDF", extensions: ["docx", "doc", "pages", "odt", "rtf", "pdf", "md", "markdown", "txt", "html", "htm"] };
const SLIDE_FILES = { name: "Presentazioni", extensions: ["pptx", "ppsx", "potx", "pptm", "ppt", "pps", "odp"] };
const PPTX_FILTER = { name: "Presentazione di PowerPoint (.pptx)", extensions: ["pptx"] };
const ALL_DOCS = {
  name: "Tutti i documenti e fogli supportati",
  extensions: ["docx", "doc", "pages", "odt", "rtf", "pdf", "md", "markdown", "txt", "html", "htm", "xlsx", "xlsm", "xls", "xlsb", "numbers", "ods", "csv", "tsv", ...SLIDE_FILES.extensions],
};

export interface RecentFile {
  path: string;
  name: string;
  kind: DocKind;
  openedAt: number;
}

const RECENT_KEY = "zikoffice.recent";

export function recentFiles(): RecentFile[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((f) => typeof f?.path === "string") : [];
  } catch {
    return [];
  }
}

function storeRecent(list: RecentFile[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 20))); } catch { /* ignora */ }
}

export function addRecent(path: string, kind: DocKind): void {
  storeRecent([{ path, name: fileName(path), kind, openedAt: Date.now() }, ...recentFiles().filter((f) => f.path !== path)]);
}

export function removeRecent(path: string): void {
  storeRecent(recentFiles().filter((f) => f.path !== path));
}

export const isDocPath = (path: string) => /\.(docx?|pages|odt|rtf|pdf|md|markdown|txt|html?)$/i.test(path);
export const isLegacyDocPath = (path: string) => /\.doc$/i.test(path);
export const isPdfPath = (path: string) => /\.pdf$/i.test(path);
export const isSheetPath = (path: string) => /\.(xls[xmb]?|numbers|ods|csv|tsv)$/i.test(path);
export const isSlidesPath = (path: string) => /\.(pptx|ppsx|potx|pptm|ppt|pps|odp)$/i.test(path);
/** Formati di presentazione che si leggono solo convertendoli con LibreOffice. */
export const isLegacySlidesPath = (path: string) => /\.(ppt|pps|odp)$/i.test(path);
export const canSaveSlidesInPlace = (path: string) => /\.pptx$/i.test(path);
export const isCsvPath = (path: string) => /\.(csv|tsv)$/i.test(path);
export const canSaveDocInPlace = (path: string) => /\.(docx|odt|md|markdown|txt)$/i.test(path);
export const canSaveSheetInPlace = (path: string) => /\.(xlsx|ods|csv)$/i.test(path);

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Nome senza estensione, per le schede ("Bilancio.xlsx" → "Bilancio"). */
export function baseName(path: string): string {
  return fileName(path).replace(/\.[^.]+$/, "");
}

async function core() {
  return import("@tauri-apps/api/core");
}

export async function pickWorkbookToOpen(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, directory: false, filters: [ALL_DOCS, DOC_FILES, SHEET_FILES, SLIDE_FILES, { name: "Tutti i file", extensions: ["*"] }] });
  return typeof picked === "string" ? picked : null;
}

export async function pickWorkbookToSave(suggestedName: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({ defaultPath: `${suggestedName}.xlsx`, filters: [XLSX_FILTER, ODS_FILTER, CSV_FILTER] });
  if (!picked) return null;
  return /\.(xlsx|ods|csv)$/i.test(picked) ? picked : `${picked}.xlsx`;
}

/** Legge un .xlsx e restituisce la cartella nel formato interno di IronCalc. */
export async function readWorkbook(path: string, password?: string): Promise<Uint8Array> {
  const { invoke } = await core();
  const data = await invoke<ArrayBuffer>("open_workbook", { path, password: password ?? null });
  return new Uint8Array(data);
}

export async function readXlsxExtras(path: string): Promise<string | null> {
  if (!inTauri || !/\.xls[xm]$/i.test(path)) return null;
  const { invoke } = await core();
  return invoke<string | null>("read_xlsx_extras", { path }).catch(() => null);
}

export async function writeWorkbook(path: string, bytes: Uint8Array, sheet = 0, extras?: string | null): Promise<void> {
  const { invoke } = await core();
  const headers: Record<string, string> = { path: encodeURIComponent(path), sheet: String(sheet) };
  let body = bytes;
  if (extras) {
    // I dati extra (grafici, note…) vanno nel corpo, non nelle intestazioni: possono essere molto grandi.
    const json = new TextEncoder().encode(extras);
    body = new Uint8Array(4 + json.length + bytes.length);
    new DataView(body.buffer).setUint32(0, json.length, true);
    body.set(json, 4);
    body.set(bytes, 4 + json.length);
    headers.framing = "extras";
  }
  await invoke("save_workbook", body, { headers });
}

export async function startupFiles(): Promise<string[]> {
  if (!inTauri) return [];
  const { invoke } = await core();
  return invoke<string[]>("startup_files");
}

export async function pickDocumentToSave(suggestedName: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({ defaultPath: `${suggestedName}.docx`, filters: [DOCX_FILTER, ODT_FILTER, MD_FILTER, TXT_FILTER] });
  if (!picked) return null;
  return /\.(docx|odt|md|markdown|txt)$/i.test(picked) ? picked : `${picked}.docx`;
}

export async function pickSlidesToSave(suggestedName: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({ defaultPath: `${suggestedName}.pptx`, filters: [PPTX_FILTER] });
  if (!picked) return null;
  return /\.pptx$/i.test(picked) ? picked : `${picked}.pptx`;
}

/** Converte una vecchia presentazione (.ppt) o un .odp in byte .pptx tramite LibreOffice. */
export async function readLegacySlides(path: string): Promise<Uint8Array> {
  const { invoke } = await core();
  return new Uint8Array(await invoke<ArrayBuffer>("convert_to_pptx", { path }));
}

export async function readBinary(path: string): Promise<Uint8Array> {
  const { invoke } = await core();
  return new Uint8Array(await invoke<ArrayBuffer>("read_file", { path }));
}

export async function writeBinary(path: string, bytes: Uint8Array, makeDir = false): Promise<void> {
  const { invoke } = await core();
  await invoke("write_file", bytes, { headers: { path: encodeURIComponent(path), ...(makeDir ? { mkdir: "1" } : {}) } });
}

export async function pickPdfToSave(suggestedName: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({ defaultPath: `${suggestedName}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (!picked) return null;
  return /\.pdf$/i.test(picked) ? picked : `${picked}.pdf`;
}

/** Stampa in PDF il contenuto da stampa già montato nella pagina. */
export async function exportPdf(path: string, width: number, height: number, margin: number): Promise<void> {
  const { invoke } = await core();
  await invoke("export_pdf", { path, width, height, margin });
}

/** Converte un vecchio .doc (Word 97-2003) in byte .docx tramite LibreOffice se disponibile. */
export async function readLegacyDoc(path: string): Promise<Uint8Array> {
  const { invoke } = await core();
  return new Uint8Array(await invoke<ArrayBuffer>("convert_legacy_doc", { path }));
}

/** Decifra un file .docx protetto da password tramite MS-OFFCRYPTO. */
export async function decryptOfficeFile(path: string, password: string): Promise<Uint8Array> {
  const { invoke } = await core();
  return new Uint8Array(await invoke<ArrayBuffer>("decrypt_office_file", { path, password }));
}

/** Estrae le pagine di testo da un PDF per aprirlo e modificarlo come documento. */
export async function importPdfPages(path: string): Promise<string[]> {
  const { invoke } = await core();
  return invoke<string[]>("import_pdf_pages", { path });
}

export async function pickPdfsToMerge(): Promise<string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: true, directory: false, filters: [{ name: "Documenti PDF", extensions: ["pdf"] }] });
  return Array.isArray(picked) && picked.length >= 2 ? picked : null;
}

export async function pickSinglePdf(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, directory: false, filters: [{ name: "Documento PDF", extensions: ["pdf"] }] });
  return typeof picked === "string" ? picked : null;
}

export async function mergePdfFiles(paths: string[], outPath: string): Promise<number> {
  const { invoke } = await core();
  return invoke<number>("pdf_merge", { paths, outPath });
}

export async function splitPdfFile(path: string, pagesSpec: string, outPath: string): Promise<number> {
  const { invoke } = await core();
  return invoke<number>("pdf_split", { path, pagesSpec, outPath });
}

export interface HistoryEntry {
  id: string;
  saved_at: number;
  size: number;
}

export async function saveHistorySnapshot(path: string): Promise<void> {
  if (!inTauri) return;
  const { invoke } = await core();
  await invoke("history_snapshot", { path }).catch(() => undefined);
}

export async function listHistory(path: string): Promise<HistoryEntry[]> {
  if (!inTauri) return [];
  const { invoke } = await core();
  return invoke<HistoryEntry[]>("history_list", { path }).catch(() => []);
}

export async function readHistoryVersion(path: string, id: string): Promise<Uint8Array> {
  const { invoke } = await core();
  return new Uint8Array(await invoke<ArrayBuffer>("history_read", { path, id }));
}
