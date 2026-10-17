// Lead-owned OFFLINE proof of the valve fix, exercised against the SHIPPED modules.
//
// The live harness keeps its old module generation, so a live probe cannot distinguish
// "the fix is wrong" from "the fix is not loaded". This probe constructs a real CWatcher
// from the code on disk and drives it with real files, so the verdict is bound to the
// shipped source rather than to whatever the running process happens to hold.
//
// It is the regression lock for the leak proved by test/_lead-p2-valve-leak.mjs:
//   * an other-software installer whose name contains "Configuration" must be REJECTED
//   * the credential-shaped names the PRD 3.3 valve exists to protect must be ADMITTED
//
// RUN: node test/_lead-p2-valve-fix.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { CWatcher, classifyName, compileSignatureGlobs } from '../lib/watcher.js';
import { LOCKED_BASENAME_RE, CREDENTIAL_NAME_RE } from '../lib/classifier.js';

const checks = [];
// Await-aware: an async body must be awaited BEFORE the verdict is recorded, otherwise a
// pending promise is reported as PASS (its detail stringifies to "[object Promise]") and
// its later rejection escapes as an unhandled crash.
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? `  -- ${detail}` : ''}`);
  } catch (err) {
    checks.push({ name, ok: false, detail: String(err?.message ?? err) });
    console.log(`FAIL  ${name}  -- ${err?.message ?? err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// The watcher's own env hijack redirects os.tmpdir() under the escape root, which is a
// protectRoot: a probe rooted there would test the protection veto, not the gate.
// Root at the REAL Windows Temp, like production.
const ROOT = path.join('C:\\Users\\kiuhg\\AppData\\Local\\Temp', `dshcc_valvefix_${process.pid}_${Date.now().toString(36)}`);

const cfg = resolveConfig({ escapeRoot: 'E:\\dsh_escape_cache', watchDirs: [{ path: ROOT, recursive: false }] });
const globs = compileSignatureGlobs(cfg);
const sig = (p) => classifyName(p, globs, true);

/* ---------------------------------------------------- 1. predicate-level checks */
check('tight regex drops the installer that leaked live', () => {
  const leak = 'Contoso Configuration Bundle.msi';
  assert(LOCKED_BASENAME_RE.test(leak), 'probe bug: the LOOSE tier pattern should still hit it');
  assert(!CREDENTIAL_NAME_RE.test(leak), 'the GATE pattern must not readmit it');
  return `loose=${LOCKED_BASENAME_RE.test(leak)} tight=${CREDENTIAL_NAME_RE.test(leak)}`;
});

check('every name the PRD 3.3 valve exists to protect is still admitted', () => {
  const must = ['credentials.json', 'credentials-mix-1.json', 'auth.json', 'session.token',
    'config.json', 'acc-product-config-v3.json', 'state.db', 'state-1.db', 'cache.sqlite',
    'session-state.sqlite3', 'keep-me.sqlite3', 'worker.pid.lock', 'x-1.lock',
    'held-exclusively.lock', 'token-47812_x.txt'];
  const lost = must.filter((n) => !CREDENTIAL_NAME_RE.test(n));
  assert(lost.length === 0, `lost: ${JSON.stringify(lost)}`);
  return `${must.length}/${must.length} kept`;
});

check('TIGHT subset of LOOSE (valve never admits a name the tier would not call red)', () => {
  const fuzz = [];
  for (const stem of ['', 'x', 'my', 'pre-', 'a_']) {
    for (const tok of ['auth', 'config', 'token', 'credential', 'credentials', 'Configuration', 'TokenManager']) {
      for (const ext of ['', '.json', '.db', '.log', '.txt', '-v2.json', 's.json']) fuzz.push(stem + tok + ext);
    }
  }
  const viol = fuzz.filter((n) => CREDENTIAL_NAME_RE.test(n) && !LOCKED_BASENAME_RE.test(n));
  assert(viol.length === 0, `violations: ${JSON.stringify(viol)}`);
  return `${fuzz.length} fuzz cases, 0 violations`;
});

/* ------------------------------------------- 2. real CWatcher end-to-end on disk */
async function driveWatcher(names) {
  const dir = path.join(ROOT, `gate_${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  // The watchDir must be the directory that RECEIVES the files. Pointing it at the parent
  // with recursive:false would watch nothing, and the probe would "pass" for the wrong
  // reason (an empty delivery set proves no gate behaviour at all).
  const cfgDir = resolveConfig({ escapeRoot: 'E:\\dsh_escape_cache', watchDirs: [{ path: dir, recursive: false }] });
  const delivered = [];
  const w = new CWatcher({
    cfg: cfgDir,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onCandidate: (c) => { delivered.push(path.basename(c.path)); },
  });
  w.start();
  try {
    for (const n of names) fs.writeFileSync(path.join(dir, n), `x ${Date.now()}\n`);
    await new Promise((r) => setTimeout(r, 4000)); // debounce (3000) + settle
    return { delivered, stats: w.stats() };
  } finally {
    w.stop();
  }
}

await check('CWatcher (shipped code): installer REJECTED, credentials ADMITTED, in one dir+second', async () => {
  const stamp = Date.now().toString(36);
  const names = [
    `Contoso Configuration Bundle ${stamp}.msi`,
    `pip-valvefix-${stamp}.log`,
    `credentials-${stamp}.json`,
  ];
  const { delivered, stats } = await driveWatcher(names);
  const installer = delivered.find((n) => n.endsWith('.msi'));
  const cred = delivered.find((n) => n.startsWith('credentials-'));
  const pip = delivered.find((n) => n.startsWith('pip-'));
  assert(installer === undefined, `installer was ADMITTED (leak): ${JSON.stringify(delivered)}`);
  assert(pip !== undefined, `pip control not delivered: ${JSON.stringify(delivered)}`);
  assert(cred !== undefined, `credential valve file not admitted: ${JSON.stringify(delivered)}`);
  assert(stats.gated === 1, `stats().gated should be exactly 1, got ${stats.gated}`);
  return `delivered=${JSON.stringify(delivered)} gated=${stats.gated} filtered=${stats.filtered}`;
});

await check('valve OFF still rejects the credential name (switch is load-bearing)', async () => {
  const dir = path.join(ROOT, `valveoff_${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  const cfgOff = resolveConfig({ escapeRoot: 'E:\\dsh_escape_cache', admitCriticalNames: false, watchDirs: [{ path: dir, recursive: false }] });
  const delivered = [];
  const w = new CWatcher({
    cfg: cfgOff,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onCandidate: (c) => { delivered.push(path.basename(c.path)); },
  });
  w.start();
  try {
    fs.writeFileSync(path.join(dir, 'credentials-off.json'), 'x\n');
    await new Promise((r) => setTimeout(r, 4000));
    assert(delivered.length === 0, `valve off still delivered ${JSON.stringify(delivered)}`);
    return `delivered=[] gated=${w.stats().gated}`;
  } finally {
    w.stop();
  }
});

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`);
console.log(`verdict=${failed.length === 0 ? 'VALVE-FIXED' : 'VALVE-STILL-BROKEN'}`);
process.exitCode = failed.length === 0 ? 0 : 1;
