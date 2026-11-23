// Pannello inferiore: terminale integrato e assistente (Claude / Antigravity da riga di comando).
import { clear, h, toast } from "./dom";
import { icon } from "./icons";

import { t, tr } from "./i18n";
import { appVersion, buildNotice, shouldShowNotice } from "./privacyNotice";
type Tab = "terminal" | "assistant" | "source";

/** Il Markdown del documento attivo, e come rileggerlo dopo una modifica (null = tutto bene, altrimenti il messaggio d'errore). */
export interface SourceView {
  name: string;
  text: string;
  apply: (text: string) => Promise<string | null>;
}

/** Il testo del documento attivo e come riscriverci sopra, fornito dall'applicazione. */
export interface AiSource {
  /** Descrizione mostrata all'utente, per esempio «selezione (12 parole)». */
  label: string;
  text: string;
  /** Sostituisce il testo di partenza, se la vista lo permette. */
  replace?: (text: string) => void;
  /** Inserisce il testo dopo quello di partenza. */
  insert?: (text: string) => void;
}

export interface DockHost {
  /** Cartella del file attivo (dove parte il terminale). */
  cwd(): string | undefined;
  /** Testo su cui lavora l'assistente; `whole` forza il documento intero. */
  aiSource(whole: boolean): Promise<AiSource | null>;
  /** Markdown del documento di testo attivo (null se il file attivo non è un documento di testo). */
  source(): SourceView | null;
}

type TermEvent = { kind: "data"; text: string } | { kind: "exit"; code: number | null };

const ENGINES: Record<string, string> = { claude: "Claude", agy: "Antigravity (agy)" };
const ACTIONS: { label: string; instruction: string }[] = [
  { label: "Riassumi", instruction: "Riassumi il testo in modo chiaro e fedele, mantenendo i punti essenziali." },
  { label: "Riscrivi", instruction: "Riscrivi il testo in modo più chiaro e scorrevole, senza cambiarne il significato." },
  { label: "Correggi", instruction: "Correggi ortografia, grammatica e punteggiatura senza cambiare lo stile né il contenuto." },
  { label: "Più formale", instruction: "Riscrivi il testo con un tono più formale e professionale." },
  { label: "Più breve", instruction: "Accorcia il testo di circa la metà tenendo le informazioni importanti." },
  { label: "Traduci in inglese", instruction: "Traduci il testo in inglese." },
  { label: "Traduci in italiano", instruction: "Traduci il testo in italiano." },
];
const OUTPUT_RULE = "Rispondi solo con il testo risultante, senza introduzioni, commenti né spiegazioni, e mantieni la lingua del testo salvo che l'istruzione chieda altro. Non usare la sintassi Markdown.";

const HEIGHT_KEY = "zikoffice.dock.height";
const ENGINE_KEY = "zikoffice.ai.engine";

function stored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignora */ }
}

async function core() {
  return import("@tauri-apps/api/core");
}

export class Dock {
  readonly el: HTMLElement;
  private tab: Tab = "terminal";
  private opened = false;
  private tabButtons = new Map<Tab, HTMLButtonElement>();
  private termPane = h("div", { class: "dock-pane term-pane" });
  private assistPane = h("div", { class: "dock-pane assist-pane" });
  private sourcePane = h("div", { class: "dock-pane source-pane" });
  private body = h("div", { class: "dock-body" });
  private notice = h("div", { class: "dock-notice", hidden: true });

  // terminale
  term: import("@xterm/xterm").Terminal | null = null;
  private fit: import("@xterm/addon-fit").FitAddon | null = null;
  termId: number | null = null;
  private termExited = false;
  private termStarting = false;
  private resizeObs: ResizeObserver;

  // sorgente Markdown
  private srcArea = h("textarea", { class: "dock-source", spellcheck: false, wrap: "off", "aria-label": "Sorgente Markdown" }) as HTMLTextAreaElement;
  private srcStatus = h("div", { class: "dock-status" });
  private srcApply = h("button", { class: "dock-btn primary", title: "Rilegge il testo e aggiorna il documento (Ctrl+Invio). Si annulla con Ctrl+Z." }, icon("Check", 14), "Applica al documento") as HTMLButtonElement;
  private srcBase = "";      // testo mostrato l'ultima volta che coincideva con il documento
  private srcDirty = false;  // l'utente ha scritto nel sorgente
  private srcView: SourceView | null = null;
  private srcTimer = 0;

  // assistente
  private engineSel = h("select", { class: "dock-select", "aria-label": "Motore" }) as HTMLSelectElement;
  private scopeSel = h("select", { class: "dock-select", "aria-label": "Testo" }, 
    h("option", { value: "auto" }, "Selezione o documento"), h("option", { value: "whole" }, "Documento intero")) as HTMLSelectElement;
  private instruction = h("textarea", { class: "dock-instruction", rows: 2, placeholder: "Scrivi un'istruzione (es. «Rendilo adatto a una mail ai colleghi») — Ctrl+Invio per inviare" }) as HTMLTextAreaElement;
  private output = h("textarea", { class: "dock-output", readonly: true, placeholder: "La risposta comparirà qui." }) as HTMLTextAreaElement;
  private statusLine = h("div", { class: "dock-status" });
  private applyButtons: HTMLButtonElement[] = [];
  private busy = false;
  private lastSource: AiSource | null = null;
  private available: { claude: boolean; agy: boolean } | null = null;

  constructor(private host: DockHost) {
    this.el = h("section", { class: "dock", hidden: true, "aria-label": "Pannello inferiore" });
    const resizer = h("div", { class: "dock-resizer", title: "Trascina per ridimensionare" });
    this.bindResizer(resizer);

    const mkTab = (t: Tab, label: string, ic: string) => {
      const b = h("button", { class: "dock-tab", role: "tab", onclick: () => this.show(t) }, icon(ic as never, 14), h("span", {}, label)) as HTMLButtonElement;
      this.tabButtons.set(t, b);
      return b;
    };
    const header = h("div", { class: "dock-header", role: "tablist" },
      mkTab("terminal", "Terminale", "SquareTerminal"),
      mkTab("assistant", "Assistente", "Sparkles"),
      mkTab("source", "Sorgente", "FileCode"),
      h("div", { class: "spacer" }),
      h("button", { class: "icon-btn", title: "Chiudi il pannello", onclick: () => this.close() }, icon("X", 14)));
    this.body.append(this.termPane, this.assistPane, this.sourcePane);
    this.el.append(resizer, header, this.notice, this.body);
    const saved = Number(stored(HEIGHT_KEY));
    if (saved >= 120) this.el.style.setProperty("--dock-h", `${saved}px`);

    this.buildAssistant();
    this.buildSource();
    this.resizeObs = new ResizeObserver(() => this.refit());
    this.resizeObs.observe(this.termPane);
  }

  isOpen(tab?: Tab): boolean {
    return this.opened && (tab === undefined || this.tab === tab);
  }

  toggle(tab: Tab): void {
    if (this.isOpen(tab)) this.close();
    else this.show(tab);
  }

  show(tab: Tab): void {
    this.tab = tab;
    this.opened = true;
    this.el.hidden = false;
    document.getElementById("app")?.classList.add("has-dock");
    for (const [t, b] of this.tabButtons) b.setAttribute("aria-selected", String(t === tab));
    this.termPane.hidden = tab !== "terminal";
    this.assistPane.hidden = tab !== "assistant";
    this.sourcePane.hidden = tab !== "source";
    void this.updateNotice(tab);
    if (tab === "terminal") void this.startTerminal();
    else if (tab === "source") this.refreshSource(true);
    else void this.refreshAssistant();
    this.onChange?.();
  }

  /** L'avviso sui dati che escono dal computer: nel Terminale e nell'Assistente, non nella vista Sorgente. */
  private async updateNotice(tab: Tab): Promise<void> {
    if (tab === "source") { this.notice.hidden = true; return; }
    const version = await appVersion();
    if (this.tab !== tab) return;
    if (!shouldShowNotice(version)) { this.notice.hidden = true; return; }
    this.notice.replaceChildren(buildNotice(version, () => { this.notice.hidden = true; this.refit(); }));
    this.notice.hidden = false;
  }

  close(): void {
    this.opened = false;
    this.el.hidden = true;
    document.getElementById("app")?.classList.remove("has-dock");
    this.onChange?.();
  }

  /** Chiamato quando il pannello si apre o si chiude (per aggiornare i pulsanti del ribbon). */
  onChange?: () => void;
  /** Chiamato quando il pannello torna a dare il fuoco all'applicazione. */
  onLeave?: () => void;

  /** Chiude il processo del terminale (all'uscita dall'applicazione). */
  async dispose(): Promise<void> {
    if (this.termId !== null) {
      const { invoke } = await core();
      await invoke("term_close", { id: this.termId }).catch(() => undefined);
      this.termId = null;
    }
  }

  // ---------- dimensione ----------

  private bindResizer(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      handle.setPointerCapture(down.pointerId);
      const startY = down.clientY;
      const startH = this.el.getBoundingClientRect().height;
      const move = (e: PointerEvent) => {
        const next = Math.max(120, Math.min(window.innerHeight * 0.75, startH + (startY - e.clientY)));
        this.el.style.setProperty("--dock-h", `${Math.round(next)}px`);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        store(HEIGHT_KEY, String(Math.round(this.el.getBoundingClientRect().height)));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  // ---------- terminale ----------

  private refit(): void {
    if (!this.term || !this.fit || this.termPane.hidden || !this.opened) return;
    if (this.termPane.clientWidth < 20 || this.termPane.clientHeight < 20) return;
    try {
      this.fit.fit();
      if (this.termId !== null) {
        void core().then(({ invoke }) => invoke("term_resize", { id: this.termId, rows: this.term!.rows, cols: this.term!.cols }).catch(() => undefined));
      }
    } catch { /* il pannello non è ancora visibile */ }
  }

  private async startTerminal(): Promise<void> {
    if (this.termStarting) { this.term?.focus(); return; }
    if (this.term && this.termId !== null && !this.termExited) {
      requestAnimationFrame(() => { this.refit(); this.term?.focus(); });
      return;
    }
    this.termStarting = true;
    try {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      await import("@xterm/xterm/css/xterm.css");
      const { invoke, Channel } = await core();
      if (!this.term) {
        this.term = new Terminal({
          fontFamily: '"JetBrains Mono", "DejaVu Sans Mono", "Ubuntu Mono", monospace',
          fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
          theme: { background: "#14161a", foreground: "#e6e8ec", cursor: "#e6e8ec", selectionBackground: "#3d5a99" },
        });
        this.fit = new FitAddon();
        this.term.loadAddon(this.fit);
        this.term.open(this.termPane);
        this.term.attachCustomKeyEventHandler((e) => {
          if (e.type !== "keydown") return true;
          // Ctrl+Maiusc+C copia la selezione (Ctrl+C resta l'interruzione del programma).
          if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
            const sel = this.term?.getSelection();
            if (sel) void navigator.clipboard.writeText(sel).catch(() => toast("Copia non riuscita"));
            return false;
          }
          return true;
        });
        this.term.onData((data) => {
          if (this.termExited) { void this.startTerminal(); return; }
          if (this.termId !== null) void invoke("term_write", { id: this.termId, data }).catch(() => undefined);
        });
      } else {
        this.term.reset();
      }
      this.termExited = false;
      this.fit!.fit();
      const channel = new Channel<TermEvent>();
      channel.onmessage = (ev) => {
        if (ev.kind === "data") this.term?.write(ev.text);
        else if (ev.kind === "exit") {
          this.termExited = true;
          this.termId = null;
          this.term?.write(`\r\n\x1b[2m[${t("Processo terminato — premi un tasto per riavviare la shell")}]\x1b[0m\r\n`);
        }
      };
      this.termId = await invoke<number>("term_open", { cwd: this.host.cwd() ?? null, rows: this.term.rows, cols: this.term.cols, onEvent: channel });
      this.term.focus();
    } catch (e) {
      toast(t("Terminale non disponibile: {0}", String(e)));
    } finally {
      this.termStarting = false;
    }
  }

  // ---------- sorgente Markdown ----------

  private buildSource(): void {
    const refresh = h("button", { class: "dock-btn", title: "Rimostra il Markdown del documento (scarta le modifiche non applicate)", onclick: () => this.refreshSource(true) }, "Aggiorna dal documento");
    const copy = h("button", { class: "dock-btn", onclick: () => { void navigator.clipboard.writeText(this.srcArea.value).then(() => toast("Markdown copiato")); } }, icon("Copy", 14), "Copia");
    this.srcApply.addEventListener("click", () => void this.applySource());
    this.srcArea.addEventListener("input", () => { this.srcDirty = this.srcArea.value !== this.srcBase; this.srcState(); });
    this.srcArea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void this.applySource(); }
      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey) { // il Tab scrive, non cambia campo
        e.preventDefault();
        const a = this.srcArea, at = a.selectionStart;
        a.setRangeText("  ", at, a.selectionEnd, "end");
        a.dispatchEvent(new Event("input"));
      }
    });
    this.sourcePane.append(
      h("div", { class: "dock-source-bar" }, refresh, copy, h("div", { class: "spacer" }), this.srcStatus, this.srcApply),
      this.srcArea,
    );
  }

  /** Il documento è cambiato (o è cambiato il documento attivo): se il sorgente è aperto e non toccato, si aggiorna. */
  docChanged(): void {
    if (!this.isOpen("source")) return;
    clearTimeout(this.srcTimer);
    this.srcTimer = window.setTimeout(() => this.refreshSource(false), 250);
  }

  private refreshSource(force: boolean): void {
    if (!this.isOpen("source")) return;
    const view = this.host.source();
    this.srcView = view;
    if (!view) {
      this.srcArea.value = "";
      this.srcArea.disabled = true;
      this.srcArea.placeholder = t("Apri un documento di testo per vederne il Markdown.");
      this.srcBase = ""; this.srcDirty = false;
      this.srcState();
      return;
    }
    this.srcArea.disabled = false;
    this.srcArea.placeholder = "";
    if (force || !this.srcDirty) {
      if (this.srcArea.value !== view.text) {
        const top = this.srcArea.scrollTop, a = this.srcArea.selectionStart, b = this.srcArea.selectionEnd;
        this.srcArea.value = view.text;
        if (!force) { this.srcArea.scrollTop = top; this.srcArea.setSelectionRange(Math.min(a, view.text.length), Math.min(b, view.text.length)); }
      }
      this.srcBase = view.text;
      this.srcDirty = false;
    }
    this.srcState(view.text !== this.srcBase);
  }

  private srcState(docMoved = false): void {
    this.srcApply.disabled = !this.srcView || !this.srcDirty;
    this.srcStatus.textContent = tr(!this.srcView ? ""
      : this.srcDirty ? (docMoved ? "Il documento è cambiato nel frattempo: «Applica» usa il tuo testo, «Aggiorna» lo scarta" : "Modificato — premi «Applica al documento» (Ctrl+Invio)")
      : "Il testo segue il documento");
  }

  private async applySource(): Promise<void> {
    const view = this.srcView;
    if (!view || !this.srcDirty) return;
    this.srcApply.disabled = true;
    const err = await view.apply(this.srcArea.value);
    if (err) { this.srcStatus.textContent = t("Impossibile applicare: {0}", err); this.srcApply.disabled = false; return; }
    this.srcDirty = false;
    toast("Documento aggiornato dal Markdown (Ctrl+Z per annullare)");
    this.refreshSource(true);
  }

  // ---------- assistente ----------

  private buildAssistant(): void {
    const quick = h("div", { class: "dock-actions" },
      ...ACTIONS.map((a) => h("button", { class: "dock-btn", onclick: () => void this.run(a.instruction) }, a.label)));
    const send = h("button", { class: "dock-btn primary", onclick: () => void this.run(this.instruction.value.trim()) }, icon("Sparkles", 14), "Invia");
    this.instruction.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void this.run(this.instruction.value.trim()); }
    });
    this.engineSel.addEventListener("change", () => store(ENGINE_KEY, this.engineSel.value));

    const mkApply = (label: string, ic: string, fn: () => void) => {
      const b = h("button", { class: "dock-btn", disabled: true, onclick: fn }, icon(ic as never, 14), label) as HTMLButtonElement;
      this.applyButtons.push(b);
      return b;
    };
    const results = h("div", { class: "dock-actions" },
      mkApply("Sostituisci", "Replace", () => this.apply("replace")),
      mkApply("Inserisci sotto", "ArrowDown", () => this.apply("insert")),
      mkApply("Copia", "Copy", () => {
        void navigator.clipboard.writeText(this.output.value).then(() => toast("Risposta copiata"), () => toast("Copia non riuscita"));
      }));

    const left = h("div", { class: "assist-col" },
      h("div", { class: "dock-row" }, h("label", {}, "Motore"), this.engineSel, h("label", {}, "Testo"), this.scopeSel),
      quick,
      this.instruction,
      h("div", { class: "dock-row" }, send, this.statusLine));
    const right = h("div", { class: "assist-col" }, this.output, results,
      h("div", { class: "dock-note" }, "Il testo viene inviato al servizio del motore scelto, con il tuo abbonamento. Non viene modificato nulla finché non premi «Sostituisci» o «Inserisci sotto»."));
    this.assistPane.append(left, right);
  }

  private async refreshAssistant(): Promise<void> {
    try {
      const { invoke } = await core();
      this.available = await invoke<{ claude: boolean; agy: boolean }>("ai_status");
    } catch {
      this.available = { claude: false, agy: false };
    }
    const prev = this.engineSel.value || stored(ENGINE_KEY) || "claude";
    clear(this.engineSel);
    for (const [id, label] of Object.entries(ENGINES)) {
      const ok = this.available[id as "claude" | "agy"];
      this.engineSel.append(h("option", { value: id, disabled: !ok }, ok ? label : t("{0} — non installato", label)));
    }
    const pick = this.available[prev as "claude" | "agy"] ? prev : this.available.claude ? "claude" : this.available.agy ? "agy" : prev;
    this.engineSel.value = pick;
    if (!this.available.claude && !this.available.agy) {
      this.statusLine.textContent = t("Nessun motore trovato: installa «claude» o «agy» e accedi con il tuo account.");
    } else if (!this.busy) {
      this.statusLine.textContent = "";
    }
    this.instruction.focus();
  }

  private setBusy(on: boolean, message = ""): void {
    this.busy = on;
    this.statusLine.textContent = tr(message);
    this.el.classList.toggle("busy", on);
  }

  private async run(instruction: string): Promise<void> {
    if (this.busy) return;
    if (!instruction) { toast("Scrivi un'istruzione o scegli un'azione"); return; }
    const engine = this.engineSel.value;
    if (!this.available?.[engine as "claude" | "agy"]) { toast("Il motore scelto non è installato"); return; }
    const source = await this.host.aiSource(this.scopeSel.value === "whole");
    if (!source || !source.text.trim()) { toast("Non c'è testo su cui lavorare: apri un documento o seleziona qualcosa"); return; }
    this.lastSource = source;
    this.output.value = "";
    for (const b of this.applyButtons) b.disabled = true;
    this.setBusy(true, t("Elaboro {0} con {1}…", source.label, ENGINES[engine]));
    try {
      const { invoke } = await core();
      const answer = await invoke<string>("ai_run", { engine, instruction: `${instruction}\n\n${OUTPUT_RULE}`, text: source.text });
      this.output.value = answer;
      this.setBusy(false, "Fatto.");
      const [replace, insert, copy] = this.applyButtons;
      replace.disabled = !source.replace;
      insert.disabled = !source.insert;
      copy.disabled = false;
    } catch (e) {
      this.setBusy(false, "");
      this.output.value = String(e);
    }
  }

  private apply(mode: "replace" | "insert"): void {
    const src = this.lastSource;
    const text = this.output.value;
    if (!src || !text) return;
    (mode === "replace" ? src.replace : src.insert)?.(text);
    toast(mode === "replace" ? "Testo sostituito (Ctrl+Z per annullare)" : "Testo inserito (Ctrl+Z per annullare)");
  }
}
