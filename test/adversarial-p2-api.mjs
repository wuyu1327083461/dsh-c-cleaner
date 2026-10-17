// test/adversarial-p2-api.mjs — verifier (task-8/task-13) adversarial probe for
// lib/web-api.js: the fence and the tier-forgery surface.
//
// Claims under attack:
//   * a foreign Origin is refused (403) and a refused /clean deletes NOTHING;
//   * a foreign Host is refused;
//   * a client-supplied category/size in POST /clean CANNOT promote a persisted row;
//   * an unknown path is dropped, not cleaned;
//   * a throwing deps.clean() degrades to JSON, never a hang or an unhandled rejection.
//
// Exit 0 only when every check passes.
import { EventEmitter } from 'node:events';
import { registerWebApi, isTrustedApiRequest, filterRequestedPaths, API_PREFIX } from '../lib/web-api.js';

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

/** A minimal IncomingMessage double; a JSON body is delivered as one data chunk. */
function mkReq({ method = 'GET', url = API_PREFIX + '/state', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:3080', ...headers };
  req.destroy = () => {};
  setImmediate(() => {
    if (body !== null) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

/** A ServerResponse double that captures status + parsed JSON. */
function mkRes() {
  const res = { status: null, headers: null, body: '', done: false };
  res.writeHead = (code, h) => {
    res.status = code;
    res.headers = h;
  };
  res.end = (b) => {
    res.body = b ?? '';
    res.done = true;
  };
  res.json = () => {
    try {
      return JSON.parse(res.body);
    } catch {
      return null;
    }
  };
  return res;
}

/** Register the API with a fake webServer, returning {handler, dispose, calls}. */
function mount(deps) {
  const calls = [];
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (spec) => { calls.push(spec); return () => { spec.disposed = true; }; } } : undefined),
  };
  const dispose = registerWebApi(ctx, deps);
  const spec = calls[0];
  return { handler: spec.handler, spec, dispose, calls };
}

const LOG = { debug() {}, info() {}, warn() {}, error() {} };

/** One request through the mounted handler. */
async function call(handler, opts) {
  const res = mkRes();
  await handler(mkReq(opts), res);
  return res;
}

const SAFE_ROW = {
  file_path: 'C:\\Users\\kiuhg\\AppData\\Local\\Temp\\forged-safe.tmp',
  file_size: 11,
  category: 'SAFE_TO_DELETE',
  is_locked: 0,
  locked_by_pid: null,
  source_process: null,
  last_checked_at: 1700000000000,
};
const LOCKED_ROW = {
  file_path: 'C:\\Users\\kiuhg\\AppData\\Local\\Temp\\forged-locked.settings',
  file_size: 22,
  category: 'LOCKED_CRITICAL',
  is_locked: 1,
  locked_by_pid: 4321,
  source_process: 'node.exe',
  last_checked_at: 1700000000001,
};

/* --------------------------------------------------------------- 1. the fence */
await check('p2api.fence-refuses-foreign-origin', () => {
  const foreign = isTrustedApiRequest({ headers: { host: '127.0.0.1:3080', origin: 'https://evil.example.com' } }, []);
  const crossSite = isTrustedApiRequest({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }, []);
  const foreignHost = isTrustedApiRequest({ headers: { host: 'evil.example.com' } }, []);
  const noHost = isTrustedApiRequest({ headers: {} }, []);
  const loopback = isTrustedApiRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }, []);
  const localhost = isTrustedApiRequest({ headers: { host: 'localhost:3080' } }, []);
  const shell = isTrustedApiRequest({ headers: { host: '127.0.0.1:3080', origin: 'dsh-app://app' } }, []);
  assert(foreign === false, 'a foreign Origin must be refused');
  assert(crossSite === false, 'Sec-Fetch-Site: cross-site must be refused');
  assert(foreignHost === false, 'Host: evil.example.com must be refused');
  assert(noHost === false, 'a missing Host must be refused');
  assert(loopback === true, 'loopback same-origin must be allowed');
  assert(localhost === true, 'localhost must be allowed');
  assert(shell === true, 'the Electron shell origin must be allowed');
  return `foreignOrigin=${foreign} crossSite=${crossSite} foreignHost=${foreignHost} noHost=${noHost} loopback=${loopback} localhost=${localhost} shell=${shell}`;
});

/* --------------------------------------- 2. refused /clean must delete nothing */
{
  const deleted = [];
  const { handler } = mount({
    cfg: { escapeRoot: 'E:\\dsh_escape_cache', useRecycleBin: true },
    log: LOG,
    db: null,
    trackedRows: async () => [SAFE_ROW, LOCKED_ROW],
    clean: async (records) => {
      for (const r of records) deleted.push(r.path);
      return { removed: records.length, skipped: 0, bytesFreed: 0, errors: [], skippedList: [] };
    },
  });
  const foreignOrigin = await call(handler, {
    method: 'POST',
    url: API_PREFIX + '/clean',
    headers: { origin: 'https://evil.example.com' },
    body: { paths: [SAFE_ROW.file_path] },
  });
  const foreignHost = await call(handler, {
    method: 'POST',
    url: API_PREFIX + '/clean',
    headers: { host: 'evil.example.com' },
    body: { paths: [SAFE_ROW.file_path] },
  });
  const crossSite = await call(handler, {
    method: 'POST',
    url: API_PREFIX + '/clean',
    headers: { 'sec-fetch-site': 'cross-site' },
    body: { paths: [SAFE_ROW.file_path] },
  });
  await check('p2api.refused-clean-is-403-and-deletes-nothing', () => {
    assert(foreignOrigin.status === 403, `foreign Origin: expected 403, got ${foreignOrigin.status}`);
    assert(foreignHost.status === 403, `foreign Host: expected 403, got ${foreignHost.status}`);
    assert(crossSite.status === 403, `cross-site: expected 403, got ${crossSite.status}`);
    assert(deleted.length === 0, `a REFUSED clean still reached the cleaner: ${JSON.stringify(deleted)}`);
    const body = foreignOrigin.json();
    assert(body && body.ok === false && body.error && body.error.code === 'forbidden', `unexpected 403 body: ${foreignOrigin.body}`);
    return `403 x3 (foreign origin / foreign host / cross-site), cleaner invocations = ${deleted.length}, body=${foreignOrigin.body}`;
  });
}

/* ------------------------------------------------ 3. tier forgery (the big one) */
{
  const seen = [];
  const { handler } = mount({
    cfg: { escapeRoot: 'E:\\dsh_escape_cache', useRecycleBin: true },
    log: LOG,
    db: null,
    trackedRows: async () => [SAFE_ROW, LOCKED_ROW],
    clean: async (records, opts) => {
      seen.push({ records: records.map((r) => ({ path: r.path, category: r.category, isLocked: r.isLocked, size: r.size })), opts: { deep: opts.deep, force: opts.force } });
      return { removed: 0, skipped: records.length, bytesFreed: 0, errors: [], skippedList: [] };
    },
  });
  // The attacker claims the SAFE row is LOCKED (to hide it) and the LOCKED row is SAFE
  // (to delete it), and inflates the byte count.
  const res = await call(handler, {
    method: 'POST',
    url: API_PREFIX + '/clean',
    body: {
      paths: [SAFE_ROW.file_path, LOCKED_ROW.file_path],
      deep: true,
      force: true,
      category: 'SAFE_TO_DELETE',
      size: 999999999,
      records: [
        { path: LOCKED_ROW.file_path, category: 'SAFE_TO_DELETE', isLocked: false, size: 999999999 },
        { path: SAFE_ROW.file_path, category: 'LOCKED_CRITICAL', isLocked: true, size: 1 },
      ],
    },
  });
  await check('p2api.tier-forgery-cannot-promote-a-persisted-row', () => {
    assert(res.status === 200, `expected 200, got ${res.status} body=${res.body}`);
    assert(seen.length === 1, `clean() should have been called exactly once, got ${seen.length}`);
    const [a, b] = seen[0].records;
    assert(a.path === SAFE_ROW.file_path, `record order/paths wrong: ${JSON.stringify(seen[0].records)}`);
    assert(a.category === 'SAFE_TO_DELETE', `SAFE row was promoted to ${a.category} by the body`);
    assert(a.isLocked === false, `SAFE row isLocked became ${a.isLocked}`);
    assert(a.size === SAFE_ROW.file_size, `SAFE row size became ${a.size}, expected ${SAFE_ROW.file_size} (body claimed 999999999)`);
    assert(b.path === LOCKED_ROW.file_path, `LOCKED row path wrong: ${JSON.stringify(b)}`);
    assert(b.category === 'LOCKED_CRITICAL', `LOCKED row was DEMOTED to ${b.category} by the body — a client could then delete it`);
    assert(b.isLocked === true, `LOCKED row isLocked became ${b.isLocked}`);
    assert(b.size === LOCKED_ROW.file_size, `LOCKED row size became ${b.size}`);
    assert(seen[0].opts.deep === true && seen[0].opts.force === true, `deep/force must be honoured as booleans: ${JSON.stringify(seen[0].opts)}`);
    return `clean() saw the PERSISTED tiers: [${a.category} size=${a.size} locked=${a.isLocked}] [${b.category} size=${b.size} locked=${b.isLocked}] despite a body claiming the opposite + size 999999999`;
  });
  await check('p2api.unknown-paths-are-dropped-not-cleaned', () => {
    const { accepted, rejected } = filterRequestedPaths(
      [SAFE_ROW.file_path, 'C:\\Windows\\System32\\kernel32.dll', '../../etc/passwd'],
      [SAFE_ROW, LOCKED_ROW],
    );
    assert(accepted.length === 1 && accepted[0] === SAFE_ROW.file_path, `accepted=${JSON.stringify(accepted)}`);
    assert(rejected.length === 2, `rejected=${JSON.stringify(rejected)}`);
    return `accepted=${JSON.stringify(accepted)} rejected=${JSON.stringify(rejected)}`;
  });
  await check('p2api.empty-or-junk-path-list-is-a-no-op-200', async () => {
    const before = seen.length;
    const r1 = await call(handler, { method: 'POST', url: API_PREFIX + '/clean', body: { paths: [] } });
    const r2 = await call(handler, { method: 'POST', url: API_PREFIX + '/clean', body: { paths: 'not-an-array' } });
    const r3 = await call(handler, { method: 'POST', url: API_PREFIX + '/clean', body: { paths: [null, 42, '   '] } });
    assert(r1.status === 200 && r2.status === 200 && r3.status === 200, `statuses ${r1.status}/${r2.status}/${r3.status}`);
    assert(seen.length === before, `the cleaner ran for a junk path list (${seen.length - before} extra call(s))`);
    const n = r1.json();
    assert(n && n.ok === true && n.value.report.removed === 0, `unexpected body: ${r1.body}`);
    return `empty/string/junk path lists -> 200 with note="${n.value.note}", cleaner invocations = 0`;
  });
}

/* ------------------------------------------- 4. craft + degradation, never a hang */
{
  const { handler, spec, dispose } = mount({
    cfg: { escapeRoot: 'E:\\dsh_escape_cache', useRecycleBin: true },
    log: LOG,
    db: null,
    trackedRows: async () => [SAFE_ROW],
    clean: async () => {
      throw new Error('deliberate cleaner explosion');
    },
  });
  const routes = [];
  routes.push(['GET state', await call(handler, { url: API_PREFIX + '/state' })]);
  routes.push(['POST state (wrong method)', await call(handler, { method: 'POST', url: API_PREFIX + '/state' })]);
  routes.push(['GET refresh (wrong method)', await call(handler, { url: API_PREFIX + '/refresh' })]);
  routes.push(['GET clean (wrong method)', await call(handler, { url: API_PREFIX + '/clean' })]);
  routes.push(['unknown route', await call(handler, { url: API_PREFIX + '/nope' })]);
  routes.push(['invalid json body', await call(handler, { method: 'POST', url: API_PREFIX + '/clean', body: '{not json' })]);
  routes.push(['json array body', await call(handler, { method: 'POST', url: API_PREFIX + '/clean', body: '[1,2,3]' })]);
  routes.push(['throwing clean()', await call(handler, { method: 'POST', url: API_PREFIX + '/clean', body: { paths: [SAFE_ROW.file_path] } })]);
  routes.push(['oversized body', await call(handler, { method: 'POST', url: API_PREFIX + '/clean', body: { paths: [SAFE_ROW.file_path], pad: 'x'.repeat(70 * 1024) } })]);
  await check('p2api.every-route-answers-json-and-never-hangs', () => {
    const bad = routes.filter(([, r]) => r.done !== true || r.status === null);
    assert(bad.length === 0, `routes that did not answer: ${JSON.stringify(bad.map(([n]) => n))}`);
    const statuses = routes.map(([n, r]) => `${n}=${r.status}`).join(' ');
    const wrong = routes.filter(([, r]) => !Number.isInteger(r.status) || r.status < 200 || r.status >= 600);
    assert(wrong.length === 0, `bad status codes: ${JSON.stringify(wrong.map(([n, r]) => [n, r.status]))}`);
    return statuses;
  });
  await check('p2api.registration-is-one-prefix-and-disposable', () => {
    assert(spec.kind === 'prefix', `kind=${spec.kind}`);
    assert(spec.path === API_PREFIX, `path=${spec.path}`);
    assert(typeof spec.handler === 'function', 'handler must be a function');
    dispose();
    assert(spec.disposed === true, 'the disposer returned by registerWebApi must dispose the registration');
    return `register({kind:${spec.kind},path:${spec.path}}) + disposer invoked once`;
  });
  await check('p2api.degrades-when-there-is-no-webServer', () => {
    const log = { warns: [], warn: (m) => log.warns.push(m), debug() {}, info() {}, error() {} };
    const d = registerWebApi({ get: () => undefined }, { cfg: {}, log, db: null });
    assert(typeof d === 'function', 'must still return a disposer');
    d();
    assert(log.warns.length === 1, `expected one warning, got ${JSON.stringify(log.warns)}`);
    return `no webServer -> warn="${log.warns[0]}" + a no-op disposer`;
  });
}

console.log(`\nSUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
