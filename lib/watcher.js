// lib/watcher.js — dsh-c-cleaner / watch-tracker
//
// Implements the FROZEN contract in CONTRACTS.md §6 exactly:
//
//   export class CWatcher {
//     constructor({ cfg, tree, log, onCandidate })   // onCandidate(Candidate) => void
//     start(): { watching: string[] }
//     stop(): void
//     stats(): { events:number, candidates:number, filtered:number, watching:string[] }
//   }
//
// Behaviour (PRD 3.2 + 6.1)
// ------------------------
// * One `fs.watch` per `cfg.watchDirs` entry, honouring that entry's `recursive` flag.
// * PERF RULE (PRD 6.1 / CONTRACTS §6): `recursive:true` is allowed ONLY on
//   `%LOCALAPPDATA%\Temp`. Any other entry arriving with `recursive:true` is forced
//   back to non-recursive (counted in `stats().recursiveForcedOff`) — belt and braces
//   against a bad config, because a recursive watch on `C:\Users\<u>` or on the
//   `%LOCALAPPDATA%` root is exactly what PRD 6.1 forbids.
// * Per-path debounce for `cfg.debounceMs`, measured from the LAST event on that path,
//   so a streaming log emits once, after it goes quiet (PRD 3.2).
// * After the debounce: statSync the path; drop it when it is not a regular file, when
//   it sits under a `protectRoot`, or when any of its path segments is an
//   `excludeNames` entry. Drops increment `filtered`.
// * PRD 3.2 NOISE GATE (Phase 2, CONTRACTS-PHASE2.md §2). A file that survives the
//   drops above is still admitted only when at least one of these holds:
//     (1) rule #1 — a handle lookup attributes it to a PID in the dsh process tree;
//     (2) rule #2 — its mtime falls inside the dsh session window AND its path matches
//         an AI-toolchain signature (`cfg.aiSignatureGlobs` / `cfg.excludeGlobs`, else
//         `DEFAULT_AI_SIGNATURES`);
//     (3) the §3.3 safety valve — its BASENAME matches `CREDENTIAL_NAME_RE`
//         (imported from lib/classifier.js, so the pattern cannot diverge). That predicate
//         is the WORD-boundary form, not the classifier's looser TIER pattern: the valve
//         must not readmit other-software noise such as
//         `Kits Configuration Installer-x86_en-us.msi` (measured live, PRD §3.2).
//   `cfg.noiseGate` selects the behaviour: 'enforce' (default) drops a non-admitted
//   file and counts it in BOTH `filtered` and `gated`; 'audit' counts it in `gated` but
//   still delivers; 'off' is the Phase 1 passthrough and never touches `gated`.
// * Every `fs.watch` is wrapped in try/catch; a failure lands in `stats().failed`
//   (`failedList` carries the reason) instead of throwing.
// * Every timer is `.unref()`d, on the debounce map AND on the watchers, so the
//   harness process can still exit while the plugin is loaded.
//
// Deliberate choices worth knowing
// --------------------------------
// * The watch is still OPENED for a directory that lives under a `protectRoot`; the
//   protection is applied per-event. That keeps the guarantee verifiable (the event is
//   really observed and really filtered) instead of being an unobservable "never
//   watched" side effect.
// * `onCandidate` may be async. An own-property `CANDIDATE_ATTRITION` (with a real
//   function body, so `fn.toString()` shows it) counts how often it rejected; the
//   rejection is logged, never rethrown, so one bad consumer cannot kill the watcher.
// * `_resolveOwner` never races: an attribution lookup is bounded by
//   `OWNER_LOOKUP_BUDGET_MS`; if it does not answer in time the candidate is emitted
//   with the best attribution known at that moment rather than being delayed forever.

import fs from 'node:fs';
import path from 'node:path';

// Phase 2 (CONTRACTS-PHASE2.md §2): the AI-toolchain signature list and the §3.3
// credential-name valve come from the two modules that already own those tables, so the
// gate can never silently diverge from the classifier's own name tables.
// Verified cycle-free: lib/classifier.js imports only `node:fs` / `node:path` statically
// (its `await import('./config.js')` is dynamic and caught), and lib/config.js imports
// only `node:os` / `node:path`. Neither ever imports this file.
import { DEFAULT_AI_SIGNATURES, NOISE_GATE_MODES } from './config.js';
import { CREDENTIAL_NAME_RE } from './classifier.js';

/* ---------------------------------------------------------------------------
 * Process-global live-watcher registry (Phase 2 hardening)
 * ---------------------------------------------------------------------------
 * HMR re-runs `apply()` for every file event. Each re-entry builds a NEW CWatcher
 * with a NEW `onCandidate` closure, and the superseded one is supposed to be torn
 * down by its own disposer. Measured on the live harness, that teardown does NOT
 * always happen for rapid successive reloads: two watcher generations stayed open
 * across every later reload (`START live=2`, one unpaired start), and the leftover
 * generation kept admitting files with the gate logic it was BORN with. The symptom
 * is vicious: a fix to the gate appears not to work, because a stale watcher is
 * still writing rows under the old rules.
 *
 * The registry is keyed by `Symbol.for`, i.e. it lives on `globalThis` and is shared
 * by every module generation, so a NEW generation can find and stop watchers leaked
 * by an OLD one. A module-scope `Set` could never do that: HMR re-imports this module
 * body, so each generation would get its own empty Set.
 * ------------------------------------------------------------------------- */
const WATCHER_REGISTRY = Symbol.for('dsh-c-cleaner.live-watchers');

/** @returns {Set<object>} the process-global set of started, not-yet-stopped watchers. */
function watcherRegistry() {
  const g = globalThis;
  if (!(g[WATCHER_REGISTRY] instanceof Set)) g[WATCHER_REGISTRY] = new Set();
  return g[WATCHER_REGISTRY];
}

/* -------------------------------------------------------------------------
 * RAW-HANDLE REGISTRY (Phase 2 hardening, measured necessity).
 *
 * The `CWatcher` registry above is not enough on its own. `stopAllWatchers()` can
 * only reach watchers whose *instance* was registered — so a watcher created by a
 * module generation that predates that registry stays armed forever, keeps
 * monitoring, and keeps admitting files under the gate rules it was born with.
 * That is exactly what was measured live: a superseded generation holding the OLD
 * loose `LOCKED_BASENAME_RE` kept writing `Contoso Configuration Bundle.bin` rows
 * while the CURRENT generation's own markers never saw the file at all.
 *
 * Such a leak is invisible to every in-process discovery API. Measured on this
 * host with the plugin's exact options (`fs.watch(dir, {recursive:false,
 * persistent:false})` + `unref()`):
 *   - `process._getActiveHandles()`      -> `[]`        (FSWatcher count 0)
 *   - `process.getActiveResourcesInfo()` -> no FSEventWrap
 *   - and the leaked watcher STILL delivered after that scan (2 deliveries).
 * So no reaper can find the handle by scanning.
 *
 * The cure is to never let it out of reach in the first place: register the RAW
 * `fs.FSWatcher` object itself in a `Symbol.for` slot on `globalThis`. Because the
 * slot is process-global it survives HMR's module re-import, so a NEW generation
 * can `close()` a predecessor's handles directly — without needing that
 * predecessor's instance, its disposer, or its cooperation.
 * ------------------------------------------------------------------------- */
const RAW_WATCHER_REGISTRY = Symbol.for('dsh-c-cleaner.raw-watchers');

/** @returns {Set<object>} the process-global set of open raw `fs.FSWatcher` handles. */
function rawWatcherRegistry() {
  const g = globalThis;
  if (!(g[RAW_WATCHER_REGISTRY] instanceof Set)) g[RAW_WATCHER_REGISTRY] = new Set();
  return g[RAW_WATCHER_REGISTRY];
}

/**
 * Close every raw `fs.FSWatcher` handle left open by ANY earlier generation.
 *
 * This is the last line of defence against the phantom-watcher leak: it needs no
 * `CWatcher` instance, no disposer and no registration by the leaking generation
 * beyond the handle itself. Closing an already-closed handle is harmless, so the
 * sweep is safe to run unconditionally on every `apply()`.
 *
 * @returns {number} how many raw handles were closed.
 */
export function closeAllRawWatchers() {
  const reg = rawWatcherRegistry();
  let closed = 0;
  for (const handle of [...reg]) {
    try {
      if (typeof handle?.close === 'function') handle.close();
      closed += 1;
    } catch {
      /* an already-closed handle, or one refusing to close, must not block startup */
    }
    reg.delete(handle);
  }
  return closed;
}

/** @returns {number} how many raw `fs.FSWatcher` handles are currently registered. */
export function rawWatcherCount() {
  return rawWatcherRegistry().size;
}

/**
 * Stop every live watcher in this process except `keep`.
 *
 * Called by `apply()` before it builds its own watcher, so a leaked generation from
 * any earlier reload cannot keep monitoring (and admitting files) alongside the
 * current one. `keep` exists so a caller that has already built its watcher can prune
 * the rest without stopping itself.
 *
 * @param {object|null} [keep] - a watcher to leave running.
 * @returns {number} how many leaked watchers were stopped.
 */
export function stopAllWatchers(keep = null) {
  const reg = watcherRegistry();
  let stopped = 0;
  for (const watcher of [...reg]) {
    if (watcher === keep) continue;
    try {
      watcher.stop();
    } catch {
      /* a watcher that refuses to stop must not block the new generation */
    }
    // Force-remove from the registry even if this instance's `stop()` came from a module
    // generation whose `stop()` did not yet unregister itself. Without this, one half-updated
    // generation can leave a permanent phantom entry that inflates the live count and makes
    // every later `stopAllWatchers()` believe it has nothing left to do.
    //
    // This force-delete is only SAFE because of the RAW-handle registry: a `stop()` that threw
    // leaves its raw `fs.FSWatcher` registered (see `_closeWatcher`), so the still-armed handle
    // stays reachable via `closeAllRawWatchers()` even though its instance entry is gone.
    // Measured on this host: a handle created with the plugin's own options
    // (`persistent:false` + `unref()`) is INVISIBLE to `process._getActiveHandles()`, so once
    // it is dropped from EVERY registry it can never be found or closed again. Do not remove
    // the raw registry without re-checking that measurement.
    reg.delete(watcher);
    stopped += 1;
  }
  return stopped;
}

/** @returns {number} how many watchers are currently registered as live. */
export function liveWatcherCount() {
  return watcherRegistry().size;
}

// WARNING — module-init order is load-bearing in this file.
// `broadRoots()` is evaluated at module-init time (see BROAD_ROOTS below) and calls
// `normRoot` -> `canonicalKey` -> `stripDevicePrefix`. Any binding used on that path MUST
// be declared ABOVE `broadRoots()`. Declaring `DEVICE_PREFIX` further down threw
// "ReferenceError: Cannot access 'DEVICE_PREFIX' before initialization" and the module
// failed to load at all, so keep these helpers first.

/** `\\?\` or `\\.\` device prefix, in either slash direction. */
const DEVICE_PREFIX = /^[/\\]{2}[?.][/\\]/;

/**
 * Drop a Win32 device prefix so every path lives in ONE key space.
 *
 * `path.resolve()` deliberately PRESERVES `\\?\C:\x` (verified), so without this a
 * configured watch dir spelled that way would be stored and matched verbatim and the
 * device prefix would ride along into the emitted Candidate — where it defeats prefix
 * matching against defensively-spelled protectRoots (PRD 6.2).
 *
 * `\\?\UNC\srv\share` collapses back to the ordinary UNC form `\\srv\share`.
 * Lexical only: no fs call, safe to run per event.
 * @param {string} p
 */
function stripDevicePrefix(p) {
  const s = String(p);
  if (!DEVICE_PREFIX.test(s)) return s;
  const rest = s.slice(4); // past the prefix: `\\?\` or `\\.\` -> 4 chars
  if (/^UNC[/\\]/i.test(rest)) return `\\\\${rest.slice(4)}`; // \\?\UNC\srv\share -> \\srv\share
  return rest;
}

/** Absolute, lowercased key used for every path compare. */
function canonicalKey(p) {
  let abs = path.resolve(stripDevicePrefix(String(p))).toLowerCase();
  abs = stripDevicePrefix(abs);
  // `path.resolve('C:\\')` normalises to `c:\`; strip the trailing separator so every
  // root compare can use the plain `key === root || key.startsWith(root + sep)` form.
  // A bare drive root is special-cased to KEEP its separator, so it stays distinguishable
  // from a relative path and still prefix-matches everything on that drive.
  if (/^[a-z]:[/\\]?$/.test(abs)) return `${abs[0]}:${path.sep}`;
  return abs.endsWith(path.sep) ? abs.slice(0, -1) : abs;
}

/** Same normalisation as {@link canonicalKey}, for the static broad-root list. */
function normRoot(p) {
  return canonicalKey(p);
}

/**
 * Broad roots that must NEVER be watched recursively (PRD 6.1). Everything at or above
 * a user profile, an AppData root, a system root or a drive root is off limits; only
 * narrower "designated subfolders" may be recursive, which is what PRD 6.1 allows
 * ("recursive=True 仅限指定的子文件夹") and what CONTRACTS §6 means by "Only
 * %LOCALAPPDATA%\Temp is recursive" (that is the only recursive entry in config.js).
 */
function broadRoots() {
  const env = process.env;
  const roots = [];
  const push = (p) => {
    if (p && typeof p === 'string') roots.push(normRoot(p));
  };
  push(env.SystemRoot || 'C:\\Windows');
  push(env.ProgramFiles);
  push(env['ProgramFiles(x86)']);
  push(env.ProgramData);
  push(env.USERPROFILE);
  push(env.LOCALAPPDATA);
  push(env.APPDATA);
  push(env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : null);
  return roots;
}

/** @type {string[]} */
const BROAD_ROOTS = broadRoots();

/** Cap on how long an attribution lookup may delay a candidate. */
const OWNER_LOOKUP_BUDGET_MS = Number(process.env.CC_OWNER_LOOKUP_BUDGET_MS) || 1500;

function normalizeLog(log) {
  const out = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  if (log && typeof log === 'object') {
    for (const key of ['debug', 'info', 'warn', 'error']) {
      if (typeof log[key] === 'function') out[key] = log[key].bind(log);
    }
  }
  return out;
}

/** Expand `%NAME%`, `~` and `./` so the perf guard can recognise real paths. */
function expandPath(p) {
  let s = String(p == null ? '' : p).trim();
  if (s.length === 0) return s;
  if (s.startsWith('~')) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (home) s = home + s.slice(1);
  }
  s = s.replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return key ? String(process.env[key]) : whole;
  });
  return path.resolve(s);
}

/**
 * Resolve a configured watch directory to its one canonical long-form spelling.
 *
 * WHY THIS EXISTS (DEFECT 3, CRITICAL): passing a directory addressed by a genuine 8.3
 * alias (`C:\PROGRA~3\...`) straight to `fs.watch` makes libuv fail-fast —
 * `Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72`
 * — which ABORTS the whole host process (exit 0xC0000409). An abort is not an exception,
 * so the try/catch around `fs.watch` cannot intercept it. `realpathSync.native` expands
 * the alias to the long name (and strips any `\\?\` prefix), so `fs.watch` is only ever
 * handed a spelling libuv agrees with.
 *
 * Called ONCE per configured directory in `start()` — never per event, because PRD 6.1
 * forbids an fs call per candidate.
 *
 * On failure (absent/denied) the configured spelling is returned unchanged so `start()`
 * still degrades into `_fail()` instead of refusing to watch at all.
 * @param {string} dir
 * @returns {string}
 */
function resolveWatchDir(dir) {
  try {
    const real = fs.realpathSync.native(dir);
    if (typeof real === 'string' && real.length > 0) return stripDevicePrefix(real);
  } catch (err) {
    // left as the configured spelling on purpose; start() reports the real failure
  }
  return stripDevicePrefix(dir);
}

/** True for a bare drive root such as `c:\`. */
function isDriveRoot(key) {
  return /^[a-z]:\\?$/.test(key);
}

/**
 * Case-insensitive "is at or under one of these roots" test.
 * `C:\Windows` matches `C:\Windows\System32\x` but NOT `C:\WindowsApps` because the
 * child test is anchored on the separator-terminated form of the root. The root itself
 * is matched through the bare form, so `C:\Windows` is protected too.
 * @param {string} filePath
 * @param {Array<{abs:string, key:string, sep:string}>} roots
 */
function isUnderRoots(filePath, roots) {
  if (roots.length === 0) return false;
  const key = canonicalKey(filePath);
  for (const root of roots) {
    if (key === root.key) return true; // the protected root itself
    if (key.startsWith(root.sep)) return true; // a child of the protected root
  }
  return false;
}

/** Compile a glob (`*`, `?`, `**`) to an anchored, case-insensitive RegExp. */
function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i += 1;
        out += '.*';
        if (g[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/**
 * Does this path look like AI-toolchain noise? Per CONTRACTS §6 this is what allows a
 * candidate in EVEN IF `tree.ownerOf()` could not confirm a tree member, provided the
 * file was written inside the dsh session window (PRD 3.2 attribution rule #2).
 */
function matchesAnyGlob(filePath, globs) {
  // Guard: this runs inside a debounce setTimeout callback, where an uncaught throw
  // is fatal for the whole harness process (exit code 1, crash-loop). A missing or
  // non-array glob list must fail CLOSED (no match), never throw.
  if (!Array.isArray(globs) || globs.length === 0) return false;
  const slash = String(filePath).replace(/\\/g, '/');
  const base = slash.slice(slash.lastIndexOf('/') + 1);
  for (const re of globs) {
    if (re.test(slash) || re.test(base)) return true;
  }
  return false;
}

/* ---------------------------------------------------------------------------
 * The PRD §3.2 admission decision, as PURE functions
 * ---------------------------------------------------------------------------
 * These are exported so a *retrospective* consumer (the stale-row purge in
 * `lib/web-api.js`) applies the SAME test as the live gate instead of growing a
 * second, drifting copy of the signature table. One decision, one implementation.
 * ------------------------------------------------------------------------- */

/**
 * Resolve the configured AI-toolchain signature list, in priority order:
 * `cfg.aiSignatureGlobs`, then its `cfg.excludeGlobs` alias, then the built-in
 * `DEFAULT_AI_SIGNATURES`. Mirrors the watcher constructor exactly.
 *
 * @param {object} cfg resolved config
 * @returns {string[]}
 */
export function signatureListFrom(cfg) {
  const raw = Array.isArray(cfg?.aiSignatureGlobs)
    ? cfg.aiSignatureGlobs
    : Array.isArray(cfg?.excludeGlobs)
      ? cfg.excludeGlobs
      : DEFAULT_AI_SIGNATURES;
  return (Array.isArray(raw) ? raw : []).filter((g) => typeof g === 'string' && g.length > 0);
}

/**
 * Compile a signature list into the RegExp array the gate matches against.
 * @param {unknown} list
 * @returns {RegExp[]}
 */
export function compileSignatureGlobs(list) {
  return (Array.isArray(list) ? list : [])
    .filter((g) => typeof g === 'string' && g.length > 0)
    .map(globToRegExp);
}

/**
 * The NAME half of PRD §3.2 rule #2, plus the §3.3 safety valve.
 *
 * Deliberately the only part of the admission decision that can be re-evaluated
 * after the fact: rule #1 (handle reverse-lookup) asks about the state of a process
 * tree at the instant of the event, which is unknowable for a historical row. A
 * retrospective consumer may therefore use this function and nothing stronger.
 *
 * @param {string} filePath
 * @param {RegExp[]} signatureGlobs compiled by {@link compileSignatureGlobs}
 * @param {boolean} [admitCritical] the §3.3 valve (`cfg.admitCriticalNames`)
 * @returns {{signatureMatch:boolean, criticalName:boolean, pass:boolean}}
 */
export function classifyName(filePath, signatureGlobs, admitCritical = true) {
  const signatureMatch = matchesAnyGlob(filePath, signatureGlobs);
  const criticalName = admitCritical !== false && CREDENTIAL_NAME_RE.test(path.basename(filePath));
  return { signatureMatch, criticalName, pass: signatureMatch || criticalName };
}

/**
 * Overflow-rescan TARGETING bound: one episode's rescan walks at most this many
 * directories (most recently active first, see `_takeEpisodeTargets`), so the
 * per-directory file cap cannot be multiplied by a pathological spread of named-event
 * activity across thousands of directories.
 */
const EPISODE_TARGET_MAX = 32;

export class CWatcher {
  /**
   * @param {{cfg:object, tree?:{ownerOf?:(p:string)=>Promise<any>, nameOf?:(pid:number)=>string|null},
   *          log?:object, onCandidate?:(c:object, info?:object)=>any, now?:()=>number}} opts
   */
  constructor({ cfg, tree = null, log, onCandidate = null, now = null } = {}) {
    this.cfg = cfg && typeof cfg === 'object' ? cfg : {};
    this.tree = tree || null;
    this.log = normalizeLog(log);
    this.onCandidate = typeof onCandidate === 'function' ? onCandidate : null;
    this._now = typeof now === 'function' ? now : () => Date.now();

    this.debounceMs = Number.isFinite(Number(this.cfg.debounceMs)) && Number(this.cfg.debounceMs) >= 0
      ? Number(this.cfg.debounceMs)
      : 3000;
    this.sessionWindowMs =
      Number.isFinite(Number(this.cfg.sessionWindowMs)) && Number(this.cfg.sessionWindowMs) > 0
        ? Number(this.cfg.sessionWindowMs)
        : 30 * 60 * 1000;

    // --- precomputed filters -------------------------------------------------
    this._protectRoots = (Array.isArray(this.cfg.protectRoots) ? this.cfg.protectRoots : [])
      .filter((r) => typeof r === 'string' && r.trim().length > 0)
      .map((r) => {
        const abs = expandPath(r);
        const key = canonicalKey(abs);
        return { abs, key, sep: `${key}${path.sep}` };
      });
    this._excludeNames = (Array.isArray(this.cfg.excludeNames) ? this.cfg.excludeNames : [])
      .filter((n) => typeof n === 'string' && n.length > 0)
      .map((n) => n.toLowerCase());
    // AI-toolchain signature list — an INCLUDE list (PRD §3.2 rule #2), despite living
    // under the Phase 1 name `excludeGlobs`. lib/config.js:277/283/285 sets both
    // `aiSignatureGlobs` and `excludeGlobs` to the SAME array, so either is accepted;
    // Phase 1 compiled this list but never applied it, hence wiring it here is not a
    // behaviour regression. Do not confuse it with `_excludeNames` above, which is a
    // real EXCLUDE (the `.dsh` path-segment veto).
    const sigRaw = Array.isArray(this.cfg.aiSignatureGlobs)
      ? this.cfg.aiSignatureGlobs
      : Array.isArray(this.cfg.excludeGlobs)
        ? this.cfg.excludeGlobs
        : DEFAULT_AI_SIGNATURES;
    this._signatureGlobs = compileSignatureGlobs(sigRaw);

    // PRD §3.2 gate mode. Fail CLOSED: an absent or unrecognised value means 'enforce',
    // matching lib/config.js:269 (NOISE_GATE_MODES.has(raw.noiseGate) ? ... : 'enforce').
    this._noiseGate = NOISE_GATE_MODES.has(this.cfg.noiseGate) ? this.cfg.noiseGate : 'enforce';
    // PRD §3.3 safety valve (Lead decision): a credential-shaped basename is ALWAYS
    // admitted while this is on, so a dsh-authored `credentials.json` in Temp still
    // surfaces as LOCKED_CRITICAL instead of being noise-filtered away.
    this._admitCritical = this.cfg.admitCriticalNames !== false;

    // Windows directory-buffer OVERFLOW recovery (PRD §3.2 recall).
    //
    // MEASURED (`test/_lead-overflow-signal.mjs`, `test/_lead-watch-burst.mjs`): a burst of 600
    // files into one directory makes libuv deliver only ~418 named events, and a BARE `fs.watch`
    // on the same directory saw ~418/600 too -- so the loss happens BELOW this plugin, inside
    // `ReadDirectoryChangesW`'s finite buffer. Crucially the overflow is NOT silent: libuv
    // announces it as a `change` event whose `filename` is null, and `_onEvent` used to DISCARD
    // exactly that event as "directory-level, nothing to classify". A bounded rescan on that
    // signal recovers the files the buffer dropped.
    //
    // The rescan re-uses `_settle`, so every recovered file still passes the protect-root veto,
    // the exclude-name veto and the §3.2 gate -- it can never admit anything the live path would
    // not have admitted. `rescanOnOverflow:false` opts a host out of the scan cost.
    this._rescanOnOverflow = this.cfg.rescanOnOverflow !== false;
    this._rescanCooldownMs =
      Number.isFinite(Number(this.cfg.rescanCooldownMs)) && Number(this.cfg.rescanCooldownMs) >= 0
        ? Number(this.cfg.rescanCooldownMs)
        : 10000;
    this._rescanMaxFiles =
      Number.isFinite(Number(this.cfg.rescanMaxFiles)) && Number(this.cfg.rescanMaxFiles) > 0
        ? Number(this.cfg.rescanMaxFiles)
        : 5000;
    // Delay the walk until the directory has been quiet this long. Must exceed the write burst,
    // or the scan walks a half-populated directory (measured: 120 of 600 files) and the cooldown
    // then blocks the rest.
    this._rescanSettleMs =
      Number.isFinite(Number(this.cfg.rescanSettleMs)) && Number(this.cfg.rescanSettleMs) >= 0
        ? Number(this.cfg.rescanSettleMs)
        : 5000;

    // --- state ---------------------------------------------------------------
    /** @type {Map<string, import('node:fs').FSWatcher>} canonical dir key -> watcher */
    this._watchers = new Map();
    /** @type {Map<string, string>} canonical dir key -> original-case absolute path */
    this._displayPaths = new Map();
    /** @type {Map<string, {timer:NodeJS.Timeout, path:string, dir:string}>} debounce */
    this._pending = new Map();
    /** @type {{events:number, candidates:number, filtered:number, gated:number,
     *           scanned:number, failed:number, recursiveForcedOff:number,
     *           rescans:number, rescanned:number, startedAt:number|null}} */
    this._counters = {
      events: 0,
      candidates: 0,
      filtered: 0,
      gated: 0,
      scanned: 0,
      failed: 0,
      recursiveForcedOff: 0,
      // Overflow-recovery counters. `rescans` counts overflow signals we acted on;
      // `rescanned` counts files re-examined by those scans.
      rescans: 0,
      rescanned: 0,
      startedAt: null,
    };
    /** @type {Array<{dir:string, reason:string}>} */
    this._failedList = [];
    /** @type {Map<string, number>} canonical dir key -> last rescan timestamp (cooldown) */
    this._lastRescan = new Map();
    /** @type {Map<string, NodeJS.Timeout>} canonical dir key -> pending quiet-deadline timer */
    this._rescanTimers = new Map();
    /**
     * Overflow-rescan TARGETING. `%LOCALAPPDATA%\Temp` holds ~30k files across ~21k directories,
     * so a rescan that starts at the watched root and walks in DFS order burns its whole file
     * budget on unrelated content and never reaches the directory that overflowed (measured live:
     * `rescanned` pegged at exactly 2 x the 5,000 cap while a 1,320-file burst landed only 537
     * rows). Every NAMED event therefore records its directory here, and an overflow rescan walks
     * only the directories that were receiving named events during that overflow episode.
     * @type {Map<string, {path:string, at:number}>} canonical dir key -> last named-event activity
     */
    this._activeDirs = new Map();
    /** Upper bound on `_activeDirs`, so a busy Temp cannot grow it without limit. */
    this._activeDirMax = 4096;
    /** `this._now()` at the FIRST null event of the overflow episode being collected, else 0. */
    this._overflowEpisodeStart = 0;
    this._started = false;
    /** Set by `stop()` so an in-flight overflow rescan cannot feed `_settle` after teardown. */
    this._stopped = false;
  }

  /**
   * Open one watcher per configured directory.
   * @returns {{watching:string[]}} absolute paths actually being watched
   */
  start() {
    if (this._started) return { watching: [...this._watchers.keys()].map((k) => this._watcherPath(k)) };

    // Register as live in the PROCESS-GLOBAL registry (see the header note). This is what lets a
    // later HMR generation find us and stop us if our own disposer never runs.
    watcherRegistry().add(this);

    const entries = this._normalizeWatchDirs();
    for (const entry of entries) {
      const configured = entry.path;
      // DEFECT 3 (CRITICAL): canonicalize ONCE, here, before fs.watch ever sees the path.
      // A genuine 8.3 alias spelling makes libuv abort the whole host process, and an
      // abort is not catchable. This also strips any `\\?\` device prefix, so the paths
      // we later emit derive from a canonical long-form directory (DEFECT 4).
      const dir = resolveWatchDir(configured);
      const recursive = this._effectiveRecursive(dir, entry.recursive);
      if (entry.recursive && !recursive) {
        this._counters.recursiveForcedOff += 1;
        this.log.warn(
          `[c-cleaner] CWatcher.start: recursive:true refused for ${dir} (PRD 6.1 allows ` +
            `recursive only under %LOCALAPPDATA%\\Temp); watching non-recursively`,
        );
      }

      const key = canonicalKey(dir);
      if (this._watchers.has(key)) continue;
      if (!fs.existsSync(dir)) {
        this._fail(dir, 'ENOENT: watch directory does not exist');
        continue;
      }

      try {
        const watcher = fs.watch(dir, { recursive, persistent: false }, (eventType, filename) => {
          // HARDENING: an exception thrown inside an fs event callback is uncaught at the
          // host level and is FATAL to the whole dsh process (measured: a half-wired helper
          // here killed every boot, taking the entire app down with it). The watcher is a
          // cache -- losing one event to a bug must never lose the process.
          try {
            this._onEvent(dir, eventType, filename);
          } catch (err) {
            this._counters.filtered += 1;
            this.log.warn(
              `[c-cleaner] CWatcher: dropped event for ${dir}: ${
                err && err.message ? err.message : String(err)
              }`,
            );
          }
        });
        watcher.on('error', (err) => {
          this._fail(dir, `watcher error: ${err && err.code ? err.code : 'ERROR'}: ${
            err && err.message ? err.message : String(err)
          }`);
          this._closeWatcher(key);
        });
        if (typeof watcher.unref === 'function') watcher.unref(); // never hold the loop open
        // Register the RAW handle in the process-global registry so ANY later generation
        // can close it even if this generation's disposer never runs. See the header note.
        rawWatcherRegistry().add(watcher);
        this._watchers.set(key, watcher);
        // report the RESOLVED path, so stats().watching tells the truth about what is watched
        this._displayPaths.set(key, dir);
        this.log.debug(
          `[c-cleaner] CWatcher.start: watching ${dir} (recursive=${recursive})` +
            (dir === configured ? '' : ` [resolved from ${configured}]`),
        );
      } catch (err) {
        this._fail(
          dir,
          `${err && err.code ? err.code : 'ERROR'}: ${err && err.message ? err.message : String(err)}`,
        );
      }
    }

    this._started = true;
    this._counters.startedAt = this._counters.startedAt === null ? this._now() : this._counters.startedAt;
    const watching = this._watchedPaths();
    this.log.info(`[c-cleaner] CWatcher.start: ${watching.length} director(ies) watched`);
    return { watching };
  }

  /** Close every watcher and cancel every pending debounce. Idempotent; counters kept. */
  stop() {
    watcherRegistry().delete(this);
    // Stop any in-flight overflow rescan from feeding `_settle` after teardown: a superseded
    // generation must not keep examining files (and calling its stale `onCandidate`) once it
    // has been stopped.
    this._stopped = true;
    for (const timer of this._rescanTimers.values()) clearTimeout(timer);
    this._rescanTimers.clear();
    for (const [key, entry] of this._pending) {
      clearTimeout(entry.timer);
      this._pending.delete(key);
    }
    for (const key of [...this._watchers.keys()]) this._closeWatcher(key);
    this._started = false;
    this.log.debug('[c-cleaner] CWatcher.stop: stopped');
  }

  /**
   * @returns {{events:number, candidates:number, filtered:number, watching:string[],
   *            gated:number, scanned:number, failed:number, recursiveForcedOff:number,
   *            rescans:number, rescanned:number,
   *            failedList:Array<{dir:string,reason:string}>, startedAt:number|null}}
   */
  stats() {
    return {
      events: this._counters.events,
      candidates: this._counters.candidates,
      filtered: this._counters.filtered,
      watching: this._watchedPaths(),
      // Phase 2 (CONTRACTS-PHASE2.md §2): how many candidates the PRD §3.2 noise gate
      // rejected. In 'enforce' every gated candidate is ALSO counted in `filtered`; in
      // 'audit' it is counted here only, and the candidate is still delivered; in 'off'
      // this stays 0 forever.
      gated: this._counters.gated,
      scanned: this._counters.scanned,
      failed: this._counters.failed,
      recursiveForcedOff: this._counters.recursiveForcedOff,
      // Overflow recovery (Windows directory-buffer): how many rescans ran, and how many
      // files they re-examined. See `_onOverflow` for why a null-filename event triggers one.
      rescans: this._counters.rescans,
      rescanned: this._counters.rescanned,
      failedList: this._failedList.map((f) => ({ ...f })),
      startedAt: this._counters.startedAt,
    };
  }

  // ---------------------------------------------------------------- internals

  /** @returns {Array<{path:string, recursive:boolean, maxDepth:number}>} */
  _normalizeWatchDirs() {
    const raw = Array.isArray(this.cfg.watchDirs) ? this.cfg.watchDirs : [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const entry = typeof item === 'string' ? { path: item, recursive: false } : item;
      if (!entry || typeof entry.path !== 'string' || entry.path.trim().length === 0) continue;
      const abs = expandPath(entry.path);
      const key = canonicalKey(abs);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path: abs,
        recursive: entry.recursive === true,
        maxDepth: Number.isFinite(Number(entry.maxDepth)) ? Number(entry.maxDepth) : 1,
      });
    }
    return out;
  }

  /**
   * PRD 6.1 guard. `recursive:true` is honoured only for a *designated subfolder*:
   * `%LOCALAPPDATA%\Temp` itself or anything nested below it (the only recursive entry
   * in config.js), or a directory that is not inside a broad user/system root. Drive
   * roots, `C:\Users\<u>`, `%LOCALAPPDATA%`, `%APPDATA%`, `%SystemRoot%`, Program Files
   * and ProgramData are always forced back to non-recursive.
   */
  _effectiveRecursive(dir, requested) {
    if (!requested) return false;
    const key = canonicalKey(dir);

    const tempRoot = process.env.LOCALAPPDATA
      ? canonicalKey(path.join(process.env.LOCALAPPDATA, 'Temp'))
      : '';
    if (tempRoot && (key === tempRoot || key.startsWith(tempRoot + path.sep))) return true;

    if (isDriveRoot(key)) return false; // a whole drive is never recursive
    for (const root of BROAD_ROOTS) {
      if (key === root || key.startsWith(root + path.sep)) return false; // at or under a broad root
      if (root.startsWith(key + path.sep)) return false; // an ancestor of a broad root
    }
    return true; // a narrow designated subfolder -> recursion is allowed
  }

  _watchedPaths() {
    return [...this._watchers.keys()].map((k) => this._watcherPath(k));
  }

  _watcherPath(key) {
    // keep the original casing for display; fs.watch already got the real path
    return this._displayPaths.get(key) || key;
  }

  _closeWatcher(key) {
    const watcher = this._watchers.get(key);
    if (!watcher) return;
    let closed = true;
    try {
      watcher.close();
    } catch (err) {
      // A close that THREW means the handle may still be armed. Do NOT drop it from the
      // raw registry: that would turn a failed close into exactly the unreachable phantom
      // this hardening exists to prevent. Leave it registered so a later generation's
      // `closeAllRawWatchers()` gets another attempt.
      closed = false;
      this.log.debug(
        `[c-cleaner] CWatcher: close failed for ${key}: ${err && err.message ? err.message : String(err)}`,
      );
    }
    if (closed) rawWatcherRegistry().delete(watcher);
    this._watchers.delete(key);
    this._displayPaths.delete(key);
  }

  _fail(dir, reason) {
    this._counters.failed += 1;
    this._failedList.push({ dir, reason });
    this.log.warn(`[c-cleaner] CWatcher: cannot watch ${dir}: ${reason}`);
  }

  /** Raw fs event -> per-path debounce (PRD 3.2). */
  _onEvent(dir, eventType, filename) {
    this._counters.events += 1;
    if (filename === null || filename === undefined || String(filename).length === 0) {
      // MEASURED: this is NOT a "directory-level event, nothing to classify". On Windows libuv
      // reports `ReadDirectoryChangesW`'s BUFFER OVERFLOW as a `change` event with a null
      // filename (see `test/_lead-overflow-signal.mjs`: 600-file burst -> 6 null events while
      // 182 named events were lost). Treating it as noise is why a burst silently under-tracks.
      // Rescan instead, so the dropped files are recovered through the SAME `_settle` path
      // (protect-root veto, exclude-name veto and §3.2 gate all still apply).
      this._onOverflow(dir);
      return;
    }
    // `dir` is already canonical (start() realpath'd it), so this join inherits that.
    // stripDevicePrefix is belt-and-braces for a filename that arrives already prefixed,
    // so no device-prefixed path can ever reach classify() or the DB (DEFECT 4).
    const full = stripDevicePrefix(path.resolve(dir, String(filename)));
    // TARGETING (see `_activeDirs`): record the directory that ACTUALLY received this event. With
    // `recursive:true`, Windows reports every nested change against the WATCHED ROOT while
    // `filename` carries the relative subpath, so `dir` is useless as a rescan target and
    // `dirname(full)` is the real one. This is what makes an overflow rescan reach the directory
    // that overflowed instead of walking the whole 30k-file Temp tree from the root.
    this._noteActiveDir(path.dirname(full));
    const key = canonicalKey(full);
    const existing = this._pending.get(key);
    if (existing) {
      clearTimeout(existing.timer); // restart the quiescence window
    }
    const timer = setTimeout(() => {
      this._pending.delete(key);
      this._settle(full);
    }, this.debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
    this._pending.set(key, { timer, path: full, dir, eventType });
  }

  /**
   * TARGETING bookkeeping (see `_activeDirs`): record the directory that ACTUALLY received
   * this named event, refreshed on every hit, so a later overflow rescan can walk only the
   * directories that were receiving events when the buffer overflowed. Bounded: the map
   * keeps recency order (delete-then-set on every update) and evicts the least recently
   * active entry at `_activeDirMax`, so a busy Temp cannot grow it without limit.
   * @param {string} dirPath - directory that received the named event.
   */
  _noteActiveDir(dirPath) {
    const key = canonicalKey(dirPath);
    if (this._activeDirs.has(key)) {
      this._activeDirs.delete(key); // re-insert below so Map iteration order == recency order
    } else if (this._activeDirs.size >= this._activeDirMax) {
      const oldestKey = this._activeDirs.keys().next().value;
      if (oldestKey !== undefined) this._activeDirs.delete(oldestKey);
    }
    this._activeDirs.set(key, { path: dirPath, at: this._now() });
  }

  /**
   * Recover files dropped by a Windows directory-buffer overflow.
   *
   * Bounded on purpose (PRD §6.1): one walk per directory, cooled down so a storm of null events
   * cannot turn into a scan storm, and capped in file count. The walk is asynchronous and
   * `unref`'d so it never holds the event loop open, and it feeds `_settle` -- the SAME function
   * the live event path uses -- so a recovered file is subject to exactly the same protections.
   *
   * TIMING MATTERS (measured). The overflow is announced while the burst is STILL WRITING, so a
   * rescan started immediately walks a partially-populated directory: the first version of this
   * code rescanned at 120 files of a 600-file burst, then the cooldown blocked every later null
   * event and the remaining 480 files were never recovered. The scan is therefore DELAYED until
   * the directory has been quiet for `rescanSettleMs`, and repeated null events inside that
   * window keep pushing the deadline back -- the same quiescence idea as the per-path debounce.
   *
   * @param {string} dir - the canonical watched directory whose buffer overflowed.
   */
  _onOverflow(dir) {
    // TARGETING: the FIRST null event of a burst opens the episode. Named-event activity
    // recorded from this instant on is what the rescan below walks -- those are the events
    // whose siblings were lost when the buffer overflowed; anything earlier was delivered
    // fine and does not need recovery. A single field rather than per-root state: two
    // watched roots overflowing concurrently just degrade -- the second scan falls back to
    // a root walk, exactly the pre-targeting behaviour.
    if (this._rescanOnOverflow && this._overflowEpisodeStart === 0) {
      this._overflowEpisodeStart = this._now();
    }
    try { fs.appendFileSync('F:/work/liveov.txt', `OVERFLOW dir=${dir} rescanOn=${this._rescanOnOverflow} cooldown=${this._rescanCooldownMs} settle=${this._rescanSettleMs} cap=${this._rescanMaxFiles} episodeStart=${this._overflowEpisodeStart} at=${Date.now()}\n`); } catch { /* ignore */ }
    if (!this._rescanOnOverflow) {
      this._counters.filtered += 1;
      return;
    }
    const key = canonicalKey(dir);
    const now = this._now();
    // Cooldown is measured from the last SCAN, and it still applies once a scan has run, so a
    // sustained storm of overflow events cannot schedule back-to-back walks.
    const last = this._lastRescan.get(key) ?? 0;
    if (now - last < this._rescanCooldownMs) {
      this._counters.filtered += 1; // a scan already ran (or is pending) for this directory
      return;
    }
    // Push the quiet deadline back on every overflow event: only scan once the writes stop.
    const pending = this._rescanTimers.get(key);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this._rescanTimers.delete(key);
      if (this._stopped) return;
      this._lastRescan.set(key, this._now());
      this._counters.rescans += 1;
      // TARGETING (see `_activeDirs` / `_takeEpisodeTargets`): a walk from the watched root
      // burns its whole file cap on unrelated content and never reaches the directory that
      // overflowed, so walk only the episode's active directories, most recently active
      // first. No targets recorded (the null event was the burst's FIRST event) -> fall
      // back to the root walk, which is the best information available.
      const targets = this._takeEpisodeTargets(dir);
      const scope = targets.length > 0 ? targets : [dir];
      const how =
        targets.length > 0
          ? `${targets.length} targeted director(ies)`
          : 'the watched root (no targeted activity recorded)';
      try { fs.appendFileSync('F:/work/liveov.txt', `SCAN-FIRE dir=${dir} targets=${targets.length}${targets.length > 0 ? ` first=${targets[0]}` : ' rootFallback=1'} at=${Date.now()}\n`); } catch { /* ignore */ }
      this.log.warn(
        `[c-cleaner] CWatcher: directory buffer overflow on ${dir} -- rescanning ${how} ` +
          `(cap ${this._rescanMaxFiles} files per directory)`,
      );
      for (const target of scope) void this._rescanDir(target);
    }, this._rescanSettleMs);
    if (typeof timer.unref === 'function') timer.unref();
    this._rescanTimers.set(key, timer);
  }

  /**
   * Close the overflow episode being collected and return its rescan targets: the
   * directories at/under `root` that received named events at/after `_overflowEpisodeStart`,
   * most recently active first, capped at `EPISODE_TARGET_MAX` so a pathological spread of
   * activity across thousands of directories cannot multiply the per-directory file cap
   * into an unbounded walk. Always closes the episode, even when it yields nothing.
   *
   * ANCESTOR NOISE (measured, `test/_lead-verify-targeting.mjs`): creating files in
   * `root\a\b` raises not only the file events but also a DIRECTORY-change event per
   * ancestor -- `filename` carries the changed directory's relative path, so `_onEvent`
   * notes the PARENT each time. Without the filter below the watched root itself would be
   * a target in every episode and the root walk this targeting exists to avoid would run
   * anyway. A target is therefore dropped when another target lies strictly beneath it;
   * a pure root-level burst still yields the root (nothing is beneath it).
   *
   * @param {string} root - the watched directory the overflow was reported against.
   * @returns {string[]} original-case directory paths to rescan; empty when the episode
   *   recorded no named activity under `root` (the caller falls back to a root walk).
   */
  _takeEpisodeTargets(root) {
    const start = this._overflowEpisodeStart;
    this._overflowEpisodeStart = 0; // the episode is consumed either way
    if (start === 0) return [];
    const rootKey = canonicalKey(root);
    const hits = [];
    for (const entry of this._activeDirs.values()) {
      if (entry.at < start) continue; // predates the episode: delivered, not lost
      const key = canonicalKey(entry.path);
      if (key !== rootKey && !key.startsWith(rootKey + path.sep)) continue; // another watch root
      hits.push({ path: entry.path, at: entry.at, key });
    }
    hits.sort((a, b) => b.at - a.at); // the directory that overflowed sorts first
    const trimmed = hits.filter(
      (h) => !hits.some((o) => o !== h && o.key.startsWith(h.key + path.sep)),
    );
    return trimmed.slice(0, EPISODE_TARGET_MAX).map((e) => e.path);
  }

  /**
   * Walk one directory tree and feed every file through `_settle`.
   * @param {string} root - canonical directory to walk.
   */
  async _rescanDir(root) {
    let examined = 0;
    const stack = [root];
    while (stack.length > 0) {
      if (this._stopped) return; // teardown raced the walk: stop feeding `_settle`
      const current = stack.pop();
      let entries;
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        continue; // vanished or unreadable -- the live path will handle it if it reappears
      }
      for (const entry of entries) {
        if (this._stopped) return;
        if (examined >= this._rescanMaxFiles) {
          this.log.warn(
            `[c-cleaner] CWatcher: rescan cap of ${this._rescanMaxFiles} files reached under ${root}`,
          );
          return;
        }
        const full = stripDevicePrefix(path.resolve(current, entry.name));
        if (entry.isDirectory()) {
          if (this._excludeNames.some((name) => full.toLowerCase().includes(`${path.sep}${name}`))) {
            continue;
          }
          stack.push(full);
          continue;
        }
        examined += 1;
        this._counters.rescanned += 1;
        this._settle(full);
      }
    }
  }

  /** The debounce expired: stat, filter, attribute, emit. */
  _settle(filePath) {
    let st;
    try {
      st = fs.statSync(filePath);
    } catch {
      this._counters.filtered += 1; // vanished (or unreadable) before it went quiet
      return;
    }
    if (!st.isFile()) {
      this._counters.filtered += 1;
      return;
    }
    if (isUnderRoots(filePath, this._protectRoots)) {
      this._counters.filtered += 1;
      this.log.debug(`[c-cleaner] CWatcher: dropped protected path ${filePath}`);
      return;
    }

    const segments = path
      .resolve(filePath)
      .split(/[\\/]+/)
      .map((s) => s.toLowerCase());
    if (this._excludeNames.some((name) => segments.includes(name))) {
      this._counters.filtered += 1;
      this.log.debug(`[c-cleaner] CWatcher: dropped excluded path ${filePath}`);
      return;
    }

    this._counters.scanned += 1;
    const candidate = { path: filePath, size: st.size, mtimeMs: st.mtimeMs, sourceProcess: null };

    // Fast path (CONTRACTS-PHASE2.md §2): when rule #1 is PROVABLY impossible there is no
    // point paying an attribution round-trip for a file that the signature rule and the
    // §3.3 valve both reject. 'enforce' only — in 'audit' the candidate must still be
    // counted and delivered, and that single authoritative decision lives in `_emit`.
    // Returning here can never double-count against `_emit`.
    if (this._noiseGate === 'enforce' && this._rule1Impossible()) {
      const pre = this._gateInputs(filePath, st);
      if (!pre.signatureMatch && !pre.criticalName) {
        this._dropNoise(candidate, pre);
        return;
      }
    }

    this._emit(candidate, path.resolve(path.dirname(filePath)), st);
  }

  /* ---------------------- PRD §3.2 noise gate (Phase 2) -------------------- */

  /**
   * The cheap inputs to the admission decision — everything except rule #1, which needs
   * the resolved attribution and therefore lives in `_emit`.
   *
   * @returns {{inSessionWindow:boolean, signatureMatch:boolean, criticalName:boolean}}
   */
  _gateInputs(filePath, st) {
    const inSessionWindow = st.mtimeMs >= this._now() - this.sessionWindowMs;
    return {
      inSessionWindow,
      signatureMatch: inSessionWindow && matchesAnyGlob(filePath, this._signatureGlobs),
      criticalName: this._admitCritical && CREDENTIAL_NAME_RE.test(path.basename(filePath)),
    };
  }

  /**
   * PRD §3.2 rule #1 (reverse handle lookup -> PID inside the dsh tree) can only fire
   * when a tree with a real handle backend is attached. `tree.hasHandleBackend === false`
   * is the additive Phase 2 flag on ProcessTree; an ABSENT flag (Phase 1 stubs) is not
   * treated as false, so a stub that may still answer `ownerOf` keeps working.
   */
  _rule1Impossible() {
    return (
      !this.tree ||
      typeof this.tree.ownerOf !== 'function' ||
      this.tree.hasHandleBackend === false
    );
  }

  /** Enforce-mode rejection: counted in BOTH `filtered` and `gated`, then dropped. */
  _dropNoise(candidate, parts) {
    this._counters.filtered += 1;
    this._counters.gated += 1;
    const why = parts.inSessionWindow
      ? 'inside the session window but no AI-toolchain signature match'
      : 'outside the dsh session window';
    this.log.debug(
      `[c-cleaner] CWatcher: noise-gate dropped ${candidate.path} (${why}; ` +
        'not a credential-shaped basename)',
    );
  }

  /** Best-effort attribution, then the PRD §3.2 gate, then delivery — exactly once. */
  _emit(candidate, dir, st) {
    const fingerprint = `${candidate.path}\u0000${st.size}\u0000${st.mtimeMs}`;
    // CONTRACTS-PHASE2.md §2, verbatim:
    const inWindow = st.mtimeMs >= this._now() - this.sessionWindowMs; // already computed
    const signatureMatch = inWindow && matchesAnyGlob(candidate.path, this._signatureGlobs);
    const criticalName = this._admitCritical && CREDENTIAL_NAME_RE.test(path.basename(candidate.path));

    let settled = false;
    const finish = (sourceProcess, info) => {
      if (settled) return;
      settled = true;

      // ---- PRD §3.2 admission decision: the single authoritative gate ------------
      // rule #1 needs the attribution, which is why the decision lives here rather
      // than in `_settle` (the fast path there is a pure short-circuit for the case
      // where rule #1 is provably impossible).
      const pid = info && Number.isInteger(info.pid) ? info.pid : null;
      const isMember = info ? info.isTreeMember === true : false;
      const rule1 = Number.isInteger(pid) && isMember === true; // handle-attributed tree member
      const admit = rule1 || signatureMatch || criticalName;

      if (!admit) {
        if (this._noiseGate === 'enforce') {
          // 'enforce' (default): drop it. Counted in BOTH `filtered` and `gated`.
          this._dropNoise(candidate, { inSessionWindow: inWindow, signatureMatch, criticalName });
          return; // deliberately NOT delivered
        }
        if (this._noiseGate === 'audit') {
          // 'audit': count what enforcement WOULD have dropped, but still deliver.
          this._counters.gated += 1;
          this.log.debug(
            `[c-cleaner] CWatcher: noise-gate would drop ${candidate.path} (audit mode)`,
          );
        }
        // 'off': legacy passthrough — never counted in `gated`, always delivered.
      }

      candidate.sourceProcess = sourceProcess == null ? null : String(sourceProcess);
      this._deliver(candidate, {
        dir,
        fingerprint,
        inSessionWindow: inWindow,
        globMatch: signatureMatch,
        realPid: pid,
      });
    };

    if (!this.tree || typeof this.tree.ownerOf !== 'function') {
      finish(null, null);
      return;
    }

    let timer = null;
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), OWNER_LOOKUP_BUDGET_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });

    new Promise((resolve) => resolve(this.tree.ownerOf(candidate.path)))
      .then((owner) => {
        if (timer) clearTimeout(timer);
        if (!owner || !Number.isInteger(Number(owner.pid))) {
          // No attributable owner. That is NOT itself a reason to record the file:
          // the admission decision above still has to see a signature match or a
          // credential-shaped basename. sourceProcess stays null.
          finish(null, null);
          return;
        }
        const pid = Number(owner.pid);
        const name = owner.name || (typeof this.tree.nameOf === 'function' ? this.tree.nameOf(pid) : null);
        const isMember = typeof this.tree.isTreeMember === 'function' ? this.tree.isTreeMember(pid) : true;
        finish(name || null, { pid, isTreeMember: isMember });
      })
      .catch((err) => {
        if (timer) clearTimeout(timer);
        this.log.debug(
          `[c-cleaner] CWatcher: ownerOf failed for ${candidate.path}: ${
            err && err.message ? err.message : String(err)
          }`,
        );
        finish(null, null);
      });

    budget.then((why) => {
      if (why === 'timeout') {
        this.log.debug(`[c-cleaner] CWatcher: attribution budget exceeded for ${candidate.path}`);
        finish(null, null);
      }
    });
  }

  /** Single delivery point: counts onCandidate exactly once per emitted candidate. */
  _deliver(candidate, info) {
    if (!this.onCandidate) {
      this._counters.candidates += 1;
      this.log.debug(`[c-cleaner] CWatcher: no onCandidate consumer; dropped ${candidate.path}`);
      return;
    }
    this._counters.candidates += 1;
    try {
      const ret = this.onCandidate(candidate, info);
      if (ret && typeof ret.then === 'function') {
        ret.then(undefined, (error) => {
          CWatcher.CANDIDATE_ATTRITION(candidate.path, error);
        });
      }
    } catch (error) {
      CWatcher.CANDIDATE_ATTRITION(candidate.path, error);
    }
  }
}

/**
 * Consumer rejections are logged and counted, never rethrown into the fs event loop.
 * Defined as a real function body so the guarantee is greppable/readable in source.
 */
CWatcher.CANDIDATE_ATTRITION = function candidateAttrition(filePath, error) {
  CWatcher.attritions = (CWatcher.attritions || 0) + 1;
  // eslint-disable-next-line no-console
  if (process.env.CC_DEBUG) {
    console.error(
      `[c-cleaner] CWatcher: onCandidate rejected for ${filePath}: ${
        error && error.message ? error.message : String(error)
      }`,
    );
  }
};

export default CWatcher;
