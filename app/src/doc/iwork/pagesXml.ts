// Importazione dei vecchi documenti Pages (Pages '09 e precedenti): un solo file index.xml.
import { strFromU8 } from "fflate";
import { newDocument } from "../styles";
import type { Align, DocumentModel, Paragraph, ParaProps, Run, RunProps, StyleDef } from "../model";
import { fontOf } from "./pages";

const ALIGN: Record<number, Align> = { 0: "left", 1: "right", 2: "center", 3: "justify", 4: "left" };

function children(el: Element, name: string): Element[] {
  return [...el.children].filter((c) => c.tagName === name);
}

interface Props { font?: string; size?: number; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string; align?: Align; outline?: boolean; spaceBefore?: number; spaceAfter?: number; leftIndent?: number; firstLine?: number }

function numberOf(el: Element | undefined): number | undefined {
  const n = el?.getElementsByTagName("sf:number")[0];
  const v = n?.getAttribute("sfa:number");
  return v === null || v === undefined ? undefined : Number(v);
}

function readProps(styleEl: Element): Props {
  const map = children(styleEl, "sf:property-map")[0];
  const p: Props = {};
  if (!map) return p;
  const get = (n: string) => children(map, n)[0];
  const font = get("sf:fontName")?.getElementsByTagName("sf:string")[0]?.getAttribute("sfa:string");
  if (font) p.font = font;
  const size = numberOf(get("sf:fontSize")); if (size) p.size = size;
  const bold = numberOf(get("sf:bold")); if (bold !== undefined) p.bold = bold !== 0;
  const italic = numberOf(get("sf:italic")); if (italic !== undefined) p.italic = italic !== 0;
  const ul = numberOf(get("sf:underline")); if (ul !== undefined) p.underline = ul !== 0;
  const st = numberOf(get("sf:strikethru")); if (st !== undefined) p.strike = st !== 0;
  const color = get("sf:fontColor")?.getElementsByTagName("sf:color")[0];
  if (color) {
    const ch = (a: string) => Math.round(Math.max(0, Math.min(1, Number(color.getAttribute(a) ?? 0))) * 255).toString(16).padStart(2, "0");
    const a = Number(color.getAttribute("sfa:a") ?? 1);
    if (a > 0) p.color = `#${ch("sfa:r")}${ch("sfa:g")}${ch("sfa:b")}`;
  }
  const al = numberOf(get("sf:alignment")); if (al !== undefined && ALIGN[al]) p.align = ALIGN[al];
  const sb = numberOf(get("sf:spaceBefore")); if (sb !== undefined) p.spaceBefore = sb;
  const sa = numberOf(get("sf:spaceAfter")); if (sa !== undefined) p.spaceAfter = sa;
  const li = numberOf(get("sf:leftIndent")); if (li !== undefined) p.leftIndent = li;
  const fi = numberOf(get("sf:firstLineIndent")); if (fi !== undefined) p.firstLine = fi;
  const ol = numberOf(get("sf:outlineLevel")); void ol;
  return p;
}

function runProps(c: Props): RunProps {
  const r: RunProps = {};
  if (c.font) {
    const f = fontOf(c.font);
    r.font = f.family;
    if (f.bold && c.bold === undefined) r.bold = true;
    if (f.italic && c.italic === undefined) r.italic = true;
  }
  if (c.bold !== undefined) r.bold = c.bold;
  if (c.italic !== undefined) r.italic = c.italic;
  if (c.size) r.size = c.size;
  if (c.color && c.color !== "#000000") r.color = c.color;
  if (c.underline !== undefined) r.underline = c.underline;
  if (c.strike !== undefined) r.strike = c.strike;
  return r;
}

function inside(el: Element, tag: string): boolean {
  for (let e = el.parentElement; e; e = e.parentElement) if (e.tagName === tag) return true;
  return false;
}

export function importPagesXml(bytes: Uint8Array): DocumentModel {
  const xml = new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
  if (xml.getElementsByTagName("parsererror").length) throw new Error("Il documento Pages contiene XML non valido");

  // Indice degli stili: per identificatore e per ID interno
  const styles = new Map<string, Element>();
  for (const tag of ["sf:paragraphstyle", "sf:characterstyle"]) {
    for (const el of [...xml.getElementsByTagName(tag)]) {
      for (const key of [el.getAttribute("sf:ident"), el.getAttribute("sfa:ID")]) if (key && (!styles.has(key) || el.children.length)) styles.set(key, el);
    }
  }
  // Gli stili senza genitore ereditano dallo stile predefinito (le proprietà vuote significano "come il genitore").
  const defaultParent = (el: Element, key: string): string | null =>
    key === "paragraph-style-default" || key === "character-style-null" ? null : el.tagName === "sf:paragraphstyle" ? "paragraph-style-default" : "character-style-null";
  const resolve = (key: string | null, stopAt?: string): { props: Props; named?: Element } => {
    const list: Element[] = [];
    const seen = new Set<string>();
    for (let cur = key; cur && !seen.has(cur) && cur !== stopAt; ) {
      seen.add(cur);
      const el = styles.get(cur);
      if (!el) break;
      list.push(el);
      cur = el.getAttribute("sf:parent-ident") ?? defaultParent(el, cur);
    }
    const props: Props = {};
    for (const el of list.reverse()) Object.assign(props, readProps(el));
    return { props, named: list.find((e) => e.getAttribute("sf:name")) };
  };
  const namedOf = (key: string | null): string | null => {
    const seen = new Set<string>();
    for (let cur = key; cur && !seen.has(cur); ) {
      seen.add(cur);
      const el = styles.get(cur);
      if (!el) return null;
      if (el.getAttribute("sf:name")) return el.getAttribute("sf:ident");
      cur = el.getAttribute("sf:parent-ident") ?? defaultParent(el, cur);
    }
    return null;
  };

  const doc = newDocument();
  doc.blocks = [];

  // Pagina
  const sl = xml.getElementsByTagName("sl:slprint-info")[0];
  const pw = Number(sl?.getAttribute("sl:page-width")), ph = Number(sl?.getAttribute("sl:page-height"));
  if (pw > 100 && ph > 100) { doc.page.width = pw; doc.page.height = ph; }
  const pm = xml.getElementsByTagName("sf:page-margins")[0];
  if (pm) {
    const m = (n: string, d: number) => { const v = Number(pm.getAttribute(`sf:${n}`)); return Number.isFinite(v) && pm.hasAttribute(`sf:${n}`) ? v : d; };
    doc.page.marginTop = m("top", doc.page.marginTop); doc.page.marginLeft = m("left", doc.page.marginLeft);
    doc.page.marginBottom = m("bottom", doc.page.marginBottom); doc.page.marginRight = m("right", doc.page.marginRight);
    doc.page.headerDistance = m("header", doc.page.headerDistance); doc.page.footerDistance = m("footer", doc.page.footerDistance);
  }

  // Ci possono essere più corpi (il modello e il documento vero): vale quello con più testo reale.
  const realLength = (s: Element) => [...s.getElementsByTagName("sf:p")].reduce((n, p) => {
    const clone = p.cloneNode(true) as Element;
    for (const g of [...clone.getElementsByTagName("sf:ghost-text")]) g.remove();
    return n + (clone.textContent?.length ?? 0);
  }, 0);
  const storage = [...xml.getElementsByTagName("sf:text-storage")].filter((s) => s.getAttribute("sf:kind") === "body" && !inside(s, "sl:section-prototypes")).sort((a, b) => realLength(b) - realLength(a))[0];
  if (!storage) throw new Error("Il documento Pages non contiene testo");

  const styleIds = new Map<string, string>();
  const styleFor = (key: string): string | undefined => {
    const named = namedOf(key);
    if (!named) return undefined;
    const hit = styleIds.get(named);
    if (hit) return hit;
    const el = styles.get(named)!;
    const name = el.getAttribute("sf:name") ?? named;
    const { props } = resolve(named);
    const heading = /^Heading (\d)$/.exec(name);
    const id = heading ? `Heading${heading[1]}` : name === "Body" ? "Normal" : name === "Title" ? "Title" : name === "Subtitle" ? "Subtitle" : name === "Caption" ? "Caption" : `IW_${name.replace(/[^A-Za-z0-9]+/g, "_")}`;
    const def: StyleDef = {
      id, name: doc.styles[id]?.name ?? name, type: "paragraph", basedOn: id === "Normal" ? undefined : "Normal", quick: true,
      para: { ...(id === "Normal" ? doc.styles.Normal.para : { spaceBefore: 0, spaceAfter: 6 }) },
      run: runProps(props),
    };
    if (props.align) def.para!.align = props.align;
    if (heading) { def.para!.outlineLevel = Number(heading[1]) - 1; def.para!.keepNext = true; }
    if (id !== "Normal") def.next = "Normal";
    doc.styles[id] = def;
    styleIds.set(named, id);
    if (id === "Normal") doc.defaultRun = { ...doc.defaultRun, ...runProps(props) };
    return id;
  };

  const readInline = (node: Node, base: RunProps, runs: Run[], link?: string): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const t = child.textContent ?? "";
        if (t) runs.push({ text: t, props: link ? { ...base, link } : { ...base } });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      switch (el.tagName) {
        case "sf:span": {
          const cs = resolve(el.getAttribute("sf:style")).props;
          readInline(el, { ...base, ...runProps(cs) }, runs, link);
          break;
        }
        case "sf:link": readInline(el, base, runs, el.getAttribute("href") ?? undefined); break;
        case "sf:lnbr": runs.push({ text: "\n", props: { ...base } }); break;
        case "sf:tab": runs.push({ text: "\t", props: { ...base } }); break;
        case "sf:pgbr": runs.push({ text: "\f", props: { ...base } }); break;
        case "sf:ghost-text": case "sf:ghost-text-ref": case "sf:br": break;
        case "sf:g": case "sf:insertion-point": case "sf:page-start": case "sf:container-hint": break;
        default: readInline(el, base, runs, link);
      }
    }
  };

  for (const p of [...storage.getElementsByTagName("sf:p")]) {
    const key = p.getAttribute("sf:style");
    const props: ParaProps = {};
    let base: RunProps = {};
    if (key) {
      props.style = styleFor(key);
      const named = namedOf(key);
      if (named && named !== key) {
        const own = resolve(key, named).props;
        base = runProps({ ...own, align: undefined });
        if (own.align) props.align = own.align;
        if (own.leftIndent) props.indentLeft = own.leftIndent;
        if (own.firstLine) props.firstLine = own.firstLine;
      }
    }
    const runs: Run[] = [];
    readInline(p, base, runs);
    const para: Paragraph = { type: "p", id: doc.nextId++, props, runs };
    doc.blocks.push(para);
  }
  if (!doc.blocks.length) doc.blocks.push({ type: "p", id: doc.nextId++, props: {}, runs: [] });
  return doc;
}
