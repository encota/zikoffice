// Pacchetto iWork (Pages/Numbers/Keynote dal 2013): zip con file .iwa e cartella Data/ per le immagini.
import { unzipSync } from "fflate";
import { all, fields, fieldsSafe, first, iwaDecompress, num, readObjects, str, type Field } from "./iwa";

export interface RawMsg { type: number; data: Uint8Array }

export class Pkg {
  readonly files: Record<string, Uint8Array>;
  private objs = new Map<number, RawMsg[]>();
  private cache = new Map<Uint8Array, Field[]>();
  private dataNames: Map<number, string> | null = null;

  constructor(files: Record<string, Uint8Array>) {
    this.files = files;
    // Alcune versioni mettono tutti i file .iwa dentro Index.zip.
    const nested = files["Index.zip"];
    if (nested && !Object.keys(files).some((n) => /^Index\/.*\.iwa$/.test(n))) {
      try { for (const [n, d] of Object.entries(unzipSync(nested))) files[n.startsWith("Index/") ? n : `Index/${n}`] = d; } catch { /* ignora */ }
    }
    let any = false;
    for (const [name, data] of Object.entries(files)) {
      if (!/\.iwa$/i.test(name)) continue;
      any = true;
      for (const o of readObjects(iwaDecompress(data))) this.objs.set(o.id, o.messages);
    }
    if (!any) throw new Error("Il pacchetto non contiene dati iWork leggibili");
  }

  static open(bytes: Uint8Array): Pkg {
    let files: Record<string, Uint8Array>;
    try { files = unzipSync(bytes); } catch { throw new Error("Il file non è un documento iWork valido (archivio danneggiato)"); }
    return new Pkg(files);
  }

  has(id: number): boolean { return this.objs.has(id); }
  type(id: number): number { return this.objs.get(id)?.[0].type ?? -1; }
  ids(): IterableIterator<number> { return this.objs.keys(); }

  /** Campi del messaggio principale dell'oggetto (o di quello del tipo indicato). */
  f(id: number, type?: number): Field[] {
    const msgs = this.objs.get(id);
    const m = type === undefined ? msgs?.[0] : msgs?.find((x) => x.type === type);
    if (!m) return [];
    let fs = this.cache.get(m.data);
    if (!fs) { fs = fieldsSafe(m.data); this.cache.set(m.data, fs); }
    return fs;
  }

  /** Primo oggetto del tipo indicato. */
  firstOfType(type: number): number | undefined {
    for (const [id, msgs] of this.objs) if (msgs[0].type === type) return id;
    return undefined;
  }

  allOfType(type: number): number[] {
    const out: number[] = [];
    for (const [id, msgs] of this.objs) if (msgs[0].type === type) out.push(id);
    return out;
  }

  /** Nomi dei file incorporati (identificatore → nome), dal registro dei dati del pacchetto. */
  private loadDataNames(): Map<number, string> {
    if (this.dataNames) return this.dataNames;
    const names = new Map<number, string>();
    for (const id of this.allOfType(11006)) {
      for (const d of all(this.f(id), 4)) {
        if (!d.bytes) continue;
        const inner = fields(d.bytes);
        const ident = num(inner, 1, -1);
        const file = str(first(inner, 3)) || str(first(inner, 4));
        if (ident >= 0 && file) names.set(ident, file);
      }
    }
    return (this.dataNames = names);
  }

  /** Cerca nel pacchetto il file che corrisponde a un identificatore di dato. */
  dataFile(ident: number): { name: string; bytes: Uint8Array } | null {
    const names = [...Object.keys(this.files)].filter((n) => /^Data\//i.test(n));
    const suffix = new RegExp(`[-_]${ident}\\.[A-Za-z0-9]+$`);
    let hit = names.find((n) => suffix.test(n));
    if (!hit) {
      const wanted = this.loadDataNames().get(ident);
      if (wanted) {
        const base = wanted.replace(/\.[^.]+$/, "");
        hit = names.find((n) => n.slice(5) === wanted) ?? names.find((n) => n.slice(5).startsWith(base));
      }
    }
    return hit ? { name: hit, bytes: this.files[hit] } : null;
  }

  /** Identificatore dell'oggetto a cui punta un campo "Reference" ({1: id}). */
  refId(f: Field | undefined): number | undefined {
    if (!f?.bytes) return undefined;
    try {
      const inner = fields(f.bytes);
      const id = first(inner, 1);
      return id && id.wire === 0 ? id.num : undefined;
    } catch { return undefined; }
  }
}
