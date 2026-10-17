/**
 * Lead acceptance probe for the COLD-BOOT panel-route regression.
 *
 * THE BUG THIS LOCKS (measured live on harness pid 41388):
 *   `webServer` is a Cordis Service, and `ctx.get(name)` defaults to `strict = true`, which
 *   returns `undefined` while the PROVIDING fiber is not yet active
 *   (`@deepseek-ai/cordis/lib/index.js:756-770`). `apply()` used to call `registerWebApi(ctx, ...)`
 *   with a bare `ctx.get('webServer')`, so on a FRESH boot the plugin's fiber could reach that
 *   line before the web server was active: `registerWebApi` degraded to a no-op, no route was
 *   registered, and the panel rendered `面板错误: HTTP 404 (no JSON body)` while the Host half
 *   (watcher, DB, env hijack) worked perfectly. It only ever appeared to work because HMR
 *   re-ran `apply()` long after boot.
 *
 * WHY THE EXISTING SUITES MISSED IT: `_lead-phase2-api.mjs` and the adversarial API probe call
 *   `registerWebApi(ctx, deps)` DIRECTLY with a ctx whose `get('webServer')` already returns a
 *   server. They test the route logic, never the `apply()` wiring, so none of them could observe
 *   an ordering race that happens before `registerWebApi` is even called.
 *
 * WHAT THIS PROBE DRIVES: the SHIPPED `apply()` from `../index.js`, with a mock ctx that models
 *   the Cordis contract faithfully:
 *     - `ctx.get('webServer')` returns `undefined` until the service is "provided" (strict).
 *     - `ctx.inject(['webServer'], cb)` stores `cb` and runs it only when the service arrives.
 *     - `ctx.effect(cb)` collects the returned disposer, like a real fiber.
 *   Stage 1 boots with the service ABSENT (the cold-boot moment) and asserts that no route is
 *   registered yet but that the callback is PENDING. Stage 2 provides the service and asserts the
 *   route registers and answers. Stage 3 proves the route disposer works.
 *
 * Runs against the REAL Windows Temp for the watcher (the plugin's own env hijack redirects
 * `os.tmpdir()` under `escapeRoot`, which is a protectRoot, so a probe rooted there would test
 * the protectRoot veto instead of the gate). Every artifact is removed afterwards.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, resolveConfig } from '../index.js';

let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`  PASS  ${name}${detail ? `  -- ${detail}` : ''}`);
  } catch (err) {
    fail += 1;
    failures.push(`${name}: ${err?.message}`);
    console.log(`  FAIL  ${name}\n        ${err?.message}`);
  }
}

/** The real Windows Temp, NOT `os.tmpdir()` (see the module doc). */
const REAL_TEMP = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Temp')
  : os.tmpdir();

const stamp = `${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
const watchDir = path.join(REAL_TEMP, `dshcc_coldboot_${stamp}`);
fs.mkdirSync(watchDir, { recursive: true });

const created = [watchDir];
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Build a mock Cordis ctx that models the `webServer` service lifecycle.
 *
 * `provideWebServer()` flips the service from absent to active and then runs every pending
 * `inject` callback, which is what a real `ctx.provide('webServer', ...)` does via
 * `ReflectService.notify()`.
 *
 * `table` is the route table of the web server. It is a PARAMETER because there is exactly ONE
 * web server per process: two generations share one table, which is precisely why a duplicate
 * `(kind, path)` registration throws. Defaulting to a fresh table keeps the single-generation
 * stages simple; section D passes one shared table to both generations.
 *
 * @param {{route: object|null}} [table] - the shared route table.
 * @returns {object} the mock ctx plus test controls.
 */
function makeCtx(table = { route: null, prefixes: new Map() }) {
  let webServer = undefined;
  const pendingInject = [];
  const disposers = [];
  const effects = [];

  const server = {
    host: '127.0.0.1',
    /**
     * The authoritative prefix table, exactly like the shipped `WebServer.prefixes`
     * (`@deepseek-ai/dsh-host-webserver/lib/index.js`: `prefixes = new Map()`, and `register`
     * does `table.set(route.path, route)` / `() => table.delete(route.path)`). It is exposed so
     * a probe can plant a PHANTOM route the way a pre-claim-slot generation did, and so
     * `registerWebApi`'s own reclaim can find it.
     */
    prefixes: table.prefixes,
    register(route) {
      if (table.prefixes.has(route.path)) {
        throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      }
      table.prefixes.set(route.path, route);
      table.route = route;
      // FAITHFUL to the shipped server: `@deepseek-ai/dsh-host-webserver/lib/index.js` returns
      // `() => { table.delete(route.path); }` — it deletes by PATH, NOT by object identity. A mock
      // that guards with `if (table.route === route)` would silently hide the real late-teardown
      // hazard (a superseded generation's late dispose removing the NEW generation's route), which
      // is exactly what this probe exists to catch. Do not "tidy" this back to an identity check.
      return () => {
        table.prefixes.delete(route.path);
        if (table.route === route) table.route = null;
      };
    },
  };

  const ctx = {
    // `apply()` registers slash commands first, so the mock must carry the `commands` service:
    // `lib/commands.js:150` throws `registerCommands: ctx.commands.register is required` without
    // BOTH the `commands` property and the `get('commands')` accessor.
    commands: { register: () => () => {} },
    // `strict = true` by default, exactly like Cordis: absent while the provider is inactive.
    get(name) {
      if (name === 'webServer') return webServer;
      if (name === 'commands') return ctx.commands;
      return undefined;
    },
    // The scoped-inject API the fix relies on.
    inject(names, callback) {
      assert.ok(Array.isArray(names), 'inject expects an array');
      pendingInject.push({ names, callback });
      if (names.includes('webServer') && webServer !== undefined) {
        pendingInject.pop();
        callback(ctx);
      }
      return { await: async () => {} };
    },
    effect(cb, label) {
      const dispose = cb();
      effects.push({ dispose, label });
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    on() {},
    logger: quietLog,
  };

  return {
    ctx,
    /** The web server's route table, so a caller can hand the SAME one to a second generation. */
    table,
    provideWebServer() {
      webServer = server;
      for (const item of [...pendingInject]) {
        if (!item.names.includes('webServer')) continue;
        pendingInject.splice(pendingInject.indexOf(item), 1);
        item.callback(ctx);
      }
    },
    get registered() {
      // PATH-LEVEL truth, not the convenience `table.route` mirror. The shipped disposer deletes
      // by PATH, so a probe that reads `table.route` would miss a route that was deleted from
      // `prefixes` while the mirror still pointed at the old object — exactly how a mutation of
      // the ownership guard could survive. Read the authoritative table.
      return table.prefixes.get('/c-cleaner/api') ?? null;
    },
    pendingCount: () => pendingInject.length,
    /**
     * Dispose this generation's effects.
     *
     * `reverse` models the OTHER legal fiber-teardown order. The route effect lives on the
     * INJECTED CHILD fiber while `cleanup` lives on the PARENT fiber, and Cordis does not
     * promise which is disposed first. In insertion order the child's route disposer runs first
     * and nulls `webApiClaim`, which makes the parent-level ownership check in `cleanup`
     * unreachable — so a mutation of THAT check survives. Reversing the order (parent first) is
     * the ordering that exercises it. Both guards are therefore real, and both need a probe.
     */
    disposeAll({ reverse = false } = {}) {
      const list = disposers.splice(0);
      if (reverse) list.reverse();
      for (const d of list) {
        try {
          d();
        } catch {
          /* teardown must not throw into the probe */
        }
      }
    },
  };
}

const baseCfg = () =>
  resolveConfig({
    enabled: true,
    escapeRoot: path.join(REAL_TEMP, `dshcc_coldboot_esc_${stamp}`),
    dbPath: path.join(REAL_TEMP, `dshcc_coldboot_${stamp}.db`),
    watchDirs: [{ path: watchDir, recursive: false }],
    noiseGate: 'enforce',
    sessionWindowMs: 600000,
    // Rule #1 (the psutil handle index) is opt-in and off by default; keep it off so the probe
    // does not depend on a python bridge.
    handleIndex: false,
  });

console.log('=== A. COLD BOOT: the web server is NOT yet active ===');
const mock = makeCtx();
const cfg = baseCfg();
created.push(cfg.escapeRoot, cfg.dbPath);

let applyThrew = null;
try {
  await apply(mock.ctx, cfg);
} catch (err) {
  applyThrew = err;
}

await check('apply() completes on a cold boot where webServer is absent (no throw)', () => {
  assert.equal(applyThrew, null, `apply() threw: ${applyThrew?.message}`);
  return 'apply() resolved';
});

await check('no route is registered YET (the service is genuinely absent)', () => {
  assert.equal(mock.registered, null, 'a route was registered before webServer existed');
  return 'registered=null';
});

await check('an inject callback for webServer is PENDING (the fix wired a scoped inject)', () => {
  assert.ok(mock.pendingCount() >= 1, `pending inject callbacks = ${mock.pendingCount()}, expected >= 1`);
  return `pending=${mock.pendingCount()}`;
});

console.log('=== B. THE SERVICE ARRIVES: the pending inject must fire ===');
mock.provideWebServer();

await check('the route IS registered once webServer becomes active (THE REGRESSION)', () => {
  assert.ok(mock.registered, 'no route registered after webServer became active -- cold-boot bug');
  assert.equal(mock.registered.kind, 'prefix');
  assert.equal(mock.registered.path, '/c-cleaner/api');
  assert.equal(typeof mock.registered.handler, 'function');
  return `kind=${mock.registered.kind} path=${mock.registered.path}`;
});

await check('the registered handler answers GET /c-cleaner/api/state with JSON', async () => {
  const route = mock.registered;
  assert.ok(route, 'no route to drive');
  const chunks = [];
  const req = { method: 'GET', url: '/c-cleaner/api/state', headers: { host: '127.0.0.1:3080' } };
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers ?? {});
    },
    end(body) {
      chunks.push(body ?? '');
    },
    write(body) {
      chunks.push(body ?? '');
    },
  };
  await route.handler(req, res);
  const body = chunks.join('');
  assert.ok(body.length > 0, 'the handler wrote no body');
  const parsed = JSON.parse(body);
  assert.equal(parsed.ok, true, `handler answered ok=${parsed.ok}`);
  assert.ok(Array.isArray(parsed.value.rows), 'the snapshot has no rows array');
  return `status=${res.statusCode} ok=${parsed.ok} rows=${parsed.value.rows.length}`;
});

await check('a FOREIGN Origin is still refused (the fence survives the rewiring)', async () => {
  const route = mock.registered;
  assert.ok(route, 'no route to drive');
  const chunks = [];
  const req = {
    method: 'GET',
    url: '/c-cleaner/api/state',
    headers: { host: '127.0.0.1:3080', origin: 'https://evil.example.com' },
  };
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(code) {
      this.statusCode = code;
    },
    end(body) {
      chunks.push(body ?? '');
    },
    write(body) {
      chunks.push(body ?? '');
    },
  };
  await route.handler(req, res);
  const parsed = JSON.parse(chunks.join(''));
  assert.equal(parsed.ok, false, 'a foreign Origin was NOT refused');
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}`);
  return `status=${res.statusCode} code=${parsed.error?.code}`;
});

console.log('=== C. TEARDOWN: the route disposer must actually release the route ===');
mock.disposeAll();

await check('disposing the generation releases the registered route', () => {
  assert.equal(mock.registered, null, 'the route survived teardown -- a duplicate-route hazard next boot');
  return 'registered=null';
});

console.log('=== D. DUPLICATE-ROUTE + LATE-TEARDOWN HAZARDS ===');
// The measured hazard: `webServer.register` THROWS on a duplicate (kind, path). If a generation
// whose fiber was never disposed still holds the route, the new generation's register throws,
// the throw is swallowed, and the panel is served by the OLD generation's handler. ONE route
// table is shared by both generations, because there is exactly one web server per process.
//
// FIDELITY: the two generations load SEPARATE module instances of `../index.js` (a cache-busting
// query does that). That is not decoration — HMR re-imports the module body, so each generation
// gets its OWN `webApiClaim`. Sharing one instance would make `webApiClaim` a single shared
// binding, and then gen-1's route disposer (which unconditionally ends with `webApiClaim = null`)
// would clear gen-2's claim before gen-1's `cleanup` ran, so the ownership check in `cleanup`
// would never be reachable and a mutation of it would SURVIVE. Proven by mutation M2.
const stale = makeCtx();
const sharedTable = stale.table;
const gen1 = await import('../index.js?generation=stale');
const gen2 = await import('../index.js?generation=new');
assert.notEqual(gen1.apply, gen2.apply, 'the two generations must be distinct module instances');

stale.provideWebServer();
const staleCfg = baseCfg();
created.push(staleCfg.escapeRoot, staleCfg.dbPath);
await gen1.apply(stale.ctx, staleCfg);
const staleRoute = stale.registered;

await check('a first generation registered the route', () => {
  assert.ok(staleRoute, 'the first generation registered nothing');
  return 'stale route present';
});

// Model the REAL phantom generation: the one measured live was created by a module generation
// that predates the process-global `ACTIVE_GENERATION` slot, so the incoming generation CANNOT
// pre-dispose it. Its teardown therefore runs FRESH and LATE — after the new generation has
// already registered. Nulling the slot by hand reproduces exactly that.
//
// This matters: the naive version of this probe left the slot intact, so gen-2's `apply()`
// pre-disposed gen-1 and gen-1's latched `cleanup` returned at its idempotency guard without ever
// reaching the ownership check. The probe then passed even with that ownership check MUTATED —
// it was testing the idempotency latch, not the guard. Nulling the slot is what makes the guard
// reachable, and a mutation test proves it.
globalThis[Symbol.for('@local/dsh-c-cleaner.active-generation')] = null;

const second = makeCtx(sharedTable);
second.provideWebServer();
const secondCfg = baseCfg();
created.push(secondCfg.escapeRoot, secondCfg.dbPath);
let secondThrew = null;
try {
  await gen2.apply(second.ctx, secondCfg);
} catch (err) {
  secondThrew = err;
}

await check('a new generation disposes the stale route and registers its own (no swallowed duplicate)', () => {
  assert.equal(secondThrew, null, `apply() threw: ${secondThrew?.message}`);
  assert.ok(second.registered, 'the new generation registered NO route -- duplicate was swallowed');
  assert.notEqual(second.registered, staleRoute, 'the new generation reused the stale route object');
  return 'new route registered after releasing the stale one';
});

await check('a LATE teardown of the stale generation cannot unregister the NEW route', () => {
  // The real hazard, and the reason ownership is re-checked before every dispose:
  // `WebServer.register` returns `() => table.delete(route.path)` — it deletes by PATH, not by
  // object identity. So if the superseded generation's fiber teardown runs AFTER the new
  // generation registered, its captured disposer removes the NEW route and the panel 404s again.
  // A probe that only asserts "a route object is present" would miss this entirely; this drives
  // the stale generation's teardown for real and then asserts the new route SURVIVED.
  //
  // `reverse: true` is load-bearing. The route effect lives on the INJECTED CHILD fiber and
  // `cleanup` on the PARENT fiber; Cordis does not promise which is disposed first. In insertion
  // order the child's route disposer runs first and nulls `webApiClaim`, which makes the
  // parent-level ownership check in `cleanup` unreachable — a mutation that removes THAT check
  // then survives. Disposing parent-first is the ordering that exercises it. (Verified by
  // mutation M2: insertion order -> SURVIVED, this order -> KILLED.)
  // The AUTHORITATIVE truth is the prefix table, not the `table.route` mirror: the shipped
  // disposer deletes by PATH, so a late teardown can remove the route from `prefixes` while the
  // mirror still points at the old object. Asserting on the mirror is exactly how a mutation of
  // the ownership guard survives (verified: with mirror assertions M2 SURVIVED; with path-level
  // assertions M2 is KILLED).
  const pathRoute = () => sharedTable.prefixes.get('/c-cleaner/api') ?? null;
  assert.ok(pathRoute(), 'no route to protect');
  assert.equal(pathRoute(), second.registered, 'precondition: the new route is installed');

  stale.disposeAll({ reverse: true });

  assert.ok(pathRoute(), 'the stale generation removed the NEW route (late-teardown hazard)');
  assert.equal(
    pathRoute(),
    second.registered,
    'the prefix table no longer holds the new generation route after the stale teardown',
  );
  return 'new route survived the stale generation teardown (parent-first disposal)';
});

console.log('=== E. PHANTOM ROUTE RECLAIM (the measured live 500) ===');
// THE MEASURED LIVE DEFECT, reproduced exactly: after an HMR reload the panel answered
// `500 {"code":"internal","message":"database is not open"}` for every verb. Cause: a module
// generation that registered `/c-cleaner/api` BEFORE the process-global claim slot existed still
// owned the path, so the new generation's `webServer.register` threw
// `webserver: duplicate prefix route "/c-cleaner/api"`, the throw was swallowed by its catch, and
// every request kept reaching the OLD handler whose captured StateDB had already been closed by
// that generation's own teardown.
//
// The phantom is planted by hand here (no module generation is involved): its handler is a
// sentinel that stands for "the dead generation's handler". If the new generation's reclaim does
// not remove it, its `register` throws and the sentinel keeps answering.
const eTable = { route: null, prefixes: new Map() };
const PHANTOM_SENTINEL = { tag: 'phantom-dead-generation' };
eTable.prefixes.set('/c-cleaner/api', { kind: 'prefix', path: '/c-cleaner/api', handler: PHANTOM_SENTINEL });
eTable.route = eTable.prefixes.get('/c-cleaner/api');

const eMock = makeCtx(eTable);
eMock.provideWebServer();
const eCfg = baseCfg();
created.push(eCfg.escapeRoot, eCfg.dbPath);

await check('a PHANTOM route from a pre-claim-slot generation holds our path', () => {
  assert.equal(eTable.prefixes.get('/c-cleaner/api')?.handler, PHANTOM_SENTINEL);
  return 'phantom installed on /c-cleaner/api';
});

let eThrew = null;
try {
  await apply(eMock.ctx, eCfg);
} catch (err) {
  eThrew = err;
}

await check('apply() does not throw on the phantom route (the duplicate is not swallowed)', () => {
  assert.equal(eThrew, null, `apply() threw: ${eThrew?.message}`);
  return 'apply() resolved';
});

await check('the phantom is RECLAIMED and replaced by this generation handler', () => {
  const current = eTable.prefixes.get('/c-cleaner/api');
  assert.ok(current, 'the route vanished entirely -- reclaim removed it without registering');
  assert.notEqual(current.handler, PHANTOM_SENTINEL, 'the DEAD generation handler still owns the route (500 live)');
  return 'route now owned by the live generation';
});

await check('the reclaimed route answers GET /state with the LIVE database (no "database is not open")', async () => {
  const route = eTable.prefixes.get('/c-cleaner/api');
  assert.ok(route, 'no route to drive');
  const chunks = [];
  const req = { method: 'GET', url: '/c-cleaner/api/state', headers: { host: '127.0.0.1:3080' } };
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(code) {
      this.statusCode = code;
    },
    end(body) {
      chunks.push(body ?? '');
    },
    write(body) {
      chunks.push(body ?? '');
    },
  };
  await route.handler(req, res);
  const parsed = JSON.parse(chunks.join(''));
  assert.equal(parsed.ok, true, `handler answered ok=${parsed.ok} error=${parsed.error?.message ?? ''}`);
  assert.notEqual(parsed.error?.message, 'database is not open', 'the dead generation handler answered again');
  return `status=${res.statusCode} ok=${parsed.ok} rows=${parsed.value.rows.length}`;
});

eMock.disposeAll();

// Clean up both generations and every artifact.
try {
  stale.disposeAll();
} catch {
  /* ignore */
}
try {
  second.disposeAll();
} catch {
  /* ignore */
}

console.log('\n--- cleanup ---');
for (const target of created) {
  try {
    if (fs.existsSync(target)) {
      const st = fs.lstatSync(target);
      // Never follow a reparse point: `fs.rmSync(recursive)` would destroy its target.
      if (st.isSymbolicLink()) continue;
      fs.rmSync(target, { recursive: true, force: true });
    }
  } catch (err) {
    console.log(`  (cleanup skipped ${target}: ${err?.message})`);
  }
}
for (const suffix of ['', '-wal', '-shm']) {
  const p = `${cfg.dbPath}${suffix}`;
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\nSUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
if (failures.length > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  console.log('verdict=COLD-BOOT-ROUTE-BROKEN');
} else {
  console.log('verdict=COLD-BOOT-ROUTE-OK');
}
process.exitCode = fail === 0 ? 0 : 1;
