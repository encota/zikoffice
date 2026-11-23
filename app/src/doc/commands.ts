// Comandi del ribbon per l'editor di testo.
import { h, toast } from "../dom";
import { FindBar, type FindOptions } from "../sheet/find";
import { closeMenu, openMenu, type MenuItem } from "../ui/menu";
import { prompt } from "../ui/dialog";
import type { DocEditor } from "./editor";
import { allParagraphs, cm, paragraphLength, paragraphText, toCm, type Align, type Paragraph, type RunProps } from "./model";
import { parseCsvRecords, runMailMerge } from "./mailMerge";
import * as ops from "./ops";
import { effectivePara, effectiveRun, ensureMarkdownStyles, isBulletList } from "./styles";

import { localeTag, t, tr } from "../i18n";
const GALLERY: Record<string, string> = {
  "style.normal": "Normal", "style.noSpacing": "NoSpacing", "style.h1": "Heading1", "style.h2": "Heading2",
  "style.h3": "Heading3", "style.title": "Title", "style.subtitle": "Subtitle", "style.quote": "Quote",
  "style.code": "CodeBlock", "style.blockquote": "BlockQuote",
};

const ALIGN: Record<string, Align> = { alignLeft: "left", alignCenter: "center", alignRight: "right", justify: "justify" };

const HIGHLIGHTS: [string, string][] = [
  ["Giallo", "#ffff00"], ["Verde chiaro", "#00ff00"], ["Turchese", "#00ffff"], ["Rosa", "#ff00ff"],
  ["Blu", "#0000ff"], ["Rosso", "#ff0000"], ["Grigio", "#c0c0c0"],
];

const SYMBOLS = "€ © ® ™ ° ± × ÷ ≤ ≥ ≠ ≈ ∞ § ¶ • – — « » “ ” ‘ ’ … → ← ↑ ↓ ✓ ✗ ½ ¼ ¾ ² ³ µ Ω α β π Σ".split(" ");

interface Match { pid: number; from: number; to: number }

/** Collega i comandi del ribbon all'editor. */
export function installDocCommands(ed: DocEditor): void {
  const range = () => ed.sel;

  /** Applica proprietà di testo: alla selezione, oppure al testo che si scriverà dopo. */
  const runProps = (patch: RunProps) => {
    if (ed.collapsed) {
      // Senza selezione Word applica alla parola sotto il cursore, se c'è; altrimenti al testo successivo.
      const p = ed.currentPara();
      const off = ed.sel.focus.off;
      if (p) {
        const [a, b] = ops.wordAt(p, off);
        const text = paragraphText(p);
        const inside = a < off && off < b && /[\p{L}\p{N}]/u.test(text[off - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[off] ?? "");
        if (inside) {
          let end = b;
          while (end > a && text[end - 1] === " ") end--;
          ed.edit("format", () => ops.applyRunProps(ed.doc, { anchor: { pid: p.id, off: a }, focus: { pid: p.id, off: end } }, patch));
          return;
        }
      }
      ed.pending = { ...(ed.pending ?? {}), ...patch };
      ed.draw();
      return;
    }
    ed.edit("format", () => ops.applyRunProps(ed.doc, range(), patch));
  };

  const toggleRun = (key: "bold" | "italic" | "underline" | "strike") => {
    const on = isOn(key);
    runProps({ [key]: on ? undefined : true });
    // Se lo stile del paragrafo lo attiva (es. Citazione in corsivo), "spegnerlo" serve un valore esplicito.
    if (on && ed.effectiveProps()[key]) runProps({ [key]: false } as RunProps);
  };

  const isOn = (key: keyof RunProps): boolean => {
    if (ed.collapsed) return !!ed.effectiveProps()[key];
    return ops.rangeHas(ed.doc, range(), (rp) => !!rp[key], (p, rp) => effectiveRun(ed.doc, p, { props: rp }));
  };

  const para = (patch: Parameters<typeof ops.applyParaProps>[2]) => ed.edit("paragraph", () => ops.applyParaProps(ed.doc, range(), patch));

  const currentAlign = (): Align => {
    const p = ed.currentPara();
    return p ? effectivePara(ed.doc, p).align ?? "left" : "left";
  };

  // ---------- trova e sostituisci ----------

  const find = new FindBar<Match>({
    search: (o) => searchDoc(ed, o),
    startIndex: (res) => {
      const order = ops.orderMap(ops.storyParagraphs(ed.doc, "body"));
      const [cur] = ed.range;
      const i = res.findIndex((m) => ops.comparePos(order, { pid: m.pid, off: m.from }, cur) >= 0);
      return i < 0 ? 0 : i;
    },
    isCurrent: (m) => {
      const [a, b] = ed.range;
      return a.pid === m.pid && b.pid === m.pid && a.off === m.from && b.off === m.to;
    },
    goTo: (m, all) => {
      if (ed.story !== "body") ed.exitStory();
      ed.highlights = all.map((x) => ({ ...x, current: x === m }));
      ed.setSelection({ pid: m.pid, off: m.from }, { pid: m.pid, off: m.to });
    },
    replace: (items, o, rep) => {
      if (!items.length) return 0;
      ed.edit("replace", () => {
        // Dalla fine all'inizio, così le posizioni dei risultati restano valide.
        for (const m of [...items].reverse()) {
          const p = ed.para(m.pid);
          if (!p) continue;
          const props = ops.runPropsAt(p, m.from + 1);
          ops.deleteRange(ed.doc, { pid: m.pid, off: m.from }, { pid: m.pid, off: m.to });
          if (rep) ops.insertText(ed.doc, { pid: m.pid, off: m.from }, rep, props);
        }
        const last = items[0];
        ed.sel = { anchor: { pid: last.pid, off: last.from + rep.length }, focus: { pid: last.pid, off: last.from + rep.length } };
      });
      void o;
      return items.length;
    },
    close: () => { ed.highlights = []; ed.draw(); ed.focus(); },
  }, "Parola intera");
  ed.overlay.append(find.el);

  // ---------- menu ----------

  const colorMenu = (apply: (c: string | null) => void, none: string): MenuItem[] => [{ colors: apply, noneLabel: none }];

  const tablePicker = (): HTMLElement => {
    const label = h("div", { class: "menu-heading" }, "Inserisci tabella");
    const grid = h("div", { class: "table-picker" });
    const cells: HTMLElement[] = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 10; c++) {
      const cell = h("button", { class: "tp-cell", "aria-label": `${r + 1} × ${c + 1}` });
      cell.addEventListener("mouseenter", () => {
        label.textContent = t("Tabella {0} × {1}", c + 1, r + 1);
        cells.forEach((x, i) => x.classList.toggle("on", Math.floor(i / 10) <= r && i % 10 <= c));
      });
      cell.addEventListener("click", () => { closeMenu(); insertTable(r + 1, c + 1); });
      cells.push(cell);
      grid.append(cell);
    }
    return h("div", {}, label, grid);
  };

  const insertTable = (rows: number, cols: number) => {
    if (ed.story !== "body") { toast("Le tabelle si inseriscono nel testo del documento"); return; }
    if (ops.tableAt(ed.doc, ed.sel.focus.pid)) { toast("Non si può inserire una tabella dentro un'altra"); return; }
    const pg = ed.doc.page;
    ed.edit("table", () => {
      const t = ops.newTable(ed.doc, rows, cols, pg.width - pg.marginLeft - pg.marginRight);
      ops.insertBlockAfter(ed.doc, ed.sel.focus, t);
      const first = t.rows[0].cells[0].paragraphs[0];
      ed.sel = { anchor: { pid: first.id, off: 0 }, focus: { pid: first.id, off: 0 } };
    });
  };

  const tableItems = (): MenuItem[] => {
    const pid = ed.sel.focus.pid;
    if (!ops.tableAt(ed.doc, pid)) return [];
    const at = (fn: () => ops.Pos | null | void) => () => ed.edit("table", () => { const pos = fn(); if (pos) ed.sel = { anchor: pos, focus: pos }; });
    return [
      { separator: true },
      { label: "Inserisci riga sopra", icon: "BetweenHorizontalStart", action: at(() => ops.addTableRow(ed.doc, pid, false)) },
      { label: "Inserisci riga sotto", icon: "BetweenHorizontalStart", action: at(() => ops.addTableRow(ed.doc, pid, true)) },
      { label: "Inserisci colonna a sinistra", icon: "BetweenVerticalStart", action: at(() => ops.addTableColumn(ed.doc, pid, false)) },
      { label: "Inserisci colonna a destra", icon: "BetweenVerticalStart", action: at(() => ops.addTableColumn(ed.doc, pid, true)) },
      { separator: true },
      { label: "Elimina riga", icon: "Trash2", action: at(() => ops.deleteTableRow(ed.doc, pid)) },
      { label: "Elimina colonna", icon: "Trash2", action: at(() => ops.deleteTableColumn(ed.doc, pid)) },
      { label: "Elimina tabella", icon: "Trash2", action: at(() => ops.deleteTable(ed.doc, pid)) },
      { separator: true },
      { colors: (c) => ed.edit("table", () => { const t = ops.tableAt(ed.doc, pid); if (t) t.table.rows[t.row].cells[t.cell].shading = c ?? undefined; }), noneLabel: "Nessuno sfondo della cella" },
    ];
  };

  const insertImage = () => {
    const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml" });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const src = String(reader.result);
        const img = new Image();
        img.onload = () => {
          const pg = ed.doc.page;
          const maxW = pg.width - pg.marginLeft - pg.marginRight;
          let w = img.naturalWidth * 0.75, hh = img.naturalHeight * 0.75;
          if (w > maxW) { hh *= maxW / w; w = maxW; }
          ed.edit("image", () => {
            const pos = ops.insertRun(ed.doc, ed.deleteSelection(), { type: "image", src, mime: file.type || "image/png", width: w, height: hh, alt: file.name, props: {} });
            ed.sel = { anchor: pos, focus: pos };
          });
        };
        img.src = src;
      };
      reader.readAsDataURL(file);
    });
    input.click();
  };

  const insertLink = async () => {
    const current = ed.collapsed ? "" : ops.runPropsAt(ed.para(ed.range[0].pid)!, ed.range[0].off + 1).link ?? "";
    const url = await prompt("Inserisci collegamento", "Indirizzo (es. https://…)", current, "https://");
    if (url === null) return;
    const clean = url.trim();
    if (!clean) { if (!ed.collapsed) runProps({ link: undefined }); return; }
    const href = /^[a-z]+:/i.test(clean) ? clean : `https://${clean}`;
    if (ed.collapsed) {
      ed.edit("link", () => {
        const pos = ops.insertText(ed.doc, ed.sel.focus, clean, { ...ed.currentProps(), link: href });
        ed.sel = { anchor: pos, focus: pos };
      });
    } else runProps({ link: href });
  };

  const pageNumbers = (where: "footer-center" | "header-right" | "footer-of") => {
    ed.edit("pagenum", () => {
      const target = where === "header-right" ? ed.doc.header : ed.doc.footer;
      const style = where === "header-right" ? "Header" : "Footer";
      const align: Align = where === "header-right" ? "right" : "center";
      const runs: Paragraph["runs"] = where === "footer-of"
        ? [{ text: "Pagina ", props: {} }, { type: "field", field: "PAGE", props: {} }, { text: " di ", props: {} }, { type: "field", field: "NUMPAGES", props: {} }]
        : [{ type: "field", field: "PAGE", props: {} }];
      target.push({ type: "p", id: ed.doc.nextId++, props: { style, align }, runs });
    });
    toast("Numeri di pagina inseriti");
  };

  const removePageNumbers = () => ed.edit("pagenum", () => {
    for (const list of [ed.doc.header, ed.doc.footer]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        p.runs = p.runs.filter((r) => r.type !== "field");
        if (!paragraphLength(p) || /^\s*(Pagina\s*di\s*)?$/.test(paragraphText(p))) list.splice(i, 1);
      }
    }
  });

  const setPage = (patch: Partial<typeof ed.doc.page>) => ed.edit("page", () => { Object.assign(ed.doc.page, patch); });

  const menus: Record<string, () => MenuItem[]> = {
    fontColor: () => colorMenu((c) => runProps({ color: c ?? undefined }), "Automatico"),
    highlight: () => [
      ...HIGHLIGHTS.map(([name, c]): MenuItem => ({ label: name, icon: "Highlighter", action: () => runProps({ highlight: c }) })),
      { separator: true },
      { label: "Nessun colore", icon: "SquareX", action: () => runProps({ highlight: undefined }) },
    ],
    lineSpacing: () => {
      const p = ed.currentPara();
      const cur = p ? effectivePara(ed.doc, p) : {};
      return [
        ...[1, 1.08, 1.15, 1.5, 2, 2.5, 3].map((v): MenuItem => ({
          label: v.toLocaleString(localeTag()), checked: cur.lineRule !== "exact" && Math.abs((cur.line ?? 1) - v) < 0.01,
          action: () => para({ line: v, lineRule: "auto" }),
        })),
        { separator: true },
        (cur.spaceBefore ?? 0) > 0
          ? { label: "Rimuovi spazio prima del paragrafo", action: () => para({ spaceBefore: 0 }) }
          : { label: "Aggiungi spazio prima del paragrafo", action: () => para({ spaceBefore: 12 }) },
        (cur.spaceAfter ?? 0) > 0
          ? { label: "Rimuovi spazio dopo il paragrafo", action: () => para({ spaceAfter: 0 }) }
          : { label: "Aggiungi spazio dopo il paragrafo", action: () => para({ spaceAfter: 8 }) },
      ];
    },
    shading: () => colorMenu((c) => para({ shading: c ?? undefined }), "Nessun colore"),
    bullets: () => [
      { label: "Elenco puntato", icon: "List", action: () => ed.edit("list", () => ops.toggleList(ed.doc, range(), "bullet")) },
      { label: "Nessun elenco", action: () => removeList() },
    ],
    numbering: () => [
      { label: "Elenco numerato 1. 2. 3.", icon: "ListOrdered", action: () => ed.edit("list", () => ops.toggleList(ed.doc, range(), "number")) },
      { label: "Ricomincia da 1", action: () => restartNumbering() },
      { label: "Nessun elenco", action: () => removeList() },
    ],
    multilevel: () => [
      { label: "Elenco numerato a più livelli (1. a. i.)", icon: "ListTree", action: () => ed.edit("list", () => ops.toggleList(ed.doc, range(), "number")) },
      { label: "Livello successivo (Tab)", action: () => ed.edit("indent", () => ops.changeIndent(ed.doc, range(), 1)) },
      { label: "Livello precedente (Maiusc+Tab)", action: () => ed.edit("indent", () => ops.changeIndent(ed.doc, range(), -1)) },
    ],
    select: () => [{ label: "Seleziona tutto", shortcut: "Ctrl+A", action: () => ed.selectAll() }],
    insertTable: () => [{ element: tablePicker() }, ...tableItems().slice(1)],
    symbol: () => [{ element: symbolGrid((s) => ed.typeText(s)) }],
    header: () => [
      { label: "Modifica intestazione", icon: "Pencil", action: () => ed.enterStory("header") },
      { label: "Rimuovi intestazione", icon: "Trash2", disabled: !ed.doc.header.length, action: () => ed.edit("header", () => { ed.doc.header = []; }) },
    ],
    footer: () => [
      { label: "Modifica piè di pagina", icon: "Pencil", action: () => ed.enterStory("footer") },
      { label: "Rimuovi piè di pagina", icon: "Trash2", disabled: !ed.doc.footer.length, action: () => ed.edit("footer", () => { ed.doc.footer = []; }) },
    ],
    pageNumber: () => [
      { label: "In fondo alla pagina, al centro", action: () => pageNumbers("footer-center") },
      { label: "In alto a destra", action: () => pageNumbers("header-right") },
      { label: "«Pagina X di Y» in fondo", action: () => pageNumbers("footer-of") },
      { separator: true },
      { label: "Rimuovi numeri di pagina", icon: "Trash2", action: removePageNumbers },
    ],
    margins: () => {
      const pg = ed.doc.page;
      const preset = (name: string, top: number, b: number, l: number, r: number): MenuItem => ({
        label: t("{0}  (sup. {1} · inf. {2} · sin. {3} · des. {4} cm)", name, top, b, l, r),
        checked: Math.abs(pg.marginTop - cm(top)) < 1 && Math.abs(pg.marginLeft - cm(l)) < 1 && Math.abs(pg.marginRight - cm(r)) < 1,
        action: () => setPage({ marginTop: cm(top), marginBottom: cm(b), marginLeft: cm(l), marginRight: cm(r) }),
      });
      return [
        preset("Normali", 2.5, 2, 2, 2), preset("Stretti", 1.27, 1.27, 1.27, 1.27),
        preset("Moderati", 2.54, 2.54, 1.91, 1.91), preset("Larghi", 2.54, 2.54, 5.08, 5.08),
        preset("Office", 2.54, 2.54, 2.54, 2.54),
        { separator: true },
        {
          label: "Margini personalizzati…",
          action: async () => {
            const cur = `${toCm(pg.marginTop).toFixed(1)}; ${toCm(pg.marginBottom).toFixed(1)}; ${toCm(pg.marginLeft).toFixed(1)}; ${toCm(pg.marginRight).toFixed(1)}`;
            const v = await prompt("Margini personalizzati (cm)", "Superiore; Inferiore; Sinistro; Destro (in cm):", cur);
            if (!v) return;
            const nums = v.split(/[;,]/).map((s) => Number(s.trim().replace(",", ".")));
            if (nums.length !== 4 || nums.some((n) => Number.isNaN(n) || n < 0 || n > 10)) {
              toast("Inserisci 4 valori validi in cm (es. 2,5; 2; 2; 2)");
              return;
            }
            setPage({ marginTop: cm(nums[0]), marginBottom: cm(nums[1]), marginLeft: cm(nums[2]), marginRight: cm(nums[3]) });
          },
        },
      ];
    },
    watermark: () => [
      ...["BOZZA", "RISERVATO", "COPIA", "CONFIDENZIALE"].map((w): MenuItem => ({
        label: w,
        checked: ed.doc.watermark === w || ed.doc.watermark === tr(w),
        action: () => ed.edit("watermark", () => { ed.doc.watermark = tr(w); }),
      })),
      {
        label: "Testo personalizzato…",
        action: async () => {
          const v = await prompt("Filigrana personalizzata", "Testo da mostrare in diagonale su ogni pagina:", ed.doc.watermark ?? "");
          if (v !== null) ed.edit("watermark", () => { ed.doc.watermark = v.trim() || undefined; });
        },
      },
      { separator: true },
      { label: "Rimuovi filigrana", icon: "Trash2", disabled: !ed.doc.watermark, action: () => ed.edit("watermark", () => { ed.doc.watermark = undefined; }) },
    ],
    orientation: () => {
      const pg = ed.doc.page;
      const portrait = pg.height >= pg.width;
      const swap = () => setPage({ width: pg.height, height: pg.width });
      return [
        { label: "Verticale", icon: "RectangleVertical", checked: portrait, action: () => { if (!portrait) swap(); } },
        { label: "Orizzontale", icon: "RectangleHorizontal", checked: !portrait, action: () => { if (portrait) swap(); } },
      ];
    },
    pageSize: () => {
      const pg = ed.doc.page;
      const portrait = pg.height >= pg.width;
      const size = (name: string, w: number, hh: number): MenuItem => {
        const [W, H] = portrait ? [w, hh] : [hh, w];
        return { label: name, checked: Math.abs(pg.width - W) < 2 && Math.abs(pg.height - H) < 2, action: () => setPage({ width: W, height: H }) };
      };
      return [
        size("A4 (21 × 29,7 cm)", 595.3, 841.9), size("A5 (14,8 × 21 cm)", 419.5, 595.3), size("A3 (29,7 × 42 cm)", 841.9, 1190.6),
        size("Lettera (21,6 × 27,9 cm)", 612, 792), size("Legale (21,6 × 35,6 cm)", 612, 1008),
      ];
    },
    breaks: () => [{ label: "Interruzione di pagina", shortcut: "Ctrl+Invio", action: () => ed.insertPageBreak() }],
    toc: () => [
      { label: "Sommario automatico", icon: "BookOpen", action: () => insertToc() },
      { separator: true },
      { label: "Rimuovi sommario", icon: "Trash2", disabled: !ed.doc.blocks.some((b) => b.type === "toc"), action: () => ed.edit("toc", () => { ed.doc.blocks = ed.doc.blocks.filter((b) => b.type !== "toc"); }) },
    ],
    paste: () => [
      { label: "Incolla", icon: "ClipboardPaste", shortcut: "Ctrl+V", action: () => void ed.pasteFromMenu() },
      { label: "Incolla solo il testo", icon: "ClipboardType", action: async () => {
        try { const t = await navigator.clipboard.readText(); ed.edit("paste", () => { const pos = ops.insertText(ed.doc, ed.deleteSelection(), t); ed.sel = { anchor: pos, focus: pos }; }); }
        catch { toast("Usa Ctrl+Maiusc+V per incollare solo il testo"); }
      } },
    ],
    borders: () => [
      { label: "Evidenzia blocco (sfondo grigio)", action: () => para({ shading: "#f3f4f6" }) },
      { label: "Evidenzia avviso (sfondo azzurro)", action: () => para({ shading: "#eff6ff" }) },
      { separator: true },
      { label: "Nessuno sfondo", action: () => para({ shading: undefined }) },
    ],
    tocAddText: () => [
      { label: "Livello 1 (Titolo 1)", action: () => ed.edit("style", () => ops.setStyle(ed.doc, range(), "Heading1")) },
      { label: "Livello 2 (Titolo 2)", action: () => ed.edit("style", () => ops.setStyle(ed.doc, range(), "Heading2")) },
      { label: "Livello 3 (Titolo 3)", action: () => ed.edit("style", () => ops.setStyle(ed.doc, range(), "Heading3")) },
      { separator: true },
      { label: "Non mostrare nel sommario", action: () => ed.edit("style", () => ops.setStyle(ed.doc, range(), "Normal")) },
    ],
    coverPage: () => [
      {
        label: "Frontespizio classico",
        icon: "FileText",
        action: () => ed.edit("cover", () => {
          const today = new Date().toLocaleDateString(localeTag(), { day: "numeric", month: "long", year: "numeric" });
          const id = () => ed.doc.nextId++;
          ed.doc.blocks.unshift(
            { type: "p", id: id(), props: { style: "Title", align: "center", spaceBefore: 120, spaceAfter: 12 }, runs: [{ text: "Titolo del documento", props: {} }] },
            { type: "p", id: id(), props: { style: "Subtitle", align: "center", spaceAfter: 36 }, runs: [{ text: "Sottotitolo o descrizione", props: {} }] },
            { type: "p", id: id(), props: { align: "center", spaceAfter: 8 }, runs: [{ text: `Autore · ${today}\f`, props: { color: "#555555" } }] },
          );
        }),
      },
    ],
    textBox: () => [
      {
        label: "Inserisci riquadro di testo",
        icon: "TextCursorInput",
        action: () => ed.edit("textbox", () => {
          const id = ed.doc.nextId++;
          const idx = Math.max(0, ed.doc.blocks.findIndex((b) => b.type === "p" && b.id === ed.sel.focus.pid) + 1);
          ed.doc.blocks.splice(idx, 0, {
            type: "p", id,
            props: { shading: "#f8fafc", indentLeft: 24, indentRight: 24, spaceBefore: 8, spaceAfter: 8 },
            runs: [{ text: "Testo del riquadro in evidenza…", props: { italic: true, color: "#334155" } }],
          });
          ed.sel = { anchor: { pid: id, off: 0 }, focus: { pid: id, off: 0 } };
        }),
      },
    ],
    citation: () => [
      {
        label: "Inserisci citazione (Autore, Anno)…",
        action: async () => {
          const v = await prompt("Inserisci citazione", "Autore e anno (es. Rossi, 2026):", "Rossi, 2026");
          if (v?.trim()) ed.typeText(` (${v.trim()})`);
        },
      },
    ],
  };

  // ---------- pannello commenti e barra revisioni ----------
  const commentsPanel = h("aside", {
    style: "position:absolute;top:8px;right:16px;width:240px;max-height:70%;overflow:auto;background:var(--surface,#fff);border:1px solid var(--border,#d1d5db);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);padding:10px;z-index:6;display:none;flex-direction:column;gap:8px;font-size:12px",
  });
  ed.el.append(commentsPanel);

  const renderComments = () => {
    const list = ed.doc.comments ?? [];
    commentsPanel.style.display = list.length ? "flex" : "none";
    commentsPanel.replaceChildren(
      h("div", { style: "font-weight:600;display:flex;justify-content:space-between;align-items:center" },
        h("span", {}, `Commenti (${list.length})`),
        h("button", { style: "border:none;background:transparent;cursor:pointer;font-size:14px", title: "Nascondi", onclick: () => { commentsPanel.style.display = "none"; } }, "×")),
      ...list.map((cm) => h("div", { style: "padding:6px 8px;background:#fefce8;border-left:3px solid #eab308;border-radius:4px;color:#1f2937" },
        h("div", { style: "display:flex;justify-content:space-between;font-size:11px;color:#6b7280;margin-bottom:2px" },
          h("span", {}, cm.author),
          h("button", {
            style: "border:none;background:transparent;cursor:pointer;color:#b91c1c;font-size:11px",
            onclick: () => {
              ed.doc.comments = (ed.doc.comments ?? []).filter((x) => x.id !== cm.id);
              ed.dirty = true;
              renderComments();
            },
          }, "Elimina")),
        cm.quote ? h("div", { style: "font-style:italic;color:#713f12;font-size:11px;margin-bottom:3px" }, `«${cm.quote.slice(0, 48)}»`) : null,
        h("div", {}, cm.text))),
    );
  };
  if (ed.doc.comments?.length) renderComments();

  let trackingChanges = false;
  const trackBar = h("div", {
    style: "position:absolute;top:8px;left:50%;transform:translateX(-50%);background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:6px;padding:4px 10px;display:none;align-items:center;gap:8px;font-size:12px;z-index:6;box-shadow:0 2px 8px rgba(0,0,0,.08)",
  },
    h("span", { style: "font-weight:600" }, "Revisioni attive"),
    h("button", {
      style: "border:1px solid #16a34a;background:#dcfce7;color:#166534;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px",
      onclick: () => {
        ed.edit("acceptChanges", () => {
          for (const b of ed.doc.blocks) {
            if (b.type !== "p") continue;
            for (const r of b.runs) if (!r.type && r.props.color === "#b91c1c" && r.props.underline) { delete r.props.color; delete r.props.underline; }
          }
        });
        toast("Tutte le revisioni accettate");
      },
    }, "Accetta tutte"),
    h("button", {
      style: "border:1px solid #dc2626;background:#fee2e2;color:#991b1b;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px",
      onclick: () => {
        ed.edit("rejectChanges", () => {
          for (const b of ed.doc.blocks) {
            if (b.type !== "p") continue;
            b.runs = b.runs.filter((r) => r.type || !(r.props.color === "#b91c1c" && r.props.underline));
          }
        });
        toast("Revisioni rifiutate");
      },
    }, "Rifiuta tutte"),
  );
  ed.el.append(trackBar);

  // ---------- pannello struttura / navigazione titoli ----------
  let outlineOpen = false;
  const outlinePanel = h("aside", {
    style: "position:absolute;top:8px;left:12px;width:220px;max-height:75%;overflow:auto;background:var(--surface,#fff);border:1px solid var(--border,#d1d5db);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);padding:10px;z-index:6;display:none;flex-direction:column;gap:4px;font-size:12px",
  });
  ed.el.append(outlinePanel);

  const renderOutline = () => {
    outlinePanel.style.display = outlineOpen ? "flex" : "none";
    if (!outlineOpen) return;
    const heads = ed.layout.headings;
    outlinePanel.replaceChildren(
      h("div", { style: "font-weight:600;display:flex;justify-content:space-between;align-items:center;margin-bottom:4px" },
        h("span", {}, "Struttura documento"),
        h("button", { style: "border:none;background:transparent;cursor:pointer;font-size:14px", onclick: () => { outlineOpen = false; renderOutline(); } }, "×")),
      ...(heads.length
        ? heads.map((hd) => h("button", {
            style: `text-align:left;border:none;background:transparent;cursor:pointer;padding:4px 6px 4px ${6 + hd.level * 12}px;border-radius:4px;display:flex;justify-content:space-between;gap:6px;color:inherit;font-size:12px`,
            onclick: () => { ed.setSelection({ pid: hd.pid, off: 0 }); ed.focus(); },
          }, h("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, hd.text || "(Titolo)"), h("span", { class: "muted" }, String(hd.page))))
        : [h("div", { class: "muted", style: "padding:4px" }, "Nessun titolo (applica Titolo 1, 2 o 3).")]),
    );
  };

  const removeList = () => ed.edit("list", () => {
    for (const p of ops.paragraphsIn(ed.doc, range())) { delete p.props.numId; delete p.props.numLevel; if (p.props.style === "ListParagraph") delete p.props.style; }
  });

  const restartNumbering = () => {
    const p = ed.currentPara();
    if (!p || p.props.numId === undefined) return;
    ed.edit("list", () => {
      // Una nuova numerazione con gli stessi livelli: riparte da 1.
      const src = ed.doc.numbering[p.props.numId!];
      const id = Math.max(0, ...Object.keys(ed.doc.numbering).map(Number)) + 1;
      ed.doc.numbering[id] = { id, levels: structuredClone(src.levels) };
      const all = ops.storyParagraphs(ed.doc, "body");
      const old = p.props.numId;
      for (let i = all.indexOf(p); i < all.length && all[i].props.numId === old; i++) all[i].props.numId = id;
    });
  };

  const insertToc = () => {
    if (ed.story !== "body") return;
    if (ed.doc.blocks.some((b) => b.type === "toc")) { toast("Il documento ha già un sommario: si aggiorna da solo"); return; }
    ed.edit("toc", () => {
      const pos = ops.insertBlockAfter(ed.doc, ed.sel.focus, { type: "toc", id: ed.doc.nextId++, maxLevel: 3, title: "Sommario" });
      ed.sel = { anchor: pos, focus: pos };
    });
    if (!ed.layout.headings.length) toast("Il sommario si riempie con i paragrafi in stile Titolo 1, 2 e 3");
  };

  ed.contextMenu = async (x, y) => {
    const wrong = ed.misspelledAtCaret();
    const spellItems: MenuItem[] = [];
    if (wrong) {
      const suggestions = await ed.spell.suggest(wrong.word);
      const replace = (word: string) => ed.edit("spelling", () => {
        const p = ed.para(wrong.pid);
        if (!p) return;
        const props = ops.runPropsAt(p, wrong.start + 1);
        ops.deleteRange(ed.doc, { pid: wrong.pid, off: wrong.start }, { pid: wrong.pid, off: wrong.end });
        const pos = ops.insertText(ed.doc, { pid: wrong.pid, off: wrong.start }, word, props);
        ed.sel = { anchor: pos, focus: pos };
      });
      spellItems.push(
        ...(suggestions.length ? suggestions.map((sg): MenuItem => ({ label: sg, icon: "Check", action: () => replace(sg) })) : [{ heading: "Nessun suggerimento" } as MenuItem]),
        { separator: true },
        { label: "Ignora tutto", action: () => ed.spell.ignore(wrong.word) },
        { label: "Aggiungi al dizionario", icon: "Plus", action: () => void ed.spell.add(wrong.word).catch((e) => toast(String(e))) },
        { separator: true },
      );
    }
    openMenu({ x, y }, [
      ...spellItems,
      { label: "Taglia", icon: "Scissors", shortcut: "Ctrl+X", disabled: ed.collapsed, action: () => ed.copyFromMenu(true) },
      { label: "Copia", icon: "Copy", shortcut: "Ctrl+C", disabled: ed.collapsed, action: () => ed.copyFromMenu(false) },
      { label: "Incolla", icon: "ClipboardPaste", shortcut: "Ctrl+V", action: () => void ed.pasteFromMenu() },
      { separator: true },
      { label: "Collegamento…", icon: "Link", shortcut: "Ctrl+K", action: () => void insertLink() },
      { label: "Cancella formattazione", icon: "Eraser", action: () => ed.edit("format", () => ops.clearRunProps(ed.doc, range())) },
      ...tableItems(),
    ]);
  };

  // ---------- comandi ----------

  ed.handle = (id: string, anchor?: HTMLElement): boolean => {
    const menu = menus[id];
    const SPLIT = new Set(["paste", "bullets", "numbering"]);
    if (menu && (anchor || !SPLIT.has(id))) {
      if (anchor) openMenu(anchor, menu());
      else { const r = ed.el.getBoundingClientRect(); openMenu({ x: r.left + r.width / 3, y: r.top + 40 }, menu()); }
      return true;
    }
    if (GALLERY[id]) { ed.edit("style", () => { ensureMarkdownStyles(ed.doc); ops.setStyle(ed.doc, range(), GALLERY[id]); }); return true; }
    if (ALIGN[id]) { para({ align: ALIGN[id] === "left" ? undefined : ALIGN[id] }); return true; }
    switch (id) {
      case "bold": case "italic": case "underline": case "strike": toggleRun(id); return true;
      case "subscript": case "superscript": runProps({ vertAlign: isOn("vertAlign") && ed.effectiveProps().vertAlign === id ? undefined : id }); return true;
      case "growFont": case "shrinkFont": {
        const steps = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
        const cur = ed.effectiveProps().size ?? 11;
        const next = id === "growFont" ? steps.find((s) => s > cur) ?? cur + 10 : [...steps].reverse().find((s) => s < cur) ?? Math.max(1, cur - 1);
        runProps({ size: next });
        return true;
      }
      case "clearFormatting":
        ed.edit("format", () => { ops.clearRunProps(ed.doc, range()); ops.setStyle(ed.doc, range(), "Normal"); });
        return true;
      case "style.emphasis": runProps({ italic: true }); return true;
      case "bullets": ed.edit("list", () => ops.toggleList(ed.doc, range(), "bullet")); return true;
      case "numbering": ed.edit("list", () => ops.toggleList(ed.doc, range(), "number")); return true;
      case "indent": ed.edit("indent", () => ops.changeIndent(ed.doc, range(), 1)); return true;
      case "outdent": ed.edit("indent", () => ops.changeIndent(ed.doc, range(), -1)); return true;
      case "undo": ed.undo(); return true;
      case "redo": ed.redo(); return true;
      case "cut": ed.copyFromMenu(true); return true;
      case "copy": ed.copyFromMenu(false); return true;
      case "paste": void ed.pasteFromMenu(); return true;
      case "find": case "replace": {
        const sel = ed.selectedText();
        find.show(id === "replace", sel && sel.length < 60 && !sel.includes("\n") ? sel : undefined);
        return true;
      }
      case "pageBreak": ed.insertPageBreak(); return true;
      case "blankPage": ed.insertPageBreak(); ed.insertPageBreak(); return true;
      case "insertImage": insertImage(); return true;
      case "insertLink": void insertLink(); return true;
      case "tocUpdate": ed.relayout(); ed.draw(); toast("Sommario aggiornato"); return true;
      case "formatPainter": {
        const props = ed.currentProps();
        ed.onMouseSelect = () => {
          ed.onMouseSelect = undefined;
          if (!ed.collapsed) ed.edit("format", () => { ops.clearRunProps(ed.doc, range()); ops.applyRunProps(ed.doc, range(), props); });
        };
        toast("Seleziona il testo a cui applicare il formato");
        return true;
      }
      case "showMarks": case "printLayout": case "readMode": ed.draw(); return true;
      case "ruler": ed.shown(); return true;
      case "spelling":
        ed.spell.enabled = !ed.spell.enabled;
        toast(ed.spell.enabled ? "Controllo ortografico attivo" : "Controllo ortografico disattivato");
        ed.draw();
        return true;
      case "newComment": {
        const quote = ed.selectedText().trim();
        void prompt("Nuovo commento", quote ? `Commento su «${quote.slice(0, 40)}»:` : "Testo del commento:").then((text) => {
          if (!text?.trim()) return;
          if (!ed.collapsed) runProps({ highlight: "#fef08a" });
          ed.doc.comments = ed.doc.comments ?? [];
          const nextId = Math.max(0, ...ed.doc.comments.map((c) => c.id)) + 1;
          ed.doc.comments.push({ id: nextId, author: "Utente", date: new Date().toISOString(), text: text.trim(), quote });
          ed.dirty = true;
          renderComments();
          toast("Commento aggiunto");
        });
        return true;
      }
      case "deleteComment": {
        if (ed.doc.comments?.length) {
          ed.doc.comments.pop();
          ed.dirty = true;
          renderComments();
          toast("Ultimo commento eliminato");
        } else {
          toast("Nessun commento da eliminare");
        }
        return true;
      }
      case "trackChanges": {
        trackingChanges = !trackingChanges;
        trackBar.style.display = trackingChanges ? "flex" : "none";
        if (trackingChanges) {
          runProps({ color: "#b91c1c", underline: true });
          toast("Modalità Revisioni attiva: le nuove aggiunte sono segnate in rosso");
        } else {
          runProps({ color: undefined, underline: false });
          toast("Modalità Revisioni disattivata");
        }
        return true;
      }
      case "footnote": {
        void prompt("Inserisci nota a piè di pagina", "Testo della nota:").then((text) => {
          if (!text?.trim()) return;
          const existing = ed.doc.blocks.filter((b) => b.type === "p" && b.runs[0] && !b.runs[0].type && /^\[\d+\] /.test(b.runs[0].text)).length;
          const n = existing + 1;
          ed.edit("footnote", () => {
            const pos = ops.insertText(ed.doc, ed.sel.focus, `[${n}]`, { ...ed.effectiveProps(), vertAlign: "superscript" });
            ed.sel = { anchor: pos, focus: pos };
            if (existing === 0) {
              ed.doc.blocks.push({ type: "p", id: ed.doc.nextId++, props: { spaceBefore: 14, spaceAfter: 4 }, runs: [{ text: "Note", props: { bold: true, size: 10, color: "#555555" } }] });
            }
            ed.doc.blocks.push({
              type: "p", id: ed.doc.nextId++, props: { spaceAfter: 3 },
              runs: [{ text: `[${n}] `, props: { bold: true, size: 9 } }, { text: text.trim(), props: { size: 9 } }],
            });
          });
          toast(`Nota [${n}] inserita`);
        });
        return true;
      }
      case "caption": {
        void prompt("Inserisci didascalia", "Testo della didascalia:", "Figura 1 — ").then((text) => {
          if (!text?.trim()) return;
          ed.edit("caption", () => {
            const id = ed.doc.nextId++;
            const idx = Math.max(0, ed.doc.blocks.findIndex((b) => b.type === "p" && b.id === ed.sel.focus.pid) + 1);
            ed.doc.blocks.splice(idx, 0, { type: "p", id, props: { style: "Caption", align: "center" }, runs: [{ text: text.trim(), props: {} }] });
          });
        });
        return true;
      }
      case "outlinePane": {
        outlineOpen = !outlineOpen;
        renderOutline();
        return true;
      }
      case "docStats": {
        const paras = [...allParagraphs(ed.doc.blocks)];
        const fullText = paras.map(paragraphText).join("\n");
        const words = fullText.trim() ? fullText.trim().split(/\s+/).length : 0;
        const chars = fullText.length;
        const charsNoSpace = fullText.replace(/\s/g, "").length;
        const tables = ed.doc.blocks.filter((b) => b.type === "table").length;
        const images = paras.flatMap((p) => p.runs).filter((r) => r.type === "image").length;
        const mins = Math.max(1, Math.round(words / 200));
        const overlay = h("div", { class: "dlg-overlay", onmousedown: (e: Event) => { if (e.target === overlay) overlay.remove(); } },
          h("div", { class: "dlg-box", style: "width:340px" },
            h("h3", { style: "margin:0 0 10px" }, "Statistiche documento"),
            h("div", { style: "display:grid;grid-template-columns:1fr auto;gap:6px 16px;font-size:13px;margin-bottom:14px" },
              h("span", {}, "Pagine"), h("strong", {}, String(ed.layout.pages.length)),
              h("span", {}, "Paragrafi"), h("strong", {}, String(paras.length)),
              h("span", {}, "Parole"), h("strong", {}, words.toLocaleString(localeTag())),
              h("span", {}, "Caratteri (spazi inclusi)"), h("strong", {}, chars.toLocaleString(localeTag())),
              h("span", {}, "Caratteri (spazi esclusi)"), h("strong", {}, charsNoSpace.toLocaleString(localeTag())),
              h("span", {}, "Tabelle / Immagini"), h("strong", {}, `${tables} / ${images}`),
              h("span", {}, "Tempo di lettura stimato"), h("strong", {}, `~${mins} min`)),
            h("div", { class: "dlg-actions" }, h("button", { class: "dlg-btn primary", onclick: () => overlay.remove() }, "Chiudi"))));
        document.body.append(overlay);
        return true;
      }
      case "mailMerge": {
        void prompt("Stampa unione (CSV)", "Incolla dati CSV con intestazione (usa {{NomeColonna}} nel documento):", "Nome;Importo\nMario Rossi;150 €\nLucia Bianchi;220 €").then((csv) => {
          if (!csv?.trim()) return;
          const recs = parseCsvRecords(csv);
          if (!recs.length) { toast("Inserisci almeno una riga di intestazione e una riga di dati"); return; }
          const merged = runMailMerge(ed.doc, recs);
          ed.edit("mailMerge", () => {
            ed.doc.blocks = merged.blocks;
            ed.doc.nextId = merged.nextId;
            const first = ed.doc.blocks.find((b) => b.type === "p");
            if (first && first.type === "p") ed.sel = { anchor: { pid: first.id, off: 0 }, focus: { pid: first.id, off: 0 } };
          });
          toast(t("Stampa unione completata: {0} documenti uniti con interruzioni di pagina", recs.length));
        });
        return true;
      }
    }
    return false;
  };

  ed.isActive = (id: string): boolean | undefined => {
    const p = ed.currentPara();
    if (GALLERY[id]) return (p?.props.style ?? "Normal") === GALLERY[id] || (!p?.props.style && GALLERY[id] === "Normal");
    if (ALIGN[id]) return currentAlign() === ALIGN[id];
    switch (id) {
      case "bold": case "italic": case "underline": case "strike": return isOn(id);
      case "subscript": case "superscript": return ed.effectiveProps().vertAlign === id;
      case "bullets": return !!p && p.props.numId !== undefined && isBulletList(ed.doc, p.props.numId);
      case "numbering": return !!p && p.props.numId !== undefined && !isBulletList(ed.doc, p.props.numId);
      case "formatPainter": return !!ed.onMouseSelect;
      case "spelling": return ed.spell.enabled;
      case "trackChanges": return trackingChanges;
      case "outlinePane": return outlineOpen;
    }
    return undefined;
  };

  ed.selectValue = (id: string): string | undefined => {
    const props = ed.effectiveProps();
    if (id === "fontName") return props.font ?? "Calibri";
    if (id === "fontSize") return String(props.size ?? 11).replace(".", ",");
    return undefined;
  };

  ed.setSelect = (id: string, value: string): boolean => {
    if (id === "fontName") runProps({ font: value });
    else if (id === "fontSize") {
      const n = Number(value.replace(",", "."));
      if (n > 0 && n < 1600) runProps({ size: n });
    } else return false;
    ed.focus();
    return true;
  };
}

function searchDoc(ed: DocEditor, o: FindOptions): Match[] {
  if (!o.query) return [];
  const out: Match[] = [];
  const q = o.matchCase ? o.query : o.query.toLocaleLowerCase("it");
  for (const p of ops.storyParagraphs(ed.doc, "body")) {
    const text = paragraphText(p);
    const hay = o.matchCase ? text : text.toLocaleLowerCase("it");
    for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + Math.max(1, q.length))) {
      if (o.wholeCell) {
        const before = text[i - 1], after = text[i + q.length];
        if ((before && /[\p{L}\p{N}]/u.test(before)) || (after && /[\p{L}\p{N}]/u.test(after))) continue;
      }
      out.push({ pid: p.id, from: i, to: i + q.length });
    }
  }
  return out;
}

function symbolGrid(insert: (s: string) => void): HTMLElement {
  return h("div", {},
    h("div", { class: "menu-heading" }, "Simboli"),
    h("div", { class: "symbol-grid" }, ...SYMBOLS.map((s) => h("button", { class: "sym", title: s, onclick: () => { closeMenu(); insert(s); } }, s))));
}
