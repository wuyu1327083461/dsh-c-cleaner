/**
 * dsh-c-cleaner — STEP 4 junction REACHABILITY probe (verifier-owned).
 *
 *   node /f/work/dsh-c-cleaner/test/adversarial-junction-reach.mjs
 *
 * J3 of adversarial-junction.mjs proved clean() deletes through a junction.
 * This file settles HOW a record with such a path can arise:
 *   (a) can CWatcher emit it from a legitimately configured recursive Temp watch?
 *   (b) does fs.watch(recursive) itself follow a junction?
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { CWatcher } = await import(new URL('../lib/watcher.js', import.meta.url));
const { resolveConfig } = await import(new URL('../lib/config.js', import.meta.url));
const CFG = resolveConfig({});
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const B = '\\';

const watched = path.join(os.tmpdir(), `dshcc_jr_${STAMP}`);
const junc = path.join(watched, 'innocent-cache');
const winTemp = `C:${B}Windows${B}Temp`;
const victim = path.join(winTemp, `dshcc_jr_victim_${STAMP}.log`);

fs.mkdirSync(watched, { recursive: true });
let ok = false;
try {
  fs.symlinkSync(winTemp, junc, 'junction');
  ok = true;
} catch (e) {
  console.log(`SETUP FAILED: ${e.code} ${e.message}`);
}

if (ok) {
  console.log(`watched dir = ${watched}   (under %LOCALAPPDATA%\\Temp = ${CFG.watchDirs[0].path})`);
  console.log(`junction    = ${junc} -> ${winTemp}\n`);

  console.log('=== (b) raw fs.watch(recursive:true) — does it follow the junction? ===');
  const raw = [];
  const rawWatcher = fs.watch(watched, { recursive: true, persistent: false }, (ev, fn) => raw.push(`${ev}:${fn}`));
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(victim, 'x');
  await new Promise((r) => setTimeout(r, 1200));
  rawWatcher.close();
  console.log(`  raw fs.watch events for a write through the junction: ${JSON.stringify(raw)}`);

  console.log('\n=== (b2) control: raw fs.watch for a plain file directly in the watched dir ===');
  const raw2 = [];
  const w2 = fs.watch(watched, { recursive: true, persistent: false }, (ev, fn) => raw2.push(`${ev}:${fn}`));
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(path.join(watched, `plain_${STAMP}.tmp`), 'x');
  await new Promise((r) => setTimeout(r, 1200));
  w2.close();
  console.log(`  raw fs.watch events for a plain file: ${JSON.stringify(raw2)}  (proves the watch itself works)`);

  console.log('\n=== (a) CWatcher with an explicit configured watchDir ===');
  for (const [label, dirs] of [
    ['recursive Temp root (production shape)', CFG.watchDirs],
    ['explicit junction dir (user config)', [{ path: junc, recursive: true, maxDepth: 3 }]],
  ]) {
    const hits = [];
    const w = new CWatcher({ cfg: { ...CFG, debounceMs: 400, watchDirs: dirs }, tree: { ownerOf: () => null, nameOf: () => null }, log: silent, onCandidate: (c) => hits.push(c) });
    const started = w.start();
    await new Promise((r) => setTimeout(r, 500));
    const v2 = path.join(winTemp, `dshcc_jr2_${STAMP}.log`);
    try { fs.writeFileSync(v2, 'x'); } catch (e) { console.log(`    write failed ${e.code}`); }
    await new Promise((r) => setTimeout(r, 2200));
    w.stop();
    console.log(`  [${label}]`);
    console.log(`    start().watching = ${JSON.stringify(started.watching)}`);
    console.log(`    hits = ${JSON.stringify(hits.map((h) => h.path))}`);
    console.log(`    stats = ${JSON.stringify(w.stats())}`);
    try { fs.rmSync(v2, { force: true }); } catch { /* ignore */ }
  }

  try { fs.rmSync(junc, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(victim, { force: true }); } catch { /* ignore */ }
}
fs.rmSync(watched, { recursive: true, force: true });
console.log('\njunction reachability probe complete.');
