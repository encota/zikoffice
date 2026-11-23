import { clear, h, toast } from "./dom";
import { LANGS, lang, localeTag, setLang, shortcut, t, tr, type Lang } from "./i18n";
import {
  addRecent, baseName, canSaveDocInPlace, canSaveSheetInPlace, canSaveSlidesInPlace, isLegacySlidesPath, isSlidesPath, pickSlidesToSave, readLegacySlides, decryptOfficeFile, inTauri, isCsvPath, isDocPath, isLegacyDocPath, isPdfPath, isSheetPath,
  listHistory, mergePdfFiles, pickDocumentToSave, pickPdfsToMerge, pickSinglePdf, pickWorkbookToOpen, pickWorkbookToSave,
  exportPdf, pickPdfToSave, readBinary, readHistoryVersion, readLegacyDoc, readWorkbook, readXlsxExtras, saveHistorySnapshot, splitPdfFile, writeBinary,
  recentFiles, removeRecent, startupFiles, writeWorkbook,
} from "./files";
import { icon, type IconName } from "./icons";
import { allCommands } from "./ribbon/definitions";
import { Ribbon, type RibbonHost } from "./ribbon/ribbon";
import type { Command, DocKind } from "./ribbon/types";
import { loadEngine, modelFromBytes, newModel } from "./sheet/engine";
import { importNumbers } from "./sheet/numbersImport";
import { renderChartSvg } from "./sheet/charts";
import { SheetView } from "./sheet/sheetView";
import { deleteRecovery, listRecovery, readRecovery, writeRecovery } from "./recovery";
import { documentPrintHtml, mountPrint, printHtml, SHEET_MARGIN, sheetPrintable, type SheetPrintOptions } from "./print";
import { loadPrefs, savePrefs } from "./prefs";
import { TEMPLATES, type TemplateDef } from "./templates";
import { cycleTheme, onThemeChange, resolvedTheme, themeMode } from "./theme";
import { alertError, choose, prompt as promptDialog } from "./ui/dialog";
import { openMenu } from "./ui/menu";
import { installDocCommands } from "./doc/commands";
import { exportDocx } from "./doc/docxExport";
import { importDocx } from "./doc/docxImport";
import { exportOdt } from "./doc/odtExport";
import { importOdt } from "./doc/odtImport";
import { importIworkDocument } from "./doc/iworkImport";
import { importRtf } from "./doc/rtfImport";
import { langLabel } from "./doc/spell";
import { exportPlainText, importHtml, importPlainText } from "./doc/textImport";
import { exportMarkdownFull, importMarkdown, loadMarkdownImages, markdownFromSource, markdownLosses, markdownSource } from "./doc/markdown";
import type { DocumentModel } from "./doc/model";
import { DocEditor } from "./doc/editor";
import { PdfEditor } from "./pdf/editor";
import { Dock, type AiSource, type SourceView } from "./dock";
import { pdfClose, pdfOpen, pdfSave, pdfText, type OpenInfo } from "./pdf/api";
import { newDocument } from "./doc/styles";
import { CommandState, type DocumentView } from "./views/view";
import { SlideView } from "./slides/slideView";
import { importPptx } from "./slides/pptxImport";
import { exportPptx } from "./slides/pptxExport";
import { deserializePresentation, newPresentation, serializePresentation, type Presentation } from "./slides/model";
import { DEFAULT_THEME } from "./slides/themes";

interface OpenFile {
  id: number;
  name: string;
  kind: DocKind;
  /** Percorso sul disco, se il documento è stato aperto o salvato. */
  path?: string;
  state: CommandState;
  view: DocumentView;
  zoom: number;
  /** Identificativo della copia di recupero. */
  rid: string;
  recoveryTimer?: number;
}

const KIND_INFO: Record<DocKind, { base: string; label: string; icon: IconName }> = {
  doc: { base: "Documento", label: "Documento", icon: "FileText" },
  slides: { base: "Presentazione", label: "Presentazione", icon: "Presentation" },
  pdf: { base: "PDF", label: "PDF", icon: "FileType" },
  sheet: { base: "Cartella", label: "Foglio di calcolo", icon: "Sheet" },
};

const commandIndex = new Map<string, Command>(
  [...allCommands("doc"), ...allCommands("sheet"), ...allCommands("pdf"), ...allCommands("slides")].map((c) => [c.id, c]),
);

// Comandi dell'applicazione (non legati al ribbon).
const APP_COMMANDS: Command[] = [
  { id: "newDoc", label: "Nuovo documento", icon: "FileText", shortcut: "Ctrl+N" },
  { id: "newSheet", label: "Nuovo foglio di calcolo", icon: "Sheet", shortcut: "Ctrl+Maiusc+N" },
  { id: "newSlides", label: "Nuova presentazione", icon: "Presentation" },
  { id: "open", label: "Apri…", icon: "FolderOpen", shortcut: "Ctrl+O" },
  { id: "save", label: "Salva", icon: "Save", shortcut: "Ctrl+S" },
  { id: "saveAs", label: "Salva con nome…", icon: "SaveAll", shortcut: "Ctrl+Maiusc+S" },
  { id: "print", label: "Stampa…", icon: "Printer", shortcut: "Ctrl+P" },
  { id: "exportPdf", label: "Esporta in PDF…", icon: "FileDown" },
  { id: "undo", label: "Annulla", icon: "Undo2", shortcut: "Ctrl+Z" },
  { id: "redo", label: "Ripeti", icon: "Redo2", shortcut: "Ctrl+Y" },
  { id: "closeTab", label: "Chiudi documento", icon: "X", shortcut: "Ctrl+W" },
  { id: "toggleRibbon", label: "Mostra/nascondi ribbon", icon: "ChevronUp", shortcut: "Ctrl+F1" },
];
APP_COMMANDS.forEach((c) => commandIndex.set(c.id, c));

const ZOOM_MIN = 0.25, ZOOM_MAX = 4;

class App implements RibbonHost {
  private files: OpenFile[] = [];
  private active: OpenFile | null = null;
  private nextId = 1;
  private counters: Record<DocKind, number> = { doc: 0, sheet: 0, pdf: 0, slides: 0 };
  private showingBackstage = true;

  private ribbon = new Ribbon(this);
  private docTabs = h("div", { class: "doc-tabs", role: "tablist" });
  private workspace = h("main", { class: "workspace" });
  private dock = new Dock({
    cwd: () => { const p = this.active?.path; return p ? p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))) || undefined : undefined; },
    aiSource: (whole) => this.aiSource(whole),
    source: () => this.sourceView(),
  });
  private statusLeft = h("div", { class: "status-left" });
  private zoomSlider = h("input", { type: "range", min: "0", max: "100", class: "zoom-slider", "aria-label": "Zoom" });
  private zoomLabel = h("button", { class: "zoom-label", title: "Zoom al 100%" }, "100%");
  private themeBtn = h("button", { class: "icon-btn", onclick: () => this.execute("themeCycle") });
  private statusBar = h("footer", { class: "statusbar" });

  constructor(root: HTMLElement) {
    const quick = h("div", { class: "quick-access" },
      ...["save", "undo", "redo"].map((id) => {
        const c = commandIndex.get(id)!;
        return h("button", { class: "icon-btn", title: `${tr(c.label)} (${shortcut(c.shortcut ?? "")})`, onclick: () => this.execute(id) }, icon(c.icon));
      }));
    const search = h("button", { class: "search-box", title: "Cerca un comando (Alt+Q)", onclick: () => this.openPalette() },
      icon("Search", 14), h("span", {}, "Cerca comandi"), h("kbd", {}, "Alt+Q"));
    const prefsBtn = h("button", { class: "icon-btn", title: "Preferenze", onclick: () => this.openPreferences() }, icon("Settings"));
    const titlebar = h("header", { class: "titlebar" },
      h("div", { class: "brand", title: "ZikOffice" }, h("img", { class: "logo", src: "/zik-mark.png", alt: "", draggable: "false" })),
      quick, this.docTabs, h("div", { class: "spacer" }), search, prefsBtn, this.themeBtn);

    this.zoomSlider.addEventListener("input", () => this.setZoom(this.sliderToZoom(Number(this.zoomSlider.value))));
    this.zoomLabel.addEventListener("click", () => this.setZoom(1));
    const zoomBox = h("div", { class: "zoom" },
      h("button", { class: "icon-btn", title: "Riduci", onclick: () => this.stepZoom(-1) }, icon("Minus", 14)),
      this.zoomSlider,
      h("button", { class: "icon-btn", title: "Ingrandisci", onclick: () => this.stepZoom(1) }, icon("Plus", 14)),
      this.zoomLabel);
    this.statusBar.append(this.statusLeft, h("div", { class: "spacer" }), zoomBox);

    root.append(titlebar, this.ribbon.el, this.workspace, this.dock.el, this.statusBar);
    this.dock.onChange = () => this.ribbon.refresh();
    this.bindKeys();
    this.bindDragDrop();
    this.guardWindowClose();
    onThemeChange(() => this.updateThemeButton());
    this.updateThemeButton();
    this.render();
    void loadEngine(); // il motore del foglio di calcolo si carica in background
    void this.openStartupFiles();
  }

  // ---------- documenti ----------

  async newFile(kind: DocKind, from?: { path: string | null; bytes: Uint8Array; doc?: DocumentModel; name?: string; dirty?: boolean; pdf?: OpenInfo; slides?: Presentation }): Promise<OpenFile> {
    let view: DocumentView;
    let state: CommandState;
    const id = this.nextId++;
    if (kind === "pdf") {
      if (!from?.pdf) throw new Error("PDF non aperto");
      state = new CommandState({});
      view = new PdfEditor(from.pdf.id, from.pdf.pages, state, {
        changed: () => { if (this.active?.id === id) { this.updateStatus(); this.ribbon.refresh(); this.dock.docChanged(); } this.renderDocTabs(); this.updateTitle(); },
        selectionChanged: () => { if (this.active?.id === id) { this.updateStatus(); this.ribbon.refresh(); } },
        extractText: (pages) => void this.openPdfText(pages, from.path ? baseName(from.path) : undefined),
      });
    } else if (kind === "slides") {
      state = new CommandState({});
      view = new SlideView(from?.slides ?? newPresentation(DEFAULT_THEME), state, {
        changed: () => { if (this.active?.id === id) { this.updateStatus(); this.ribbon.refresh(); this.dock.docChanged(); } this.renderDocTabs(); this.updateTitle(); this.scheduleRecovery(id); },
        selectionChanged: () => { if (this.active?.id === id) { this.updateStatus(); this.ribbon.refresh(); } },
      });
    } else if (kind === "doc") {
      state = new CommandState({ toggles: ["ruler"], radios: { docView: "printLayout" } });
      const docModel = from?.doc ?? newDocument();
      if (!from?.doc) {
        const prefs = loadPrefs();
        docModel.defaultRun = { ...docModel.defaultRun, font: prefs.defaultFont, size: prefs.defaultFontSize };
      }
      const editor = new DocEditor(docModel, state, {
        changed: () => { if (this.active?.id === id) { this.updateStatus(); this.ribbon.refresh(); this.dock.docChanged(); } this.renderDocTabs(); this.updateTitle(); this.scheduleRecovery(id); },
        selectionChanged: () => { if (this.active?.id === id) { this.updateStatus(); this.ribbon.refresh(); } },
      });
      installDocCommands(editor);
      view = editor;
    } else {
      await loadEngine();
      state = new CommandState({ toggles: ["headings", "formulaBar"] });
      const model = from ? modelFromBytes(from.bytes) : newModel(`${tr(KIND_INFO.sheet.base)}${this.counters.sheet + 1}`);
      view = new SheetView(model, state, {
        changed: () => { if (this.active?.id === id) { this.updateStatus(); this.ribbon.refresh(); this.dock.docChanged(); } this.renderDocTabs(); this.updateTitle(); this.scheduleRecovery(id); },
        selectionChanged: () => { if (this.active?.id === id) { this.updateStatus(); this.ribbon.refresh(); } },
      });
    }
    let name: string;
    if (from?.name) name = from.name;
    else if (from?.path) name = baseName(from.path);
    else { this.counters[kind]++; name = `${tr(KIND_INFO[kind].base)}${this.counters[kind]}`; }
    const file: OpenFile = { id, name, kind, state, view, zoom: 1, path: from?.path ?? undefined, rid: crypto.randomUUID() };
    if (from?.dirty) (view as { dirty: boolean }).dirty = true;
    this.files.push(file);
    this.activate(file);
    return file;
  }

  private activate(file: OpenFile): void {
    this.active = file;
    this.showingBackstage = false;
    this.render();
    requestAnimationFrame(() => { file.view.shown(); file.view.focus(); this.dock.docChanged(); });
  }

  private async close(file: OpenFile): Promise<boolean> {
    if (file.view.dirty) {
      this.activate(file);
      const answer = await choose(
        "Salvare le modifiche?",
        t("Vuoi salvare le modifiche a «{0}» prima di chiudere?", file.name),
        [
          { id: "save", label: "Salva", primary: true },
          { id: "discard", label: "Non salvare" },
          { id: "cancel", label: "Annulla" },
        ]);
      if (answer === "cancel") return false;
      if (answer === "save" && !(await this.save(file))) return false;
    }
    const i = this.files.indexOf(file);
    if (i < 0) return true;
    this.files.splice(i, 1);
    clearTimeout(file.recoveryTimer);
    void deleteRecovery(file.rid);
    if (file.view instanceof PdfEditor) { file.view.dispose(); void pdfClose(file.view.sessionId).catch(() => undefined); }
    if (file.view instanceof SlideView) file.view.dispose();
    file.view.el.remove();
    if (this.active === file) {
      this.active = this.files[Math.min(i, this.files.length - 1)] ?? null;
      if (!this.active) this.showingBackstage = true;
    }
    this.render();
    this.active?.view.shown();
    return true;
  }

  /** Apertura dei file trascinati sulla finestra e da seconda istanza (file manager). */
  private bindDragDrop(): void {
    if (!inTauri) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      void win.onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          // Immagini trascinate su una presentazione: si inseriscono nella diapositiva.
          const view = this.active && !this.showingBackstage ? this.active.view : null;
          for (const path of event.payload.paths) {
            if (view instanceof SlideView && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path)) void view.insertImagePath(path);
            else void this.openPath(path);
          }
        }
      });
      void win.listen<string[]>("open-files", (event) => {
        for (const path of event.payload) void this.openPath(path);
      });
    });
  }

  /** Chiudendo la finestra con documenti non salvati, chiede conferma per ognuno. */
  private guardWindowClose(): void {
    if (!inTauri) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      void win.onCloseRequested(async (event) => {
        const unsaved = this.files.filter((f) => f.view.dirty);
        if (!unsaved.length) return;
        event.preventDefault();
        for (const f of unsaved) if (!(await this.close(f))) return;
        await win.destroy();
      });
    });
  }

  // ---------- file ----------

  private async openDialog(): Promise<void> {
    if (!inTauri) { toast("L'apertura dei file è disponibile nell'app desktop"); return; }
    const path = await pickWorkbookToOpen();
    if (path) await this.openPath(path);
  }

  private async importDocumentByPath(path: string, bytes: Uint8Array): Promise<DocumentModel> {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "md" || ext === "markdown") {
      const doc = importMarkdown(bytes);
      // Le immagini indicate con percorso relativo si leggono dalla cartella del file.
      const missing = await loadMarkdownImages(doc, path.replace(/[\\/][^\\/]*$/, ""), readBinary);
      if (missing) toast(missing === 1 ? t("Un'immagine non è stata trovata: il riferimento resta nel file") : t("{0} immagini non sono state trovate: il riferimento resta nel file", missing));
      return doc;
    }
    switch (ext) {
      case "docx": return importDocx(bytes);
      case "odt": return importOdt(bytes);
      case "pages": return importIworkDocument(bytes);
      case "rtf": return importRtf(bytes);
      case "html": case "htm": return importHtml(bytes);
      case "txt": return importPlainText(bytes);
      default: return importDocx(bytes);
    }
  }

  private exportDocumentByPath(path: string, ed: DocEditor): Uint8Array {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "odt") return exportOdt(ed.doc);
    if (ext === "txt") return exportPlainText(ed.doc);
    const pages = new Map(ed.layout.headings.map((h) => [h.pid, h.page]));
    return exportDocx(ed.doc, pages);
  }

  async openPath(path: string): Promise<void> {
    const already = this.files.find((f) => f.path === path);
    if (already) { this.activate(already); return; }
    if (!isSheetPath(path) && !isDocPath(path) && !isSlidesPath(path)) {
      await alertError("Formato non supportato", "ZikOffice apre documenti (.docx, .pages, .odt, .rtf, .md, .txt, .html), fogli di calcolo (.xlsx, .xlsm, .xls, .xlsb, .numbers, .ods, .csv, .tsv) e presentazioni (.pptx, .ppt, .odp).");
      return;
    }
    toast(t("Apertura di {0}…", baseName(path)));
    try {
      const kind: DocKind = isPdfPath(path) ? "pdf" : isDocPath(path) ? "doc" : isSlidesPath(path) ? "slides" : "sheet";
      // Se è aperto solo un documento nuovo e mai toccato, lo sostituiamo (come fanno Word ed Excel).
      const blank = this.files.length === 1 && !this.files[0].path && !this.files[0].view.dirty ? this.files[0] : null;
      if (kind === "pdf") {
        let info: OpenInfo;
        try {
          info = await pdfOpen(path);
        } catch (err) {
          if (!String(err).includes("PASSWORD_REQUIRED")) throw err;
          const pw = await promptDialog("PDF protetto da password", t("Inserisci la password per aprire «{0}»:", baseName(path)));
          if (pw === null) return;
          info = await pdfOpen(path, pw);
        }
        await this.newFile("pdf", { path, bytes: new Uint8Array(), pdf: info });
      } else if (kind === "slides") {
        let bytes = isLegacySlidesPath(path) ? await readLegacySlides(path) : await readBinary(path);
        if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && !isLegacySlidesPath(path)) {
          const pw = await promptDialog("Presentazione protetta da password", t("Inserisci la password per aprire «{0}»:", baseName(path)));
          if (pw === null) return;
          bytes = await decryptOfficeFile(path, pw);
        }
        const slides = importPptx(bytes);
        // Un .ppt/.odp convertito o un modello si salvano come nuovo .pptx.
        await this.newFile("slides", { path: canSaveSlidesInPlace(path) ? path : null, bytes, slides, name: baseName(path) });
      } else if (kind === "doc") {
        let bytes: Uint8Array = new Uint8Array();
        let doc: DocumentModel;
        if (isLegacyDocPath(path)) {
          bytes = await readLegacyDoc(path);
          doc = importDocx(bytes);
        } else {
          bytes = await readBinary(path);
          // File .docx protetto da password (contenitore OLE2)
          if (/\.docx$/i.test(path) && bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
            const pw = await promptDialog("Documento protetto da password", t("Inserisci la password per aprire «{0}»:", baseName(path)));
            if (pw === null) return;
            bytes = await decryptOfficeFile(path, pw);
          }
          doc = await this.importDocumentByPath(path, bytes);
        }
        await this.newFile("doc", { path, bytes, doc });
      } else {
        let wbBytes: Uint8Array;
        try {
          if (/\.numbers$/i.test(path)) {
            await loadEngine();
            wbBytes = importNumbers(await readBinary(path));
          } else wbBytes = await readWorkbook(path);
        } catch (err) {
          if (String(err).includes("PASSWORD_REQUIRED")) {
            const pw = await promptDialog("Cartella protetta da password", t("Inserisci la password per aprire «{0}»:", baseName(path)));
            if (pw === null) return;
            wbBytes = await readWorkbook(path, pw);
          } else {
            throw err;
          }
        }
        const opened = await this.newFile("sheet", { path, bytes: wbBytes });
        const extras = await readXlsxExtras(path);
        if (extras && opened.view instanceof SheetView) opened.view.importExtras(extras);
      }
      if (blank) await this.close(blank);
      addRecent(path, kind);
    } catch (e) {
      removeRecent(path);
      await alertError("Impossibile aprire il file", String(e));
      this.render();
    }
  }

  /** Apre come documento il testo estratto da un PDF (una pagina del PDF = una pagina del documento). */
  private async openPdfText(pages: string[], name?: string): Promise<void> {
    if (!pages.some((p) => p.trim())) {
      toast("Il PDF non contiene testo selezionabile: usa prima il riconoscimento (OCR)");
      return;
    }
    const doc = newDocument();
    doc.blocks = [];
    pages.forEach((pageText, pi) => {
      const lines = pageText.replace(/\r\n?/g, "\n").split("\n");
      lines.forEach((line, li) => {
        const suffix = pi < pages.length - 1 && li === lines.length - 1 ? "\f" : "";
        doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: line || suffix ? [{ text: line + suffix, props: {} }] : [] });
      });
    });
    if (!doc.blocks.length) doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
    await this.newFile("doc", { path: null, bytes: new Uint8Array(), doc, name: name ? t("{0} (testo)", name) : undefined, dirty: true });
  }

  /** Salva il documento; restituisce false se l'utente annulla o c'è un errore. */
  private async save(file: OpenFile, saveAs = false): Promise<boolean> {
    if (!inTauri) { toast("Il salvataggio è disponibile nell'app desktop"); return false; }
    let path = file.path;
    if (file.view instanceof PdfEditor) {
      if (!path || saveAs) path = (await pickPdfToSave(file.name)) ?? undefined;
      if (!path) return false;
      try {
        await saveHistorySnapshot(path);
        await pdfSave(file.view.sessionId, path);
      } catch (e) {
        await alertError("Impossibile salvare", String(e));
        return false;
      }
      return this.afterSave(file, path);
    }
    if (file.view instanceof SlideView) {
      if (!path || saveAs || !canSaveSlidesInPlace(path)) path = (await pickSlidesToSave(file.name)) ?? undefined;
      if (!path) return false;
      try {
        file.view.prepareExport();
        file.view.p.title ??= baseName(path);
        await saveHistorySnapshot(path);
        await writeBinary(path, exportPptx(file.view.p));
      } catch (e) {
        await alertError("Impossibile salvare", String(e));
        return false;
      }
      return this.afterSave(file, path);
    }
    if (file.view instanceof DocEditor) {
      const chosen = !path || saveAs || !canSaveDocInPlace(path);
      if (chosen) path = (await pickDocumentToSave(file.name)) ?? undefined;
      if (!path) return false;
      if (/\.(md|markdown)$/i.test(path) && !(await this.confirmMarkdownLosses(file, file.view.doc))) return false;
      try {
        await saveHistorySnapshot(path);
        if (/\.(md|markdown)$/i.test(path)) {
          // Le immagini vanno in una cartella accanto al file ("nota.md" → "nota.assets/"); salvando dove è stato aperto restano ai loro percorsi.
          const dir = path.replace(/[\\/][^\\/]*$/, "");
          const out = exportMarkdownFull(file.view.doc, { assetDir: `${baseName(path)}.assets`, keepPaths: path === file.path });
          for (const a of out.assets) await writeBinary(`${dir}/${a.path}`, a.bytes, true);
          await writeBinary(path, out.bytes);
        } else {
          await writeBinary(path, this.exportDocumentByPath(path, file.view));
        }
      } catch (e) {
        await alertError("Impossibile salvare", String(e));
        return false;
      }
      return this.afterSave(file, path);
    }
    if (!(file.view instanceof SheetView)) return false;
    const chosen = !path || saveAs || !canSaveSheetInPlace(path);
    if (chosen) path = (await pickWorkbookToSave(file.name)) ?? undefined;
    if (!path) return false;
    if (isCsvPath(path) && chosen) {
      const ok = await choose("Salvare come CSV?",
        "Il formato CSV conserva solo i valori del foglio attivo: formule, formattazione e altri fogli andranno persi nel file salvato.",
        [{ id: "yes", label: "Salva come CSV", primary: true }, { id: "no", label: "Annulla" }]);
      if (ok !== "yes") return false;
    }
    try {
      await saveHistorySnapshot(path);
      await writeWorkbook(path, file.view.toBytes(), file.view.currentSheet, isCsvPath(path) ? null : file.view.exportExtras());
    } catch (e) {
      await alertError("Impossibile salvare", String(e));
      return false;
    }
    return this.afterSave(file, path);
  }

  /** Il Markdown non conserva colori, font, allineamenti…: lo si dice una volta per documento prima di salvare. */
  private async confirmMarkdownLosses(file: OpenFile, doc: DocumentModel): Promise<boolean> {
    const losses = markdownLosses(doc);
    const known = this.mdWarned.get(file.id) ?? [];
    if (losses.some((l) => !known.includes(l))) {
      const ok = await choose("Salvare come Markdown?",
        t("Il Markdown è solo testo con una formattazione semplice. Nel file salvato andranno persi: {0}. Titoli, elenchi, tabelle, grassetto, corsivo, collegamenti, codice e immagini restano.", losses.map(tr).join(", ")),
        [{ id: "yes", label: "Salva come Markdown", primary: true }, { id: "no", label: "Annulla" }]);
      if (ok !== "yes") return false;
    }
    this.mdWarned.set(file.id, losses);
    return true;
  }

  private mdWarned = new Map<number, string[]>();

  private afterSave(file: OpenFile, path: string): boolean {
    clearTimeout(file.recoveryTimer);
    void deleteRecovery(file.rid);
    file.path = path;
    file.name = baseName(path);
    (file.view as SheetView | DocEditor | PdfEditor | SlideView).markSaved();
    addRecent(path, file.kind);
    this.renderDocTabs();
    this.updateTitle();
    toast(t("Salvato: {0}", file.name));
    return true;
  }

  /** Contenuto da stampare: pagine del documento o tabella del foglio attivo. */
  private printable(file: OpenFile, sheetOpts: SheetPrintOptions = {}): { html: string; page: { width: number; height: number }; margin: number } {
    if (file.view instanceof DocEditor) {
      const { html, width, height } = documentPrintHtml(file.view);
      return { html, page: { width, height }, margin: 0 };
    }
    if (file.view instanceof SlideView) {
      const { html, width, height } = file.view.printHtml();
      return { html, page: { width, height }, margin: 0 };
    }
    const sv = file.view as SheetView;
    const base = sheetPrintable(sv.model, sv.currentSheet, file.name, sheetOpts);
    const charts = sv.chartLayer.forSheet(sv.currentSheet);
    if (charts.length) {
      const chartsHtml = charts.map((c) => `<div style="margin-top:14pt;page-break-inside:avoid"><div style="font-weight:600;font-size:10pt;margin-bottom:4pt">${c.title}</div>${renderChartSvg(sv.model, c, 440, 220)}</div>`).join("");
      return { html: `${base.html}${chartsHtml}`, page: base.page, margin: base.margin };
    }
    return base;
  }

  private async print(file: OpenFile, sheetOpts?: SheetPrintOptions): Promise<void> {
    if (file.view instanceof PdfEditor) {
      toast("Preparazione della stampa…");
      const r = await file.view.printImages(150);
      await printHtml(r.html, { width: r.width, height: r.height }, 0);
      setTimeout(r.done, 8000);
      return;
    }
    const { html, page, margin } = this.printable(file, sheetOpts);
    await printHtml(html, page, margin);
  }

  private async exportPdf(file: OpenFile, sheetOpts?: SheetPrintOptions): Promise<void> {
    if (file.view instanceof PdfEditor) { await this.save(file, true); return; }
    if (!inTauri) { toast("Usa Stampa e scegli «Salva come PDF»"); await this.print(file, sheetOpts); return; }
    const path = await pickPdfToSave(file.name);
    if (!path) return;
    const { html, page, margin } = this.printable(file, sheetOpts);
    const unmount = mountPrint(html, page, margin);
    toast("Esportazione in PDF…");
    try {
      await exportPdf(path, page.width, page.height, margin);
      toast(t("PDF salvato: {0}.pdf", baseName(path)));
    } catch (e) {
      unmount();
      const answer = await choose("Esportazione PDF non riuscita", t("{0}\n\nPuoi usare Stampa e scegliere «Stampa su file» (PDF).", e), [
        { id: "print", label: "Apri la stampa", primary: true }, { id: "no", label: "Chiudi" }]);
      if (answer === "print") await this.print(file, sheetOpts);
      return;
    }
    unmount();
  }

  /** Copia di recupero qualche secondo dopo l'ultima modifica. */
  private scheduleRecovery(id: number): void {
    const file = this.files.find((f) => f.id === id);
    if (!file || !inTauri || file.kind === "pdf") return;
    clearTimeout(file.recoveryTimer);
    file.recoveryTimer = window.setTimeout(() => {
      if (!file.view.dirty || !this.files.includes(file)) return;
      const bytes = file.view instanceof DocEditor
        ? new TextEncoder().encode(JSON.stringify(file.view.doc))
        : file.view instanceof SlideView
          ? new TextEncoder().encode(serializePresentation(file.view.p))
          : (file.view as SheetView).model.toBytes();
      void writeRecovery({ id: file.rid, name: file.name, kind: file.kind, path: file.path ?? null }, bytes).catch(() => undefined);
    }, 4000);
  }

  /** All'avvio: documenti rimasti non salvati da una chiusura anomala. */
  private async offerRecovery(): Promise<void> {
    const entries = await listRecovery().catch(() => []);
    if (!entries.length) return;
    const names = entries.map((e) => `• ${e.name}`).join("\n");
    const answer = await choose(
      entries.length === 1 ? "Recuperare un documento?" : `Recuperare ${entries.length} documenti?`,
      t("ZikOffice non è stato chiuso correttamente. Questi documenti avevano modifiche non salvate:\n{0}", names),
      [{ id: "restore", label: "Recupera", primary: true }, { id: "discard", label: "Elimina le copie" }, { id: "later", label: "Non ora" }]);
    if (answer === "later") return;
    for (const e of entries) {
      if (answer === "restore") {
        try {
          const bytes = await readRecovery(e.id);
          if (e.kind === "doc") {
            const doc = JSON.parse(new TextDecoder().decode(bytes)) as DocumentModel;
            await this.newFile("doc", { path: e.path, bytes, doc, name: e.name, dirty: true });
          } else if (e.kind === "slides") {
            await this.newFile("slides", { path: e.path, bytes, slides: deserializePresentation(new TextDecoder().decode(bytes)), name: e.name, dirty: true });
          } else {
            await this.newFile("sheet", { path: e.path, bytes, name: e.name, dirty: true });
          }
        } catch (err) {
          toast(t("Impossibile recuperare «{0}»: {1}", e.name, err));
          continue;
        }
      }
      await deleteRecovery(e.id);
    }
    if (answer === "restore") this.files.forEach((f) => this.scheduleRecovery(f.id));
  }

  private async openStartupFiles(): Promise<void> {
    await this.offerRecovery();
    for (const path of await startupFiles()) await this.openPath(path);
  }

  // ---------- rendering ----------

  private render(): void {
    const kind = this.showingBackstage ? null : this.active?.kind ?? null;
    document.body.dataset.kind = this.active?.kind ?? "doc";
    this.ribbon.setKind(kind);
    this.renderDocTabs();

    // Le viste restano nel DOM (nascoste) per conservare scroll e stato.
    for (const f of this.files) {
      if (!f.view.el.isConnected) this.workspace.append(f.view.el);
      f.view.el.hidden = this.showingBackstage || f !== this.active;
    }
    this.workspace.querySelector(".backstage")?.remove();
    if (this.showingBackstage) this.workspace.append(this.backstage());

    this.statusBar.hidden = this.showingBackstage;
    this.updateStatus();
    this.updateZoomUi();
    this.updateTitle();
  }

  private renderDocTabs(): void {
    clear(this.docTabs);
    for (const f of this.files) {
      const selected = f === this.active && !this.showingBackstage;
      this.docTabs.append(h("div", {
        class: `doc-tab kind-${f.kind}${f.view.dirty ? " dirty" : ""}`, role: "tab", "aria-selected": String(selected),
        title: f.path ?? f.name,
        onclick: () => this.activate(f),
        onauxclick: (e: MouseEvent) => { if (e.button === 1) void this.close(f); },
      },
        icon(KIND_INFO[f.kind].icon, 14),
        h("span", { class: "doc-tab-name" }, f.name),
        h("span", { class: "dirty-dot", title: "Modifiche non salvate" }),
        h("button", {
          class: "doc-tab-close", title: "Chiudi (Ctrl+W)",
          onclick: (e: Event) => { e.stopPropagation(); void this.close(f); },
        }, icon("X", 12, 2))));
    }
  }

  private async openTemplate(t: TemplateDef): Promise<void> {
    if (t.kind === "sheet") await loadEngine();
    const res = t.create();
    if (t.kind === "doc") {
      await this.newFile("doc", { path: null, bytes: new Uint8Array(), doc: res as DocumentModel, name: t.title, dirty: true });
    } else {
      await this.newFile("sheet", { path: null, bytes: res as Uint8Array, name: t.title, dirty: true });
    }
  }

  private async openVersionHistory(file: OpenFile): Promise<void> {
    if (!file.path) { toast("Salva prima il file per avere una cronologia delle versioni"); return; }
    const versions = await listHistory(file.path);
    if (!versions.length) { toast("Nessuna versione precedente salvata per questo file"); return; }
    const fmt = (sec: number) => new Date(sec * 1000).toLocaleString(localeTag(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const picked = await choose(
      `Cronologia versioni — ${file.name}`,
      "Scegli una versione precedente da aprire in una nuova scheda (il file attuale non viene sovrascritto):",
      [
        ...versions.slice(0, 8).map((v) => ({ id: v.id, label: `${fmt(v.saved_at)} (${Math.max(1, Math.round(v.size / 1024))} KB)` })),
        { id: "cancel", label: "Chiudi" },
      ],
    );
    if (!picked || picked === "cancel") return;
    try {
      const bytes = await readHistoryVersion(file.path, picked);
      if (file.kind === "doc") {
        await this.newFile("doc", { path: null, bytes, doc: await this.importDocumentByPath(file.path, bytes), name: `${file.name} (versione)`, dirty: true });
      } else if (file.kind === "slides") {
        await this.newFile("slides", { path: null, bytes, slides: importPptx(bytes), name: `${file.name} (versione)`, dirty: true });
      } else {
        await this.newFile("sheet", { path: null, bytes, name: `${file.name} (versione)`, dirty: true });
      }
      toast("Versione precedente aperta in una nuova scheda");
    } catch (e) {
      await alertError("Impossibile aprire la versione", String(e));
    }
  }

  private async openPrintPreview(file: OpenFile): Promise<void> {
    const isSheet = file.view instanceof SheetView;
    const opts: SheetPrintOptions = { orientation: "auto", margin: SHEET_MARGIN, scale: "fit", repeatHeader: true, showTitle: false };
    const metaLabel = h("span", { class: "muted", style: "font-size:12px" });
    const stage = h("div", { style: "overflow:auto;background:#e5e7eb;padding:16px;border-radius:6px;flex:1;display:flex;justify-content:center" });

    const refresh = () => {
      const { html, page, margin } = this.printable(file, opts);
      const scale = Math.min(0.65, (window.innerWidth - 160) / (page.width * (96 / 72)));
      const wPx = Math.round(page.width * (96 / 72) * scale);
      const orient = page.width > page.height ? "Orizzontale" : "Verticale";
      metaLabel.textContent = `${tr(orient)} · ${Math.round(page.width / 2.83465)} × ${Math.round(page.height / 2.83465)} mm`;
      const box = h("div", { style: `background:#fff;color:#000;box-shadow:0 2px 12px rgba(0,0,0,.18);padding:${Math.round(margin * scale)}px;width:${wPx}px;overflow:hidden;zoom:${scale.toFixed(3)}` });
      box.innerHTML = html;
      stage.replaceChildren(box);
    };

    let controls: HTMLElement | null = null;
    if (isSheet) {
      const orientSel = h("select", { class: "find-input", onchange: () => { opts.orientation = orientSel.value as SheetPrintOptions["orientation"]; refresh(); } },
        h("option", { value: "auto" }, "Orientamento: Auto"),
        h("option", { value: "portrait" }, "Verticale"),
        h("option", { value: "landscape" }, "Orizzontale"));
      const scaleSel = h("select", { class: "find-input", onchange: () => { opts.scale = scaleSel.value === "fit" ? "fit" : Number(scaleSel.value); refresh(); } },
        h("option", { value: "fit" }, "Scala: Adatta"),
        h("option", { value: "1" }, "100%"),
        h("option", { value: "0.85" }, "85%"),
        h("option", { value: "0.7" }, "70%"));
      const marSel = h("select", { class: "find-input", onchange: () => { opts.margin = Number(marSel.value); refresh(); } },
        h("option", { value: String(SHEET_MARGIN) }, "Margini: Normali"),
        h("option", { value: "22" }, "Stretti (0,8 cm)"),
        h("option", { value: "70" }, "Larghi (2,5 cm)"));
      const repCb = h("input", { type: "checkbox", checked: "true", onchange: () => { opts.repeatHeader = repCb.checked; refresh(); } });
      const titleCb = h("input", { type: "checkbox", onchange: () => { opts.showTitle = titleCb.checked; refresh(); } });
      controls = h("div", { style: "display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px" },
        orientSel, scaleSel, marSel,
        h("label", { style: "display:flex;align-items:center;gap:4px" }, repCb, "Ripeti intestazione"),
        h("label", { style: "display:flex;align-items:center;gap:4px" }, titleCb, "Titolo e data"));
    }

    const overlay = h("div", { class: "dlg-overlay", onmousedown: (e: Event) => { if (e.target === overlay) overlay.remove(); } },
      h("div", { class: "dlg-box", style: "max-width:92vw;max-height:90vh;display:flex;flex-direction:column;gap:10px;width:820px" },
        h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:12px" },
          h("h3", { style: "margin:0" }, t("Anteprima di stampa — {0}", file.name)), metaLabel),
        controls,
        stage,
        h("div", { class: "dlg-actions" },
          h("button", { class: "dlg-btn", onclick: () => overlay.remove() }, "Chiudi"),
          h("button", { class: "dlg-btn", onclick: () => { overlay.remove(); void this.exportPdf(file, isSheet ? opts : undefined); } }, "Esporta PDF…"),
          h("button", { class: "dlg-btn primary", onclick: () => { overlay.remove(); void this.print(file, isSheet ? opts : undefined); } }, "Stampa…"))));
    document.body.append(overlay);
    refresh();
  }

  private async runPdfMerge(): Promise<void> {
    if (!inTauri) { toast("Disponibile nell'app desktop"); return; }
    const paths = await pickPdfsToMerge();
    if (!paths) return;
    const out = await pickPdfToSave("Documento_unito");
    if (!out) return;
    try {
      const n = await mergePdfFiles(paths, out);
      toast(t("PDF unito salvato ({0} pagine)", n));
    } catch (e) {
      await alertError("Errore unione PDF", String(e));
    }
  }

  private async runPdfSplit(): Promise<void> {
    if (!inTauri) { toast("Disponibile nell'app desktop"); return; }
    const path = await pickSinglePdf();
    if (!path) return;
    const spec = await promptDialog("Estrai pagine da PDF", "Pagine da estrarre (es. 1-3, 5):", "1-2");
    if (!spec?.trim()) return;
    const out = await pickPdfToSave(`${baseName(path)}_estratto`);
    if (!out) return;
    try {
      const n = await splitPdfFile(path, spec, out);
      toast(t("Estratte {0} pagine in {1}.pdf", n, baseName(out)));
    } catch (e) {
      await alertError("Errore estrazione PDF", String(e));
    }
  }

  private openPreferences(): void {
    const prefs = loadPrefs();
    const fontSel = h("select", { class: "find-input", style: "width:100%" },
      ...["Calibri", "Carlito", "Liberation Sans", "Liberation Serif", "Noto Sans", "Ubuntu"].map((f) => h("option", { value: f, ...(f === prefs.defaultFont ? { selected: "true" } : {}) }, f)));
    const sizeInp = h("input", { class: "find-input", type: "number", min: "8", max: "36", value: String(prefs.defaultFontSize), style: "width:100%" });
    const uiSel = h("select", { class: "find-input", style: "width:100%" },
      ...LANGS.map((l) => h("option", { value: l.id, ...(l.id === lang() ? { selected: "true" } : {}) }, l.name)));
    const langSel = h("select", { class: "find-input", style: "width:100%" },
      ...["it_IT", "en_US", "es_ES", "fr_FR", "de_DE", "pt_BR"].map((l) => h("option", { value: l, ...(l === prefs.spellLang ? { selected: "true" } : {}) }, langLabel(l))));
    const overlay = h("div", { class: "dlg-overlay", onmousedown: (e: Event) => { if (e.target === overlay) overlay.remove(); } },
      h("div", { class: "dlg-box", style: "width:360px;display:flex;flex-direction:column;gap:10px" },
        h("h3", { style: "margin:0" }, "Preferenze ZikOffice"),
        h("label", { style: "font-size:12px" }, "Lingua dell'interfaccia:", uiSel),
        h("label", { style: "font-size:12px" }, "Font predefinito nuovi documenti:", fontSel),
        h("label", { style: "font-size:12px" }, "Dimensione carattere predefinita (pt):", sizeInp),
        h("label", { style: "font-size:12px" }, "Lingua controllo ortografico:", langSel),
        h("div", { class: "dlg-actions" },
          h("button", { class: "dlg-btn", onclick: () => overlay.remove() }, "Annulla"),
          h("button", {
            class: "dlg-btn primary",
            onclick: () => {
              const next = { ...prefs, defaultFont: fontSel.value, defaultFontSize: Number(sizeInp.value) || 11, spellLang: langSel.value };
              savePrefs(next);
              if (this.active?.view instanceof DocEditor) void this.active.view.spell.setLang(next.spellLang).catch(() => undefined);
              overlay.remove();
              if (uiSel.value !== lang()) {
                // Ribbon, menu e finestre si ridisegnano solo ripartendo: non lo si fa con documenti da salvare.
                const pending = this.files.some((f) => f.view.dirty);
                setLang(uiSel.value as Lang, !pending);
                if (pending) toast(t("La lingua cambierà al prossimo avvio: salva prima i documenti aperti"));
                return;
              }
              toast("Preferenze salvate");
            },
          }, "Salva"))));
    document.body.append(overlay);
  }

  private backstage(): HTMLElement {
    const card = (kind: DocKind, title: string, desc: string, onclick?: () => void) =>
      h("button", { class: `new-card kind-${kind}`, onclick: onclick ?? (() => void this.newFile(kind)) },
        h("div", { class: "new-card-thumb" }, kind === "doc" ? docThumb() : kind === "slides" ? slidesThumb() : sheetThumb()),
        h("div", { class: "new-card-title" }, title),
        h("div", { class: "new-card-desc" }, desc));

    const when = (ms: number) => {
      const d = new Date(ms), today = new Date();
      return d.toDateString() === today.toDateString()
        ? t("Oggi, {0}", d.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit" }))
        : d.toLocaleDateString(localeTag(), { day: "numeric", month: "long", year: "numeric" });
    };
    const openNow = this.files.map((f) => h("li", {},
      h("button", { class: "recent-item", onclick: () => this.activate(f) },
        icon(KIND_INFO[f.kind].icon, 18), h("span", {}, f.name), h("span", { class: "muted" }, "Aperto ora"))));
    const recent = recentFiles().filter((r) => !this.files.some((f) => f.path === r.path)).map((r) => h("li", {},
      h("button", { class: "recent-item", title: r.path, onclick: () => void this.openPath(r.path) },
        icon(KIND_INFO[r.kind].icon, 18),
        h("span", { class: "recent-name" }, r.name, h("small", {}, r.path.replace(/[\\/][^\\/]*$/, ""))),
        h("span", { class: "muted" }, when(r.openedAt)))));
    const list = openNow.length + recent.length
      ? h("ul", { class: "recent-list" }, ...openNow, ...recent)
      : h("p", { class: "muted empty" }, "Nessun documento recente. I file che apri compariranno qui.");

    const hour = new Date().getHours();
    const greeting = hour < 13 ? "Buongiorno" : hour < 18 ? "Buon pomeriggio" : "Buonasera";

    return h("div", { class: "backstage" },
      h("nav", { class: "backstage-nav" },
        this.active ? h("button", { class: "back-btn", onclick: () => { this.showingBackstage = false; this.render(); this.active?.view.shown(); this.active?.view.focus(); } }, icon("ChevronUp", 16), "Torna al documento") : null,
        h("button", { class: "nav-item", "aria-current": "page" }, icon("Plus", 18), "Nuovo"),
        h("button", { class: "nav-item", onclick: () => void this.openDialog() }, icon("FolderOpen", 18), "Apri"),
        this.active ? h("button", { class: "nav-item", onclick: () => this.execute("save") }, icon("Save", 18), "Salva") : null,
        this.active ? h("button", { class: "nav-item", onclick: () => this.execute("saveAs") }, icon("SaveAll", 18), "Salva con nome") : null,
        this.active?.path ? h("button", { class: "nav-item", onclick: () => void this.openVersionHistory(this.active!) }, icon("Clock", 18), "Cronologia versioni") : null,
        this.active ? h("button", { class: "nav-item", onclick: () => void this.openPrintPreview(this.active!) }, icon("Printer", 18), "Anteprima e stampa") : null,
        this.active ? h("button", { class: "nav-item", onclick: () => this.execute("exportPdf") }, icon("FileDown", 18), "Esporta PDF") : null,
        h("button", { class: "nav-item", onclick: () => void this.runPdfMerge() }, icon("Merge", 18), "Unisci PDF"),
        h("button", { class: "nav-item", onclick: () => void this.runPdfSplit() }, icon("Scissors", 18), "Estrai pagine PDF"),
        h("button", { class: "nav-item", onclick: () => this.openPreferences() }, icon("Settings", 18), "Preferenze")),
      h("div", { class: "backstage-main" },
        h("h1", {}, greeting),
        h("section", {},
          h("h2", {}, "Nuovo"),
          h("div", { class: "new-cards" },
            card("doc", "Documento vuoto", "Lettere, relazioni, tesi"),
            card("sheet", "Cartella di lavoro vuota", "Tabelle, calcoli, bilanci"),
            card("slides", "Presentazione vuota", "Diapositive che si impaginano da sole"),
            ...TEMPLATES.map((t) => card(t.kind, t.title, t.desc, () => void this.openTemplate(t))))),
        h("section", {},
          h("div", { class: "section-head" }, h("h2", {}, "Recenti"),
            h("button", { class: "link-btn", onclick: () => void this.openDialog() }, icon("FolderOpen", 14), "Apri altri file")),
          list)));
  }

  private updateStatus(): void {
    clear(this.statusLeft);
    if (!this.active) return;
    const view = this.active.view;
    for (const s of view.status()) {
      if (view instanceof DocEditor && s === "Italiano (Italia)") {
        const btn = h("button", {
          class: "zoom-label", title: "Cambia lingua del controllo ortografico",
          onclick: async (e: MouseEvent) => {
            const langs = await view.spell.listLangs();
            openMenu(e.currentTarget as HTMLElement, langs.map((code) => ({
              label: langLabel(code),
              icon: code === view.spell.lang ? "Check" : undefined,
              action: () => void view.spell.setLang(code).then(() => { this.updateStatus(); toast(`Dizionario: ${langLabel(code)}`); }).catch((err) => toast(String(err))),
            })));
          },
        }, langLabel(view.spell.lang));
        this.statusLeft.append(btn);
      } else {
        this.statusLeft.append(h("span", {}, s));
      }
    }
  }

  private async updateTitle(): Promise<void> {
    const f = this.active && !this.showingBackstage ? this.active : null;
    const title = f ? `${f.view.dirty ? "• " : ""}${f.name} — ZikOffice` : "ZikOffice";
    if (document.title === title) return;
    document.title = title;
    if (inTauri) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setTitle(title);
      } catch { /* titolo non essenziale */ }
    }
  }

  private updateThemeButton(): void {
    const m = themeMode();
    const label = m === "system" ? "Tema: sistema" : m === "light" ? "Tema: chiaro" : "Tema: scuro";
    this.themeBtn.replaceChildren(icon(m === "system" ? "Monitor" : resolvedTheme() === "dark" ? "Moon" : "Sun"));
    this.themeBtn.title = t("{0} (clic per cambiare)", label);
  }

  // ---------- zoom ----------

  // Lo slider è logaritmico: 100% sta al centro, come in Office.
  private sliderToZoom(v: number): number {
    return Math.round(Math.exp(Math.log(ZOOM_MIN) + (v / 100) * (Math.log(ZOOM_MAX) - Math.log(ZOOM_MIN))) * 100) / 100;
  }
  private zoomToSlider(z: number): number {
    return ((Math.log(z) - Math.log(ZOOM_MIN)) / (Math.log(ZOOM_MAX) - Math.log(ZOOM_MIN))) * 100;
  }

  private setZoom(z: number): void {
    if (!this.active) return;
    z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    if (Math.abs(z - 1) < 0.04) z = 1; // aggancia al 100%
    this.active.zoom = z;
    this.active.view.setZoom(z);
    this.updateZoomUi();
  }

  private stepZoom(dir: number): void {
    if (!this.active) return;
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
    const z = this.active.zoom;
    const next = dir > 0 ? steps.find((s) => s > z + 0.001) : [...steps].reverse().find((s) => s < z - 0.001);
    this.setZoom(next ?? z);
  }

  private updateZoomUi(): void {
    const z = this.active?.zoom ?? 1;
    this.zoomSlider.value = String(this.zoomToSlider(z));
    this.zoomLabel.textContent = `${Math.round(z * 100)}%`;
  }

  // ---------- comandi (RibbonHost) ----------

  execute(id: string, anchor?: HTMLElement): void {
    const f = this.active;
    const meta = commandIndex.get(id);

    switch (id) {
      case "newDoc": void this.newFile("doc"); return;
      case "newSheet": void this.newFile("sheet"); return;
      case "newSlides": void this.newFile("slides"); return;
      case "closeTab": if (f) void this.close(f); return;
      case "toggleRibbon": this.ribbon.toggleCollapsed(); return;
      case "dockTerminal": this.dock.toggle("terminal"); return;
      case "dockAssistant": this.dock.toggle("assistant"); return;
      case "dockSource": this.dock.toggle("source"); return;
      case "themeCycle": {
        const m = cycleTheme();
        toast(m === "system" ? "Tema: segue il sistema" : m === "light" ? "Tema chiaro" : "Tema scuro");
        return;
      }
      case "zoom100": this.setZoom(1); return;
      case "zoomDialog": this.zoomSlider.focus(); return;
      case "pageWidth":
        if (f?.view instanceof DocEditor || f?.view instanceof PdfEditor) this.setZoom(f.view.fitWidthZoom());
        else if (f?.view instanceof SlideView) this.setZoom(1);
        return;
      case "open": void this.openDialog(); return;
      case "print": if (f) void this.openPrintPreview(f); else toast("Non c'è nessun documento da stampare"); return;
      case "exportPdf": if (f) void this.exportPdf(f); else toast("Non c'è nessun documento da esportare"); return;
      case "save": case "saveAs":
        if (f) void this.save(f, id === "saveAs");
        else toast("Non c'è nessun documento da salvare");
        return;
    }

    if (!f) { toast(t("«{0}» sarà disponibile nelle prossime tappe", meta?.label ?? id)); return; }

    // I comandi il cui stato dipende dal contenuto (es. Grassetto) li gestisce la vista.
    const viewOwned = f.view.isActive?.(id) !== undefined;
    if (!viewOwned) {
      if (id.startsWith("style.")) f.state.set("style", id);
      else if (meta?.radio) f.state.choose(meta.radio, id, meta.radio === "list");
      else if (meta?.toggle) f.state.flip(id);
    }

    const handled = f.view.handle(id, anchor);
    if (!handled && (viewOwned || (!meta?.toggle && !meta?.radio && !id.startsWith("style.")))) {
      toast(t("«{0}» sarà disponibile nelle prossime tappe", meta?.label ?? id));
    }
    this.ribbon.refresh();
    this.updateStatus();
  }

  /** Il testo del documento attivo per l'assistente, con il modo di riscriverci sopra. */
  /** Il Markdown del documento attivo per la scheda «Sorgente», e come rileggerlo se l'utente lo modifica. */
  private sourceView(): SourceView | null {
    const file = this.active;
    const view = file?.view;
    if (!file || !view || this.showingBackstage || !(view instanceof DocEditor)) return null;
    const src = markdownSource(view.doc);
    return {
      name: file.name,
      text: src.text,
      apply: async (text) => {
        try {
          const doc = markdownFromSource(view.doc, text, src.images);
          // Immagini nuove indicate con un percorso: si cercano accanto al file (se non ci sono, resta un riquadro).
          const dir = file.path?.replace(/[\\/][^\\/]*$/, "");
          await loadMarkdownImages(doc, dir ?? "", dir ? readBinary : async () => { throw new Error("nessuna cartella"); });
          view.replaceDocument(doc);
          return null;
        } catch (e) { return String(e); }
      },
    };
  }

  private async aiSource(whole: boolean): Promise<AiSource | null> {
    const view = this.active?.view;
    if (!view || this.showingBackstage) return null;
    const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
    if (view instanceof DocEditor) {
      const { text, selection } = view.aiText(whole);
      return {
        label: t("{0} ({1} parole)", selection ? "la selezione" : "il documento", words(text)), text,
        replace: (t) => view.aiApply("replace", t, selection),
        insert: (t) => view.aiApply("insert", t, selection),
      };
    }
    if (view instanceof SheetView) {
      const text = view.aiText();
      return { label: t("le celle selezionate ({0} parole)", words(text)), text, insert: (t) => view.aiInsert(t) };
    }
    if (view instanceof SlideView) {
      const text = view.aiText(whole);
      return { label: t("{0} ({1} parole)", whole ? "la presentazione" : "la diapositiva", words(text)), text };
    }
    if (view instanceof PdfEditor) {
      const text = (await pdfText(view.sessionId)).join("\n\n");
      return { label: t("il testo del PDF ({0} parole)", words(text)), text };
    }
    return null;
  }

  isActive(id: string): boolean {
    if (id === "dockTerminal") return this.dock.isOpen("terminal");
    if (id === "dockAssistant") return this.dock.isOpen("assistant");
    if (id === "dockSource") return this.dock.isOpen("source");
    if (!this.active) return false;
    const fromView = this.active.view.isActive?.(id);
    if (fromView !== undefined) return fromView;
    if (id.startsWith("style.")) return this.active.state.get("style") === id;
    return this.active.state.isOn(id);
  }

  selectValue(id: string): string | undefined {
    return this.active?.view.selectValue?.(id) ?? this.active?.state.get(id);
  }

  setSelect(id: string, value: string): void {
    const f = this.active;
    if (!f) return;
    if (!f.view.setSelect?.(id, value)) {
      f.state.set(id, value);
      f.view.focus();
    }
    this.ribbon.refresh();
  }

  openBackstage(): void {
    this.showingBackstage = true;
    this.render();
  }

  // ---------- tastiera ----------

  private bindKeys(): void {
    window.addEventListener("keydown", (e) => {
      if (document.querySelector(".dlg-overlay")) return; // una finestra di dialogo è aperta
      const ctrl = e.ctrlKey || e.metaKey;
      // I campi di testo gestiscono da soli Ctrl+Z ecc.; l'editor di documenti invece usa i comandi dell'app.
      const t = e.target as HTMLElement;
      const inField = (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) && !("docInput" in t.dataset);
      const k = e.key.toLowerCase();

      if (e.altKey && k === "q") { e.preventDefault(); this.openPalette(); return; }
      if (e.ctrlKey && (e.key === "`" || e.code === "Backquote")) { e.preventDefault(); this.execute("dockTerminal"); return; }
      if (e.ctrlKey && e.shiftKey && k === "a") { e.preventDefault(); this.execute("dockAssistant"); return; }
      if (e.ctrlKey && e.shiftKey && k === "m") { e.preventDefault(); this.execute("dockSource"); return; }
      // Dentro il pannello (terminale, assistente) le scorciatoie sono quelle del terminale e dei campi di testo.
      if (t.closest?.(".dock")) return;
      if (ctrl && e.key === "F1") { e.preventDefault(); this.execute("toggleRibbon"); return; }
      if (!ctrl) return;

      const appKeys: Record<string, string> = {
        n: e.shiftKey ? "newSheet" : "newDoc", o: "open", s: e.shiftKey ? "saveAs" : "save", w: "closeTab", p: "print",
      };
      if (appKeys[k]) { e.preventDefault(); this.execute(appKeys[k]); return; }
      if (e.key === "Tab" && this.files.length > 1 && this.active) {
        e.preventDefault();
        const i = this.files.indexOf(this.active);
        this.activate(this.files[(i + (e.shiftKey ? -1 : 1) + this.files.length) % this.files.length]);
        return;
      }
      if (k === "=" || k === "+") { e.preventDefault(); this.stepZoom(1); return; }
      if (k === "-") { e.preventDefault(); this.stepZoom(-1); return; }
      if (k === "0") { e.preventDefault(); this.setZoom(1); return; }

      if (inField || !this.active || this.showingBackstage) return;
      if (this.active.kind === "pdf") {
        if (k === "z" || k === "y") { e.preventDefault(); this.execute(k === "z" ? "undo" : "redo"); }
        return;
      }
      const fmtKeys: Record<string, string> = this.active.kind === "slides"
        ? { b: "bold", i: "italic", u: "underline", l: "alignLeft", e: "alignCenter", r: "alignRight", j: "justify", f: "find", h: "replace", k: "insertLink", m: "newSlide", d: "duplicateSlide", a: "selectAll", ...(e.shiftKey ? { ">": "growFont", "<": "shrinkFont" } : {}) }
        : this.active.kind === "doc"
        ? { b: "bold", i: "italic", u: "underline", l: "alignLeft", e: "alignCenter", r: "alignRight", j: "justify", f: "find", h: "replace", k: "insertLink", "=": "subscript", ...(e.shiftKey ? { "+": "superscript", ">": "growFont", "<": "shrinkFont" } : {}) }
        : { b: "bold", i: "italic", u: "underline", "5": "strike", f: "find", h: "replace", ...(e.shiftKey ? { l: "filter" } : {}) };
      if (fmtKeys[k]) { e.preventDefault(); this.execute(fmtKeys[k]); }
      if (k === "z" || k === "y") { e.preventDefault(); this.execute(k === "z" ? "undo" : "redo"); }
    });

    // Ctrl+rotellina = zoom, come in Office.
    this.workspace.addEventListener("wheel", (e) => {
      if (!e.ctrlKey || !this.active) return;
      e.preventDefault();
      this.setZoom(this.active.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    window.addEventListener("resize", () => this.active?.view.shown());
  }

  // ---------- palette comandi ("Cerca", Alt+Q) ----------

  private openPalette(): void {
    if (document.querySelector(".palette")) return;
    const kind = this.active?.kind;
    const commands = [...APP_COMMANDS, ...(kind ? allCommands(kind) : [])];
    const input = h("input", { class: "palette-input", placeholder: "Cosa vuoi fare? (es. sommario, grassetto, tabella)", spellcheck: "false" });
    const list = h("ul", { class: "palette-list", role: "listbox" });
    let matches: Command[] = [];
    let sel = 0;

    const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const update = () => {
      const q = norm(input.value.trim());
      matches = commands.filter((c) => !q || norm(tr(c.label)).includes(q) || norm(c.id).includes(q)).slice(0, 9);
      sel = Math.min(sel, Math.max(0, matches.length - 1));
      list.replaceChildren(...matches.map((c, i) => h("li", {
        class: "palette-item", role: "option", "aria-selected": String(i === sel),
        onmousedown: (e: Event) => { e.preventDefault(); run(c); },
      }, icon(c.icon, 16), h("span", {}, c.label), c.shortcut ? h("kbd", {}, c.shortcut) : null)));
      if (!matches.length) list.append(h("li", { class: "palette-empty" }, "Nessun comando trovato"));
    };
    const closePalette = () => { overlay.remove(); this.active?.view.focus(); };
    const run = (c: Command) => { closePalette(); this.execute(c.id); };

    input.addEventListener("input", () => { sel = 0; update(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(1, matches.length); update(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + matches.length) % Math.max(1, matches.length); update(); }
      else if (e.key === "Enter" && matches[sel]) { e.preventDefault(); run(matches[sel]); }
      else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
      e.stopPropagation();
    });

    const overlay = h("div", { class: "palette-overlay", onmousedown: (e: Event) => { if (e.target === overlay) closePalette(); } },
      h("div", { class: "palette" }, h("div", { class: "palette-search" }, icon("Search", 16), input), list));
    document.body.append(overlay);
    update();
    input.focus();
  }
}

// Miniature per le schede "Nuovo".
function docThumb(): HTMLElement {
  return h("div", { class: "thumb-doc" }, ...Array.from({ length: 7 }, (_, i) => h("span", { style: `width:${[60, 90, 82, 95, 70, 88, 40][i]}%` })));
}
function slidesThumb(): HTMLElement {
  return h("div", { class: "thumb-slides" }, h("span", { class: "t" }), h("span", { class: "s" }), h("span", { class: "b" }));
}
function sheetThumb(): HTMLElement {
  return h("div", { class: "thumb-sheet" }, ...Array.from({ length: 24 }, () => h("span")));
}

const app = new App(document.getElementById("app")!);
// Solo in sviluppo: permette ai test automatici di aprire file senza le finestre di sistema.
if (import.meta.env.DEV) {
  Object.assign(window, { __zikoffice: app, __importDocx: importDocx });
  if (inTauri) void import("./selftest").then((t) => t.runSelftest());
}
