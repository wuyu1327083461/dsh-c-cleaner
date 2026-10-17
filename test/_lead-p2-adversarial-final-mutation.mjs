// Lead-owned MUTATION test for test/_lead-p2-adversarial-final.mjs.
//
// WHY: a probe that passes is worthless until a mutation makes it FAIL. This copies the plugin
// to a THROWAWAY tree, applies one targeted mutation at a time, and re-runs the probe against the
// mutated copy. A mutation that SURVIVES means the probe's assertion tests nothing.
//
// The mutations target the four code changes this probe was written to attack:
//   M1  the gate valve forced OFF        -> A3 (credential protection) must FAIL
//   M2  the TIGHT regex made LOOSE       -> A2 (other-software rejection) must FAIL
//   M3  closeAllRawWatchers() made a no-op -> B1 must FAIL
//   M4  cleanup() always restores env    -> C1 must FAIL
//
// RUN: node test/_lead-p2-adversarial-final.mjs-mutation.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SRC = path.resolve(import.meta.dirname, '..');
const PROBE = path.join(SRC, 'test', '_lead-p2-adversarial-final.mjs');

const MUTATIONS = [
  {
    id: 'M1',
    what: 'gate valve forced OFF (admitCritical=false at every valve site)',
    file: 'lib/watcher.js',
    from: 'CREDENTIAL_NAME_RE.test(',
    to: 'false && CREDENTIAL_NAME_RE.test(',
    all: true,
    expectFail: 'A3',
  },
  {
    id: 'M2',
    what: 'TIGHT gate regex widened to a bare substring (the measured leak shape)',
    file: 'lib/classifier.js',
    from: '  /\\.lock$|\\.sqlite3?$|\\.db$|(?:^|[^a-z0-9])(?:auth|config|credentials?|token)(?=[^a-z0-9]|$)/i;',
    to: '  /config/i;',
    expectFail: 'A2',
  },
  {
    id: 'M3',
    what: 'closeAllRawWatchers() neutered to a no-op',
    file: 'lib/watcher.js',
    from: 'export function closeAllRawWatchers() {',
    to: 'export function closeAllRawWatchers() { return 0;',
    expectFail: 'B1',
  },
  {
    id: 'M4',
    what: 'cleanup() restores env unconditionally (drops the ownership check)',
    file: 'index.js',
    from: 'const stillActive = globalThis[ACTIVE_GENERATION]?.dispose === cleanup;',
    to: 'const stillActive = true; /* MUTATED */',
    expectFail: 'C1',
  },
];

const results = [];
for (const m of MUTATIONS) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), `cc-mut-${m.id}-`));
  try {
    // Copy the plugin + the probe, preserving relative layout so the probe's ../ imports work.
    for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'docs') continue;
      fs.cpSync(path.join(SRC, entry.name), path.join(tree, entry.name), { recursive: true });
    }
    const target = path.join(tree, m.file);
    const before = fs.readFileSync(target, 'utf8');
    if (!before.includes(m.from)) {
      results.push({ id: m.id, what: m.what, verdict: 'SETUP-FAILED', detail: `anchor not found in ${m.file}` });
      continue;
    }
    fs.writeFileSync(target, m.all ? before.replaceAll(m.from, m.to) : before.replace(m.from, m.to));
    // Syntax-check the mutant so a broken mutation is not mistaken for a killed probe.
    try {
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    } catch (err) {
      results.push({ id: m.id, what: m.what, verdict: 'SETUP-FAILED', detail: `mutant does not parse: ${String(err.stderr ?? err).slice(0, 200)}` });
      continue;
    }
    let out = '';
    let failed = false;
    try {
      out = execFileSync(process.execPath, [path.join(tree, 'test', '_lead-p2-adversarial-final.mjs')], {
        stdio: 'pipe', encoding: 'utf8', timeout: 120000,
      });
    } catch (err) {
      failed = true;
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    const sawExpected = out.includes(`FAIL  ${m.expectFail}`);
    const verdict = failed && sawExpected ? 'KILLED' : failed ? 'KILLED-ELSEWHERE' : 'SURVIVED';
    results.push({
      id: m.id, what: m.what, verdict,
      detail: (out.match(/verdict=\S+/) ?? ['(no verdict)'])[0],
    });
  } finally {
    try { fs.rmSync(tree, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log('MUTATION RESULTS');
for (const r of results) {
  const mark = r.verdict === 'KILLED' ? 'OK  ' : r.verdict === 'SURVIVED' ? 'BAD ' : '??  ';
  console.log(`${mark}${r.id}  ${r.verdict.padEnd(16)} ${r.what}`);
  if (r.detail) console.log(`      ${r.detail}`);
}
const survived = results.filter((r) => r.verdict !== 'KILLED');
const ok = survived.length === 0;
console.log(`\n${ok ? 'MUTATION TEST PASSED: every mutation made the probe fail' : `MUTATION TEST FAILED: ${survived.map((r) => r.id).join(', ')} survived`}`);
process.exitCode = ok ? 0 : 1;
