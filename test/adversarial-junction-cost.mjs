// verifier probe: PRD §6.1 cost defence with a NUMBER (lead item 4).
// Measures the per-candidate guard cost of the junction fix so we can report the added
// cost rather than assert it, and independently validates the lead's realpath benchmark.
// Run BEFORE and AFTER the fix lands; the delta is the added per-candidate cost.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { resolveConfig } = await import('../lib/config.js');
const { isProtectedPath, classify } = await import('../lib/classifier.js');

const cfg = resolveConfig({});
const B = path.sep;
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const holder = path.join(cfg.watchDirs[0].path, `dshcc_cost_${STAMP}`);
fs.mkdirSync(holder, { recursive: true });

// A realistic candidate batch: many files in a few directories (the watcher's real shape).
const dirs = [];
for (let d = 0; d < 10; d++) {
  const dir = path.join(holder, `d${d}`);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  for (let f = 0; f < 50; f++) fs.writeFileSync(path.join(dir, `f${f}.tmp`), 'x');
}
const candidates = [];
for (const dir of dirs) for (const f of fs.readdirSync(dir)) candidates.push(path.join(dir, f));
console.log('candidate batch =', candidates.length, 'files across', dirs.length, 'directories');
console.log('');

function bench(label, fn, iters = 3) {
  for (let i = 0; i < 2; i++) for (const c of candidates) fn(c); // warm-up
  const runs = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    for (const c of candidates) fn(c);
    runs.push(Number(process.hrtime.bigint() - t0) / candidates.length);
  }
  const best = Math.min(...runs);
  console.log(`${label.padEnd(42)} ${Math.round(best).toString().padStart(9)} ns/candidate`);
  return best;
}

const guard = bench('isProtectedPath (plugin guard)', (c) => isProtectedPath(c, cfg.protectRoots));
const cls = bench('classify (full)', (c) => classify({ path: c, size: 1 }, { cfg }));

// Independent validation of the lead's benchmark: cold NTFS realpath cost.
const realpathTargets = dirs.map((d) => ({ d, real: fs.realpathSync.native(d), alias: null }));
function benchRaw(label, fn, iters = 3) {
  const runs = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    for (const t of realpathTargets) fn(t);
    runs.push(Number(process.hrtime.bigint() - t0) / realpathTargets.length);
  }
  const best = Math.min(...runs);
  console.log(`${label.padEnd(42)} ${Math.round(best).toString().padStart(9)} ns/call`);
  return best;
}
const rpPlain = benchRaw('fs.realpathSync.native (uncached)', (t) => fs.realpathSync.native(t.d));
const cache = new Map();
const rpMemo = benchRaw('fs.realpathSync.native (memoized)', (t) => {
  if (!cache.has(t.d)) cache.set(t.d, fs.realpathSync.native(t.d));
  return cache.get(t.d);
});
console.log('');
console.log('memo speedup vs uncached :', (rpPlain / rpMemo).toFixed(1) + 'x');
console.log('');

// Projection to 10k candidates.
console.log('PROJECTION at 10,000 candidates:');
console.log('  guard total            =', (guard * 10000 / 1e6).toFixed(2), 'ms');
console.log('  classify total         =', (cls * 10000 / 1e6).toFixed(2), 'ms');
console.log('  + unconditional realpath =', ((rpPlain + guard) * 10000 / 1e6).toFixed(2), 'ms  <- the variant the lead rejected');
console.log('  + memoized realpath      =', ((rpMemo + guard) * 10000 / 1e6).toFixed(2), 'ms  <- the accepted recipe');
console.log('');
console.log('NOTE: this is a per-call microbenchmark, NOT a wall-clock sweep; it isolates the');
console.log('guard so PRD §6.1 can be argued with a number. Compare BEFORE vs AFTER the fix.');

try { fs.rmSync(holder, { recursive: true, force: true }); } catch {}
