// The service worker's cache version must match the app version, or phones keep old files.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
const app = /APP_VERSION = '([^']+)'/.exec(readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8'))[1];
const sw = /VERSION = '([^']+)'/.exec(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'))[1];
assert.strictEqual(sw, app, `sw.js VERSION ${sw} ≠ APP_VERSION ${app}`);
// Every module the app imports must be in the offline list.
const shell = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
for (const f of ['main', 'ui', 'canvas', 'model', 'geometry', 'imaging', 'pdfsupport', 'render', 'export', 'exportui', 'zip', 'store', 'icons', 'perspective', 'scan-worker', 'png', 'pdfcrypt', 'ocr', 'markup']) {
  assert(shell.includes(`'js/${f}.js'`), `js/${f}.js missing from sw.js SHELL`);
}
console.log(`✓ version ${app} consistent; offline list complete`);
