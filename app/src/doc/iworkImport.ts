// Punto d'ingresso per i file Pages (.pages): formato attuale (.iwa) e vecchio (index.xml).
import { unzipSync } from "fflate";
import { importPages } from "./iwork/pages";
import { importPagesXml } from "./iwork/pagesXml";
import { Pkg } from "./iwork/pkg";
import type { DocumentModel } from "./model";

export function importIworkDocument(bytes: Uint8Array): DocumentModel {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error("Il file non è un documento Pages valido (archivio danneggiato o protetto)"); }
  const iwa = Object.keys(files).some((n) => /^Index\/.*\.iwa$/i.test(n)) || !!files["Index.zip"];
  if (!iwa) {
    const xml = files["index.xml"];
    if (xml) return importPagesXml(xml);
    throw new Error("Il file Pages non contiene dati leggibili (potrebbe essere protetto da password)");
  }
  return importPages(new Pkg(files));
}
