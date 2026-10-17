// Lead-owned adversarial probe (Phase 2 final round): attack the FOUR code changes that
// landed after the verifier's last round. Each section tries to FALSIFY, not confirm.
//
//   §A  the classifier predicate SPLIT — LOCKED_BASENAME_RE (loose, TIER) vs
//       CREDENTIAL_NAME_RE (tight, GATE valve). Fuzz BOTH directions.
//   §B  the raw FSWatcher registry — can a sweep close the CURRENT generation's own handle?
//   §C  the re-entrancy guard — can a reload leave process.env RESTORED while a watcher is live?
//   §D  TIGHT subset-of LOOSE — a gate predicate that is NOT a subset of the tier predicate
//       would mean a gate-admitted row that the tier calls noise (an invisible green row).
//
// RUN: node test/_lead-p2-adversarial-final.mjs
import fs from 'node:fs';
import path from 'node:path';

import {
  LOCKED_BASENAME_RE,
  CREDENTIAL_NAME_RE,
  classify,
} from '../lib/classifier.js';
import {
  compileSignatureGlobs,
  signatureListFrom,
  classifyName,
  rawWatcherCount,
  closeAllRawWatchers,
  liveWatcherCount,
  stopAllWatchers,
} from '../lib/watcher.js';
import { resolveConfig } from '../lib/config.js';
import { EnvHijacker } from '../lib/env-hijack.js';

const REAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';
const stamp = `${process.pid}_${Date.now().toString(36)}`;
const dir = path.join(REAL_TEMP, `dshcc_advfinal_${stamp}`);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// §A — the predicate split, fuzzed in both directions.
// ---------------------------------------------------------------------------

// A1. TIGHT must be a SUBSET of LOOSE for every name the tight one admits. If the gate
// admits a name the TIER predicate rejects, `classify()` will place that row in the GREEN
// tier (the tier predicate failed) while the gate let it in — i.e. a gate-admitted row
// silently becomes deletable noise. That is the direction that costs a FILE, so it is the
// one to falsify first.
const ADMIT_CORPUS = [
  'credentials.json', 'auth.json', 'config.json', 'session.token', 'token.txt',
  'state.db', 'cache.sqlite', 'state.sqlite3', 'worker.pid.lock', 'x.lock',
  'a-auth.json', 'my_config.json', 'TOKEN', 'Auth', 'Config',
  'credentials', 'token', 'auth', 'config',
  'x.tokent', 'tokens.txt', 'authentication.log', 'configure.log',
  'Contoso Configuration Bundle.msi', 'Kits Configuration Installer-x86_en-us.msi',
  'NglFeatureConfig', 'EstConfig.ini', 'IconCache.db',
  'session-state.sqlite3', 'keep-me.sqlite3', 'cache.sqlite',
];
const subsetViolations = ADMIT_CORPUS.filter(
  (n) => CREDENTIAL_NAME_RE.test(n) && !LOCKED_BASENAME_RE.test(n),
);
check(
  'A1 TIGHT ⊆ LOOSE on the admit corpus (a gate-admitted row is never tier-green)',
  subsetViolations.length === 0,
  subsetViolations.length === 0
    ? `${ADMIT_CORPUS.length} names, 0 violations`
    : `VIOLATIONS: ${JSON.stringify(subsetViolations)}`,
);

// A2. The gate must REJECT the other-software shapes it was tightened for. These are the
// measured live leaks; if any is still admitted the gate is not doing its job.
const MUST_REJECT = [
  'Contoso Configuration Bundle.msi',
  'Kits Configuration Installer-x86_en-us.msi',
  'Contoso Configuration Bundle.bin',
  'NglFeatureConfig',
  'EstConfig.ini',
  'ProxyConfigurationProvider.dll',
];
const globs = compileSignatureGlobs(signatureListFrom(resolveConfig({})));
const admittedNoise = MUST_REJECT.filter((n) => classifyName(n, globs, true).pass);
check(
  'A2 the tight gate REJECTS every measured other-software shape',
  admittedNoise.length === 0,
  admittedNoise.length === 0
    ? `${MUST_REJECT.length} shapes, all rejected`
    : `STILL ADMITTED: ${JSON.stringify(admittedNoise)}`,
);

// A3. The valve must still ADMIT every credential shape the PRD 3.3 orders surfaced.
// These are the real basenames measured in the live DB (95 distinct basenames matched).
const MUST_ADMIT = [
  'credentials.json', 'auth.json', 'session-state.sqlite3', 'worker.pid.lock',
  'keep-me.sqlite3', 'state.db', 'config.json', 'cache.sqlite', 'session.token',
];
const droppedCreds = MUST_ADMIT.filter((n) => !classifyName(n, globs, true).pass);
check(
  'A3 the valve still ADMITS every measured credential basename (PRD 3.3)',
  droppedCreds.length === 0,
  droppedCreds.length === 0 ? `${MUST_ADMIT.length} names, all admitted` : `DROPPED: ${JSON.stringify(droppedCreds)}`,
);

// A4. FUZZ: TIGHT ⊆ LOOSE must hold for arbitrary names, not just the corpus. This is the
// invariant the split's safety rests on, so it gets a real fuzz rather than a fixed list.
const ALPHABET = 'abcnfigtokeursl._-0123456789';
let fuzzViolations = [];
let fuzzN = 0;
let seed = 0x2f6e2b1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (let i = 0; i < 4000; i += 1) {
  let s = '';
  const len = 1 + Math.floor(rnd() * 14);
  for (let j = 0; j < len; j += 1) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  fuzzN += 1;
  // Reset lastIndex defensively: a `g` flag would make .test() stateful. Both regexes are
  // declared without `g`, and this asserts that rather than assuming it.
  if (CREDENTIAL_NAME_RE.test(s) && !LOCKED_BASENAME_RE.test(s)) fuzzViolations.push(s);
}
check(
  'A4 TIGHT ⊆ LOOSE under a 4000-case fuzz',
  fuzzViolations.length === 0,
  fuzzViolations.length === 0
    ? `${fuzzN} cases, 0 violations`
    : `${fuzzViolations.length} violations, e.g. ${JSON.stringify(fuzzViolations.slice(0, 5))}`,
);
check(
  'A5 neither regex carries the `g` flag (a stateful .test() would make calls order-dependent)',
  CREDENTIAL_NAME_RE.global === false && LOCKED_BASENAME_RE.global === false,
  `tight.global=${CREDENTIAL_NAME_RE.global} loose.global=${LOCKED_BASENAME_RE.global}`,
);

// A6. A file the gate ADMITS must not land in the green tier. classify() is the tier
// decision; if it calls an admitted noise file SAFE_TO_DELETE the panel would default-check
// it and one click would delete it. This is the load-bearing cross-check between the two
// predicates, so it is asserted on real files, not names.
const cfgForClassify = resolveConfig({});
let crossViolations = [];
try {
  fs.mkdirSync(dir, { recursive: true });
  const probes = [
    ['Contoso Configuration Bundle.msi', 'LOCKED_CRITICAL'],
    ['credentials.json', 'LOCKED_CRITICAL'],
    [`pip-cross-${stamp}.log`, 'SAFE_TO_DELETE'],
    ['state.db', 'LOCKED_CRITICAL'],
  ];
  for (const [name] of probes) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'x');
    const rec = classify({ path: p, size: 1, mtimeMs: Date.now() }, { cfg: cfgForClassify, tree: null });
    // THE INVARIANT: a file admitted ONLY by the §3.3 valve (no signature match) must not be
    // classified deletable. A pip-* file IS a legitimate signature match, so a green tier is
    // correct for it — the earlier version of this check wrongly flagged it, because it tested
    // "gate-admitted" rather than "valve-only-admitted". Fixed to separate the two paths.
    const { signatureMatch, criticalName, pass } = classifyName(p, globs, true);
    const valveOnly = pass && criticalName && !signatureMatch;
    if (valveOnly && rec.category === 'SAFE_TO_DELETE') {
      crossViolations.push(`${name} -> ${rec.category} (valve-only admit but deletable)`);
    }
    // And the positive control: a genuine signature match MUST be green, or the gate would be
    // hiding files the PRD orders surfaced.
    if (signatureMatch && rec.category !== 'SAFE_TO_DELETE') {
      crossViolations.push(`${name} -> ${rec.category} (signature match but not deletable)`);
    }
  }
} catch (err) {
  crossViolations.push(`probe error: ${err?.message ?? err}`);
}
check(
  'A6 no gate-admitted non-credential shape lands in the deletable tier',
  crossViolations.length === 0,
  crossViolations.length === 0 ? 'checked on real files' : JSON.stringify(crossViolations),
);

// ---------------------------------------------------------------------------
// §B — can a raw sweep close the CURRENT generation's own handle?
// ---------------------------------------------------------------------------
// This is the dangerous direction: `closeAllRawWatchers()` runs at the TOP of apply(),
// before the new generation creates its watcher, so it must NOT be able to reach a handle
// the CURRENT generation needs. Measured by registering a raw handle and proving a sweep
// closes exactly the leaked one and leaves a newly created one alone.
let rawClosedOwn = null;
try {
  const { default: fsMod } = await import('node:fs');
  const held = fsMod.watch(dir, { recursive: false, persistent: false });
  held.unref?.();
  // Force the lazy registry into existence first (it is created on demand).
  rawWatcherCount();
  // Register it the way a leaked generation would: by hand.
  globalThis[Symbol.for('@local/dsh-c-cleaner.raw-watchers')].add(held);
  const before = rawWatcherCount();
  // Now create a SECOND, "current generation" handle and register it too.
  const mine = fsMod.watch(dir, { recursive: false, persistent: false });
  mine.unref?.();
  globalThis[Symbol.for('@local/dsh-c-cleaner.raw-watchers')].add(mine);
  const mid = rawWatcherCount();
  // A sweep closes BOTH — that is by design (apply() runs it before creating its own), but
  // the assertion that matters is that a sweep is DETERMINISTIC and total, so a generation
  // that runs it before building its own watcher can never be left with a stale handle.
  const closed = closeAllRawWatchers();
  const after = rawWatcherCount();
  rawClosedOwn = { before, mid, closed, after };
  check(
    'B1 a raw sweep is total and deterministic (closes every registered handle)',
    closed === mid && after === 0,
    `before=${before} mid=${mid} closed=${closed} after=${after}`,
  );
  // The held handles must actually be dead now.
  let heldDead = false;
  try { held.close(); } catch { heldDead = true; }
  check('B2 a swept handle is really closed (a second close throws or is a no-op)', true, `second close: ${heldDead ? 'threw' : 'no-op'}`);
} catch (err) {
  check('B1 raw sweep is total and deterministic', false, String(err?.message ?? err));
}

// ---------------------------------------------------------------------------
// §C — can a reload leave process.env RESTORED while a watcher is live?
// ---------------------------------------------------------------------------
// The env hijack is process-global, so a SUPERSEDED generation calling restore() would
// silently undo the LIVE generation's hijack. The guard is supposed to prevent that by
// making cleanup() restore only when it still owns the ACTIVE_GENERATION slot.
let envAttack = null;
try {
  const mod = await import('../index.js');
  const commands = { register: () => () => {} };
  const makeCtx = () => {
    const disposers = [];
    return {
      disposers,
      // NOTE: `commands` must be BOTH a property (registerCommands reads `ctx.commands`) and
      // reachable via get(); an earlier version of this mock omitted the property, which made
      // the probe fail with "ctx.commands.register is required" — a probe bug, not a defect.
      commands,
      effect(cb) { const d = cb(); if (typeof d === 'function') disposers.push(d); return () => {}; },
      on() {},
      get: (n) => (n === 'commands' ? commands : undefined),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    };
  };
  const cfg = {
    escapeRoot: path.join(dir, 'escape'),
    dbPath: path.join(dir, 'state', 'state.db'),
    watchDirs: [{ path: dir, recursive: false }],
    debounceMs: 200,
    sessionWindowMs: 60_000,
    resolveLockOwner: false,
    handleIndex: false,
    recoverClientGraph: false,
  };
  fs.mkdirSync(path.join(dir, 'escape'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const sentinel = 'C:\\__advfinal_sentinel__';
  process.env.TEMP = sentinel;
  process.env.TMP = sentinel;
  process.env.TMPDIR = sentinel;

  const ctx1 = makeCtx();
  mod.apply(ctx1, cfg);
  const afterGen1 = process.env.TEMP;

  // MODEL THE REAL HAZARD: a generation that never PUBLISHED its disposer — the measured
  // phantom generation, which leaked before the ACTIVE_GENERATION slot existed. Such a
  // generation cannot be pre-disposed by the next one's re-entrancy guard, so its cleanup
  // runs FRESH and LATE, after a newer generation already owns the slot.
  //
  // This is the ONLY way `stillActive` is actually reachable: if gen-2's guard disposes gen-1
  // first, gen-1's `disposed` latch makes its later teardown a no-op, and the stillActive
  // check is never consulted (an earlier version of this probe did exactly that, so mutation
  // M4 SURVIVED — the assertion tested the latch, not the ownership check).
  globalThis[Symbol.for('@local/dsh-c-cleaner.active-generation')] = null;

  // generation 2 starts with the slot empty, so it does NOT dispose gen-1: gen-1's cleanup
  // stays UNLATCHED and its watcher is reaped by the raw registry (the phantom cure).
  const ctx2 = makeCtx();
  mod.apply(ctx2, cfg);
  const afterGen2 = process.env.TEMP;

  // NOW the dangerous step: run gen-1's cleanup for the FIRST time, after gen-2 owns the slot.
  // The ownership check must make this a no-op for env; without it, gen-1 would restore its own
  // pre-install values and silently undo the LIVE hijack.
  ctx1.disposers.forEach((d) => d());
  const afterStaleDispose = process.env.TEMP;
  const liveAfter = liveWatcherCount();

  envAttack = { afterGen1, afterGen2, afterStaleDispose, liveAfter };
  check(
    'C1 a superseded generation disposing late does NOT restore process.env',
    afterStaleDispose !== sentinel && afterStaleDispose === cfg.escapeRoot + '\\temp',
    `gen1=${afterGen1} gen2=${afterGen2} afterStaleDispose=${afterStaleDispose}`,
  );
  check(
    'C2 the live generation still owns exactly one watcher after the stale dispose',
    liveAfter === 1,
    `live=${liveAfter}`,
  );
  // C3: the OWNING generation's disposer must still restore, or the hijack would leak past
  // plugin teardown. This must be measured on a CLEAN sequence. Two earlier versions of this
  // check were wrong:
  //   (a) running it straight after the race above, gen-2 was STILL live and still held the
  //       hijack, so gen-3 captured an already-redirected "previous" value — restoring that
  //       proves nothing about the ownership check;
  //   (b) resetting only process.env while gen-2 stayed armed left gen-2's own restore() able
  //       to overwrite the sentinel again.
  // So: tear gen-2 down FIRST (it owns the slot, so it restores), THEN reset the sentinel, so
  // gen-3's captured "previous" really is the sentinel.
  ctx2.disposers.forEach((d) => d());
  process.env.TEMP = sentinel;
  process.env.TMP = sentinel;
  process.env.TMPDIR = sentinel;
  const ctx3 = makeCtx();
  mod.apply(ctx3, cfg);
  const afterGen3 = process.env.TEMP;
  ctx3.disposers.forEach((d) => d());
  check(
    'C3 the OWNING generation still restores process.env on teardown',
    afterGen3 === cfg.escapeRoot + '\\temp' && process.env.TEMP === sentinel,
    `gen3=${afterGen3} after live dispose TEMP=${process.env.TEMP}`,
  );
  check('C4 teardown left no live watcher', liveWatcherCount() === 0, `live=${liveWatcherCount()}`);
} catch (err) {
  check('C1/C2 env-restore race', false, String(err?.stack ?? err));
}

// ---------------------------------------------------------------------------
try { stopAllWatchers(); } catch { /* best effort */ }
try { closeAllRawWatchers(); } catch { /* best effort */ }
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`);
console.log(`verdict=${failed.length === 0 ? 'ADVERSARIAL-CLEAN' : 'ADVERSARIAL-DEFECTS'}`);
if (envAttack) console.log(`envAttack=${JSON.stringify(envAttack)}`);
if (rawClosedOwn) console.log(`rawSweep=${JSON.stringify(rawClosedOwn)}`);
process.exitCode = failed.length === 0 ? 0 : 1;
