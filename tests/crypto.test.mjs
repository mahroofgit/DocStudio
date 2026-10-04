// MD5 used by PDF password protection. Run: node tests/crypto.test.mjs
import { md5 } from '../js/pdfcrypt.js';
import { createHash } from 'node:crypto';
import assert from 'node:assert';

for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000)]) {
  const mine = Buffer.from(md5(new TextEncoder().encode(s))).toString('hex');
  assert.strictEqual(mine, createHash('md5').update(s).digest('hex'), `md5 of ${s.length} bytes`);
}
console.log('✓ md5 matches Node for 6 inputs');
