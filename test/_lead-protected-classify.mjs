// Lead: one remaining wart. With production cfg, a .tmp file inside cfg.protectRoots classifies as
// SAFE_TO_DELETE (default-checked green in the UI) even though clean() will refuse it. That is
// defence-in-depth working, but it surfaces a protected file as deletable. Quantify it.
import { classify } from '../lib/classifier.js';
import { resolveConfig } from '../lib/config.js';
import fs from 'node:fs';
import path from 'node:path';

const cfg = resolveConfig({}, process.env);
const base = fs.mkdtempSync('C:\\ProgramData\\dshcc_wart_');
const cases = [
  path.join(base, 'cache.tmp'),                  // .tmp under a protectRoot
  path.join(base, 'notes.log'),
  path.join(base, 'thing.dat'),
];
for (const c of cases) fs.writeFileSync(c, 'x'.repeat(32));

console.log('=== classify() for a file under cfg.protectRoots ===');
for (const c of cases) {
  const r = classify({ path: c, size: 32, mtimeMs: Date.now(), sourceProcess: null }, { cfg, tree: null });
  console.log(`  ${r.category}  ${path.basename(c)}`);
  console.log(`      reason: ${r.reason}`);
}

console.log('\n=== does clean() actually refuse them? ===');
const { clean } = await import('../lib/cleaner.js');
const recs = cases.map((c) => classify({ path: c, size: 32, mtimeMs: Date.now() }, { cfg, tree: null }));
const report = await clean(recs, { deep: true, force: true, cfg, log: { info() {}, warn() {}, debug() {}, error() {} } });
console.log('  report:', JSON.stringify(report));
console.log('  survivors:', fs.readdirSync(base).join(', ') || '(none)');
fs.rmSync(base, { recursive: true, force: true });
