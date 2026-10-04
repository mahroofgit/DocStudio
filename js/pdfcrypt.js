// PDF password protection: Standard security handler, AES-128 (V4 / R4 / AESV2), the same
// open-password protection the Mac app writes. pdf-lib can't encrypt, so the saved file is
// re-loaded, every string and stream is encrypted with its per-object key, and an /Encrypt
// dictionary + /ID are added to the trailer.

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
const PERMISSIONS = -4;          // everything allowed (printing, copying…) once opened

// ------------------------------------------------------------------ MD5

const K = new Int32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

export function md5(bytes) {
  const n = bytes.length;
  const total = ((n + 8) >> 6) + 1 << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes); buf[n] = 0x80;
  const v = new DataView(buf.buffer);
  v.setUint32(total - 8, (n * 8) >>> 0, true);
  v.setUint32(total - 4, Math.floor(n / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = v.getInt32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const s = S[(i >> 4) * 4 + (i & 3)];
      const t = (a + f + K[i] + M[g]) | 0;
      a = d; d = c; c = b;
      b = (b + ((t << s) | (t >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setInt32(0, a0, true); ov.setInt32(4, b0, true); ov.setInt32(8, c0, true); ov.setInt32(12, d0, true);
  return out;
}

function rc4(key, data) {
  const s = new Uint8Array(256).map((_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

/** Password → 32 padded bytes (PDFDocEncoding ≈ Latin-1; other characters become '?'). */
function padPassword(pw) {
  const bytes = Array.from(pw.slice(0, 32), (ch) => (ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 63));
  return concat(new Uint8Array(bytes), PAD).subarray(0, 32);
}

const le32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); return b; };
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Computes /O, /U and the file key (Algorithms 2, 3 and 5 of the PDF spec, revision 4). */
export function computeKeys(userPw, ownerPw, id0) {
  // O: RC4 of the padded user password, keyed from the owner password.
  let ok = md5(padPassword(ownerPw || userPw));
  for (let i = 0; i < 50; i++) ok = md5(ok);
  let O = rc4(ok, padPassword(userPw));
  for (let i = 1; i <= 19; i++) O = rc4(ok.map((b) => b ^ i), O);

  let key = md5(concat(padPassword(userPw), O, le32(PERMISSIONS), id0));
  for (let i = 0; i < 50; i++) key = md5(key);

  let U = rc4(key, md5(concat(PAD, id0)));
  for (let i = 1; i <= 19; i++) U = rc4(key.map((b) => b ^ i), U);
  U = concat(U, new Uint8Array(16));
  return { O, U, key };
}

async function aesEncrypt(objKey, data) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const k = await crypto.subtle.importKey('raw', objKey, { name: 'AES-CBC' }, false, ['encrypt']);
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data));
  return concat(iv, enc);
}

function objectKey(fileKey, num, gen) {
  const extra = new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255, 0x73, 0x41, 0x6c, 0x54]);
  return md5(concat(fileKey, extra)).subarray(0, 16);
}

/** Returns new PDF bytes protected with `password` (needed to open the file). */
export async function encryptPDF(bytes, password) {
  const L = window.PDFLib;
  const { PDFDocument, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, PDFName, PDFNumber } = L;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;

  const id0 = crypto.getRandomValues(new Uint8Array(16));
  const { O, U, key } = computeKeys(password, password, id0);

  const stringBytes = (s) => (typeof s.asBytes === 'function' ? s.asBytes()
    : s instanceof PDFHexString ? hexToBytes(s.asString()) : latin1(s.asString()));

  async function encryptValue(v, okey) {
    if (v instanceof PDFString || v instanceof PDFHexString) {
      return PDFHexString.of(toHex(await aesEncrypt(okey, stringBytes(v))));
    }
    if (v instanceof PDFDict) {
      for (const [k, val] of v.entries()) {
        const nv = await encryptValue(val, okey);
        if (nv !== val) v.set(k, nv);
      }
      return v;
    }
    if (v instanceof PDFArray) {
      for (let i = 0; i < v.size(); i++) {
        const val = v.get(i);
        const nv = await encryptValue(val, okey);
        if (nv !== val) v.set(i, nv);
      }
      return v;
    }
    return v;
  }

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const okey = objectKey(key, ref.objectNumber, ref.generationNumber);
    if (obj instanceof PDFRawStream) {
      const type = obj.dict.get(PDFName.of('Type'));
      if (type === PDFName.of('XRef')) continue;
      await encryptValue(obj.dict, okey);
      obj.contents = await aesEncrypt(okey, obj.contents);
    } else if (obj && typeof obj.dict === 'object' && typeof obj.getContents === 'function') {
      // Any other stream class: freeze its encoded bytes into a raw stream first.
      const raw = PDFRawStream.of(obj.dict, obj.getContents());
      await encryptValue(raw.dict, okey);
      raw.contents = await aesEncrypt(okey, raw.contents);
      ctx.assign(ref, raw);
    } else {
      await encryptValue(obj, okey);
    }
  }

  const encrypt = ctx.obj({
    Filter: 'Standard', V: 4, R: 4, Length: 128, P: PDFNumber.of(PERMISSIONS),
    O: PDFHexString.of(toHex(O)), U: PDFHexString.of(toHex(U)),
    CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV2', Length: 16 } },
    StmF: 'StdCF', StrF: 'StdCF',
  });
  ctx.trailerInfo.Encrypt = ctx.register(encrypt);
  const idHex = PDFHexString.of(toHex(id0));
  ctx.trailerInfo.ID = ctx.obj([idHex, idHex]);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(Math.ceil(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2).padEnd(2, '0'), 16);
  return out;
}
function latin1(s) { return Uint8Array.from(s, (c) => c.charCodeAt(0) & 255); }
