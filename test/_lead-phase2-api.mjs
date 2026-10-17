/**
 * Lead acceptance probe for Phase 2 (PRD 4 `ui`).
 *
 * Covers the pieces that are pure logic and therefore provable offline:
 *   1. the security fence on `lib/web-api.js` (this route DELETES files)
 *   2. `filterRequestedPaths` (the panel may only name paths the plugin tracks)
 *   3. every route through a mock (req, res) pair
 *   4. the new `ui` verb in `lib/commands.js`, including that it does NOT clean
 *
 * The fence cases are the load-bearing ones: a regression there means any web
 * page on the machine can delete files through 127.0.0.1:3080.
 */
import assert from 'node:assert/strict';
import { API_PREFIX, isTrustedApiRequest, filterRequestedPaths, registerWebApi } from '../lib/web-api.js';
import { parseArgs, registerCommands, USAGE } from '../lib/commands.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    fail += 1;
    failures.push(`${name}: ${err?.message}`);
    console.log(`  FAIL  ${name}\n        ${err?.message}`);
  }
}

console.log('=== 1. fence: what may reach the routes ===');

const req = (headers) => ({ headers, method: 'GET', url: `${API_PREFIX}/state` });

check('loopback Host, no Origin -> allowed', () => {
  assert.equal(isTrustedApiRequest(req({ host: '127.0.0.1:3080' })), true);
});
check('localhost Host -> allowed', () => {
  assert.equal(isTrustedApiRequest(req({ host: 'localhost:3080' })), true);
});
check('IPv6 ::1 -> allowed', () => {
  assert.equal(isTrustedApiRequest(req({ host: '[::1]:3080' })), true);
});
check('RFC1918 Host -> REFUSED', () => {
  assert.equal(isTrustedApiRequest(req({ host: '192.168.1.50:3080' })), false);
});
check('public Host -> REFUSED', () => {
  assert.equal(isTrustedApiRequest(req({ host: 'evil.example.com' })), false);
});
check('missing Host -> REFUSED', () => {
  assert.equal(isTrustedApiRequest(req({})), false);
});
check('unparsable Host -> REFUSED', () => {
  assert.equal(isTrustedApiRequest(req({ host: '::::' })), false);
});
check('127.0.0.1 with an out-of-range octet -> REFUSED', () => {
  assert.equal(isTrustedApiRequest(req({ host: '127.0.0.1.999' })), false);
});
check('cross-site Sec-Fetch-Site -> REFUSED even on loopback', () => {
  assert.equal(isTrustedApiRequest(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })), false);
});
check('same-site Sec-Fetch-Site -> allowed', () => {
  assert.equal(isTrustedApiRequest(req({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' })), true);
});
check('foreign Origin -> REFUSED', () => {
  assert.equal(
    isTrustedApiRequest(req({ host: '127.0.0.1:3080', origin: 'https://evil.example.com' })),
    false,
  );
});
check('same-host Origin -> allowed', () => {
  assert.equal(isTrustedApiRequest(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })), true);
});
check('Electron shell Origin dsh-app://app -> allowed', () => {
  assert.equal(isTrustedApiRequest(req({ host: '127.0.0.1:3080', origin: 'dsh-app://app' })), true);
});
check('foreign Origin on a loopback Host is still refused (origin beats loopback)', () => {
  assert.equal(
    isTrustedApiRequest(req({ host: 'localhost:3080', origin: 'http://localhost.evil.com' })),
    false,
  );
});
check('trustedHosts entry admits a non-loopback authority', () => {
  assert.equal(isTrustedApiRequest(req({ host: 'box.lan:3080' }), ['box.lan']), true);
});
check('trustedHosts does not admit a different host', () => {
  assert.equal(isTrustedApiRequest(req({ host: 'other.lan:3080' }), ['box.lan']), false);
});
check('garbage trustedHosts entry is ignored, not thrown on', () => {
  assert.equal(isTrustedApiRequest(req({ host: 'box.lan:3080' }), ['::::', null, 42]), false);
});

console.log('=== 2. filterRequestedPaths: the panel may only name tracked paths ===');

const ROWS = [
  { file_path: 'C:\\Users\\k\\AppData\\Local\\Temp\\a.tmp', file_size: 10 },
  { file_path: 'C:\\Users\\k\\AppData\\Local\\Temp\\B.LOG', file_size: 20 },
];

check('unknown path is rejected, never forwarded', () => {
  const r = filterRequestedPaths(['C:\\Windows\\notepad.exe'], ROWS);
  assert.deepEqual(r.accepted, []);
  assert.deepEqual(r.rejected, ['C:\\Windows\\notepad.exe']);
});
check('case-insensitive match keeps the DB spelling', () => {
  const r = filterRequestedPaths(['c:\\users\\k\\appdata\\local\\temp\\b.log'], ROWS);
  assert.deepEqual(r.accepted, ['C:\\Users\\k\\AppData\\Local\\Temp\\B.LOG']);
});
check('duplicates collapse to one deletion', () => {
  const r = filterRequestedPaths([ROWS[0].file_path, ROWS[0].file_path], ROWS);
  assert.equal(r.accepted.length, 1);
});
check('mixed known/unknown splits correctly', () => {
  const r = filterRequestedPaths([ROWS[0].file_path, 'D:\\nope'], ROWS);
  assert.deepEqual(r.accepted, [ROWS[0].file_path]);
  assert.deepEqual(r.rejected, ['D:\\nope']);
});
check('non-string / empty / array / null input cannot smuggle a path', () => {
  for (const junk of [null, undefined, 'a-string', 42, [null, 42, '', '   '], [{}], [[]]]) {
    const r = filterRequestedPaths(junk, ROWS);
    assert.deepEqual(r.accepted, [], `accepted non-empty for ${JSON.stringify(junk)}`);
  }
});
check('preserves DB order in the accepted list', () => {
  const r = filterRequestedPaths([ROWS[1].file_path, ROWS[0].file_path], ROWS);
  assert.deepEqual(r.accepted, [ROWS[1].file_path, ROWS[0].file_path]);
});

console.log('=== 3. routes through a mock (req, res) ===');

/** A minimal response recorder. */
function mockRes() {
  return {
    code: 0,
    body: '',
    headers: null,
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

/** Drive one request through a registered handler. */
async function call(handler, { method = 'GET', url = `${API_PREFIX}/state`, headers = {}, body = null } = {}) {
  const res = mockRes();
  const listeners = new Map();
  const request = {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...headers },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return this;
    },
    destroy() {},
  };
  const done = handler(request, res);
  // Feed the body (if any) then end the stream, so readJsonBody resolves.
  for (const fn of listeners.get('data') ?? []) if (body !== null) fn(Buffer.from(JSON.stringify(body), 'utf8'));
  for (const fn of listeners.get('end') ?? []) fn();
  await done;
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    /* left null so the assertion message shows the raw body */
  }
  return { status: res.code, body: parsed, raw: res.body, headers: res.headers };
}

let registered = null;
const ROWS_2 = [
  { file_path: 'C:\\t\\safe.tmp', file_size: 100, category: 'SAFE_TO_DELETE', is_locked: 0, locked_by_pid: null, source_process: null, last_checked_at: '2026-10-16 10:00:00' },
  { file_path: 'C:\\t\\held.lock', file_size: 200, category: 'LOCKED_CRITICAL', is_locked: 1, locked_by_pid: 4242, source_process: 'node.exe', last_checked_at: '2026-10-16 10:00:01' },
];
const cleaned = [];

const ctx = {
  get(name) {
    if (name !== 'webServer') return undefined;
    return {
      register(route) {
        registered = route;
        return () => {
          registered = null;
        };
      },
    };
  },
};
const log = { debug() {}, info() {}, warn() {}, error() {} };

const dispose = registerWebApi(ctx, {
  cfg: { escapeRoot: 'E:\\dsh_escape_cache', useRecycleBin: true, trustedHosts: [] },
  log,
  db: {},
  refresh: async () => {},
  trackedRows: async () => ROWS_2,
  clean: async (records, opts) => {
    cleaned.push({ records, paths: records.map((r) => r.path), opts });
    return { removed: records.length, skipped: 0, bytesFreed: 300, errors: [], skippedList: [] };
  },
  status: () => ({ installed: true, escapeRoot: 'E:\\dsh_escape_cache', entries: [{ name: 'TEMP', ok: true }] }),
  escapeWritable: () => true,
});

await (async () => {
  check('registerWebApi registered a prefix route on the API_PREFIX', () => {
    assert.ok(registered, 'no route registered');
    assert.equal(registered.kind, 'prefix');
    assert.equal(registered.path, API_PREFIX);
    assert.equal(typeof registered.handler, 'function');
  });

  const handler = registered.handler;

  let r = await call(handler);
  check('GET /state returns rows + hijack + escapeRoot', () => {
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.value.rows.length, 2);
    assert.equal(r.body.value.hijack.installed, true);
    assert.equal(r.body.value.escapeRoot, 'E:\\dsh_escape_cache');
    assert.equal(r.body.value.escapeWritable, true);
  });
  check('/state sets no-store (a deleted file must not be replayed from cache)', () => {
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });
  r = await call(handler, { method: 'POST', url: `${API_PREFIX}/state` });
  check('POST /state -> 405 method-not-allowed', () => {
    assert.equal(r.status, 405);
    assert.equal(r.body.error.code, 'method-not-allowed');
  });

  r = await call(handler, { method: 'GET', url: `${API_PREFIX}/refresh` });
  check('GET /refresh -> 405 (refresh is a mutation of process state)', () => {
    assert.equal(r.status, 405);
  });
  r = await call(handler, { method: 'POST', url: `${API_PREFIX}/refresh` });
  check('POST /refresh -> refreshed:true and fresh rows', () => {
    assert.equal(r.status, 200);
    assert.equal(r.body.value.refreshed, true);
    assert.equal(r.body.value.rows.length, 2);
  });

  r = await call(handler, { method: 'POST', url: `${API_PREFIX}/clean`, body: { paths: ['C:\\t\\safe.tmp'] } });
  check('POST /clean forwards only the accepted path', () => {
    assert.equal(r.status, 200);
    assert.equal(cleaned.length, 1);
    assert.deepEqual(cleaned[0].paths, ['C:\\t\\safe.tmp']);
    assert.equal(r.body.value.report.removed, 1);
  });
  cleaned.length = 0;
  r = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/clean`,
    body: { paths: ['C:\\t\\safe.tmp'], category: 'LOCKED_CRITICAL', isLocked: true, size: 999999 },
  });
  check('a client cannot forge the tier: the record carries the PERSISTED category and size', () => {
    assert.equal(cleaned.length, 1);
    const rec = cleaned[0].records[0];
    assert.equal(rec.category, 'SAFE_TO_DELETE', `client-supplied category leaked: ${rec.category}`);
    assert.equal(rec.size, 100, `client-supplied size leaked: ${rec.size}`);
    assert.equal(rec.isLocked, false, `client-supplied isLocked leaked: ${rec.isLocked}`);
  });

  cleaned.length = 0;
  r = await call(handler, { method: 'POST', url: `${API_PREFIX}/clean`, body: { paths: ['C:\\t\\held.lock'] } });
  check('a LOCKED path reaches clean() with its lock state intact, for clean() to refuse', () => {
    assert.equal(cleaned.length, 1);
    const rec = cleaned[0].records[0];
    assert.equal(rec.category, 'LOCKED_CRITICAL');
    assert.equal(rec.isLocked, true);
    assert.equal(rec.lockedByPid, 4242);
    assert.equal(rec.lockedByProcess, 'node.exe');
  });

  cleaned.length = 0;
  r = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/clean`,
    body: { paths: ['C:\\Windows\\notepad.exe', 'C:\\t\\safe.tmp'], deep: true, force: true },
  });
  check('an untracked path is reported rejected and NOT cleaned', () => {
    assert.deepEqual(cleaned[0].paths, ['C:\\t\\safe.tmp']);
    assert.deepEqual(r.body.value.rejected, ['C:\\Windows\\notepad.exe']);
  });
  check('deep/force flags pass through to the cleaner', () => {
    assert.equal(cleaned[0].opts.deep, true);
    assert.equal(cleaned[0].opts.force, true);
  });

  cleaned.length = 0;
  r = await call(handler, { method: 'POST', url: `${API_PREFIX}/clean`, body: { paths: ['D:\\nope'] } });
  check('clean with zero accepted paths never calls the cleaner', () => {
    assert.equal(cleaned.length, 0);
    assert.equal(r.status, 200);
    assert.equal(r.body.value.note, 'no tracked path was selected');
  });

  r = await call(handler, { method: 'GET', url: `${API_PREFIX}/nope` });
  check('unknown sub-route -> 404', () => {
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'not-found');
  });
  r = await call(handler, { url: `${API_PREFIX}/state/` });
  check('trailing slash still resolves', () => {
    assert.equal(r.status, 200);
  });
  r = await call(handler, {
    url: `${API_PREFIX}/state`,
    headers: { host: 'evil.example.com' },
  });
  check('a REFUSED request gets 403 and no rows at all', () => {
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'forbidden');
    assert.equal(r.body.value, undefined);
  });
  const beforeRefused = cleaned.length;
  r = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/clean`,
    headers: { host: 'evil.example.com' },
    body: { paths: ['C:\\t\\safe.tmp'] },
  });
  check('a REFUSED clean deletes NOTHING', () => {
    assert.equal(r.status, 403);
    assert.equal(
      cleaned.length,
      beforeRefused,
      `clean() was reached from a refused origin (calls went ${beforeRefused} -> ${cleaned.length})`,
    );
  });
  r = await call(handler, { method: 'POST', url: `${API_PREFIX}/clean`, body: 'not-json' });
  check('a malformed body yields an error result, not a crash', () => {
    assert.ok([400, 500].includes(r.status), `unexpected status ${r.status}`);
    assert.equal(r.body.ok, false);
  });
  r = await call(handler, { method: 'POST', url: `${API_PREFIX}/clean`, body: [1, 2, 3] });
  check('a JSON array body is refused', () => {
    assert.equal(r.body.ok, false);
  });

  check('dispose() is a function and removes the route', () => {
    assert.equal(typeof dispose, 'function');
    dispose();
    assert.equal(registered, null);
  });

  // No webServer at all must degrade, not throw.
  const silent = registerWebApi({ get: () => undefined }, { cfg: {}, log, db: null });
  check('a profile without webServer degrades to a no-op disposer', () => {
    assert.equal(typeof silent, 'function');
    silent();
  });
})();

console.log('=== 4. the `ui` verb ===');

check('parseArgs("ui") -> verb ui', () => {
  assert.deepEqual(parseArgs('  ui  '), { ok: true, verb: 'ui', deep: false, force: false });
});
check('parseArgs("UI") is case-insensitive', () => {
  assert.equal(parseArgs('UI').verb, 'ui');
});
check('parseArgs("ui extra") -> UI_EXTRA_ARGS', () => {
  assert.equal(parseArgs('ui extra').code, 'UI_EXTRA_ARGS');
});
check('parseArgs("ui --deep") -> UI_EXTRA_ARGS (no flags on ui)', () => {
  assert.equal(parseArgs('ui --deep').code, 'UI_EXTRA_ARGS');
});
check('existing grammar is unchanged', () => {
  assert.equal(parseArgs('status').verb, 'status');
  assert.equal(parseArgs('now').verb, 'now');
  assert.equal(parseArgs('now --deep --force').deep, true);
  assert.equal(parseArgs('').code, 'EMPTY');
  assert.equal(parseArgs('bogus').code, 'UNKNOWN_VERB');
});

const calls = { clean: 0, collect: 0, refresh: 0, summary: 0 };
const cmdCtx = { commands: { register(def) { cmdCtx.def = def; return () => {}; } } };
registerCommands(cmdCtx, {
  cfg: { escapeRoot: 'E:\\dsh_escape_cache' },
  log,
  db: { summary() { calls.summary += 1; return { SAFE: { count: 128, bytes: 358612992 }, CAUTION: { count: 1, bytes: 1288490188 }, LOCKED: { count: 3, bytes: 1024 } }; } },
  hijacker: { status: () => ({ installed: true, escapeRoot: 'E:\\dsh_escape_cache', entries: Array.from({ length: 9 }, (_, i) => ({ name: `V${i}`, ok: true })) }) },
  refresh: async () => { calls.refresh += 1; },
  collect: async () => { calls.collect += 1; return []; },
  clean: async () => { calls.clean += 1; return {}; },
});

const uiResult = await cmdCtx.def.handler({ rawInput: 'ui', signal: { aborted: false } });
check('`ui` returns a success result', () => {
  assert.equal(uiResult.kind, 'success');
});
check('`ui` does NOT run a clean', () => {
  assert.equal(calls.clean, 0, 'ui triggered a sweep');
  assert.equal(calls.collect, 0, 'ui collected candidates');
  assert.equal(calls.refresh, 0, 'ui refreshed');
});
check('`ui` names the sidebar panel so a user can find it', () => {
  assert.match(uiResult.text, /侧边栏/);
  assert.match(uiResult.text, /C 盘逃逸清理/);
});
check('`ui` still reports the live headline (one round trip, not two)', () => {
  assert.match(uiResult.text, /可清理/);
  assert.equal(calls.summary, 1);
});
check('the registered command documents the ui verb in its own help text', () => {
  assert.match(cmdCtx.def.description, /ui/, `description omits ui: ${cmdCtx.def.description}`);
  assert.match(cmdCtx.def.input.hint, /ui/, `input hint omits ui: ${cmdCtx.def.input.hint}`);
});
check('the USAGE constant lists every implemented verb', () => {
  for (const verb of ['status', 'ui', 'now', '--deep', '--force']) {
    assert.match(USAGE, new RegExp(verb.replace(/-/g, '\\-')), `USAGE omits ${verb}`);
  }
});
const bogus = await cmdCtx.def.handler({ rawInput: 'ui --deep', signal: { aborted: false } });
check('`ui --deep` is rejected instead of being silently treated as a clean', () => {
  assert.equal(bogus.kind, 'error');
  assert.equal(calls.clean, 0, 'a malformed ui invocation ran a sweep');
  assert.match(bogus.text, /UI_EXTRA_ARGS/);
});

const unknown = await cmdCtx.def.handler({ rawInput: 'frobnicate', signal: { aborted: false } });
check('an unknown verb still errors with the usage text, and cleans nothing', () => {
  assert.equal(unknown.kind, 'error');
  assert.match(unknown.text, /UNKNOWN_VERB/);
  assert.equal(calls.clean, 0);
  assert.equal(calls.collect, 0);
});

console.log(`\nSUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
if (fail > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
