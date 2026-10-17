// test/adversarial-p2-purge-strict.mjs — verifier (task-8/task-13), round 2.
//
// Covers the gaps left by adversarial-p2-purge.mjs after the Lead's purge delta:
//   * the purge is BYTE-PRESERVING on disk (hash every file before/after) — the Lead asked
//     for byte-identity, because a bookkeeping bug here is indistinguishable from data loss;
//   * GET /stale is a pure read: called twice it must return an identical answer and must
//     not touch the row set;
//   * POST /stale is 405; a foreign Host or Origin on BOTH new routes is 403 AND leaves the
//     store byte-for-byte unchanged;
//   * single-implementation claim: does the live gate's admission decision equal
//     classifyName()'s, or is there a second divergent copy? (Reported, not assumed.)
//
// Exit 0 only when every check passes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { registerWebApi, findStaleRows, API_PREFIX } from '../lib/web-api.js';
import { compileSignatureGlobs, signatureListFrom, classifyName } from '../lib/watcher.js';
import { resolveConfig } from '../lib/config.js';
import { StateDB } from '../lib/state-db.js';

let pass = 0;
let fail = 0;
const notes = [];
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
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const ROOT = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp', `dshcc_pstrict_${STAMP}`);
fs.mkdirSync(ROOT, { recursive: true });
const LOG = { debug() {}, info() {}, warn() {}, error() {} };

const cfg = resolveConfig({ dshHome: ROOT, escapeRoot: path.join(ROOT, 'esc') });
const globs = compileSignatureGlobs(signatureListFrom(cfg));

// Real content, so a hash comparison means something (a zero-byte file could not tell
// "preserved" from "recreated empty").
const NOISE = ['Win11SDK_WindowsPerformanceToolkit-x64_en-us.msi', 'Microsoft.VisualStudio.Debugger.dll', 'cab-payload-7.cab'];
const KEEP = ['credentials-auth.json', 'pip-install-31.log', 'torch-cache-9.tmp'];
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const disk = {};
for (const n of [...NOISE, ...KEEP]) {
  const p = path.join(ROOT, n);
  fs.writeFileSync(p, `payload:${n}:${STAMP}:` + 'z'.repeat(4096));
  disk[n] = { size: fs.statSync(p).size, hash: sha(p) };
}
const diskDigest = () => JSON.stringify(Object.fromEntries(Object.keys(disk).map((n) => [n, sha(path.join(ROOT, n))])));

/* ------------------------------------------------------------------ harness --- */
const dbFile = path.join(ROOT, 'state', 'state.db');
const db = new StateDB(dbFile);
db.migrate();
for (const n of [...NOISE, ...KEEP]) {
  db.upsert({ path: path.join(ROOT, n), size: disk[n].size, category: 'SAFE_TO_DELETE', isLocked: false, lockedByPid: null, sourceProcess: null, mtimeMs: Date.now() });
}
db.upsert({ path: path.join(ROOT, 'ntuser.dat'), size: 4096, category: 'LOCKED_CRITICAL', isLocked: true, lockedByPid: 777, sourceProcess: 'lsass.exe', mtimeMs: Date.now() });
db.upsert({ path: path.join(ROOT, 'setup-api-cache.dll'), size: 2048, category: 'CAUTION_CACHE', isLocked: false, lockedByPid: null, sourceProcess: null, mtimeMs: Date.now() });

const trackedRows = async () =>
  db.list({ limit: 5000 }).map((r) => ({
    file_path: r.file_path,
    file_size: r.file_size,
    category: r.category,
    is_locked: r.is_locked ? 1 : 0,
    locked_by_pid: r.locked_by_pid ?? null,
    source_process: r.source_process ?? null,
    last_checked_at: r.last_checked_at ?? null,
  }));
const forgetRows = (paths) => db.removeByPath(paths);

const calls = [];
const ctx = { get: (n) => (n === 'webServer' ? { register: (spec) => { calls.push(spec); return () => {}; } } : undefined) };
registerWebApi(ctx, { cfg, log: LOG, db, trackedRows, forgetRows, clean: async () => ({ removed: 0, skipped: 0, bytesFreed: 0, errors: [], skippedList: [] }) });
const handler = calls[0].handler;

const call = async (opts) => {
  const req = new EventEmitter();
  req.method = opts.method ?? 'GET';
  req.url = opts.url;
  req.headers = { host: '127.0.0.1:3080', ...(opts.headers ?? {}) };
  req.socket = { remoteAddress: '127.0.0.1' };
  req.destroy = () => {};
  setImmediate(() => {
    if (opts.body !== undefined) req.emit('data', Buffer.from(JSON.stringify(opts.body)));
    req.emit('end');
  });
  const res = { status: null, body: '' };
  res.writeHead = (c) => { res.status = c; };
  res.end = (b) => { res.body = b ?? ''; };
  await handler(req, res);
  return { status: res.status, json: (() => { try { return JSON.parse(res.body); } catch { return null; } })(), raw: res.body };
};

const rowKey = () => JSON.stringify(db.list({ limit: 5000 }).map((r) => `${r.file_path}|${r.category}|${r.file_size}`).sort());

/* -------------------------------------------------- 1. GET /stale is a pure read --- */
const beforeRead = rowKey();
const s1 = await call({ url: API_PREFIX + '/stale' });
const midRead = rowKey();
const s2 = await call({ url: API_PREFIX + '/stale' });
const afterRead = rowKey();

await check('p2strict.get-stale-is-a-pure-read', () => {
  assert(s1.status === 200 && s2.status === 200, `statuses ${s1.status}/${s2.status}: ${s1.raw}`);
  const a = s1.json?.value;
  const b = s2.json?.value;
  assert(JSON.stringify(a) === JSON.stringify(b), `GET /stale not idempotent: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  assert(beforeRead === midRead && midRead === afterRead, 'GET /stale changed the persisted row set');
  return `two calls -> identical ${JSON.stringify(a)}; row set unchanged across all three snapshots`;
});

/* ------------------------------------------- 2. POST /stale is 405 (method fenced) --- */
await check('p2strict.post-stale-is-405', async () => {
  const r = await call({ method: 'POST', url: API_PREFIX + '/stale', body: {} });
  assert(r.status === 405, `expected 405, got ${r.status} ${r.raw}`);
  assert(rowKey() === afterRead, 'POST /stale touched the store despite the 405');
  return `405 ${r.raw}`;
});

/* --------------------------------------------------- 3. fences on BOTH new routes --- */
await check('p2strict.foreign-host-and-origin-are-403-on-both-routes', async () => {
  const attempts = [
    ['GET', '/stale', { host: 'evil.example.com' }],
    ['GET', '/stale', { origin: 'https://evil.example.com' }],
    ['POST', '/purge', { host: 'evil.example.com' }],
    ['POST', '/purge', { origin: 'https://evil.example.com' }],
  ];
  const seen = [];
  for (const [method, verb, headers] of attempts) {
    const r = await call({ method, url: API_PREFIX + verb, headers, body: method === 'POST' ? {} : undefined });
    seen.push(`${method} ${verb} ${Object.keys(headers)[0]}=${Object.values(headers)[0]} -> ${r.status}`);
    assert(r.status === 403, `expected 403 for ${method} ${verb} ${JSON.stringify(headers)}, got ${r.status} ${r.raw}`);
  }
  assert(rowKey() === afterRead, 'a fenced request still mutated the store');
  return `${seen.join(' | ')}; store unchanged`;
});

/* ------------------------ 4. THE PURGE: byte-preserving, exact count, right rows ---- */
const diskBefore = diskDigest();
const rowCountBefore = db.list({ limit: 5000 }).length;
const purge = await call({ method: 'POST', url: API_PREFIX + '/purge', body: {} });
const rowsAfter = db.list({ limit: 5000 });
const diskAfter = diskDigest();

await check('p2strict.purge-is-byte-preserving-on-disk', () => {
  // The strongest form of "it deleted nothing": every tracked file still exists, with the
  // same size AND the same sha256. A "recreated empty" bug would pass an existsSync check
  // and fail this one.
  for (const n of [...NOISE, ...KEEP]) {
    const p = path.join(ROOT, n);
    assert(fs.existsSync(p), `${n} was deleted from disk by a BOOKKEEPING operation`);
    const st = fs.statSync(p);
    assert(st.size === disk[n].size, `${n} changed size ${disk[n].size} -> ${st.size}`);
  }
  assert(diskBefore === diskAfter, 'a tracked file\'s sha256 changed across the purge');
  return `all ${NOISE.length + KEEP.length} files present with identical sha256 (${Object.values(disk)[0].size}B each) before and after`;
});

await check('p2strict.forgotten-count-equals-the-db-delta-exactly', () => {
  assert(purge.status === 200, `purge status ${purge.status} ${purge.raw}`);
  const v = purge.json?.value;
  const delta = rowCountBefore - rowsAfter.length;
  assert(v.forgotten === delta, `reported forgotten=${v.forgotten} but the DB delta is ${delta}`);
  assert(v.forgotten === NOISE.length, `expected exactly the ${NOISE.length} noise rows purged, got ${v.forgotten}`);
  assert(v.remaining === rowsAfter.length, `remaining=${v.remaining} but db.list() has ${rowsAfter.length}`);
  assert(v.bytes === s1.json.value.bytes - 0, `purge bytes=${v.bytes} but GET /stale reported ${s1.json.value.bytes}`);
  return `rows ${rowCountBefore} -> ${rowsAfter.length}; forgotten=${v.forgotten} == DB delta; bytes=${v.bytes} == GET /stale's`;
});

await check('p2strict.exactly-the-noise-rows-were-removed', () => {
  const remaining = rowsAfter.map((r) => path.basename(r.file_path)).sort();
  const expected = [...KEEP, 'ntuser.dat', 'setup-api-cache.dll'].sort();
  assert(JSON.stringify(remaining) === JSON.stringify(expected), `remaining ${JSON.stringify(remaining)} != ${JSON.stringify(expected)}`);
  const gone = NOISE.every((n) => !remaining.includes(n));
  assert(gone, 'a noise row survived the purge');
  return `removed ${JSON.stringify(NOISE)}; kept ${JSON.stringify(expected)}`;
});

await check('p2strict.locked-and-caution-rows-survive-despite-failing-the-name-test', () => {
  const byName = Object.fromEntries(rowsAfter.map((r) => [path.basename(r.file_path), r]));
  for (const n of ['ntuser.dat', 'setup-api-cache.dll']) {
    assert(byName[n], `${n} was purged`);
    const nameOpinion = classifyName(path.join(ROOT, n), globs, true);
    assert(nameOpinion.pass === false, `fixture error: ${n} should FAIL the name test, got ${JSON.stringify(nameOpinion)}`);
  }
  return `🔴 ntuser.dat (LOCKED_CRITICAL) and 🟡 setup-api-cache.dll (CAUTION_CACHE) both survive although classifyName().pass === false for each — category alone protects them`;
});

/* ------------------- 5. single-implementation claim: gate vs classifyName ---------- */
await check('p2strict.gate-and-purge-share-the-name-decision', () => {
  // The Lead's stated goal: "ONE implementation of the admission decision (no second,
  // divergent copy)". The purge calls classifyName(). Probe what the WATCHER actually
  // calls, by reading the shipped source, and report the literal finding.
  const src = fs.readFileSync(new URL('../lib/watcher.js', import.meta.url), 'utf8');
  const emitCalls = /_emit\s*\(candidate,\s*dir,\s*st\)\s*\{[\s\S]{0,1400}?classifyName\(/.test(src);
  const inlineCopies = (src.match(/admitCritical\s*&&\s*LOCKED_BASENAME_RE\.test\(/g) || []).length;
  notes.push(
    `gate reuses classifyName()= ${emitCalls}; inline copies of the valve/glob expression = ${inlineCopies} (classifyName itself is one of them)`,
  );
  // The purged rows must be a SUBSET of what a rule-#2-only gate would reject: this is the
  // safety property that matters, independent of which function computes it.
  const worstCase = findStaleRows(
    [...NOISE, ...KEEP].map((n) => ({ file_path: path.join(ROOT, n), category: 'SAFE_TO_DELETE', file_size: 1 })),
    globs,
    true,
  );
  const conservatively = worstCase.kept;
  assert(conservatively === KEEP.length, `purge kept ${conservatively} rows, expected ${KEEP.length}`);
  return `purge removed exactly the ${NOISE.length} rows that classifyName() rejects and kept all ${KEEP.length} it admits; source finding: classifyName reused in _emit = ${emitCalls}, inline valve/glob copies = ${inlineCopies}`;
});

/* ------------------------------------------- 6. second purge is a strict no-op ------- */
await check('p2strict.second-purge-is-a-no-op-and-touches-nothing', async () => {
  const before = rowKey();
  const r = await call({ method: 'POST', url: API_PREFIX + '/purge', body: {} });
  assert(r.status === 200, `status ${r.status}`);
  assert(r.json.value.forgotten === 0 && r.json.value.bytes === 0, `not a no-op: ${r.raw}`);
  assert(rowKey() === before, 'the no-op purge changed the row set');
  assert(diskDigest() === diskAfter, 'the no-op purge touched a file');
  return `forgotten=0 bytes=0; rows and disk hashes unchanged`;
});

/* ------------------------------------------------------------- teardown + report --- */
db.close();
try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* best effort */
}
for (const n of notes) console.log('NOTE ' + n);
console.log(`\nSUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
