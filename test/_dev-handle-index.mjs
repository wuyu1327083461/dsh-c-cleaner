// test/_dev-handle-index.mjs — dsh-c-cleaner / handle-backend (task-11 dev probe)
//
// Proves lib/handle-index.js against CONTRACTS-PHASE2.md §3, with captured literal output:
//   S1  bogus pythonPath      -> start() resolves FALSE (not a rejection), stats().available === false
//   S2  lookup() on empty cache -> null, with no child handle and no bridge pid
//   S3  REAL sweep, rootPid=process.pid -> a file this process holds open with fs.openSync(p,'r+')
//       is attributed to THIS pid (via lookup() and via probe(), the ProcessTree seam);
//       also key normalisation, sweep() coalescing, and the exact stats() shape
//   S4  auto-disable with budgetMs:0 (3 consecutive slow sweeps) while lookup() keeps serving
//   S5  stop() idempotent, bridge gone, no python child of ours outlives it
//   S6  never-throws fence (ENOENT interpreter, lookup(null/undefined/123/{}), probe(null))
//
// Optional: CC_HANDLE_ROOT_PID=<pid> sweeps a bigger real tree (e.g. the live dsh harness
// process) instead of this process. The held-file attribution check is then scored only
// when this probe is provably inside that tree; otherwise the probe asserts the honest
// miss, or reports the case as unscored when membership cannot be proved at all (an
// exited intermediate ancestor breaks the parent chain).
//
// Every step prints CHECK lines and the run ends with a single machine-readable SUMMARY
// line. Missing python/psutil keeps the process-side scenario honest instead of failing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { HandleIndex } from '../lib/handle-index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRATCH = path.join(REPO, 'test', '.tmp-handle-index');

const lines = [];
const summaries = {};
let failures = 0;

function log(...args) {
  const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  lines.push(text);
  process.stdout.write(text + '\n');
}

function check(name, ok, detail) {
  if (!ok) failures += 1;
  log(`CHECK ${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`);
  return ok;
}

/** Literal-ish logger so the degradation path is captured, not asserted. */
function makeLog(tag) {
  const out = [];
  const mk = (level) => (...args) => {
    const text = `[${level}] ${args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')}`;
    out.push(text);
    log(`  ${tag} ${text}`);
  };
  return { lines: out, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };
}

/** Count live python processes (task's own verification method). */
function pythonCount() {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-Process python -ErrorAction SilentlyContinue | Measure-Object).Count',
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const n = parseInt(String(r.stdout || '').trim(), 10);
  return Number.isFinite(n) ? n : -1;
}

/** Pids of python processes whose PARENT is this probe process — i.e. the bridge(s)
 *  this test itself spawned. A machine-wide count is racy (other agents run python),
 *  so orphan detection is scoped to our own children. */
function pythonChildrenOfSelf() {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.ParentProcessId -eq ${process.pid} } | Select-Object -ExpandProperty ProcessId`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return String(r.stdout || '').trim().split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number);
}

/** One CIM snapshot -> Map(pid -> ppid). Used only to decide whether THIS probe
 *  process is inside the swept tree; empty Map means "unknown", never "no". */
function processTable() {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const txt = String(r.stdout || '');
  const start = txt.search(/[[{]/);
  if (start < 0) return new Map();
  let data;
  try {
    data = JSON.parse(txt.slice(start));
  } catch {
    return new Map();
  }
  const rows = Array.isArray(data) ? data : [data];
  const table = new Map();
  for (const row of rows) table.set(Number(row.ProcessId), Number(row.ParentProcessId));
  return table;
}

/** true / false / null(unknown) — whether `pid` sits inside `ancestorPid`'s tree.
 *  An exited intermediate ancestor drops out of the process table, which breaks the
 *  chain; that is "cannot prove membership" (null), NOT "not a descendant". */
function isDescendantOf(pid, ancestorPid) {
  if (pid === ancestorPid) return true;
  const table = processTable();
  if (table.size === 0) return null;
  let cur = pid;
  for (let i = 0; i < 64; i += 1) {
    const parent = table.get(cur);
    if (parent === undefined) return null; // chain broken by an exited ancestor
    if (!Number.isFinite(parent) || parent <= 0) return false;
    if (parent === ancestorPid) return true;
    if (parent === cur) return false;
    cur = parent;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  log(`# dsh-c-cleaner test/_dev-handle-index.mjs  (node ${process.version}, pid ${process.pid})`);
  log(`# scratch ${SCRATCH}`);

  /* ---------------- S1: bogus pythonPath degrades honestly ---------------- */
  log('# --- S1 bogus pythonPath -> start() false, no throw ---');
  {
    const logr = makeLog('S1');
    const hi = new HandleIndex({
      log: logr,
      pythonPath: path.join(SCRATCH, 'definitely-not-python.exe'),
      rootPid: process.pid,
      sweepMs: 60000,
    });
    let threw = false;
    let result = 'THREW';
    try {
      result = await hi.start();
    } catch (err) {
      threw = true;
      log(`  S1 start() REJECTED: ${err && err.message}`);
    }
    const st = hi.stats();
    check('S1 start() resolves (no rejection)', threw === false, `threw=${threw}`);
    check('S1 start() === false', result === false, `result=${result}`);
    check('S1 stats().available === false', st.available === false, JSON.stringify(st));
    check('S1 lookup() on unavailable index === null', hi.lookup('C:\\Temp\\whatever.tmp') === null);
    check('S1 probe() on unavailable index === null', (await hi.probe('C:\\Temp\\whatever.tmp')) === null);
    check(
      'S1 start() again still false (no zombie retry loop)',
      (await hi.start()) === false,
    );
    hi.stop();
    hi.stop(); // idempotent even when nothing was ever spawned
    summaries.S1 = { start: result, available: st.available, disabled: st.disabled, warns: logr.lines.length };
  }

  /* ---------------- S3 setup: hold a file open in THIS process ---------------- */
  const heldPath = path.join(SCRATCH, `handle-index-held-${process.pid}.tmp`);
  fs.writeFileSync(heldPath, 'held-open-by-the-node-process\n');
  const heldFd = fs.openSync(heldPath, 'r+');
  log(`# held open (fd ${heldFd}): ${heldPath}`);

  const pyCountBefore = pythonCount();
  log(`# python process count before start: ${pyCountBefore}`);

  // Default root is this process (the task's requirement). CC_HANDLE_ROOT_PID lets the
  // SAME probe be re-run against a bigger real tree (e.g. the dsh node process) without
  // editing it. The held-file attribution check is only meaningful when THIS process is
  // inside the swept tree, so that mode is detected rather than assumed.
  const rootPid = Number.isInteger(Number(process.env.CC_HANDLE_ROOT_PID)) && Number(process.env.CC_HANDLE_ROOT_PID) > 0
    ? Number(process.env.CC_HANDLE_ROOT_PID)
    : process.pid;
  const selfInTree = rootPid === process.pid ? true : isDescendantOf(process.pid, rootPid);
  log(`# sweep root pid: ${rootPid}${rootPid === process.pid ? ' (this process)' : ' (from CC_HANDLE_ROOT_PID)'}`);
  log(`# is this probe process (pid ${process.pid}) inside that tree? ${selfInTree === null ? 'unknown' : selfInTree}`
    + (selfInTree === false ? ' -> held-file attribution is IMPOSSIBLE in this mode; the probe asserts the honest negative instead' : ''));

  /* ---------------- S2: empty cache, real backend ---------------- */
  const realLog = makeLog('MAIN');
  const hi = new HandleIndex({ log: realLog, rootPid, sweepMs: 60000 });
  log('# --- S2 lookup() on an empty (never-swept) cache ---');
  {
    const pyBefore = pythonCount();
    const missed = hi.lookup(heldPath);
    const pyAfter = pythonCount();
    check('S2 lookup() before any sweep === null', missed === null, JSON.stringify(missed));
    log(`# python process count across lookup() on empty cache: ${pyBefore} -> ${pyAfter} (informational; shared machine)`);
    // The decisive proof that lookup() cannot spawn: no child object and no bridge pid,
    // and lookup() is synchronous — it has no await point where a spawn could resolve.
    check('S2 lookup() left no child handle and no bridge pid', hi._child === null && hi._childPid === null, `child=${hi._child} childPid=${hi._childPid}`);
    const st = hi.stats();
    check('S2 stats() before start: sweeps=0 files=0 lastAt=0', st.sweeps === 0 && st.files === 0 && st.lastAt === 0, JSON.stringify(st));
    summaries.S2 = { lookup: missed, childSpawned: hi._child !== null, pythonBefore: pyBefore, pythonAfter: pyAfter, stats: st };
  }

  /* ---------------- S3: real sweep + attribution ---------------- */
  log('# --- S3 real start() + one honest sweep (rootPid=process.pid) ---');
  const t0 = Date.now();
  const started = await hi.start();
  const startMs = Date.now() - t0;
  log(`# start() = ${started} in ${startMs} ms; stats=${JSON.stringify(hi.stats())}`);
  check('S3 start() === true with real python', started === true, `startMs=${startMs}`);
  check('S3 stats().available === true', hi.stats().available === true);

  const sweep = await hi.sweep();
  log(`# sweep() = ${JSON.stringify(sweep)}`);
  check('S3 sweep().ok === true', sweep.ok === true, JSON.stringify(sweep));
  check('S3 sweep() reported members >= 2 (root + python bridge)', sweep.members >= 2, `members=${sweep.members}`);

  const hit = hi.lookup(heldPath);
  log(`# lookup(${heldPath}) = ${JSON.stringify(hit)}`);
  if (selfInTree === true) {
    check('S3 held-open file attributed to the correct pid', !!hit && hit.pid === process.pid, JSON.stringify(hit));
    check('S3 attributed owner name is node', !!hit && /^node/i.test(hit.name), hit ? hit.name : 'null');
    const viaProbe = await hi.probe(heldPath);
    check('S3 probe() (the ProcessTree seam) returns the same owner', !!viaProbe && viaProbe.pid === process.pid, JSON.stringify(viaProbe));
  } else if (selfInTree === false) {
    // This probe process is NOT inside the swept tree, so the file it holds cannot be
    // attributed by that tree's handle map. The honest expectation is a MISS, and the
    // sweep must still be a successful real sweep (proved by members/files above).
    check('S3 file held OUTSIDE the swept tree is not attributed (honest miss)', hit === null, JSON.stringify(hit));
    const viaProbeOutside = await hi.probe(heldPath);
    check('S3 probe() agrees with lookup() (both null)', viaProbeOutside === null, JSON.stringify(viaProbeOutside));
    summaries.S3_OUTSIDE_TREE = { rootPid, selfPid: process.pid, selfInTree, hitIsNull: hit === null };
  } else {
    // Membership could not be proved (a transient intermediate ancestor exited and broke
    // the chain). Neither expectation may be asserted, so this is reported, not scored.
    const viaProbeUnknown = await hi.probe(heldPath);
    log(`# NOTE (not scored): tree membership unprovable; observed held-file lookup=${JSON.stringify(hit)} probe=${JSON.stringify(viaProbeUnknown)}; the sweep itself was ${sweep.ok ? 'ok' : 'FAILED'}`);
    summaries.S3_MEMBERSHIP_UNKNOWN = { rootPid, selfPid: process.pid, observed: hit };
  }

  // Key normalisation: forward slashes + UPPERCASE must land on the same cache key.
  const weird = heldPath.replace(/\\/g, '/').toUpperCase();
  const hitWeird = hi.lookup(weird);
  check('S3 lookup() normalises / -> \\ and lowercases', JSON.stringify(hitWeird) === JSON.stringify(hit), `${weird} -> ${JSON.stringify(hitWeird)}`);
  check('S3 lookup() on a path nobody holds === null', hi.lookup(path.join(SCRATCH, 'nobody-holds-this.tmp')) === null);

  // A path that IS in the cache (for the later "cache survives" checks). In the default
  // mode this is the file we hold; in root-override mode it is any real cached entry.
  const cachedKey = hit ? heldPath : (hi._map.size > 0 ? hi._map.keys().next().value : null);
  const cachedOwner = cachedKey === null ? null : hi.lookup(cachedKey);
  log(`# cached entry used for the cache-survival checks: ${cachedKey} -> ${JSON.stringify(cachedOwner)}`);

  const stAfter = hi.stats();
  check(
    'S3 stats() shape exact',
    Object.keys(stAfter).sort().join(',') ===
      'available,avgMs,denied,disabled,files,lastAt,lastMs,sweeps'.split(',').sort().join(','),
    Object.keys(stAfter).join(','),
  );
  check('S3 stats().sweeps >= 1 and lastAt > 0', stAfter.sweeps >= 1 && stAfter.lastAt > 0, JSON.stringify(stAfter));

  // Coalescing: two concurrent sweeps must be one bridge round-trip.
  {
    const before = hi.stats().sweeps;
    const [a, b] = await Promise.all([hi.sweep(), hi.sweep()]);
    const after = hi.stats().sweeps;
    log(`# coalesced sweeps: ${before} -> ${after} (a.ok=${a.ok} b.ok=${b.ok})`);
    check('S3 concurrent sweep() calls coalesce (one command)', after - before === 1, `${before}->${after}`);
  }

  // Sustained cost: 2 extra honest sweeps for the avg.
  for (let i = 0; i < 2; i += 1) {
    const s = await hi.sweep();
    log(`# sweep #${i + 2} = ${JSON.stringify(s)}`);
  }
  const stSustained = hi.stats();
  log(`# sustained stats = ${JSON.stringify(stSustained)}`);
  summaries.S3 = { rootPid, startMs, sweeps: stSustained.sweeps, members: sweep.members, files: sweep.files, denied: sweep.denied, lastMs: sweep.ms, avgMs: stSustained.avgMs, heldPid: hit ? hit.pid : null, heldName: hit ? hit.name : null };
  summaries.S3_STATS = stSustained;

  /* ---------------- S4: auto-disable on budgetMs ---------------- */
  log('# --- S4 auto-disable with budgetMs: 0, maxConsecutiveSlow: 3 ---');
  {
    const log4 = makeLog('S4');
    const hi4 = new HandleIndex({ log: log4, rootPid: process.pid, sweepMs: 60000, budgetMs: 0, maxConsecutiveSlow: 3 });
    const ok4 = await hi4.start();
    check('S4 start() true', ok4 === true);
    // start() already fired one warm-up sweep asynchronously; wait for it to settle.
    await hi4.sweep();
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      seen.push(await hi4.sweep());
      if (hi4.stats().disabled) break;
    }
    const st4 = hi4.stats();
    log(`# S4 disabled=${st4.disabled} after ${st4.sweeps} sweep(s); states=${JSON.stringify(seen.map((s) => (s.ok ? s.ms : s.error)))}`);
    check('S4 disabled === true', st4.disabled === true, JSON.stringify(st4));
    check('S4 further sweep() is refused with an error string', (await hi4.sweep()).ok === false && typeof (await hi4.sweep()).error === 'string');
    // hi4 sweeps rootPid=process.pid, so the file THIS process holds must be in its map.
    const served = hi4.lookup(heldPath);
    check(
      'S4 lookup() keeps serving the last good cache while disabled',
      !!served && served.pid === process.pid,
      `${heldPath} -> ${JSON.stringify(served)}`,
    );
    check('S4 the DISABLED warn was logged exactly once', log4.lines.filter((l) => l.includes('DISABLED after')).length === 1, `warns=${log4.lines.filter((l) => l.includes('DISABLED')).length}`);
    summaries.S4 = { disabled: st4.disabled, sweeps: st4.sweeps, budgetMs: 0, maxConsecutiveSlow: 3, cacheStillServing: !!served };
    hi4.stop();
  }

  /* ---------------- S5: stop() idempotent, no orphan ---------------- */
  log('# --- S5 stop() idempotent / no orphan python child ---');
  {
    const bridgePid = hi._childPid;
    log(`# bridge child pid before stop: ${bridgePid}`);
    hi.stop();
    hi.stop();
    hi.stop();
    const st5 = hi.stats();
    check('S5 stop() is idempotent (3 calls, no throw)', true);
    check('S5 stats().available === false after stop', st5.available === false, JSON.stringify(st5));
    let gone = false;
    for (let i = 0; i < 40; i += 1) {
      if (hi._child === null && hi._childPid === null) {
        try {
          process.kill(bridgePid, 0);
        } catch {
          gone = true;
          break;
        }
      }
      await sleep(100);
    }
    check('S5 bridge process is gone after stop()', gone, `bridgePid=${bridgePid}`);
    const pyAfter = pythonCount();
    const ownChildren = pythonChildrenOfSelf();
    log(`# python process count after stop: ${pyAfter} (before start: ${pyCountBefore}); python children of THIS probe: ${JSON.stringify(ownChildren)}`);
    // The machine-wide count is informational ONLY: this is a shared machine and other
    // agents (and this repo's own suite) run python concurrently, so it moves on its own
    // with zero involvement from HandleIndex. The scoped check below is the real proof.
    check('S5 no python child of this probe outlived stop()', ownChildren.length === 0, `ownChildren=${JSON.stringify(ownChildren)}`);
    summaries.S5 = {
      bridgePid,
      pythonBefore: pyCountBefore,
      pythonAfter: pyAfter,
      ownPythonChildren: ownChildren,
      orphan: ownChildren.length > 0,
    };
    check('S5 sweep() after stop() is falsy, not a throw', (await hi.sweep()).ok === false, JSON.stringify(await hi.sweep()));
    const served5 = cachedKey === null ? null : hi.lookup(cachedKey);
    check(
      'S5 lookup() after stop() still answers from cache',
      cachedKey !== null && JSON.stringify(served5) === JSON.stringify(cachedOwner),
      `${cachedKey} -> ${JSON.stringify(served5)}`,
    );
  }

  /* ---------------- S6: fences ---------------- */
  log('# --- S6 never-throws fence ---');
  {
    const hi6 = new HandleIndex({ log: makeLog('S6'), pythonPath: 'no-such-python-binary-xyz', rootPid: process.pid });
    const r6 = await hi6.start();
    check('S6 ENOENT interpreter -> false, no throw', r6 === false);
    check('S6 lookup(null/undefined/123/{}) all null', hi6.lookup(null) === null && hi6.lookup(undefined) === null && hi6.lookup(123) === null && hi6.lookup({}) === null);
    check('S6 probe(null) === null', (await hi6.probe(null)) === null);
    hi6.stop();
  }

  fs.closeSync(heldFd);
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }

  summaries.FAILURES = failures;
  summaries.NODE = process.version;
  const verdict = failures === 0 ? 'PASS' : `FAIL(${failures})`;
  log(`SUMMARY ${JSON.stringify({ verdict, pid: process.pid, node: process.version, ...summaries })}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  log(`FATAL ${err && err.stack ? err.stack : String(err)}`);
  log(`SUMMARY ${JSON.stringify({ verdict: 'FAIL(fatal)', ...summaries })}`);
  process.exitCode = 1;
});
