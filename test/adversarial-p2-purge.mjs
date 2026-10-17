// test/adversarial-p2-purge.mjs — verifier (task-8/task-13) adversarial probe for the
// retroactive purge (PRD §7 Phase 2 gap: pre-gate rows still default-checked in the panel).
//
// Claims under attack:
//   * the purge decision EQUALS the live PRD §3.2 gate decision on the same input —
//     no second, divergent implementation;
//   * a credential-shaped (🔴-by-name) row SURVIVES the purge;
//   * 🔴 / 🟡 rows survive REGARDLESS of their name, because they carry information;
//   * the purge never touches a file on disk (bookkeeping only);
//   * the returned count equals the real DB delta, through the production StateDB;
//   * the lead's motivating claim (N of M persisted rows fail the gate) is independently
//     reproducible — measured on a COPY of the live DB, never the live file.
//
// Exit 0 only when every check passes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registerWebApi,
  findStaleRows,
  API_PREFIX,
} from '../lib/web-api.js';
import { compileSignatureGlobs, signatureListFrom, classifyName } from '../lib/watcher.js';
import { resolveConfig } from '../lib/config.js';
import { StateDB } from '../lib/state-db.js';
import { EventEmitter } from 'node:events';

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
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const ROOT = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp', `dshcc_purge_${STAMP}`);
fs.mkdirSync(ROOT, { recursive: true });
const LOG = { debug() {}, info() {}, warn() {}, error() {} };

const cfg = resolveConfig({ dshHome: ROOT, escapeRoot: path.join(ROOT, 'esc') });
const globs = compileSignatureGlobs(signatureListFrom(cfg));

/* --------------------- 1. the purge decision equals the live gate decision ------ */
{
  const names = [
    // pre-gate other-software noise the lead named — MUST be stale
    'Win11SDK_WindowsPerformanceToolkit-x64_en-us.msi',
    'Win11SDK_WindowsPerformanceToolkit-x64_en-us.cab',
    'Microsoft.VisualStudio.Debugger.dll',
    'setup_host_x64.exe',
    'vc_redist.x64.exe',
    // ordinary temp noise a Phase-1 sweep could have caught WITHOUT a signature — MUST be stale
    'random-junk-99123.tmp',
    'leftover-48211.dat',
    // gate-admitted (signature glob) — MUST survive
    'pip-install-1234.log',
    'tmp-abc123.tmp',
    'node-compile-cache-42.tmp',
    'hf-download-77.tmp',
    '*-cache'.replace('*', 'torch'),
    // credential-shaped, admitted only by the §3.3 valve — MUST survive
    'credentials.json',
    'auth-token-cache.tmp',
    'session.db',
    'myapp.sqlite3',
    'something.lock',
  ];
  let mismatches = [];
  for (const name of names) {
    const p = path.join(ROOT, name);
    const row = { file_path: p, category: 'SAFE_TO_DELETE', file_size: 10 };
    const purged = findStaleRows([row], globs, true).stale.length === 1;
    const gateRejects = classifyName(p, globs, true).pass === false;
    if (purged !== gateRejects) mismatches.push(`${name}: purge=${purged ? 'STALE' : 'kept'} gate=${gateRejects ? 'REJECT' : 'admit'}`);
  }
  await check('p2purge.decision-is-byte-identical-to-the-live-gate', () => {
    assert(mismatches.length === 0, `purge and gate disagree on ${mismatches.length}/${names.length}: ${JSON.stringify(mismatches)}`);
    const stale = names.filter((n) => findStaleRows([{ file_path: path.join(ROOT, n), category: 'SAFE_TO_DELETE', file_size: 1 }], globs, true).stale.length === 1);
    return `${names.length} inputs, 0 disagreements. STALE (${stale.length}): ${JSON.stringify(stale)}`;
  });
}

/* --------------------------- 2. the credential valve survives the purge --------- */
{
  const rows = [
    { file_path: path.join(ROOT, 'credentials.json'), category: 'SAFE_TO_DELETE', file_size: 111 },
    { file_path: path.join(ROOT, 'auth-token-cache.tmp'), category: 'SAFE_TO_DELETE', file_size: 222 },
    { file_path: path.join(ROOT, 'Win11SDK_x64_en-us.msi'), category: 'SAFE_TO_DELETE', file_size: 80 * 1024 * 1024 },
  ];
  const found = findStaleRows(rows, globs, true);
  await check('p2purge.credential-shaped-row-survives', () => {
    assert(found.stale.length === 1, `expected exactly 1 stale row, got ${JSON.stringify(found.stale)}`);
    assert(found.stale[0].endsWith('.msi'), `the wrong row was purged: ${found.stale[0]}`);
    assert(!found.stale.some((p) => /credential|auth|token/i.test(p)), `a credential-shaped row was purged: ${JSON.stringify(found.stale)}`);
    return `purged=${JSON.stringify(found.stale.map((p) => path.basename(p)))} kept=${found.kept}/3 bytes=${found.bytes}`;
  });
  const valveOff = findStaleRows(rows, globs, false);
  await check('p2purge.valve-off-matches-the-gate-with-the-valve-off', () => {
    // With `admitCriticalNames:false` the LIVE gate would also reject `credentials.json`,
    // so the purge must agree. Consistency, not a defect — recorded explicitly.
    const gateOpinion = classifyName(rows[0].file_path, globs, false);
    const purgeOpinion = valveOff.stale.includes(rows[0].file_path);
    assert(purgeOpinion === (gateOpinion.pass === false), `purge=${purgeOpinion} gate=${JSON.stringify(gateOpinion)}`);
    return `admitCriticalNames:false -> credentials.json purged=${purgeOpinion}, identical to the gate's own opinion (pass=${gateOpinion.pass})`;
  });
}

/* ------------------------ 3. 🔴 / 🟡 rows survive on category alone ------------- */
{
  const rows = [
    { file_path: path.join(ROOT, 'Win11SDK_x64_en-us.msi'), category: 'LOCKED_CRITICAL', file_size: 5 },
    { file_path: path.join(ROOT, 'Microsoft.VisualStudio.Debugger.dll'), category: 'CAUTION_CACHE', file_size: 6 },
    { file_path: path.join(ROOT, 'garbage-no-extension'), category: 'LOCKED_CRITICAL', file_size: 7 },
    { file_path: path.join(ROOT, 'Win11SDK_y_x64.msi'), category: 'SAFE_TO_DELETE', file_size: 8 },
  ];
  const found = findStaleRows(rows, globs, true);
  await check('p2purge.locked-and-caution-rows-survive-regardless-of-name', () => {
    assert(found.stale.length === 1, `only the SAFE row may be purged, got ${JSON.stringify(found.stale)}`);
    assert(found.stale[0].endsWith('Win11SDK_y_x64.msi'), `wrong row purged: ${found.stale[0]}`);
    return `🔴 x2 and 🟡 x1 survived although their names fail the gate; purged=${JSON.stringify(found.stale.map((p) => path.basename(p)))}`;
  });
}

/* ---------------------------- 4. malformed rows never crash or over-purge ------ */
{
  const junk = [null, undefined, {}, 42, 'string', { file_path: '' }, { file_path: 42 }, { file_path: null, category: 'SAFE_TO_DELETE' }];
  const good = { file_path: path.join(ROOT, 'real-junk-99.dat'), category: 'SAFE_TO_DELETE', file_size: 13 };
  const found = findStaleRows([...junk, good], globs, true);
  await check('p2purge.malformed-rows-are-kept-not-crashed', () => {
    assert(found.scanned === junk.length + 1, `scanned=${found.scanned}`);
    assert(found.stale.length === 1 && found.stale[0] === good.file_path, `stale=${JSON.stringify(found.stale)}`);
    return `8 malformed rows + 1 real: 0 throws, only the real row purged, kept=${found.kept}`;
  });
  await check('p2purge.non-finite-size-contributes-zero-bytes', () => {
    const rows = [
      { file_path: path.join(ROOT, 'a-junk.dat'), category: 'SAFE_TO_DELETE', file_size: 'nope' },
      { file_path: path.join(ROOT, 'b-junk.dat'), category: 'SAFE_TO_DELETE', file_size: NaN },
      { file_path: path.join(ROOT, 'c-junk.dat'), category: 'SAFE_TO_DELETE' },
      { file_path: path.join(ROOT, 'd-junk.dat'), category: 'SAFE_TO_DELETE', file_size: 100 },
    ];
    const f = findStaleRows(rows, globs, true);
    assert(f.stale.length === 4, `all 4 are stale, got ${f.stale.length}`);
    assert(f.bytes === 100, `bytes must ignore non-finite sizes, got ${f.bytes}`);
    return `4 stale rows with junk sizes -> bytes=${f.bytes} (only the finite 100 counted)`;
  });
}

/* --------------- 5. end-to-end through the real route + real StateDB ----------- */
{
  const dbFile = path.join(ROOT, 'state', 'state.db');
  const db = new StateDB(dbFile);
  db.migrate();

  // Real files on disk that MATCH the names the purge would drop or keep.
  const noiseFiles = ['Win11SDK_WindowsPerformanceToolkit-x64_en-us.msi', 'Microsoft.VisualStudio.Debugger.dll', 'random-junk-42.dat'];
  const keepFiles = ['credentials.json', 'pip-install-7.log'];
  for (const n of [...noiseFiles, ...keepFiles]) fs.writeFileSync(path.join(ROOT, n), 'x'.repeat(20));

  const seed = (names) => {
    for (const n of names) {
      const p = path.join(ROOT, n);
      db.upsert({
        path: p,
        size: 20,
        category: 'SAFE_TO_DELETE',
        isLocked: false,
        lockedByPid: null,
        sourceProcess: null,
        mtimeMs: Date.now(),
      });
    }
  };
  seed(noiseFiles);
  seed(keepFiles);
  // And two rows that must survive on category alone.
  db.upsert({ path: path.join(ROOT, 'Win11SDK_WindowsPerformanceToolkit-x64_en-us.cab'), size: 30, category: 'LOCKED_CRITICAL', isLocked: true, lockedByPid: 1234, sourceProcess: 'msiexec.exe', mtimeMs: Date.now() });
  db.upsert({ path: path.join(ROOT, 'Microsoft.VC.Runtime.dll'), size: 40, category: 'CAUTION_CACHE', isLocked: false, lockedByPid: null, sourceProcess: null, mtimeMs: Date.now() });

  const before = db.list({ limit: 1000 });
  const trackedRows = async () => db.list({ limit: 1000 }).map((r) => ({
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
  registerWebApi(ctx, {
    cfg,
    log: LOG,
    db,
    trackedRows,
    forgetRows,
    clean: async () => ({ removed: 0, skipped: 0, bytesFreed: 0, errors: [], skippedList: [] }),
  });
  const handler = calls[0].handler;

  const call = async (opts) => {
    const req = new EventEmitter();
    req.method = opts.method ?? 'GET';
    req.url = opts.url;
    req.headers = { host: '127.0.0.1:3080', ...(opts.headers ?? {}) };
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

  const staleRes = await call({ url: API_PREFIX + '/stale' });
  const purgeRes = await call({ method: 'POST', url: API_PREFIX + '/purge', body: {} });
  const after = db.list({ limit: 1000 });

  await check('p2purge.e2e-stale-count-matches-the-purge-count-and-the-db-delta', () => {
    const stale = staleRes.json?.value;
    const purged = purgeRes.json?.value;
    assert(staleRes.status === 200 && purgeRes.status === 200, `statuses ${staleRes.status}/${purgeRes.status}: ${staleRes.raw} ${purgeRes.raw}`);
    assert(stale.count === 3, `GET /stale should report 3, got ${stale.count} (${staleRes.raw})`);
    assert(purged.forgotten === 3, `POST /purge should forget 3, got ${purged.forgotten} (${purgeRes.raw})`);
    assert(before.length - after.length === 3, `DB delta ${before.length - after.length} != reported ${purged.forgotten}`);
    assert(purged.remaining === after.length, `remaining=${purged.remaining} but db.list() has ${after.length}`);
    assert(purged.bytes === stale.bytes, `GET /stale bytes=${stale.bytes} but purge bytes=${purged.bytes}`);
    return `rows ${before.length} -> ${after.length}; GET /stale count=${stale.count} bytes=${stale.bytes}; POST /purge forgotten=${purged.forgotten} bytes=${purged.bytes} remaining=${purged.remaining}`;
  });

  await check('p2purge.e2e-purge-never-touches-a-file-on-disk', () => {
    const survivors = [...noiseFiles, ...keepFiles].filter((n) => fs.existsSync(path.join(ROOT, n)));
    assert(survivors.length === noiseFiles.length + keepFiles.length, `purge deleted files from disk: missing ${JSON.stringify([...noiseFiles, ...keepFiles].filter((n) => !fs.existsSync(path.join(ROOT, n))))}`);
    return `all ${survivors.length} files still on disk after purging ${noiseFiles.length} rows for them (bookkeeping only)`;
  });

  await check('p2purge.e2e-exactly-the-right-rows-remain', () => {
    const names = after.map((r) => path.basename(r.file_path)).sort();
    const expected = ['Microsoft.VC.Runtime.dll', 'Win11SDK_WindowsPerformanceToolkit-x64_en-us.cab', 'credentials.json', 'pip-install-7.log'].sort();
    assert(JSON.stringify(names) === JSON.stringify(expected), `remaining rows ${JSON.stringify(names)} != ${JSON.stringify(expected)}`);
    const cats = after.map((r) => `${path.basename(r.file_path)}=${r.category}`).join(', ');
    return `remaining: ${cats}`;
  });

  await check('p2purge.e2e-second-purge-is-a-no-op', async () => {
    const again = await call({ method: 'POST', url: API_PREFIX + '/purge', body: {} });
    assert(again.status === 200, `status ${again.status}`);
    const v = again.json.value;
    assert(v.forgotten === 0 && v.bytes === 0, `second purge must be a no-op, got ${again.raw}`);
    assert(db.list({ limit: 1000 }).length === after.length, 'the second purge changed the row count');
    return `second purge -> forgotten=0 bytes=0 note="${v.note}"; row count unchanged at ${after.length}`;
  });

  await check('p2purge.e2e-purge-without-forgetRows-is-503-not-a-crash', async () => {
    const c2 = [];
    const ctx2 = { get: (n) => (n === 'webServer' ? { register: (s) => { c2.push(s); return () => {}; } } : undefined) };
    registerWebApi(ctx2, { cfg, log: LOG, db: null, trackedRows: async () => [], clean: async () => ({}) });
    const res = { status: null, body: '' };
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = API_PREFIX + '/purge';
    req.headers = { host: '127.0.0.1:3080' };
    req.destroy = () => {};
    setImmediate(() => req.emit('end'));
    res.writeHead = (code) => { res.status = code; };
    res.end = (b) => { res.body = b ?? ''; };
    await c2[0].handler(req, res);
    assert(res.status === 503, `expected 503, got ${res.status} ${res.body}`);
    return `no forgetRows -> 503 ${res.body}`;
  });

  await check('p2purge.e2e-purge-is-fenced', async () => {
    const res = await call({ method: 'POST', url: API_PREFIX + '/purge', headers: { origin: 'https://evil.example.com' }, body: {} });
    assert(res.status === 403, `a foreign origin must be refused, got ${res.status}`);
    return `foreign Origin -> 403 ${res.raw}`;
  });

  db.close();
}

/* ------------- 6. independently reproduce the lead's motivating claim ---------- */
{
  const liveDb = 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';
  const copyDir = path.join(ROOT, 'livecopy');
  await check('p2purge.live-db-claim-is-independently-reproducible', () => {
    if (!fs.existsSync(liveDb)) return `SKIPPED: live DB not present at ${liveDb}`;
    fs.mkdirSync(copyDir, { recursive: true });
    const copy = path.join(copyDir, 'state.db');
    // COPY, never open the live file: this probe must not write to the user's table.
    fs.copyFileSync(liveDb, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(liveDb + suffix)) fs.copyFileSync(liveDb + suffix, copy + suffix);
    }
    const db = new StateDB(copy);
    const rows = db.list({ limit: 100000 }).map((r) => ({
      file_path: r.file_path,
      file_size: r.file_size,
      category: r.category,
    }));
    const found = findStaleRows(rows, globs, true);
    db.close();
    const byCat = {};
    for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + 1;
    const sampleNames = found.stale.slice(0, 6).map((p) => path.basename(p));
    const mb = (found.bytes / 1024 / 1024).toFixed(1);
    assert(rows.length > 0, 'the copied live DB listed 0 rows');
    return `rows=${rows.length} byCategory=${JSON.stringify(byCat)} | gate-rejected SAFE rows=${found.stale.length} (${mb} MB) kept=${found.kept} | sample=${JSON.stringify(sampleNames)}`;
  });
}

try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* best effort */
}
console.log(`\nSUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
