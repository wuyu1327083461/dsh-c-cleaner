/**
 * Lead acceptance probe for the Phase 2 stale-row purge.
 *
 * The concern this guards: rows recorded BEFORE the PRD 3.2 noise gate existed are still
 * in the table, and the panel default-checks every green row — so the pre-gate noise
 * (Windows SDK installers, Visual Studio DLLs) is what one click of
 * 「一键清理已选」 would delete. The purge must remove exactly those rows from the VIEW
 * while never touching a file on disk and never hiding a red/green decision the user needs.
 *
 * Runs against the REAL modules (no copies), plus the LIVE API when the harness answers.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerWebApi, findStaleRows, API_PREFIX } from '../lib/web-api.js';
import { compileSignatureGlobs, signatureListFrom, classifyName } from '../lib/watcher.js';
import { resolveConfig } from '../lib/config.js';

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`CHECK PASS ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`CHECK FAIL ${name} :: ${err?.message}`);
  }
};

const cfg = resolveConfig({});
const globs = compileSignatureGlobs(signatureListFrom(cfg));
const T = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';

console.log(`globs compiled: ${globs.length}`);
check('signatureListFrom resolves the configured list', () => {
  assert.ok(globs.length >= 10, `expected the default signature list, got ${globs.length}`);
});

// --- the decision, row by row ----------------------------------------------------
check('a pre-gate foreign-software row is STALE', () => {
  const rows = [{ file_path: `${T}\\ngymxng3\\Win11SDK_WindowsPerformanceToolkit.msi`, category: 'SAFE_TO_DELETE', file_size: 84025344 }];
  const found = findStaleRows(rows, globs, true);
  assert.equal(found.stale.length, 1, 'the .msi must be stale');
  assert.equal(found.bytes, 84025344, 'the byte total must be the summed file_size');
  console.log(`   stale .msi -> bytes=${found.bytes}`);
});

check('a Visual Studio DLL row is STALE', () => {
  const rows = [{ file_path: `${T}\\vs\\Microsoft.VisualStudio.Setup.Common.resources.dll`, category: 'SAFE_TO_DELETE', file_size: 100 }];
  assert.equal(findStaleRows(rows, globs, true).stale.length, 1);
});

check('an AI-signature row is KEPT', () => {
  const rows = [{ file_path: `${T}\\pip-build-cache-0001.log`, category: 'SAFE_TO_DELETE', file_size: 10 }];
  assert.equal(findStaleRows(rows, globs, true).stale.length, 0);
});

check('a LOCKED_CRITICAL row is KEPT even without a signature', () => {
  // Belt and braces: the category veto runs before the name test, so a red row that
  // somehow lacks a signature still survives and keeps showing its holder.
  const rows = [{ file_path: `${T}\\mystery.bin`, category: 'LOCKED_CRITICAL', file_size: 10 }];
  const found = findStaleRows(rows, globs, true);
  assert.equal(found.stale.length, 0, 'a red row must never be purged');
  assert.equal(found.kept, 1);
});

check('a CAUTION_CACHE row is KEPT even without a signature', () => {
  const rows = [{ file_path: `${T}\\mystery.bin`, category: 'CAUTION_CACHE', file_size: 10 }];
  assert.equal(findStaleRows(rows, globs, true).stale.length, 0, 'a yellow row must never be purged');
});

check('a credential-named row is KEPT by the 3.3 valve', () => {
  const rows = [{ file_path: `${T}\\credentials.json`, category: 'SAFE_TO_DELETE', file_size: 10 }];
  assert.equal(findStaleRows(rows, globs, true).stale.length, 0, 'the valve must protect credentials.json');
  // ...and the SAME row becomes stale when the valve is deliberately disabled, which
  // proves the previous check was actually testing the valve rather than passing by luck.
  assert.equal(findStaleRows(rows, globs, false).stale.length, 1, 'valve off -> the row is stale');
});

check('classifyName agrees with findStaleRows', () => {
  const { pass: p1 } = classifyName(`${T}\\pip-x.log`, globs, true);
  const { pass: p2 } = classifyName(`${T}\\Win11SDK_x.msi`, globs, true);
  assert.equal(p1, true);
  assert.equal(p2, false);
});

check('a malformed row cannot crash the purge', () => {
  // Every malformed shape is KEPT (never purged) — dropped rows are irreversible, so an
  // unreadable row must fail toward keeping it. Only the well-formed, non-matching,
  // green row is stale.
  const rows = [
    null,
    {},
    { file_path: '' },
    { file_path: 42 },
    { file_path: null, category: 'SAFE_TO_DELETE' },
    { file_path: `${T}\\thing.dat` }, // no category -> kept by the category veto
    { file_path: `${T}\\thing.dat`, category: 'SAFE_TO_DELETE', file_size: 7 }, // stale
  ];
  const found = findStaleRows(rows, globs, true);
  assert.equal(found.scanned, 7);
  assert.equal(found.stale.length, 1, `only the well-formed green non-matching row is stale, got ${found.stale.length}`);
  assert.equal(found.kept, 6);
  assert.equal(found.bytes, 7);
});

check('a non-array rows payload degrades to empty', () => {
  assert.equal(findStaleRows(null, globs, true).stale.length, 0);
  assert.equal(findStaleRows('nope', globs, true).scanned, 0);
});

// --- the route -------------------------------------------------------------------
const makeRes = () => {
  const res = { code: 0, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  // `writeJson` uses writeHead(code, headers) + end(body); capture both, and assert on
  // the code the handler actually chose rather than on a default we invented.
  res.writeHead = (code, headers) => { res.code = code; Object.assign(res.headers, headers || {}); };
  res.end = (text) => { res.body = text === undefined ? null : JSON.parse(text); };
  return res;
};
const makeReq = (method, url, headers = {}) => ({
  method,
  url,
  headers: { host: '127.0.0.1:3080', ...headers },
  on() {},
  async *[Symbol.asyncIterator]() {},
});

const store = {
  rows: [
    { file_path: `${T}\\Win11SDK_WindowsPerformanceToolkit.msi`, category: 'SAFE_TO_DELETE', file_size: 84025344 },
    { file_path: `${T}\\pip-build-cache-0001.log`, category: 'SAFE_TO_DELETE', file_size: 10 },
    { file_path: `${T}\\credentials.json`, category: 'LOCKED_CRITICAL', file_size: 50 },
  ],
  forgotten: [],
};

let route = null;
const ctx = { get: (name) => (name === 'webServer' ? { register: (r) => { route = r; return () => { route = null; }; } } : undefined) };
const log = { info() {}, warn() {}, debug() {} };
const dispose = registerWebApi(ctx, {
  cfg,
  log,
  db: null,
  trackedRows: async () => store.rows,
  forgetRows: (paths) => {
    store.forgotten.push(...paths);
    store.rows = store.rows.filter((r) => !paths.includes(r.file_path));
    return paths.length;
  },
  clean: async () => ({ removed: 0, skipped: 0, bytesFreed: 0, errors: [], skippedList: [] }),
  status: () => ({ installed: true, entries: [] }),
  escapeWritable: () => true,
});

check('registerWebApi registered the prefix route', () => {
  assert.ok(route, 'no route captured');
  assert.equal(route.path, API_PREFIX);
  assert.equal(route.kind, 'prefix');
});

// GET /stale reports the count without mutating anything.
{
  const res = makeRes();
  await route.handler(makeReq('GET', `${API_PREFIX}/stale`), res);
  check('GET /stale counts the stale rows without mutating', () => {
    assert.equal(res.code, 200);
    assert.equal(res.body.value.count, 1, `expected 1 stale row, got ${res.body.value.count}`);
    assert.equal(res.body.value.bytes, 84025344);
    assert.equal(store.forgotten.length, 0, 'a GET must never forget anything');
  });
}

check('POST /stale is refused (405)', async () => {});
{
  const res = makeRes();
  await route.handler(makeReq('POST', `${API_PREFIX}/stale`, { 'content-type': 'application/json' }), res);
  check('POST /stale is 405, not a silent success', () => {
    assert.equal(res.code, 405);
  });
}

// The load-bearing one: the purge removes the .msi row and keeps the other two.
{
  const res = makeRes();
  await route.handler(makeReq('POST', `${API_PREFIX}/purge`, { 'content-type': 'application/json' }), res);
  check('POST /purge forgets exactly the stale row', () => {
    assert.equal(res.code, 200);
    assert.equal(res.body.value.forgotten, 1, `expected 1 forgotten, got ${res.body.value.forgotten}`);
    assert.deepEqual(store.forgotten, [`${T}\\Win11SDK_WindowsPerformanceToolkit.msi`]);
  });
  check('the pip row and the credential row survive the purge', () => {
    const surviving = store.rows.map((r) => path.basename(r.file_path)).sort();
    assert.deepEqual(surviving, ['credentials.json', 'pip-build-cache-0001.log']);
  });
  check('the purge response carries the post-purge rows', () => {
    assert.equal(res.body.value.rows.length, 2);
  });
}

// Re-running is idempotent.
{
  const res = makeRes();
  await route.handler(makeReq('POST', `${API_PREFIX}/purge`, { 'content-type': 'application/json' }), res);
  check('a second purge is a no-op', () => {
    assert.equal(res.body.value.forgotten, 0);
    assert.equal(store.forgotten.length, 1, 'nothing new may be forgotten');
  });
}

// A refused origin must not be able to purge.
{
  const before = store.rows.length;
  const res = makeRes();
  await route.handler(makeReq('POST', `${API_PREFIX}/purge`, { host: 'evil.example.com', 'content-type': 'application/json' }), res);
  check('the fence refuses a foreign Host on /purge with 403', () => {
    assert.equal(res.code, 403);
    assert.equal(store.rows.length, before, 'a refused purge must change nothing');
  });
}

check('dispose removed the route', () => {
  dispose();
  assert.equal(route, null);
});

console.log(`SUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
