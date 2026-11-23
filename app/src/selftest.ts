// Autotest dentro la vera app (solo sviluppo). Vedi selftest in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";
import { exportDocx } from "./doc/docxExport";
import { importDocx } from "./doc/docxImport";
import { paragraphText, type Paragraph } from "./doc/model";
import * as ops from "./doc/ops";
import { newDocument } from "./doc/styles";
import { readBinary, readWorkbook, readXlsxExtras, writeBinary, writeWorkbook } from "./files";
import { loadEngine, modelFromBytes, newModel } from "./sheet/engine";

export async function runSelftest(): Promise<void> {
  const dir = await invoke<string | null>("selftest_dir").catch(() => null);
  if (!dir) return;
  const report = (ok: boolean, message: string) => invoke("selftest_report", { ok, message });
  try {
    await loadEngine();
    const m = newModel("autotest");
    m.setUserInput(0, 1, 1, "1,5");
    m.setUserInput(0, 2, 1, "2");
    m.setUserInput(0, 3, 1, '=SE(SOMMA(A1:A2)>3;"ok";"no")');
    m.evaluate();
    const path = `${dir}/Autotest è prova.xlsx`;
    // Dati extra molto grandi (400 KB): devono passare nel corpo della richiesta, non nelle intestazioni.
    const bigExtras = JSON.stringify({ notes: { "0:1:1": "n".repeat(400_000) } });
    await writeWorkbook(path, m.toBytes(), 0, bigExtras);
    const extrasBack = await readXlsxExtras(path);
    if (extrasBack !== bigExtras) { await report(false, `extras grandi non conservati (${extrasBack?.length})`); return; }
    const back = modelFromBytes(await readWorkbook(path));
    const value = back.getFormattedCellValue(0, 3, 1);
    const canvas = document.createElement("canvas").getContext("2d") !== null;
    // Documento .docx: crea, salva su disco, rileggi
    const doc = newDocument();
    const p0 = doc.blocks[0] as Paragraph;
    ops.insertText(doc, { pid: p0.id, off: 0 }, "Ciao àèìòù\nSeconda riga");
    const docPath = `${dir}/Autotest documento.docx`;
    await writeBinary(docPath, exportDocx(doc));
    const docBack = importDocx(await readBinary(docPath));
    const docText = docBack.blocks.filter((b): b is Paragraph => b.type === "p").map(paragraphText).join("|");
    // PDF: documento di due pagine (interruzione di pagina) esportato con il vero percorso di stampa
    const { mountPrint, documentPrintHtml } = await import("./print");
    const { DocEditor } = await import("./doc/editor");
    const { CommandState } = await import("./views/view");
    const pdfDoc = newDocument();
    const q = pdfDoc.blocks[0] as Paragraph;
    ops.insertText(pdfDoc, { pid: q.id, off: 0 }, "Prima pagina àèì\f");
    const ed = new DocEditor(pdfDoc, new CommandState(), { changed() {}, selectionChanged() {} });
    const printable = documentPrintHtml(ed);
    ed.dispose();
    const unmount = mountPrint(printable.html, printable);
    const { exportPdf, importPdfPages } = await import("./files");
    let pdf = "ok";
    try {
      await exportPdf(`${dir}/Autotest.pdf`, printable.width, printable.height, 0);
      const pdfPages = await importPdfPages(`${dir}/Autotest.pdf`);
      const flat = pdfPages.join(" ").replace(/\s+/g, " ").trim();
      if (!flat.includes("Prima") && !flat.includes("pagina")) pdf = `import="${flat.slice(0, 80)}"`;
    } catch (e) { pdf = String(e); }
    unmount();
    // Recupero: la copia di questa sessione non deve essere proposta (il processo è vivo)
    const rec = await import("./recovery");
    await rec.writeRecovery({ id: "autotest-rec", name: "Prova", kind: "doc", path: null }, new TextEncoder().encode("{}"));
    const listed = (await rec.listRecovery()).some((e) => e.id === "autotest-rec");
    const readBack = new TextDecoder().decode(await rec.readRecovery("autotest-rec"));
    await rec.deleteRecovery("autotest-rec");
    const recovery = !listed && readBack === "{}" ? "ok" : `listed=${listed} read=${readBack}`;
    // Ortografia italiana
    let spelling = "ok";
    try {
      const checked = await invoke<boolean[]>("spell_check", { words: ["casa", "perché", "dell'impaginazione", "un'altra", "sbagliatto"] });
      const sugg = await invoke<string[]>("spell_suggest", { word: "perchè" });
      if (checked.join() !== "true,true,true,true,false" || !sugg.includes("perché")) spelling = `check=${checked} sugg=${sugg}`;
    } catch (e) { spelling = String(e); }

    // Formati reali (se presenti nella cartella di test): .docx, .odt, .rtf, .html, .md, .txt, .xlsx, .xls, .ods, .csv
    let formats = "ok";
    try {
      const { importOdt } = await import("./doc/odtImport");
      const { exportOdt } = await import("./doc/odtExport");
      const { importRtf } = await import("./doc/rtfImport");
      const { importHtml, importMarkdown, importPlainText } = await import("./doc/textImport");
      const { allParagraphs } = await import("./doc/model");
      const textOf = (d: ReturnType<typeof importDocx>) => [...allParagraphs(d.blocks)].map(paragraphText).join("\n");

      // Round-trip ODT dentro la vera webview
      const odtBack = importOdt(exportOdt(doc));
      if (!textOf(odtBack).includes("Ciao àèìòù")) throw new Error("ODT round-trip fallito");

      // Se nella cartella ci sono file reali generati da LibreOffice/Pandoc/OpenPyXL, aprili tutti!
      const tryDoc = async (name: string, fn: (b: Uint8Array) => ReturnType<typeof importDocx>, expectText: string) => {
        let b: Uint8Array;
        try { b = await readBinary(`${dir}/${name}`); } catch { return; }
        const parsed = fn(b);
        const ed2 = new DocEditor(parsed, new CommandState(), { changed() {}, selectionChanged() {} });
        ed2.dispose();
        const txt = textOf(parsed);
        if (!txt.includes(expectText)) throw new Error(`${name}: manca "${expectText}" (trovato: ${txt.slice(0, 120)})`);
      };
      await tryDoc("real-pandoc.docx", importDocx, "Relazione Tecnica 2026");
      await tryDoc("real-lo.docx", importDocx, "Relazione Tecnica 2026");
      await tryDoc("real-lo.odt", importOdt, "Relazione Tecnica 2026");
      await tryDoc("real-lo.rtf", importRtf, "Relazione Tecnica 2026");
      await tryDoc("real-lo.html", importHtml, "Relazione Tecnica 2026");
      await tryDoc("real-lo.txt", importPlainText, "Relazione Tecnica 2026");
      await tryDoc("doc.md", importMarkdown, "Relazione Tecnica 2026");

      for (const sName of ["real.xlsx", "real.xls", "real.ods", "real.csv"]) {
        let sb: Uint8Array;
        try { sb = await readWorkbook(`${dir}/${sName}`); } catch (e) {
          // Se il file non esiste nella cartella, salta; se esiste ma fallisce l'apertura, errore!
          if (String(e).includes("No such file") || String(e).includes("os error 2")) continue;
          throw new Error(`${sName}: ${e}`);
        }
        const sm = modelFromBytes(sb);
        const v = sm.getFormattedCellValue(0, 5, 2);
        if (v !== "1310,75") throw new Error(`${sName}: atteso 1310,75 in B5, trovato "${v}"`);
        if (sName !== "real.csv") {
          const sheets = sm.getWorksheetsProperties().map((w) => w.name);
          if (!sheets.includes("Bilancio") || !sheets.includes("Note")) throw new Error(`${sName}: fogli=${sheets.join(",")}`);
        }
      }
    } catch (e) { formats = String(e); }

    // Modifica di PDF: apri, leggi gli oggetti, sposta, elimina, disegna, salva e riapri
    let pdfEdit = "ok";
    try {
      const api = await import("./pdf/api");
      const info = await api.pdfOpen(`${dir}/Autotest.pdf`);
      const objs = await api.pdfObjects(info.id, 0);
      // La stampa di WebKit mette ogni lettera in un oggetto a sé: la riga è l'insieme di tutti i testi della pagina.
      const letters = objs.filter((o) => o.kind === "text");
      const line = letters.map((o) => o.text).join("");
      if (info.pages.length !== 2 || line !== "Primapaginaàèì") throw new Error(`pagine=${info.pages.length} testo="${line}"`);
      const ids = letters.map((o) => o.id);
      const moved = await api.pdfTransformObjects(info.id, 0, ids, [1, 0, 0, 1, 40, -60]);
      const after = moved.objects.filter((o) => moved.new_ids.includes(o.id));
      if (after.length !== letters.length) throw new Error(`oggetti spostati: ${after.length} su ${letters.length}`);
      after.forEach((m, i) => {
        const t = letters[i];
        if (Math.abs(m.bbox[0] - t.bbox[0] - 40) > 0.05 || Math.abs(m.bbox[1] - t.bbox[1] + 60) > 0.05) throw new Error(`spostamento: ${JSON.stringify(m.bbox)} da ${JSON.stringify(t.bbox)}`);
      });
      const png = await api.pdfRender(info.id, 0, 72);
      const head = new Uint8Array(await png.slice(0, 4).arrayBuffer());
      if (head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47) throw new Error("la pagina non è un PNG");
      const del = await api.pdfDeleteObjects(info.id, 0, moved.new_ids);
      if (del.objects.some((o) => o.kind === "text")) throw new Error("il testo è ancora presente");
      await api.pdfSave(info.id, `${dir}/Autotest-modificato.pdf`);
      await api.pdfUndo(info.id); await api.pdfUndo(info.id);
      const back = await api.pdfObjects(info.id, 0);
      if (back.filter((o) => o.kind === "text").map((o) => o.text).join("") !== line) throw new Error("annulla non ripristina");
      // Pagine: ruota, sposta, elimina e annulla tutto
      const r = await api.pdfRotatePage(info.id, 0, 90);
      if (r[0].rotate !== 90 || r[0].width !== info.pages[0].height) throw new Error(`rotazione: ${JSON.stringify(r[0])}`);
      const mv = await api.pdfMovePage(info.id, 0, 1);
      if (mv[1].rotate !== 90 || mv[0].rotate !== 0) throw new Error("lo spostamento non ha portato con sé la rotazione");
      if ((await api.pdfDeletePage(info.id, 0)).length !== 1) throw new Error("eliminazione pagina");
      for (let i = 0; i < 3; i++) await api.pdfUndo(info.id);
      const restored = await api.pdfUndo(info.id);
      if (restored !== null) throw new Error("troppi passi di annulla");
      const textAfter = (await api.pdfObjects(info.id, 0)).filter((o) => o.kind === "text").map((o) => o.text).join("");
      if (textAfter !== line) throw new Error(`dopo annulla delle pagine: "${textAfter}"`);
      await api.pdfClose(info.id);
      const re = await api.pdfOpen(`${dir}/Autotest-modificato.pdf`);
      const reObjs = await api.pdfObjects(re.id, 0);
      await api.pdfClose(re.id);
      if (reObjs.some((o) => o.kind === "text")) throw new Error("il file salvato contiene ancora il testo eliminato");
      const ocr = await api.pdfOcrStatus();
      pdfEdit = `ok (ocr ${ocr.available ? `disponibile: ${ocr.languages.join("+")}` : "non installato"})`;
    } catch (e) { pdfEdit = String(e); }
    // Presentazioni: crea, salva .pptx su disco, riapri; conversione con LibreOffice; vista vera con PDF.
    let slides = "ok";
    try {
      const { newPresentation, newSlide } = await import("./slides/model");
      const { exportPptx } = await import("./slides/pptxExport");
      const { importPptx } = await import("./slides/pptxImport");
      const { DEFAULT_THEME } = await import("./slides/themes");
      const { readLegacySlides } = await import("./files");
      const pres = newPresentation(DEFAULT_THEME);
      (pres.slides[0].items[0] as { paras: unknown }).paras = [{ runs: [{ text: "Diapositiva àèì" }], level: 0 }];
      const s2 = newSlide(pres, "content");
      (s2.items[1] as { paras: unknown }).paras = [{ runs: [{ text: "Punto uno" }], level: 0 }, { runs: [{ text: "Sotto" }], level: 1 }];
      pres.slides.push(s2);
      const path = `${dir}/Autotest presentazione.pptx`;
      await writeBinary(path, exportPptx(pres));
      const backP = importPptx(await readBinary(path));
      const texts = backP.slides.flatMap((sl) => sl.items.flatMap((it) => it.kind === "shape" ? it.paras.map((q) => q.runs.map((r) => r.text).join("")) : [])).filter(Boolean).join("|");
      if (texts !== "Diapositiva àèì|Punto uno|Sotto") throw new Error(`testo riletto: ${texts}`);
      // LibreOffice apre il file e lo riscrive: il testo deve sopravvivere.
      try {
        const viaLo = importPptx(await readLegacySlides(path));
        const loText = viaLo.slides.flatMap((sl) => sl.items.flatMap((it) => it.kind === "shape" ? it.paras.map((q) => q.runs.map((r) => r.text).join("")) : [])).join("|");
        if (!loText.includes("Diapositiva àèì") || !loText.includes("Sotto")) throw new Error(`LibreOffice: ${loText}`);
      } catch (e) {
        if (!String(e).includes("LibreOffice (soffice)")) throw e;
        slides = "ok (LibreOffice assente)";
      }
      const { SlideView } = await import("./slides/slideView");
      const view = new SlideView(backP, new CommandState(), { changed() {}, selectionChanged() {} });
      document.body.append(view.el);
      const sp = view.printHtml();
      view.el.remove();
      view.dispose();
      const unmountS = mountPrint(sp.html, sp, 0);
      try {
        await exportPdf(`${dir}/Autotest presentazione.pdf`, sp.width, sp.height, 0);
        const pagesS = await importPdfPages(`${dir}/Autotest presentazione.pdf`);
        if (pagesS.length !== 2 || !pagesS.join(" ").includes("Punto")) throw new Error(`PDF: ${pagesS.length} pagine, "${pagesS.join(" ").slice(0, 80)}"`);
      } finally { unmountS(); }
    } catch (e) { slides = String(e); }
    // Terminale integrato: apre il pannello vero, scrive un comando nella shell e legge lo schermo.
    let terminal = "";
    try {
      const dock = (window as any).__zikoffice.dock;
      dock.show("terminal");
      for (let i = 0; i < 50 && dock.termId === null; i++) await new Promise((r) => setTimeout(r, 100));
      if (dock.termId === null) throw new Error("shell non partita");
      await invoke("term_write", { id: dock.termId, data: "echo cota$((6*7))è\n" });
      let screen = "";
      for (let i = 0; i < 50 && !screen.includes("cota42è\n"); i++) {
        await new Promise((r) => setTimeout(r, 100));
        const buf = dock.term.buffer.active;
        screen = Array.from({ length: buf.length }, (_, n) => buf.getLine(n)?.translateToString(true) ?? "").join("\n") + "\n";
      }
      if (!screen.includes("cota42è\n")) throw new Error(`risposta non trovata: ${screen.slice(-200)}`);
      const ai = await invoke<{ claude: boolean; agy: boolean }>("ai_status");
      dock.close();
      terminal = `ok (claude=${ai.claude}, agy=${ai.agy})`;
    } catch (e) { terminal = String(e); }
    const ok = terminal.startsWith("ok") && value === "ok" && canvas && docText === "Ciao àèìòù|Seconda riga" && pdf === "ok" && recovery === "ok" && spelling === "ok" && formats === "ok" && pdfEdit.startsWith("ok") && slides.startsWith("ok");
    await report(ok, `A3=${value}, formula=${back.getCellContent(0, 3, 1)}, docx="${docText}", pdf=${pdf}, recupero=${recovery}, ortografia=${spelling}, formati=${formats}, pdfedit=${pdfEdit}, presentazioni=${slides}, terminale=${terminal}, canvas=${canvas}, ua=${navigator.userAgent}`);
  } catch (e) {
    await report(false, String(e));
  }
}
