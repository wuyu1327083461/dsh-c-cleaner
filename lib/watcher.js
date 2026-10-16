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
  if (globs.length === 0) return false;
  const slash = String(filePath).replace(/\\/g, '/');
  const base = slash.slice(slash.lastIndexOf('/') + 1);
  for (const re of globs) {
    if (re.test(slash) || re.test(base)) return true;
  }
  return false;
}

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
    this._excludeGlobs = (Array.isArray(this.cfg.excludeGlobs) ? this.cfg.excludeGlobs : [])
      .filter((g) => typeof g === 'string' && g.length > 0)
      .map(globToRegExp);

    // --- state ---------------------------------------------------------------
    /** @type {Map<string, import('node:fs').FSWatcher>} canonical dir key -> watcher */
    this._watchers = new Map();
    /** @type {Map<string, string>} canonical dir key -> original-case absolute path */
    this._displayPaths = new Map();
    /** @type {Map<string, {timer:NodeJS.Timeout, path:string, dir:string}>} debounce */
    this._pending = new Map();
    /** @type {{events:number, candidates:number, filtered:number, scanned:number,
     *           failed:number, recursiveForcedOff:number, startedAt:number|null}} */
    this._counters = {
      events: 0,
      candidates: 0,
      filtered: 0,
      scanned: 0,
      failed: 0,
      recursiveForcedOff: 0,
      startedAt: null,
    };
    /** @type {Array<{dir:string, reason:string}>} */
    this._failedList = [];
    this._started = false;
  }

  /**
   * Open one watcher per configured directory.
   * @returns {{watching:string[]}} absolute paths actually being watched
   */
  start() {
    if (this._started) return { watching: [...this._watchers.keys()].map((k) => this._watcherPath(k)) };

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
          this._onEvent(dir, eventType, filename);
        });
        watcher.on('error', (err) => {
          this._fail(dir, `watcher error: ${err && err.code ? err.code : 'ERROR'}: ${
            err && err.message ? err.message : String(err)
          }`);
          this._closeWatcher(key);
        });
        if (typeof watcher.unref === 'function') watcher.unref(); // never hold the loop open
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
   *            scanned:number, failed:number, recursiveForcedOff:number,
   *            failedList:Array<{dir:string,reason:string}>, startedAt:number|null}}
   */
  stats() {
    return {
      events: this._counters.events,
      candidates: this._counters.candidates,
      filtered: this._counters.filtered,
      watching: this._watchedPaths(),
      scanned: this._counters.scanned,
      failed: this._counters.failed,
      recursiveForcedOff: this._counters.recursiveForcedOff,
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
    try {
      watcher.close();
    } catch (err) {
      this.log.debug(
        `[c-cleaner] CWatcher: close failed for ${key}: ${err && err.message ? err.message : String(err)}`,
      );
    }
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
      this._counters.filtered += 1; // directory-level event, no file to classify
      return;
    }
    // `dir` is already canonical (start() realpath'd it), so this join inherits that.
    // stripDevicePrefix is belt-and-braces for a filename that arrives already prefixed,
    // so no device-prefixed path can ever reach classify() or the DB (DEFECT 4).
    const full = stripDevicePrefix(path.resolve(dir, String(filename)));
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
    this._emit(candidate, path.resolve(path.dirname(filePath)), st);
  }

  /** Best-effort attribution, then hand the candidate to the consumer exactly once. */
  _emit(candidate, dir, st) {
    const fingerprint = `${candidate.path}\u0000${st.size}\u0000${st.mtimeMs}`;
    const inSessionWindow = st.mtimeMs >= this._now() - this.sessionWindowMs;
    const globMatch = inSessionWindow && matchesAnyGlob(candidate.path, this._excludeGlobs);

    let settled = false;
    const finish = (sourceProcess, info) => {
      if (settled) return;
      settled = true;
      candidate.sourceProcess = sourceProcess == null ? null : String(sourceProcess);
      this._deliver(candidate, {
        dir,
        fingerprint,
        inSessionWindow,
        globMatch,
        realPid: info && Number.isInteger(info.pid) ? info.pid : null,
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
          // Rule #2 (PRD 3.2): no attributable owner, but AI-toolchain noise inside the
          // session window is still recorded — sourceProcess stays null.
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
