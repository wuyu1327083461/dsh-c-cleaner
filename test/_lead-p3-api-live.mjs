#!/usr/bin/env node
/**
 * test/_lead-p3-api-live.mjs — drives the REAL Phase 3 HTTP routes (`/migrate`, `/unmigrate`)
 * through `registerWebApi` on a live Node http server, the way the panel calls them.
 *
 * What this pins that `test/run.js` does not:
 *   1. `POST /migrate` refuses a path the server does NOT currently offer (`NOT_A_CANDIDATE`),
 *      even when that path is a perfectly good directory — the fence, not a formality.
 *   2. It refuses `C:\Windows` with the same answer, proving a forged request cannot aim the
 *      operation at a blacklisted path.
 *   3. A genuine candidate migrates, the junction appears, and `rows`/`migrations` come back.
 *   4. `POST /unmigrate` refuses a path with no LINKED journal row (`NO_RECORD`).
 *   5. `GET /migrate` is 405, and the foreign-Origin fence still answers 403.
 *
 * Owner: Lead. Write scope: test/** only.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `dcc_p3api_${STAMP}_`));
const cleanup = [];
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
cleanup.push(() => rmrf(scratch));

const { resolveConfig } = await import(`file://${path.join(ROOT, 'lib/config.js')}`);
const { StateDB } = await import(`file://${path.join(ROOT, 'lib/state-db.js')}`);
const webApi = await import(`file://${path.join(ROOT, 'lib/web-api.js')}`);
const migrateMod = await import(`file://${path.join(ROOT, 'lib/symlink-migrate.js')}`);

const targetRoot = path.join('E:\\dsh_escape_cache', `apiprobe_${STAMP}`);
cleanup.push(() => rmrf(targetRoot));
const cfg = resolveConfig({ migrateTargetRoot: targetRoot, migrateMinBytes: 1024 }, process.env);

const db = new StateDB(path.join(scratch, 'state.db'));
cleanup.push(() => { try { db.close(); } catch {} });

const stubborn = path.join(process.env.LOCALAPPDATA, 'Temp', `dcc_api_${STAMP}`);
rmrf(stubborn);
fs.mkdirSync(path.join(stubborn, 'nested'), { recursive: true });
fs.writeFileSync(path.join(stubborn, 'a.bin'), Buffer.alloc(4096, 1));
fs.writeFileSync(path.join(stubborn, 'nested', 'b.bin'), Buffer.alloc(4096, 2));
cleanup.push(() => rmrf(stubborn));
db.upsertMany([
  { path: path.join(stubborn, 'a.bin'), size: 4096, category: 'SAFE_TO_DELETE' },
  { path: path.join(stubborn, 'nested', 'b.bin'), size: 4096, category: 'SAFE_TO_DELETE' },
]);

// ── a live server standing in for the harness webServer service ──────────────────────────────
const routes = new Map();
const webServer = {
  prefixes: new Map(),
  register({ kind, path: p, handler }) {
    assertEq(kind, 'prefix', 'register kind');
    routes.set(p, handler);
    webServer.prefixes.set(p, handler);
    return () => { routes.delete(p); webServer.prefixes.delete(p); };
  },
};

const deps = {
  cfg,
  log: silentLog,
  db,
  refresh: async () => {},
  trackedRows: async () => db.list({ limit: db.count() }),
  forgetRows: (paths) => db.removeByPath(paths),
  clean: async () => ({ removed: 0, skipped: 0, bytesFreed: 0, errors: [], skippedList: [] }),
  status: () => ({ active: false, installed: 0, total: 9 }),
  escapeWritable: () => true,
  migrationTargetRoot: migrateMod.targetRootOf(cfg),
  migrationHistory: () => db.listMigrations(50),
  migrationRecordFor: (p) => db.getMigrationBySource(p),
  migrate: async (dirPath, opts) => migrateMod.migrateDirectory(dirPath, opts),
  undoMigration: async (p, opts) => migrateMod.undoMigration(p, opts),
};

webApi.registerWebApi({ get: () => webServer }, deps);

const handler = routes.get(webApi.API_PREFIX);
assert(typeof handler === 'function', 'registerWebApi did not register a prefix handler');

const server = http.createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
cleanup.push(() => { try { server.close(); } catch {} });
const base = `http://127.0.0.1:${server.address().port}${webApi.API_PREFIX}`;

async function call(verb, body = null, { method = 'POST', headers = {} } = {}) {
  const url = `${base}/${verb}`;
  const init = {
    method: body === null ? 'GET' : method,
    headers: { 'content-type': 'application/json', ...headers },
  };
  if (body !== null) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

// ── 1. the fence ────────────────────────────────────────────────────────────────────────────
{
  const r = await call('migrate', { path: stubborn }, { headers: { origin: 'https://evil.example' } });
  check('foreign origin is refused with 403', () => {
    assertEq(r.status, 403, 'status');
    assertEq(r.json?.ok, false, 'ok flag');
    return `403 ${r.json?.error?.code}`;
  });
}

{
  const r = await fetch(`${base}/migrate`, { method: 'GET', headers: { 'content-type': 'application/json' } });
  check('GET /migrate is 405', () => {
    assertEq(r.status, 405, 'status');
    return 'POST only';
  });
}

// ── 2. the fence on the PAYLOAD: a real directory that is not currently offered ─────────────
{
  const outsider = path.join(process.env.LOCALAPPDATA, 'Temp', `dcc_api_outsider_${STAMP}`);
  fs.mkdirSync(outsider, { recursive: true });
  fs.writeFileSync(path.join(outsider, 'x.bin'), Buffer.alloc(4096, 3));
  cleanup.push(() => rmrf(outsider));

  const r = await call('migrate', { path: outsider });
  check('a directory with no tracked rows cannot be migrated through the API', () => {
    assertEq(r.status, 200, 'status (a refusal is an answer, not an HTTP error)');
    const v = r.json?.value?.result;
    assertEq(v?.ok, false, 'result.ok');
    assertEq(v?.code, 'NOT_A_CANDIDATE', 'refusal code');
    assert(!fs.lstatSync(outsider).isSymbolicLink(), 'the outsider directory was NOT touched');
    return `${v.code}`;
  });
}

// ── 3. the same fence vs the blacklist ──────────────────────────────────────────────────────
{
  const r = await call('migrate', { path: 'C:\\Windows' });
  check('C:\\Windows cannot be migrated through the API', () => {
    assertEq(r.status, 200, 'status');
    const v = r.json?.value?.result;
    assertEq(v?.ok, false, 'result.ok');
    assertEq(v?.code, 'NOT_A_CANDIDATE', 'refusal code');
    assert(fs.existsSync('C:\\Windows'), 'C:\\Windows survived');
    return v.code;
  });
}

// ── 4. the genuine migration ────────────────────────────────────────────────────────────────
{
  const r = await call('migrate', { path: stubborn });
  check('an offered candidate migrates and returns the new state', () => {
    assertEq(r.status, 200, 'status');
    const v = r.json?.value;
    assertEq(v?.migrated, true, 'migrated flag');
    assertEq(v?.result?.ok, true, `result.ok (${v?.result?.code}: ${v?.result?.reason})`);
    assert(fs.lstatSync(stubborn).isSymbolicLink(), 'the source is now a junction');
    assert(fs.existsSync(path.join(stubborn, 'a.bin')), 'the data is reachable through the junction');
    assert(Array.isArray(v.rows), 'rows were returned so the panel can re-render');
    // `migrations` is the VIEW the panel renders: {targetRoot, candidates, interrupted, history}.
    assert(v.migrations && typeof v.migrations === 'object', 'the migration view was returned');
    assertEq(v.migrations.targetRoot, migrateMod.targetRootOf(cfg), 'view targetRoot');
    const hist = v.migrations.history ?? [];
    assertEq(hist.length, 1, 'the migration history has one row');
    assertEq(hist[0].state, 'LINKED', 'history state');
    assertEq((v.migrations.candidates ?? []).length, 0, 'a migrated directory is no longer a candidate');
    return `${v.result.method} ${v.result.files} files -> ${v.result.target}`;
  });
}

// ── 5. undo ─────────────────────────────────────────────────────────────────────────────────
{
  const r = await call('unmigrate', { path: stubborn });
  check('unmigrate reverses a LINKED migration', () => {
    assertEq(r.status, 200, 'status');
    const v = r.json?.value;
    assertEq(v?.restored, true, 'restored flag');
    assertEq(v?.result?.ok, true, `result.ok (${v?.result?.code})`);
    assert(!fs.lstatSync(stubborn).isSymbolicLink(), 'the source is a real directory again');
    assert(fs.existsSync(path.join(stubborn, 'a.bin')), 'the data came back');
    assertEq(v.migrations?.history?.[0]?.state, 'RESTORED', 'history state');
    return `restored, ${v.migrations?.history?.[0]?.state}`;
  });
}

{
  const r = await call('unmigrate', { path: path.join(process.env.LOCALAPPDATA, 'Temp', `nope_${STAMP}`) });
  check('unmigrate refuses a path the plugin never migrated', () => {
    assertEq(r.status, 200, 'status');
    const v = r.json?.value?.result;
    assertEq(v?.ok, false, 'result.ok');
    // The ROUTE refuses before the module is reached, and says so with its own code.
    assertEq(v?.code, 'NO_MIGRATION', 'refusal code');
    return v.code;
  });
}

{
  const r = await call('migrate', {});
  check('migrate without a path is a 400', () => {
    assertEq(r.status, 400, 'status');
    return r.json?.error?.code ?? 'bad-request';
  });
}

for (const fn of cleanup.reverse()) fn();
console.log(`\nSUMMARY pass=${pass} fail=${fail} verdict=${fail === 0 ? 'GREEN' : 'RED'}`);
process.exit(fail === 0 ? 0 : 1);
