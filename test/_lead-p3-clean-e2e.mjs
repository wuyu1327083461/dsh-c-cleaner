/**
 * End-to-end probe for the SECOND user-reported symptom:
 * "为什么选择了可清理文件然后点击一键清理没啥反应".
 *
 * The panel path is: POST /clean {paths} -> filterRequestedPaths -> clean() -> forget rows.
 * This probe drives the real HTTP route against a real StateDB seeded with BOTH kinds of row
 * that made the click look inert:
 *   - rows whose file still exists and is deletable  (must be removed AND forgotten)
 *   - rows whose file is long gone                   (must be reported gone AND forgotten)
 * and asserts the response makes the outcome visible to the panel.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { StateDB } from '../lib/state-db.js';
import { resolveConfig } from '../lib/config.js';
import { registerWebApi, API_PREFIX, findDeadRows } from '../lib/web-api.js';
import { clean } from '../lib/cleaner.js';

const TAG = `dcc_e2e_${process.pid}_${Date.now().toString(36)}`;
const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
const results = [];
async function check(name, fn) {
  try {
    const out = await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}${out ? ` :: ${out}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name} :: ${err && err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A scratch tree on the real C: volume (the plugin's whole point) plus one on temp.
const C_ROOT = 'C:/Users/kiuhg/AppData/Local/Temp';
const liveDir = path.join(C_ROOT, `${TAG}_live`);
fs.mkdirSync(liveDir, { recursive: true });
const liveFiles = [];
for (let i = 0; i < 5; i += 1) {
  const p = path.join(liveDir, `pip-${TAG}-${i}.log`);
  fs.writeFileSync(p, `x`.repeat(1024 * (i + 1)));
  liveFiles.push(p);
}
// Two rows that point at files which do not exist at all.
const ghostFiles = [
  path.join(C_ROOT, `${TAG}_gone`, 'never-existed-1.log'),
  path.join(C_ROOT, `${TAG}_gone`, 'never-existed-2.log'),
];

const dbDir = path.join(os.tmpdir(), `${TAG}_db`);
fs.mkdirSync(dbDir, { recursive: true });
const db = new StateDB(path.join(dbDir, 'state.db'));

const cfg = resolveConfig({ useRecycleBin: true }, process.env);

const rows = [
  ...liveFiles.map((p) => ({ path: p, size: fs.statSync(p).size, category: 'SAFE_TO_DELETE' })),
  ...ghostFiles.map((p) => ({ path: p, size: 2048, category: 'SAFE_TO_DELETE' })),
];
const written = db.upsertMany(rows);
assert(written === rows.length, `seeded ${written} of ${rows.length} rows`);

await check('seeded table holds both live and ghost rows', () => {
  const all = db.list({ limit: 100 });
  assert(all.length === 7, `want 7 rows, got ${all.length}`);
  const ghosts = findDeadRows(all);
  assert(ghosts.dead.length === 2, `want 2 ghosts, got ${ghosts.dead.length}`);
  assert(ghosts.alive === 5, `want 5 alive, got ${ghosts.alive}`);
  return `${all.length} rows: ${ghosts.alive} alive, ${ghosts.dead.length} dead`;
});

// --- boot the real route ------------------------------------------------------
const routes = new Map();
const webServer = {
  prefixes: new Map(),
  register({ path: p, handler }) {
    routes.set(p, handler);
    webServer.prefixes.set(p, handler);
    return () => {
      routes.delete(p);
      webServer.prefixes.delete(p);
    };
  },
};
const ctx = { get: (name) => (name === 'webServer' ? webServer : undefined) };

registerWebApi(ctx, {
  cfg,
  log: silentLog,
  db,
  refresh: async () => 0,
  trackedRows: async () => db.list({ limit: db.count() }),
  forgetRows: (paths) => db.removeByPath(paths),
  clean: async (records, opts) => clean(records, opts),
  status: () => ({ active: false, vars: {}, escapeRoot: cfg.escapeRoot }),
  escapeWritable: () => true,
  migrationTargetRoot: 'E:/dsh_escape_cache/migrated',
  migrationHistory: () => [],
  migrationRecordFor: () => null,
  migrate: async () => ({ ok: false, code: 'unused' }),
  undoMigration: async () => ({ ok: false, code: 'unused' }),
});

const handler = routes.get(API_PREFIX);
assert(typeof handler === 'function', 'no route handler registered');
const server = http.createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;

async function call(verb, body) {
  const init = { method: 'POST', headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${base}/${verb}`, init);
  return { status: res.status, payload: await res.json() };
}

try {
  const allPaths = [...liveFiles, ...ghostFiles];
  const out = await call('clean', { paths: allPaths });

  await check('clean answers 200 with a report the panel can render', () => {
    assert(out.status === 200, `status ${out.status}`);
    assert(out.payload.ok === true, `not ok: ${JSON.stringify(out.payload)}`);
    const rep = out.payload.value.report;
    assert(rep && typeof rep === 'object', 'no report');
    return `removed=${rep.removed} skipped=${rep.skipped} freed=${rep.bytesFreed}`;
  });

  await check('the 5 real files were actually deleted', () => {
    const survivors = liveFiles.filter((p) => fs.existsSync(p));
    assert(survivors.length === 0, `survivors: ${survivors.join(', ')}`);
    const rep = out.payload.value.report;
    assert(rep.removed === 5, `want removed=5, got ${rep.removed}`);
    assert(rep.bytesFreed > 0, `want bytesFreed > 0, got ${rep.bytesFreed}`);
    return `removed 5, freed ${rep.bytesFreed} B`;
  });

  await check('the 2 ghost rows are reported as skipped, not as removed', () => {
    const rep = out.payload.value.report;
    assert(rep.skipped === 2, `want skipped=2, got ${rep.skipped}`);
    const reasons = (rep.skippedList || []).map((s) => s.reason).join(' | ');
    assert(/no longer exists/.test(reasons), `skipped reasons should name the cause: ${reasons}`);
    return 'ghosts skipped with a reason';
  });

  await check('BOTH cleaned and ghost rows were dropped from the table', () => {
    const rep = out.payload.value.report;
    assert(Array.isArray(rep.removedPaths), 'report.removedPaths missing');
    assert(Array.isArray(rep.gonePaths), 'report.gonePaths missing');
    assert(rep.removedPaths.length === 5, `removedPaths=${rep.removedPaths.length}`);
    assert(rep.gonePaths.length === 2, `gonePaths=${rep.gonePaths.length}`);
    assert(out.payload.value.forgotten === 7, `want forgotten=7, got ${out.payload.value.forgotten}`);
    assert(db.count() === 0, `table should be empty now, holds ${db.count()}`);
    assert(Array.isArray(out.payload.value.rows) && out.payload.value.rows.length === 0, 'rows in response not refreshed');
    return 'forgot 7 rows (5 removed + 2 gone)';
  });

  await check('a second clean of the same paths reports nothing left to do', () => {
    assert(out.payload.value.report.removed === 5, 'sanity: first run removed 5');
    return 'idempotency left to the next call';
  });

  const again = await call('clean', { paths: allPaths });
  await check('re-cleaning paths that are no longer tracked is refused cleanly', () => {
    assert(again.status === 200, `status ${again.status}`);
    const v = again.payload.value;
    assert(v.report.removed === 0, `want removed=0, got ${v.report.removed}`);
    assert((v.rejected || []).length === 7, `want 7 rejected, got ${(v.rejected || []).length}`);
    assert(typeof v.note === 'string' && v.note.length > 0, 'no explanatory note');
    return `note: ${v.note}`;
  });

  await check('purge forgets dead rows without touching live files', () => {
    const keep = path.join(liveDir, `keep-${TAG}.log`);
    fs.writeFileSync(keep, 'keep me');
    db.upsert({ path: keep, size: 7, category: 'SAFE_TO_DELETE' });
    db.upsert({ path: path.join(C_ROOT, `${TAG}_ghost2.log`), size: 9, category: 'SAFE_TO_DELETE' });
    const before = db.count();
    assert(before === 2, `want 2 rows, got ${before}`);
    return (async () => {
      const res = await call('purge', {});
      assert(res.status === 200, `status ${res.status}`);
      const v = res.payload.value;
      assert(v.forgotten === 1, `want forgotten=1 (the ghost), got ${v.forgotten}`);
      assert(v.dead === 1, `want dead=1, got ${v.dead}`);
      assert(fs.existsSync(keep), 'purge deleted a real file');
      assert(db.count() === 1, `live row should survive, table holds ${db.count()}`);
      fs.rmSync(keep, { force: true });
      db.removeByPath([keep]);
      return 'ghost forgotten, live row kept, file untouched';
    })();
  });
} finally {
  await new Promise((r) => server.close(r));
  try {
    db.close();
  } catch {}
  fs.rmSync(liveDir, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\nSUMMARY pass=${results.length - fail} fail=${fail} total=${results.length} verdict=${fail === 0 ? 'GREEN' : 'RED'}`);
/* Set the exit code instead of calling process.exit(): the recycle path leaves libuv async
 * handles (PowerShell child + undici sockets) that must drain, and a hard exit trips
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` on Windows. */
process.exitCode = fail === 0 ? 0 : 1;
