// test/adversarial-p2-purge-rule1.mjs — verifier (task-13), round 2.
//
// The Lead's stated invariant for the purge is: "the purge only ever forgets rows the
// gate itself would reject today." This probe tests the one direction where that can be
// FALSE: PRD §3.2 rule #1 (handle-attributed dsh-tree member). A rule-#1-admitted file
// whose NAME matches no signature glob and is not credential-shaped is ADMITTED by the
// live gate today, but findStaleRows() asks classifyName(), which (correctly, per its own
// docstring) cannot evaluate rule #1 — so the purge forgets exactly those rows.
//
// Harm direction: no data loss (the purge touches no file). It removes legitimate cleanup
// candidates from the panel, which is the operator's only way to select and delete them.
//
// Exit 0 only when every check passes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CWatcher, signatureListFrom, compileSignatureGlobs, classifyName } from '../lib/watcher.js';
import { findStaleRows } from '../lib/web-api.js';
import { resolveConfig } from '../lib/config.js';
import { classify } from '../lib/classifier.js';
import { StateDB } from '../lib/state-db.js';

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`PASS ${name}${detail ? ` | ${detail}` : ''}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL ${name}: ${err && err.message ? err.message : String(err)}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STAMP = `${process.pid}_${Date.now().toString(36)}`;

// MUST be the REAL temp dir: after the env hijack, os.tmpdir() is the E: escape cache,
// which is a protectRoot (classify() would never call anything in there SAFE_TO_DELETE).
const REAL_TEMP = path.join(process.env.LOCALAPPDATA || os.homedir(), 'AppData', 'Local', 'Temp');
const ROOT = path.join(REAL_TEMP, `dshcc_rule1_${STAMP}`);
fs.mkdirSync(ROOT, { recursive: true });

const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const cfg = resolveConfig({ dshHome: path.join(ROOT, 'dsh'), escapeRoot: path.join(ROOT, 'esc'), debounceMs: 200, pollIntervalMs: 250 });
const globs = compileSignatureGlobs(signatureListFrom(cfg));

// Names that match NO signature glob and are not credential-shaped — the documented
// recall gap. Asserted below so this probe cannot silently go vacuous.
const VICTIMS = [`model-${STAMP}.safetensors`, `datasets-${STAMP}.json`, `session-${STAMP}.dsh`];

await check('p2rule1.precondition-fixtures-really-match-no-signature', async () => {
  const cfg2 = resolveConfig({ dshHome: path.join(ROOT, 'dsh'), escapeRoot: path.join(ROOT, 'esc'), aiSignatureGlobs: signatureListFrom(cfg), admitCriticalNames: true });
  const g = compileSignatureGlobs(signatureListFrom(cfg2));
  const observed = VICTIMS.map((n) => {
    const p = path.join(ROOT, n);
    const r = classifyName(p, g, true);
    return { n, signatureMatch: r.signatureMatch, criticalName: r.criticalName, pass: r.pass };
  });
  const bad = observed.filter((o) => o.pass !== false);
  assert(bad.length === 0, `fixture drift: ${JSON.stringify(bad)} now passes classifyName()`);
  return `all 3 victims fail classifyName() (signatureMatch=false, criticalName=false), so rule #1 is their ONLY admission route`;
});

// A stub tree that PROVES rule #1: a live handle attributed to a dsh-tree member. This is
// the module's own documented condition for rule #1 (`hasHandleBackend !== false`).
const tree = {
  hasHandleBackend: true,
  nameOf: () => 'dsh-child',
  isTreeMember: () => true,
  ownerOf: async () => ({ pid: process.pid, name: 'dsh-child' }),
};
const delivered = [];
const watcher = new CWatcher({
  cfg: { ...cfg, noiseGate: 'enforce', watchDirs: [{ path: ROOT, recursive: false, maxDepth: 1 }], aiSignatureGlobs: signatureListFrom(cfg) },
  tree,
  log: LOG,
  onCandidate: (c) => delivered.push(c),
});
watcher.start();
await sleep(1200); // arm the fs.watch handle BEFORE creating the victims

for (const n of VICTIMS) fs.writeFileSync(path.join(ROOT, n), `payload:${n}:` + 'z'.repeat(2048));
const deadline = Date.now() + 8000;
while (delivered.length < VICTIMS.length && Date.now() < deadline) await sleep(150);
watcher.stop();

await check('p2rule1.gate-admits-rule1-only-files-so-they-get-recorded', () => {
  const names = delivered.map((c) => path.basename(c.path)).sort();
  const stats = watcher.stats();
  assert(delivered.length === VICTIMS.length, `gate delivered ${JSON.stringify(names)}, expected all 3 (stats=${JSON.stringify({ scanned: stats.scanned, candidates: stats.candidates, gated: stats.gated, filtered: stats.filtered })})`);
  assert(stats.gated === 0, `expected 0 gated, got ${stats.gated}`);
  return `gate ADMITTED all ${VICTIMS.length} rule-#1-only files (gated=0) -> index.js would persist them as tracked rows`;
});

// Now persist them exactly as index.js does, and ask the purge.
const dbFile = path.join(ROOT, 'state', 'state.db');
const db = new StateDB(dbFile);
db.migrate();
for (const c of delivered) {
  const verdict = classify(c.path, { cfg });
  db.upsert({
    path: c.path,
    size: c.size,
    category: verdict.category,
    isLocked: verdict.category === 'LOCKED_CRITICAL',
    lockedByPid: verdict.locked?.pid ?? null,
    sourceProcess: c.sourceProcess ?? null,
    mtimeMs: c.mtimeMs,
  });
}
const rows = db.list({ limit: 100 });

await check('p2rule1.recorded-rows-are-safe-to-delete', () => {
  const cats = [...new Set(rows.map((r) => r.category))];
  assert(rows.length === VICTIMS.length, `expected ${VICTIMS.length} rows, got ${rows.length}`);
  assert(cats.length === 1 && cats[0] === 'SAFE_TO_DELETE', `categories ${JSON.stringify(cats)}`);
  return `${rows.length} rows persisted, all SAFE_TO_DELETE`;
});

await check('p2rule1.purge-forgets-rule1-admitted-rows', () => {
  const found = findStaleRows(rows.map((r) => ({ file_path: r.file_path, category: r.category, file_size: r.file_size })), globs, true);
  // THE FINDING: these rows were admitted by the live gate seconds ago, yet the purge
  // classifies all three as stale.
  assert(found.stale.length === VICTIMS.length, `purge considered ${found.stale.length} of ${VICTIMS.length} stale: ${JSON.stringify(found)}`);
  const forgotten = db.removeByPath(found.stale);
  const after = db.list({ limit: 100 });
  assert(forgotten === VICTIMS.length, `forgot ${forgotten}`);
  assert(after.length === 0, `${after.length} rows remain`);
  return `FINDING: all ${VICTIMS.length} rows that the live gate admitted via rule #1 are FORGOTTEN by POST /purge (forgotten=${forgotten}, remaining=0) — the "only forgets rows the gate would reject today" invariant does not hold for rule-#1-only rows`;
});

await check('p2rule1.finding-is-scoped-to-rule1-files-not-to-every-row', () => {
  // Control: the same probe shape with a signature-matching name must SURVIVE the purge,
  // so the finding above is specific to rule-#1-only admission, not a blanket purge bug.
  const ctrl = path.join(ROOT, `pip-install-${STAMP}.log`);
  fs.writeFileSync(ctrl, 'x'.repeat(512));
  const cRows = [{ file_path: ctrl, category: 'SAFE_TO_DELETE', file_size: 512 }];
  const cFound = findStaleRows(cRows, globs, true);
  assert(cFound.stale.length === 0, `control row was deemed stale: ${JSON.stringify(cFound)}`);
  // And a rule-#1 file with a credential-shaped name is protected by the §3.3 valve too.
  const valved = path.join(ROOT, `credentials-${STAMP}.json`);
  const vFound = findStaleRows([{ file_path: valved, category: 'SAFE_TO_DELETE', file_size: 1 }], globs, true);
  assert(vFound.stale.length === 0, `valve row was deemed stale: ${JSON.stringify(vFound)}`);
  return `signature-matching (pip-*.log) and valve-shaped (credentials-*.json) rows both survive -> the finding is specific to rule-#1-only rows`;
});

db.close();
try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* best effort */
}
console.log(`\nSUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
