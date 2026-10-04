// Scan pipeline tests (ports of the macOS ScanPipelineTests). Run: node tests/scan.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Load the worker script with a fake `self` and call it through its message API.
let reply;
const self = { postMessage: (m) => { reply = m; } };
new Function('self', fs.readFileSync(path.join(__dirname, '../js/scan-worker.js'), 'utf8'))(self);
const call = (msg) => { reply = null; self.onmessage({ data: { id: 1, ...msg } }); if (reply.error) throw new Error(reply.error); return reply; };

const DEFAULT = { mode: 'original', exposure: 0, contrast: 1, saturation: 1, gamma: 1, sharpness: 0, hardThreshold: false, inkSensitivity: 0.5 };
const PRESET = {
  colorScan: { ...DEFAULT, mode: 'colorScan', sharpness: 0.3 },
  grayscale: { ...DEFAULT, mode: 'grayscale', sharpness: 0.3 },
  blackWhite: { ...DEFAULT, mode: 'blackWhite' },
};

// ---- fixture: a "photo of a form" (same drawing as the Mac tests)
function photographedForm() {
  const W = 900, H = 1200, d = new Uint8ClampedArray(W * H * 4);
  const fill = (x0, y0, w, h, r, g, b) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const p = (y * W + x) * 4; d[p] = r * 255 + 0.5; d[p + 1] = g * 255 + 0.5; d[p + 2] = b * 255 + 0.5; d[p + 3] = 255;
    }
  };
  for (let y = 0; y < H; y += 4) {
    const shade = y < 400 ? 0.55 + 0.45 * y / 400 : 1;
    fill(0, y, W, 4, 0.93 * shade, 0.90 * shade, 0.78 * shade);
  }
  for (let row = 0; row < 6; row++) {
    const y = 120 + row * 20, shade = 0.55 + 0.45 * y / 400;
    fill(100, y, 300, 2, 0.5 * shade, 0.5 * shade, 0.5 * shade);
    fill(100, 620 + row * 20, 300, 2, 0.5, 0.5, 0.5);
  }
  fill(500, 600, 300, 40, 0.05, 0.05, 0.05);
  fill(450, 800, 380, 300, 0.15, 0.25, 0.55);
  return { w: W, h: H, data: d };
}

const form = photographedForm();
const run = (settings) => call({ type: 'process', w: form.w, h: form.h, data: new Uint8ClampedArray(form.data), quad: null, settings });
const px = (img, x, y) => { const p = (y * img.w + x) * 4; return { r: img.data[p], g: img.data[p + 1], b: img.data[p + 2] }; };
const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

const tests = {
  'B&W whitens paper everywhere, including the shadow'() {
    const out = run(PRESET.blackWhite);
    assert.strictEqual(out.w, 900); assert.strictEqual(out.h, 1200);
    assert(luma(px(out, 600, 60)) > 230, `paper in shadow ${luma(px(out, 600, 60))}`);
    assert(luma(px(out, 600, 500)) > 230, 'paper in light');
  },
  'B&W keeps faint thin strokes'() {
    const out = run(PRESET.blackWhite);
    assert(luma(px(out, 250, 121)) < 110, `faint stroke in shadow ${luma(px(out, 250, 121))}`);
    assert(luma(px(out, 250, 621)) < 110, `faint stroke in light ${luma(px(out, 250, 621))}`);
    assert(luma(px(out, 650, 620)) < 60, 'bold bar stays black');
  },
  'Color scan does not blow out large dark areas'() {
    const out = run(PRESET.colorScan);
    const blue = px(out, 640, 950);
    assert(luma(blue) < 140, `dark picture normalized to ${luma(blue)}`);
    assert(blue.b > blue.r + 40, 'picture keeps its blue');
    const paper = px(out, 600, 500);
    assert(luma(paper) > 225, `paper ${luma(paper)}`);
    assert(Math.abs(paper.r - paper.b) < 25, 'yellow cast removed');
  },
  'Illumination map is not flipped'() {
    const out = run(PRESET.grayscale);
    const top = luma(px(out, 820, 30)), bottom = luma(px(out, 820, 1180));
    assert(top > 200, `top ${top}`);
    assert(Math.abs(top - bottom) < 30, `top ${top} bottom ${bottom}`);
  },
  'Original mode is untouched'() {
    const out = run(DEFAULT);
    for (let i = 0; i < form.data.length; i += 997) assert.strictEqual(out.data[i], form.data[i]);
  },
  'Higher ink sensitivity keeps more ink'() {
    const count = (o) => { let n = 0; for (let i = 0; i < o.data.length; i += 4) if (o.data[i] < 128) n++; return n; };
    const lo = count(run({ ...PRESET.blackWhite, inkSensitivity: 0 }));
    const hi = count(run({ ...PRESET.blackWhite, inkSensitivity: 1 }));
    assert(hi >= lo, `${hi} < ${lo}`);
  },
  'Hard threshold is pure black and white'() {
    const out = run({ ...PRESET.blackWhite, hardThreshold: true });
    for (let i = 0; i < out.data.length; i += 4) assert(out.data[i] === 0 || out.data[i] === 255);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { const t = Date.now(); fn(); console.log(`✓ ${name} (${Date.now() - t} ms)`); }
  catch (e) { failed++; console.log(`✗ ${name}\n    ${e.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
