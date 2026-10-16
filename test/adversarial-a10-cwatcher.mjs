// verifier probe: does the PLUGIN (CWatcher) still hard-abort on an 8.3-alias watchDir,
// now that watch-tracker canonicalises watch dirs in start()? Raw fs.watch aborting is a
// libuv fact, NOT a plugin defect — only the production path (CWatcher) counts.
// Runs in a CHILD because the abort is uncatchable.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = path.sep;
const here = path.dirname(fileURLToPath(import.meta.url));
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const longRoot = path.join('C:' + B + 'ProgramData', `dshcc_a10c_${STAMP}`);
fs.mkdirSync(longRoot, { recursive: true });
const shortRoot = 'C:' + B + 'PROGRA~3' + B + path.basename(longRoot);
console.log('long  =', JSON.stringify(longRoot));
console.log('short =', JSON.stringify(shortRoot));
console.log('short is a live alias =', fs.realpathSync.native(shortRoot).toLowerCase() === longRoot.toLowerCase());

const CHILD = `
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { CWatcher } from '../lib/watcher.js';
const dir = process.env.DCC_DIR;
const LOG = { debug(){}, info(){}, warn(){}, error(){} };
const cfg = resolveConfig({ watchDirs: [{ path: dir, recursive: false, maxDepth: 1 }], debounceMs: 300 });
const hits = [];
const w = new CWatcher({ cfg, tree: { ownerOf: () => null, nameOf: () => null }, log: LOG, onCandidate: (c) => hits.push(c.path) });
let err = null;
try { w.start(); } catch (e) { err = (e.code || '') + ' ' + e.message; }
console.log('  startErr =', err);
console.log('  stats.watching =', JSON.stringify(w.stats().watching));
await new Promise((r) => setTimeout(r, 700));
// A real write in the LONG spelling so the event definitely happens under a live path.
fs.writeFileSync(path.join(process.env.DCC_LONG, 'a10c_trigger.tmp'), 'x'.repeat(8));
await new Promise((r) => setTimeout(r, 2000));
w.stop();
console.log('  hits =', JSON.stringify(hits));
console.log('  SURVIVED-CHILD');
`;

const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
  encoding: 'utf8', cwd: here, timeout: 30000,
  env: { ...process.env, DCC_DIR: shortRoot, DCC_LONG: longRoot },
});
const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
const aborted = r.status === 3221226505 || r.status === -1073740791;
console.log('\n--- CWatcher with an 8.3-alias watchDir (production path) ---');
for (const l of out.split('\n').filter(Boolean)) console.log(`  | ${l}`);
console.log('  exit =', r.status, aborted ? '  <<< ABORT 0xC0000409' : '');
console.log('\n' + (aborted
  ? '>>> REAL DEFECT (still): CWatcher hard-aborts on an 8.3-alias watchDir'
  : '>>> FIXED: CWatcher canonicalises the watchDir and does NOT abort'));

// control: the same watcher with the long spelling
const r2 = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
  encoding: 'utf8', cwd: here, timeout: 30000,
  env: { ...process.env, DCC_DIR: longRoot, DCC_LONG: longRoot },
});
const ab2 = r2.status === 3221226505 || r2.status === -1073740791;
console.log('\n--- control: same watcher, LONG spelling ---');
for (const l of `${r2.stdout || ''}${r2.stderr || ''}`.trim().split('\n').filter(Boolean)) console.log(`  | ${l}`);
console.log('  exit =', r2.status, ab2 ? '  <<< ABORT' : '');

try { fs.rmSync(longRoot, { recursive: true, force: true }); } catch {}
