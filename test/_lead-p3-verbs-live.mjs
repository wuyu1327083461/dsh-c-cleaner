#!/usr/bin/env node
/**
 * test/_lead-p3-verbs-live.mjs — drives the REAL `c-clean` command handler end to end, through
 * the same mock runtime `test/_wire.mjs` uses, and asserts the Phase 3 verbs behave against a
 * live filesystem: `migrate` (list), `migrate <dir>`, `unmigrate <dir>`.
 *
 * Why a separate probe: `test/run.js`'s `commands.register-and-handlers` check exercises
 * status/now only. A verb that parses but whose handler throws would still leave the harness
 * green, so the verbs are driven here through the registered handler rather than the parser.
 *
 * Owner: Lead. Write scope: test/** only.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STAMP = `${process.pid}_${Date.now().toString(36)}`;

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    const d = fn();
    pass += 1;
    console.log(`PASS ${name}${d ? ` :: ${d}` : ''}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL ${name} :: ${e.message}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const assertEq = (a, b, w) => { if (a !== b) throw new Error(`${w}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `dcc_p3verbs_${STAMP}_`));
const cleanup = [];
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}
cleanup.push(() => rmrf(scratch));

const { resolveConfig } = await import(`file://${path.join(ROOT, 'lib/config.js')}`);
const { registerCommands, parseArgs, USAGE } = await import(`file://${path.join(ROOT, 'lib/commands.js')}`);
const { StateDB } = await import(`file://${path.join(ROOT, 'lib/state-db.js')}`);

// A migration target on E: (the only non-C: volume here), so `migrate` has somewhere to go.
const targetRoot = path.join('E:\\dsh_escape_cache', `verbs_${STAMP}`);
cleanup.push(() => rmrf(targetRoot));
const cfg = resolveConfig({ migrateTargetRoot: targetRoot, migrateMinBytes: 1024 }, process.env);

const dbDir = path.join(scratch, 'db');
fs.mkdirSync(dbDir, { recursive: true });
const db = new StateDB(path.join(dbDir, 'state.db'));
cleanup.push(() => { try { db.close(); } catch {} });

// A stubborn directory on C: with enough bytes to clear migrateMinBytes.
const stubborn = path.join(process.env.LOCALAPPDATA, 'Temp', `dcc_verbs_${STAMP}`);
rmrf(stubborn);
fs.mkdirSync(path.join(stubborn, 'nested'), { recursive: true });
fs.writeFileSync(path.join(stubborn, 'a.bin'), Buffer.alloc(4096, 1));
fs.writeFileSync(path.join(stubborn, 'nested', 'b.bin'), Buffer.alloc(4096, 2));
cleanup.push(() => rmrf(stubborn));

// Track the directory's files so `findCandidates` can offer it.
// `upsert()` takes a Classified record (`path`/`size`), not a raw DB row.
const rows = [
  { path: path.join(stubborn, 'a.bin'), size: 4096, category: 'SAFE_TO_DELETE' },
  { path: path.join(stubborn, 'nested', 'b.bin'), size: 4096, category: 'SAFE_TO_DELETE' },
];
const written = db.upsertMany(rows);
if (written !== 2) throw new Error(`fixture setup: upsertMany wrote ${written}/2 rows`);

// ── the mock command runtime `_wire.mjs` uses ────────────────────────────────────────────────
let registered = null;
const ctx = {
  commands: {
    register(def) { registered = def; return () => {}; },
  },
};

const deps = {
  cfg,
  log: silentLog,
  db,
  hijacker: { status: () => ({ active: true, installed: 9, total: 9, escapeRoot: cfg.escapeRoot }) },
  tree: { refresh: async () => {}, start() {}, stop() {} },
  watcher: null,
  refresh: async () => {},
  collect: async () => [],
};

registerCommands(ctx, deps);
assert(registered !== null, 'registerCommands did not register anything');

async function run(input) {
  const res = await registered.handler({ rawInput: input, signal: { aborted: false } });
  return res;
}
function textOf(res) {
  return typeof res === 'string' ? res : String(res?.text ?? res?.content ?? JSON.stringify(res));
}

// ── grammar ──────────────────────────────────────────────────────────────────────────────────
check('grammar: migrate accepts a bare path and a path with spaces', () => {
  assertEq(parseArgs('migrate C:\\a\\b').verb, 'migrate', 'verb');
  assertEq(parseArgs('migrate C:\\a\\b').path, 'C:\\a\\b', 'path');
  const spaced = parseArgs('migrate C:\\Program Files\\Some Dir');
  assertEq(spaced.path, 'C:\\Program Files\\Some Dir', 'a path with spaces is rejoined, not truncated');
  assertEq(parseArgs('migrate').path, '', 'bare migrate is the LIST form');
  assertEq(parseArgs('unmigrate C:\\a').verb, 'unmigrate', 'unmigrate verb');
  assertEq(parseArgs('unmigrate').ok, false, 'bare unmigrate is rejected (it needs a path)');
  assert(/migrate/.test(USAGE) && /unmigrate/.test(USAGE), 'USAGE documents both verbs');
  return 'list form, explicit form, spaced path, bare unmigrate';
});

// ── list ────────────────────────────────────────────────────────────────────────────────────
let listed = null;
try {
  listed = await run('migrate');
} catch (e) {
  fail += 1;
  console.log(`FAIL migrate.list :: handler threw: ${e.message}`);
}
if (listed !== null) {
  check('migrate.list names the tracked candidate', () => {
    const text = textOf(listed);
    assert(listed.kind !== 'error', `list answered error: ${text}`);
    assert(text.includes(stubborn), `the candidate ${stubborn} is not listed:\n${text}`);
    assert(/migrate <|迁移/.test(text), 'the listing explains how to act on a candidate');
    return text.split('\n').find((l) => l.includes(stubborn))?.trim().slice(0, 100) ?? 'listed';
  });
}

// ── migrate <dir> ───────────────────────────────────────────────────────────────────────────
let didMigrate = false;
try {
  const res = await run(`migrate ${stubborn}`);
  check('migrate <dir> performs the migration', () => {
    const text = textOf(res);
    assert(res.kind !== 'error', `migrate answered error: ${text}`);
    assert(fs.lstatSync(stubborn).isSymbolicLink(), `the source is not a junction after migrate:\n${text}`);
    assert(fs.existsSync(path.join(stubborn, 'a.bin')), 'the junction does not resolve to the data');
    const rec = db.getMigrationBySource(path.resolve(stubborn));
    assert(rec !== null, 'no journal row was written');
    assertEq(rec.state, 'LINKED', 'journal state');
    didMigrate = true;
    return text.split('\n')[0].slice(0, 110);
  });
} catch (e) {
  fail += 1;
  console.log(`FAIL migrate <dir> :: handler threw: ${e.message}`);
}

// ── unmigrate <dir> ─────────────────────────────────────────────────────────────────────────
if (didMigrate) {
  try {
    const res = await run(`unmigrate ${stubborn}`);
    check('unmigrate <dir> reverses it', () => {
      const text = textOf(res);
      assert(res.kind !== 'error', `unmigrate answered error: ${text}`);
      assert(!fs.lstatSync(stubborn).isSymbolicLink(), `the source is still a junction:\n${text}`);
      assert(fs.existsSync(path.join(stubborn, 'a.bin')), 'the data did not come back');
      assertEq(db.getMigrationBySource(path.resolve(stubborn)).state, 'RESTORED', 'journal state');
      return text.split('\n')[0].slice(0, 110);
    });
  } catch (e) {
    fail += 1;
    console.log(`FAIL unmigrate <dir> :: handler threw: ${e.message}`);
  }
}

// ── refusals must be ANSWERS, never throws ──────────────────────────────────────────────────
try {
  const res = await run('migrate C:\\Windows');
  check('migrate C:\\Windows is refused as an answer', () => {
    const text = textOf(res);
    assert(/PROTECTED|保护/.test(text), `the refusal does not name the reason:\n${text}`);
    assert(fs.existsSync('C:\\Windows'), 'C:\\Windows survived');
    return text.split('\n')[0].slice(0, 110);
  });
} catch (e) {
  fail += 1;
  console.log(`FAIL migrate C:\\Windows :: handler threw ${e.message}`);
}

try {
  const res = await run(`unmigrate ${path.join(process.env.LOCALAPPDATA, 'Temp', `never_${STAMP}`)}`);
  check('unmigrate of an unknown path is an answer, not a throw', () => {
    const text = textOf(res);
    assert(/NO_RECORD|未|没有|not/.test(text), `unexpected text:\n${text}`);
    return text.split('\n')[0].slice(0, 110);
  });
} catch (e) {
  fail += 1;
  console.log(`FAIL unmigrate unknown :: handler threw ${e.message}`);
}

// ── cleanup + summary ───────────────────────────────────────────────────────────────────────
for (const fn of cleanup.reverse()) fn();
console.log(`\nSUMMARY pass=${pass} fail=${fail} verdict=${fail === 0 ? 'GREEN' : 'RED'}`);
process.exit(fail === 0 ? 0 : 1);
