
import { t } from "../../i18n";// Lettura del contenitore dei file iWork (Pages, Numbers, Keynote dal 2013): file .iwa = blocchi Snappy
// (senza CRC) con dentro oggetti protobuf. Qui non serve nessuno schema: si legge il formato "a fili"
// (wire format) e si interpretano solo i campi che interessano.

const utf8 = new TextDecoder("utf-8");

/** Decomprime un blocco Snappy "raw" (senza intestazione di flusso). */
export function snappyDecompress(src: Uint8Array): Uint8Array {
  let pos = 0;
  let size = 0;
  for (let shift = 0; ; shift += 7) {
    const b = src[pos++];
    size |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
  }
  const out = new Uint8Array(size);
  let o = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >> 2;
      if (len >= 60) {
        const extra = len - 59;
        len = 0;
        for (let i = 0; i < extra; i++) len |= src[pos++] << (8 * i);
      }
      len += 1;
      if (pos + len > src.length || o + len > size) throw new Error("Snappy: dati troncati");
      out.set(src.subarray(pos, pos + len), o);
      pos += len;
      o += len;
    } else {
      let len: number;
      let offset: number;
      if (kind === 1) {
        len = ((tag >> 2) & 7) + 4;
        offset = ((tag >> 5) << 8) | src[pos++];
      } else if (kind === 2) {
        len = (tag >> 2) + 1;
        offset = src[pos] | (src[pos + 1] << 8);
        pos += 2;
      } else {
        len = (tag >> 2) + 1;
        offset = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
        pos += 4;
      }
      if (offset === 0 || offset > o || o + len > size) throw new Error("Snappy: riferimento non valido");
      // La copia può sovrapporsi a se stessa (ripetizioni): va fatta byte per byte.
      for (let i = 0; i < len; i++, o++) out[o] = out[o - offset];
    }
  }
  if (o !== size) throw new Error("Snappy: lunghezza inattesa");
  return out;
}

/** Concatena i blocchi di un file .iwa decomprimendoli. */
export function iwaDecompress(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let pos = 0;
  let total = 0;
  while (pos + 4 <= data.length) {
    const type = data[pos];
    const len = data[pos + 1] | (data[pos + 2] << 8) | (data[pos + 3] << 16);
    pos += 4;
    if (type !== 0) throw new Error(t("Blocco IWA di tipo {0} non supportato", type));
    if (pos + len > data.length) throw new Error("File IWA troncato");
    const chunk = snappyDecompress(data.subarray(pos, pos + len));
    parts.push(chunk);
    total += chunk.length;
    pos += len;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- protobuf a fili ----------

export interface Field {
  /** Numero del campo. */
  n: number;
  /** 0 = varint, 1 = 64 bit, 2 = lunghezza, 5 = 32 bit. */
  wire: number;
  /** Valore numerico (varint, 32 e 64 bit; i 64 bit possono perdere precisione). */
  num: number;
  /** Contenuto per i campi a lunghezza variabile (stringhe, messaggi, byte). */
  bytes?: Uint8Array;
}

export class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, end = buf.length) {
    this.end = end;
  }
  end: number;

  get done(): boolean { return this.pos >= this.end; }

  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error("Protobuf: fine inattesa");
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if (!(b & 0x80)) return result;
      mul *= 128;
    }
    throw new Error("Protobuf: varint troppo lungo");
  }

  field(): Field {
    const key = this.varint();
    const n = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) return { n, wire, num: this.varint() };
    if (wire === 2) {
      const len = this.varint();
      if (this.pos + len > this.end) throw new Error("Protobuf: lunghezza fuori dai limiti");
      const bytes = this.buf.subarray(this.pos, this.pos + len);
      this.pos += len;
      return { n, wire, num: len, bytes };
    }
    if (wire === 5) {
      const v = (this.buf[this.pos] | (this.buf[this.pos + 1] << 8) | (this.buf[this.pos + 2] << 16) | (this.buf[this.pos + 3] << 24)) >>> 0;
      this.pos += 4;
      return { n, wire, num: v, bytes: this.buf.subarray(this.pos - 4, this.pos) };
    }
    if (wire === 1) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
      this.pos += 8;
      return { n, wire, num: view.getUint32(0, true) + view.getUint32(4, true) * 4294967296, bytes: this.buf.subarray(this.pos - 8, this.pos) };
    }
    throw new Error(t("Protobuf: tipo di campo {0} non supportato", wire));
  }
}

export function fields(buf: Uint8Array): Field[] {
  const r = new Reader(buf);
  const out: Field[] = [];
  while (!r.done) out.push(r.field());
  return out;
}

/** Come `fields`, ma se il contenuto non è un messaggio valido restituisce i campi letti finora. */
export function fieldsSafe(buf: Uint8Array): Field[] {
  const r = new Reader(buf);
  const out: Field[] = [];
  try { while (!r.done) out.push(r.field()); } catch { /* contenuto non protobuf o troncato */ }
  return out;
}

export const first = (fs: Field[], n: number): Field | undefined => fs.find((f) => f.n === n);
export const all = (fs: Field[], n: number): Field[] => fs.filter((f) => f.n === n);
export const num = (fs: Field[], n: number, dflt = 0): number => first(fs, n)?.num ?? dflt;
export const str = (f: Field | undefined): string => (f?.bytes ? utf8.decode(f.bytes) : "");
export const float32 = (f: Field | undefined): number | undefined =>
  f?.bytes && f.wire === 5 ? new DataView(f.bytes.buffer, f.bytes.byteOffset, 4).getFloat32(0, true) : undefined;

/** Interi impacchettati (packed) o ripetuti per lo stesso campo. */
export function ints(fs: Field[], n: number): number[] {
  const out: number[] = [];
  for (const f of fs) {
    if (f.n !== n) continue;
    if (f.wire === 0) out.push(f.num);
    else if (f.wire === 2 && f.bytes) {
      const r = new Reader(f.bytes);
      while (!r.done) out.push(r.varint());
    }
  }
  return out;
}

// ---------- archivio: oggetti con identificatore e tipo ----------

export interface IwaMessage {
  /** Tipo del messaggio (indice nella tabella di registrazione dell'app). */
  type: number;
  data: Uint8Array;
}

export interface IwaObject {
  id: number;
  messages: IwaMessage[];
}

/** Legge gli oggetti di un file .iwa già decompresso: [lunghezza][ArchiveInfo][payload…]. */
export function readObjects(buf: Uint8Array): IwaObject[] {
  const r = new Reader(buf);
  const out: IwaObject[] = [];
  while (!r.done) {
    const infoLen = r.varint();
    const info = fields(buf.subarray(r.pos, r.pos + infoLen));
    r.pos += infoLen;
    const id = num(info, 1);
    const messages: IwaMessage[] = [];
    for (const mi of all(info, 2)) {
      const m = fields(mi.bytes!);
      const type = num(m, 1);
      const length = num(m, 3);
      if (r.pos + length > buf.length) throw new Error("Oggetto IWA troncato");
      messages.push({ type, data: buf.subarray(r.pos, r.pos + length) });
      r.pos += length;
    }
    out.push({ id, messages });
  }
  return out;
}
