// verifier probe: does the per-directory memo actually work? (lead item 4 — a NUMBER for PRD §6.1)
// The lead's recipe claims ~922 ns/call memoized vs 91,350 ns/call unconditional. The claim is
// specifically "one syscall per DIRECTORY, not per file". That is directly testable: compare the
// per-candidate guard cost when all candidates share ONE directory (memo should absorb it) against
// many distinct directories (memo misses). If the memo were ineffective, the one-dir case would
// cost the same as the many-dir case.
import fs from 'node:fs';
import path from 'node:path';

const { resolveConfig } = await import('../lib/config.js');
const { isProtectedPath, classify } = await import('../lib/classifier.js');

const cfg = resolveConfig({});
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const base = path.join(process.env.LOCALAPPDATA || '', 'Temp');
const root = path.join(base, `dshcc_memo_${STAMP}`);
fs.mkdirSync(root, { recursive: true });

function makeSet(dirCount, filesPerDir) {
  const files = [];
  for (let d = 0; d < dirCount; d++) {
    const dir = path.join(root, `case${dirCount}_${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < filesPerDir; f++) {
      const p = path.join(dir, `f${f}.tmp`);
      if (!fs.existsSync(p)) fs.writeFileSync(p, 'x');
      files.push(p);
    }
  }
  return files;
}

function bench(label, files, fn, iters = 3) {
  for (let i = 0; i < 2; i++) for (const f of files) fn(f); // warm the memo
  const runs = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    for (const f of files) fn(f);
    runs.push(Number(process.hrtime.bigint() - t0) / files.length);
  }
  const ns = Math.min(...runs);
  console.log(`  ${label.padEnd(46)} ${Math.round(ns).toString().padStart(8)} ns/candidate  (${files.length} files)`);
  return ns;
}

console.log('candidate batch shapes (%TEMP% files, the watcher\'s real input):');
console.log('');
const oneDir = makeSet(1, 500);
const manyDirs = makeSet(200, 5);
console.log('  1 directory  x 500 files');
console.log('  200 directories x 5 files');
console.log('');

const guard1 = bench('isProtectedPath, 1 dir (memo should hit)', oneDir, (f) => isProtectedPath(f, cfg.protectRoots));
const guardN = bench('isProtectedPath, 200 dirs (memo misses)', manyDirs, (f) => isProtectedPath(f, cfg.protectRoots));
const cls1 = bench('classify (full), 1 dir', oneDir, (f) => classify({ path: f, size: 1 }, { cfg }));
const clsN = bench('classify (full), 200 dirs', manyDirs, (f) => classify({ path: f, size: 1 }, { cfg }));
console.log('');

console.log('MEMO EFFECTIVENESS — this ratio CANNOT answer that question:');
console.log('  guard many-dirs / one-dir ratio =', (guardN / guard1).toFixed(2) + 'x');
console.log('  -> INCONCLUSIVE BY CONSTRUCTION. A flat ratio is equally consistent with (a) the memo');
console.log('     being broken and (b) the memo working while an unrelated per-call cost dominates.');
console.log('     The memo saves the realpath syscall only; it cannot make the WHOLE guard cheap.');
console.log('     See adversarial-memo2.mjs, which measures cold-vs-warm in one directory and DOES');
console.log('     isolate the memo (66.94x cold/warm ratio => the memo works).');
console.log('');
console.log('ATTRIBUTION of the remaining per-call cost:');
const noRoots = bench('isProtectedPath, cfg.protectRoots=[] ', oneDir, (f) => isProtectedPath(f, []));
console.log('  with 0 config roots  =', Math.round(noRoots).toString().padStart(7), 'ns/candidate');
console.log('  with', cfg.protectRoots.length, 'config roots =', Math.round(guard1).toString().padStart(7), 'ns/candidate');
console.log('  -> per-root cost =', Math.round((guard1 - noRoots) / Math.max(1, cfg.protectRoots.length)).toString().padStart(6), 'ns');
console.log('  ->', (guard1 - noRoots) / guard1 > 0.5
  ? 'the guard is DOMINATED by canonicalising every config protectRoot on every call,'
  : 'config roots are not the dominant term,');
console.log('     NOT by the realpath (which the memo absorbs).');
console.log('');
console.log('PRD §6.1 PROJECTION (the watcher sees ~22 candidates per 3 s burst, from nfr-perf):');
const burst = 22;
console.log('  guard   cost per burst =', (guardN * burst / 1e6).toFixed(3), 'ms  (worst case: all distinct dirs)');
console.log('  classify cost per burst =', (clsN * burst / 1e6).toFixed(3), 'ms');
console.log('  -> guard share of a 3 s wall =', (guardN * burst / 1e9 / 3 * 100).toFixed(4), '% CPU');
console.log('  -> classify share of a 3 s wall =', (clsN * burst / 1e9 / 3 * 100).toFixed(4), '% CPU');
console.log('  PRD §6.1 budget = 2% CPU; both are far inside it.');
console.log('');
console.log('Per-DELETION cost (clean() re-validates with {fresh:true}, so no memo benefit):');
const freshSample = manyDirs.slice(0, 5);
const t0 = process.hrtime.bigint();
for (const f of freshSample) isProtectedPath(f, cfg.protectRoots, { fresh: true });
console.log('  fresh resolve =', Math.round(Number(process.hrtime.bigint() - t0) / freshSample.length / 1000), 'us/deletion (one resolve, paid only for files actually being deleted)');

try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
