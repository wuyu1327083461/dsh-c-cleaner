// Mutation harness for test/_lead-p2-reentry.mjs.
//
// An assertion that survives a mutation tests nothing, so this copies the SHIPPED tree to a
// throwaway directory, removes the re-entrancy guard, and re-runs the probe. The probe MUST
// fail on the mutant; if it still passes, the probe is not actually testing the guard.
//
// RUN:  node test/_lead-p2-reentry-mutation.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reentry-mut-'));
const SRC = path.resolve(import.meta.dirname, '..');

fs.cpSync(path.join(SRC, 'lib'), path.join(ROOT, 'lib'), { recursive: true });
fs.copyFileSync(path.join(SRC, 'index.js'), path.join(ROOT, 'index.js'));
fs.copyFileSync(path.join(SRC, 'package.json'), path.join(ROOT, 'package.json'));
fs.mkdirSync(path.join(ROOT, 'test'), { recursive: true });
fs.copyFileSync(
  path.join(SRC, 'test', '_lead-p2-reentry.mjs'),
  path.join(ROOT, 'test', '_lead-p2-reentry.mjs'),
);

// MUTATION: disable ALL THREE re-entrancy guards. Each guard alone is sufficient to stop a
// predecessor's watcher, so mutating only one leaves the invariant satisfied and the probe
// would "survive" for a reason that does not test anything. Removing all of them is the real
// test: a direct second `apply()` then leaves the first generation's watcher running, and the
// phantom raw handle is never reaped.
const INDEX = path.join(ROOT, 'index.js');
let src = fs.readFileSync(INDEX, 'utf8');
const GUARD_A = 'const previous = globalThis[ACTIVE_GENERATION];';
const GUARD_B = 'const leaked = stopAllWatchers();';
const GUARD_C = 'const closedRaw = closeAllRawWatchers();';
for (const [label, needle] of [['A (disposer slot)', GUARD_A], ['B (live registry)', GUARD_B], ['C (raw handle registry)', GUARD_C]]) {
  if (!src.includes(needle)) {
    console.log(`MUTATION HARNESS BROKEN: could not find guard ${label}: "${needle}"`);
    process.exit(2);
  }
}
src = src.replace(GUARD_A, 'const previous = null; /* MUTATED */');
src = src.replace(GUARD_B, 'const leaked = 0; /* MUTATED */');
src = src.replace(GUARD_C, 'const closedRaw = 0; /* MUTATED */');
fs.writeFileSync(INDEX, src, 'utf8');

const probe = path.join(ROOT, 'test', '_lead-p2-reentry.mjs');
const run = spawnSync(process.execPath, [probe], {
  encoding: 'utf8',
  errors: 'replace',
  cwd: ROOT,
  timeout: 120_000,
});

const out = `${run.stdout || ''}${run.stderr || ''}`;
const tail = out.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
console.log('--- mutant probe output (tail) ---');
console.log(tail);

const survived = out.includes('REENTRY-SAFE');
const killed = out.includes('REENTRY-LEAKS');

console.log('');
console.log(`mutant exit      : ${run.status}`);
console.log(`mutant verdict   : ${survived ? 'REENTRY-SAFE (SURVIVED)' : killed ? 'REENTRY-LEAKS (KILLED)' : 'indeterminate'}`);
console.log(
  survived
    ? 'MUTATION TEST FAILED: the probe still passes without the guard, so it does not test it'
    : 'MUTATION TEST PASSED: removing the guard makes the probe fail',
);

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
process.exitCode = survived ? 1 : 0;
