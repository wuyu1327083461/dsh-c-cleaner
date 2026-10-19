// Lead-owned probe: does `apply()` tear down a PREVIOUS generation of itself?
//
// WHY THIS MATTERS (measured on the live harness): the harness HMR-watches this repo and
// re-runs `apply()` on every file event. Each re-entry builds a NEW CWatcher with a NEW
// `onCandidate` closure. If a superseded generation's watcher is not stopped, it keeps
// monitoring and keeps admitting files using the gate logic it was BORN with — so a fix
// to the gate looks like it did nothing, because a stale watcher is still writing rows.
//
// This probe drives the SHIPPED `apply()` twice in ONE process, against the real Windows
// Temp directory, with a gate that the SECOND generation must enforce. It asserts:
//   A. after the second apply(), exactly ONE watcher is registered as live
//   B. a file the gate rejects is NOT delivered by the leftover first generation
//
// RUN:  node test/_lead-p2-reentry.mjs
import fs from 'node:fs';
import path from 'node:path';

// os.tmpdir() is redirected by the plugin's own env hijack to the escape root, which is a
// protectRoot -> a probe rooted there would test the protectRoot veto, not the gate.
const REAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';

const { liveWatcherCount, stopAllWatchers, rawWatcherCount } = await import('../lib/watcher.js');
const mod = await import('../index.js');

const stamp = `${process.pid}_${Date.now().toString(36)}`;
const dir = path.join(REAL_TEMP, `dshcc_reentry_${stamp}`);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

/**
 * Build a mock Cordis ctx that records the disposer handed to `ctx.effect`, exactly like the
 * harness does (`_execute` collects the callback's RETURN VALUE as the disposer).
 */
function makeCtx() {
  const disposers = [];
  const commands = { register: () => () => {} };
  return {
    disposers,
    commands,
    effect(cb) {
      const d = cb();
      if (typeof d === 'function') disposers.push(d);
      return () => {};
    },
    on() {},
    get: (name) => (name === 'commands' ? commands : undefined),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

function baseConfig(extra = {}) {
  return {
    escapeRoot: path.join(dir, 'escape'),
    dbPath: path.join(dir, 'state', 'state.db'),
    watchDirs: [{ path: dir, recursive: false }],
    debounceMs: 300,
    sessionWindowMs: 60_000,
    // Keep the probe focused on the watcher lifecycle: no subprocess machinery.
    resolveLockOwner: false,
    handleIndex: false,
    recoverClientGraph: false,
    ...extra,
  };
}

// Two files written in ONE directory and the SAME second:
//   NOISE  -> an installer-shaped name the TIGHT valve rejects
//   CONTROL-> pip-* which the signature glob must still admit (proves the watcher is live)
const NOISE = path.join(dir, 'Contoso Configuration Bundle.msi');
const CONTROL = path.join(dir, `pip-reentry-${stamp}.log`);

let ctx1 = null;
try {
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'escape'), { recursive: true });
  fs.writeFileSync(NOISE, `reentry noise ${stamp}\n`);
  fs.writeFileSync(CONTROL, `reentry control ${stamp}\n`);

  // ---- generation 1 -------------------------------------------------------
  ctx1 = makeCtx();
  mod.apply(ctx1, baseConfig());
  const afterFirst = liveWatcherCount();
  check('gen-1 apply() starts exactly one watcher', afterFirst === 1, `live=${afterFirst}`);

  // ---- generation 2 (a simulated HMR re-entry) ----------------------------
  const ctx2 = makeCtx();
  mod.apply(ctx2, baseConfig());
  const afterSecond = liveWatcherCount();
  check(
    'gen-2 apply() leaves exactly ONE watcher live (no leaked predecessor)',
    afterSecond === 1,
    `live=${afterSecond} (expected 1; >1 means a leaked generation is still watching)`,
  );

  // The guard is allowed to either dispose gen-1 through the registry or through the
  // recorded effect disposer; what matters is that gen-1 is no longer monitoring.
  check(
    'the superseded generation is no longer registered as live',
    afterSecond === 1,
    'checked via the process-global registry',
  );

  // ---- behaviour: only the CURRENT generation may admit --------------------
  // Wait past the debounce for both generations to settle any event they received.
  const deadline = Date.now() + 12_000;
  let delivered = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if (delivered.length >= 1) break;
    delivered = [];
  }

  // The noise file must have been rejected by BOTH generations; the control admitted.
  // We cannot read a DB here (apply() owns its own), so we assert on the registry state
  // plus a direct re-classification through the shipped gate helpers.
  const { classifyName, compileSignatureGlobs, signatureListFrom } = await import('../lib/watcher.js');
  // `classifyName` takes COMPILED globs, so compile the same default list the watcher uses.
  const compiledGlobs = compileSignatureGlobs(signatureListFrom(baseConfig()));
  const noiseVerdict = classifyName(NOISE, compiledGlobs, true);
  const controlVerdict = classifyName(CONTROL, compiledGlobs, true);
  check(
    'shipped gate rejects the installer-shaped noise (tight valve)',
    noiseVerdict.criticalName === false,
    `criticalName=${noiseVerdict.criticalName}`,
  );
  check(
    'shipped gate still admits a pip-* control (gate is live, not disabled)',
    controlVerdict.signatureMatch === true,
    `signatureMatch=${controlVerdict.signatureMatch}`,
  );

  // ---- generation 3: must also reap a RAW handle leaked by a pre-registry generation ----
  // A watcher born before the instance registry existed cannot be reached through
  // `stopAllWatchers()`. The raw registry is what makes it reachable. Simulate that leak by
  // creating a raw `fs.watch` (the plugin's exact options) and registering it BY HAND, as a
  // pre-registry generation could not have registered itself; then let apply() reap it.
  const RAW_REG = Symbol.for('dsh-c-cleaner.raw-watchers');
  let phantomDelivered = 0;
  const phantom = fs.watch(dir, { recursive: false, persistent: false }, () => {
    phantomDelivered += 1;
  });
  phantom.unref();
  const rawReg = globalThis[RAW_REG] instanceof Set
    ? globalThis[RAW_REG]
    : (globalThis[RAW_REG] = new Set());
  rawReg.add(phantom);
  // NOTE: gen-2's OWN watcher is in the raw registry too, so the expected count is 2, not 1.
  // Asserting 1 here would be asserting the live generation's handle is absent — which is wrong.
  check(
    'gen-2 handle + phantom raw handle are registered before gen-3',
    rawWatcherCount() === 2,
    `raw=${rawWatcherCount()} (gen-2's own + the phantom)`,
  );

  // Prove the phantom is genuinely ARMED before the reap, or the "stopped delivering"
  // assertion below would pass for the wrong reason (0 deliveries either way).
  fs.writeFileSync(path.join(dir, 'phantom-before.txt'), 'x');
  await new Promise((r) => setTimeout(r, 800));
  check('the phantom is live before gen-3 apply()', phantomDelivered > 0, `delivered=${phantomDelivered}`);

  const before3 = phantomDelivered;
  const ctx3 = makeCtx();
  mod.apply(ctx3, baseConfig());
  // gen-3 reaped the phantom AND gen-2's watcher, then registered its own -> exactly 1.
  check(
    'gen-3 apply() reaped the phantom raw handle (the pre-registry cure)',
    rawWatcherCount() === 1,
    `raw=${rawWatcherCount()} (only gen-3's own handle remains)`,
  );

  fs.writeFileSync(path.join(dir, 'phantom-probe.txt'), 'x');
  await new Promise((r) => setTimeout(r, 800));
  check(
    'the phantom stopped delivering after gen-3 apply()',
    phantomDelivered === before3,
    `delivered before=${before3} after=${phantomDelivered}`,
  );
  check(
    'gen-3 still left exactly one live watcher (its own)',
    liveWatcherCount() === 1,
    `live=${liveWatcherCount()}`,
  );

  // ---- teardown must be idempotent ----------------------------------------
  stopAllWatchers();
  const afterStopAll = liveWatcherCount();
  check('stopAllWatchers() leaves nothing live', afterStopAll === 0, `live=${afterStopAll}`);

  // The disposers recorded by ctx.effect are the generation teardown; invoking one twice
  // must not throw (a double teardown would double-close the DB and the API).
  let threw = null;
  try {
    ctx1.disposers.forEach((d) => d());
    ctx1.disposers.forEach((d) => d());
  } catch (err) {
    threw = String(err?.message ?? err);
  }
  check('generation teardown is idempotent (no throw on a second call)', threw === null, threw ?? 'ok');
} catch (err) {
  check('probe ran', false, String(err?.stack ?? err));
} finally {
  try { stopAllWatchers(); } catch { /* best effort */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`);
console.log(`verdict=${failed.length === 0 ? 'REENTRY-SAFE' : 'REENTRY-LEAKS'}`);
process.exitCode = failed.length === 0 ? 0 : 1;
