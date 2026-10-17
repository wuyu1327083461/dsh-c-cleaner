/**
 * Mutation test for the overflow-recovery probe.
 *
 * A probe that passes is worthless until a mutation proves it can FAIL. This copies the plugin
 * into a throwaway tree, applies ONE mutation to the recovery logic, `node --check`s the mutant
 * (so a broken mutation is never mistaken for a killed probe), re-runs the probe there and
 * requires it to fail.
 *
 * Mutations:
 *   M1  `_onEvent` reverts to DISCARDING the null-filename event (the original defect).
 *   M2  the quiet-deadline is removed, so the walk runs while the burst is still writing.
 *   M3  the cooldown check is neutered, so a null-event storm schedules a scan per event.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
// RELATIVE on purpose, and run with cwd = the mutant tree. The probe resolves its imports against
// its OWN file location (`new URL('../lib/watcher.js', import.meta.url)`), so an absolute path
// pointing back at the original tree would import the UNMUTATED lib and every mutation would
// "survive" -- which is exactly what happened on the first run of this runner.
const PROBE = path.join('test', '_lead-p2-overflow-recovery.mjs');

const SKIP = new Set(['.git', 'node_modules', 'docs', 'cache', 'data']);

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

const MUTATIONS = [
  {
    id: 'M1',
    label: '_onEvent discards the null-filename overflow signal (THE ORIGINAL DEFECT)',
    file: 'lib/watcher.js',
    apply(src) {
      const anchor = '      this._onOverflow(dir);\n      return;';
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, '      this._counters.filtered += 1;\n      return; /* MUTATED */');
    },
  },
  {
    id: 'M2',
    label: 'quiet-deadline removed -- the walk runs while the burst is still writing',
    file: 'lib/watcher.js',
    apply(src) {
      const anchor = '    }, this._rescanSettleMs);';
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, '    }, 0); /* MUTATED */');
    },
  },
  {
    id: 'M3',
    label: 'cooldown check neutered -- a null-event storm schedules a scan per event',
    file: 'lib/watcher.js',
    apply(src) {
      const anchor = '    if (now - last < this._rescanCooldownMs) {';
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, '    if (false) { /* MUTATED */');
    },
  },
];

const results = [];
for (const mut of MUTATIONS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-ovf-mut-${mut.id}-`));
  copyTree(ROOT, dir);
  const target = path.join(dir, mut.file);
  const original = fs.readFileSync(target, 'utf8');
  const mutated = mut.apply(original);
  if (mutated === null) {
    results.push({ id: mut.id, outcome: 'ANCHOR-NOT-FOUND', detail: `anchor missing in ${mut.file}` });
    console.log(`${mut.id}: ANCHOR NOT FOUND in ${mut.file} -- mutation is invalid, fix the anchor`);
    fs.rmSync(dir, { recursive: true, force: true });
    continue;
  }
  fs.writeFileSync(target, mutated);

  // A broken mutation must never be mistaken for a killed probe.
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
  } catch (err) {
    results.push({ id: mut.id, outcome: 'BROKEN-MUTATION', detail: String(err).slice(0, 200) });
    console.log(`${mut.id}: BROKEN MUTATION (mutant fails --check) -- not a killed probe`);
    fs.rmSync(dir, { recursive: true, force: true });
    continue;
  }

  let out = '';
  let exit = 0;
  try {
    out = execFileSync(process.execPath, [PROBE], { cwd: dir, encoding: 'utf8', timeout: 240000 });
  } catch (err) {
    exit = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const verdict = (out.match(/verdict=(\S+)/) ?? [, 'NO-VERDICT'])[1];
  const killed = exit !== 0 && verdict !== 'OVERFLOW-RECOVERY-OK';
  const failLine = (out.split('\n').find((l) => l.startsWith('FAIL')) ?? '').trim();
  results.push({ id: mut.id, outcome: killed ? 'KILLED' : 'SURVIVED', verdict, exit, failLine });
  console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${mut.id} ${mut.label}`);
  console.log(`         verdict=${verdict} exit=${exit}${failLine ? `\n         ${failLine}` : ''}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

const bad = results.filter((r) => r.outcome !== 'KILLED');
console.log(`\n${bad.length === 0 ? 'MUTATION TEST PASSED: every mutation makes the probe fail' : `MUTATION TEST FAILED: ${bad.map((b) => `${b.id}=${b.outcome}`).join(' ')}`}`);
process.exitCode = bad.length === 0 ? 0 : 1;
