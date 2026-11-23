// Dimensioni in pixel di un'immagine, lette dall'intestazione (PNG, JPEG, GIF, WebP, SVG), senza decodificarla.

export interface Size { w: number; h: number }

export function imageSize(b: Uint8Array): Size | null {
  const u16be = (o: number) => (b[o] << 8) | b[o + 1];
  const u16le = (o: number) => b[o] | (b[o + 1] << 8);
  const u32be = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: u32be(16), h: u32be(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: u16le(6), h: u16le(8) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1];
      if (marker === 0xff) { o++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = u16be(o + 2);
      // SOF0..SOF15 tranne DHT (c4), JPG (c8) e DAC (cc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: u16be(o + 7), h: u16be(o + 5) };
      o += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === "VP8X") return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8L") {
      const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { w: 1 + (v & 0x3fff), h: 1 + ((v >>> 14) & 0x3fff) };
    }
    if (kind === "VP8 ") return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    return null;
  }
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 2048)));
  if (/<svg[\s>]/i.test(head)) {
    const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? "";
    const num = (name: string) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)\\s*(px)?\\s*["']`, "i").exec(tag);
      return m ? parseFloat(m[1]) : undefined;
    };
    const w = num("width"), h = num("height");
    if (w && h) return { w, h };
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
    if (vb) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
  }
  return null;
}

export function mimeFromName(name: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name)?.[1].toLowerCase() ?? "";
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp" } as Record<string, string>)[ext] ?? "image/png";
}

export function extFromMime(mime: string): string {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp" } as Record<string, string>)[mime] ?? "png";
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
