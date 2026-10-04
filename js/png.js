// zlib deflate (CompressionStream when available) and a small PNG encoder for 1-bit and 8-bit
// grayscale images — the browser's canvas encoder only writes 32-bit RGBA PNGs, which are
// several times larger for black-and-white documents.

import { crc32 } from './zip.js';

/** zlib-wrapped deflate (what PNG IDAT and PDF FlateDecode expect). */
export async function zlibDeflate(bytes) {
  if (typeof CompressionStream === 'function') {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { /* fall through */ }
  }
  return zlibStored(bytes);
}

/** Uncompressed ("stored") zlib stream — valid everywhere, just not small. */
function zlibStored(bytes) {
  const blocks = Math.max(1, Math.ceil(bytes.length / 65535));
  const out = new Uint8Array(2 + bytes.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const chunk = bytes.subarray(i * 65535, Math.min(bytes.length, (i + 1) * 65535));
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = chunk.length & 255; out[o++] = chunk.length >> 8;
    out[o++] = ~chunk.length & 255; out[o++] = (~chunk.length >> 8) & 255;
    out.set(chunk, o); o += chunk.length;
  }
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  const adler = ((b << 16) | a) >>> 0;
  out[o++] = adler >>> 24; out[o++] = (adler >>> 16) & 255; out[o++] = (adler >>> 8) & 255; out[o++] = adler & 255;
  return out;
}

/** Packs 8-bit gray (0…255) into 1-bit rows, MSB first, 1 = white (threshold 50 %). */
export function packBits(gray, w, h) {
  const rowBytes = (w + 7) >> 3;
  const out = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    const row = y * w, o = y * rowBytes;
    for (let x = 0; x < w; x++) if (gray[row + x] >= 128) out[o + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return { bits: out, rowBytes };
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Grayscale PNG. `rows` is a packed byte array of `rowBytes` × h (already 1-bit packed when
 * bitDepth = 1). `dpi` writes a pHYs chunk so the image opens at its physical size.
 */
export async function encodeGrayPNG(rows, w, h, bitDepth, rowBytes, dpi) {
  const raw = new Uint8Array((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rows.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w); v.setUint32(4, h);
  ihdr[8] = bitDepth; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (dpi) {
    const phys = new Uint8Array(9);
    const ppm = Math.round(dpi / 0.0254);
    new DataView(phys.buffer).setUint32(0, ppm); new DataView(phys.buffer).setUint32(4, ppm); phys[8] = 1;
    parts.push(chunk('pHYs', phys));
  }
  parts.push(chunk('IDAT', await zlibDeflate(raw)), chunk('IEND', new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
