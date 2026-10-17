// lib/handle-index.js — dsh-c-cleaner / handle-backend (shared task task-7 = task-11)
//
// PRD §3.2 rule #1 backend: "the file is attributed by handle reverse-lookup to a PID
// inside the dsh process tree". This module owns the psutil bridge and the cache; the
// ProcessTree injection seam (`constructor({ handleProbe })`, lib/process-tree.js:137
// and lib/process-tree.js:311-332) is the consumer. Nothing here imports ProcessTree,
// and nothing here edits another owner's file.
//
// WHY THIS SHIPS OPT-IN AND OFF BY DEFAULT (CONTRACTS-PHASE2.md §0, measured on this host):
//   psutil.Process(root).children(recursive=True) ..... ~9 ms for 11 members
//   open_files() over those same members .............. ~2000-2100 ms, CPU-bound
//   PRD §6.1 marginal-CPU budget ...................... < 2 %
//   => a 60 s sweep interval alone is already ~3.4 % CPU. `cfg.handleIndex` defaults to
//      false; rule #2 (session window + AI-toolchain signature) is the gate that runs in
//      production. Turning this on buys real handle attribution and costs ~2 s of CPU per
//      sweep for it. That is the honest position, stated here and in stats().
//
// SHAPE (CONTRACTS-PHASE2.md §3, signatures frozen):
//   ONE long-lived `python -u -c BRIDGE <rootPid>` child, newline-delimited JSON.
//   Parent writes bare tokens `ping\n` | `sweep\n` | `quit\n`; the child answers EXACTLY
//   ONE JSON line per command and emits nothing unsolicited (no banner), so a manual
//   `sweep`/`quit` session sees exactly one line per command. `ping` is additive to the
//   frozen sweep/quit protocol: it is the cheap readiness handshake that lets start()
//   prove python + psutil + bridge work WITHOUT paying for a 2 s sweep.
//   `lookup()` is a synchronous Map read. Nothing in this file spawns per file, and
//   nothing spawns per sweep (the child is created once, in start()).
//
// SELF-PROTECTION: sweep() never runs concurrently (an in-flight promise is coalesced),
// and when a sweep exceeds `budgetMs` for `maxConsecutiveSlow` consecutive sweeps the
// index sets `disabled = true`, logs once and stops issuing sweeps — lookup() keeps
// serving the last good cache. Every failure path logs and returns falsy; nothing in
// this module ever throws to its caller.

import { spawn } from 'node:child_process';

/**
 * The Python bridge, EMBEDDED (CONTRACTS-PHASE2.md §3: no extra .py file in the bundle).
 *
 * Protocol, one JSON line per command on stdout:
 *   ping  -> {"ok":true,"ready":true,"root":N,"psutil":"7.0.0","python":"3.13.9","pid":N}
 *            or {"ok":true,"ready":false,"error":"import psutil failed: ..."}
 *   sweep -> {"ok":true,"members":N,"files":N,"denied":N,"ms":N,"map":{<path>:{pid,name}}}
 *            or {"ok":false,"error":"...","members":0,"files":0,"denied":0,"ms":N}
 *   quit  -> {"ok":true,"bye":true} then exit 0
 * Anything else -> one {"ok":false,"error":"unknown command"} line.
 *
 * Root pid arrives as argv[1] (documented choice; the alternative was a first stdin line,
 * which would have made start() depend on the command channel it is trying to validate).
 *
 * It NEVER raises: every step is guarded, and a failure is reported as data.  Written
 * without a single backslash escape on purpose (`os.sep`, `print()`'s default end) so the
 * source survives being embedded in a JS template literal byte-for-byte.
 *
 * `map` is rebuilt from scratch every sweep (no stale entries). `files` counts every open
 * file entry enumerated; a path opened by several tree members keeps the FIRST owner in
 * iteration order (root first, then children ascending by pid) — deterministic, and any
 * one of them is a legitimate rule #1 hit. `denied` counts members whose open_files()
 * raised (AccessDenied/NoSuchProcess/ZombieProcess …) — honest reporting, not silence.
 */
const BRIDGE = `import json
import os
import sys
import time

SEP = os.sep


def emit(obj):
    print(json.dumps(obj), flush=True)


def norm(p):
    return str(p).replace("/", SEP).lower()


def sweep(psutil, root):
    t0 = time.perf_counter()
    try:
        proc = psutil.Process(root)
        kids = proc.children(recursive=True)
        kids.sort(key=lambda p: p.pid)
        members = [proc] + kids
    except Exception as exc:
        return {
            "ok": False,
            "error": "tree enumeration failed: " + type(exc).__name__ + ": " + str(exc),
            "members": 0,
            "files": 0,
            "denied": 0,
            "ms": round((time.perf_counter() - t0) * 1000.0, 1),
        }
    table = {}
    files = 0
    denied = 0
    for p in members:
        try:
            handles = p.open_files()
        except Exception:
            denied += 1
            continue
        for f in handles:
            try:
                key = norm(f.path)
            except Exception:
                continue
            if not key:
                continue
            files += 1
            if key in table:
                continue
            try:
                name = p.name()
            except Exception:
                name = ""
            table[key] = {"pid": int(p.pid), "name": name}
    return {
        "ok": True,
        "root": root,
        "members": len(members),
        "files": files,
        "denied": denied,
        "ms": round((time.perf_counter() - t0) * 1000.0, 1),
        "map": table,
    }


def main():
    try:
        root = int(sys.argv[1])
    except Exception:
        root = os.getpid()

    psutil = None
    import_error = ""
    try:
        import psutil as _psutil
        psutil = _psutil
    except Exception as exc:
        import_error = "import psutil failed: " + type(exc).__name__ + ": " + str(exc)

    for line in sys.stdin:
        cmd = line.strip()
        if not cmd:
            continue
        if cmd == "quit":
            emit({"ok": True, "bye": True})
            return 0
        if cmd == "ping":
            if psutil is None:
                emit({"ok": True, "ready": False, "root": root, "error": import_error})
                continue
            try:
                ver = getattr(psutil, "__version__", "?")
                pv = sys.version.split()[0]
            except Exception:
                ver = "?"
                pv = "?"
            emit({"ok": True, "ready": True, "root": root, "psutil": ver,
                  "python": pv, "pid": os.getpid()})
            continue
        if cmd == "sweep":
            if psutil is None:
                emit({"ok": False, "error": import_error, "members": 0,
                      "files": 0, "denied": 0, "ms": 0.0})
                continue
            try:
                emit(sweep(psutil, root))
            except Exception as exc:
                emit({"ok": False, "error": type(exc).__name__ + ": " + str(exc),
                      "members": 0, "files": 0, "denied": 0, "ms": 0.0})
            continue
        emit({"ok": False, "error": "unknown command"})
    return 0


raise SystemExit(main())
`;

/** Defaults, all overridable per CONTRACTS-PHASE2.md §3. */
const DEFAULTS = Object.freeze({
  sweepMs: 60000, // §4 handleSweepMs default (config applies the 15000 floor)
  timeoutMs: 30000, // one sweep is ~2 s here; 30 s is a hang detector, not a budget
  budgetMs: 5000, // self-protection watchdog, NOT a §6.1 CPU guarantee — see header
  maxConsecutiveSlow: 3,
});

/** Hot-loop guard: never let a caller ask for a sub-second repeat sweep. */
const MIN_SWEEP_MS = 1000;

/** Default interpreter when no explicit path is configured (§4 `pythonPath: null`). */
const DEFAULT_PYTHON = 'python';

/** Silent log sink: this module must never crash on a missing/partial logger. */
function normalizeLog(log) {
  const out = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  if (log && typeof log === 'object') {
    for (const key of ['debug', 'info', 'warn', 'error']) {
      if (typeof log[key] === 'function') out[key] = log[key].bind(log);
    }
  }
  return out;
}

/**
 * Canonical cache key (CONTRACTS-PHASE2.md §3): psutil returns lowercased backslash
 * paths, so a forward-slash mixed-case path from the watcher must land on the same key.
 * Additionally strips an extended-length / device prefix (`\\?\`, `\??\`, `\\.\`) on
 * BOTH sides, so a path handed over as `\\?\C:\...` (long-path form) still hits. For
 * ordinary DOS paths this is a no-op, i.e. keys remain exactly the frozen form.
 * @param {string} p
 * @returns {string}
 */
function normKey(p) {
  let s = String(p).replace(/\//g, '\\');
  for (const prefix of ['\\\\?\\', '\\??\\', '\\\\.\\']) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  return s.toLowerCase();
}

/** @param {unknown} v @returns {string} */
function errText(v) {
  if (v && typeof v.message === 'string' && v.message.length > 0) return v.message;
  return String(v);
}

export class HandleIndex {
  /**
   * @param {{log?:object, pythonPath?:string|null, rootPid?:number, sweepMs?:number,
   *          timeoutMs?:number, budgetMs?:number, maxConsecutiveSlow?:number}} [opts]
   *   `rootPid` is not in CONTRACTS-PHASE2 §3 but is required to sweep the right tree;
   *   it defaults to `process.pid` (the dsh process itself), matching ProcessTree.
   */
  constructor(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    this.log = normalizeLog(o.log);

    this.pythonPath =
      typeof o.pythonPath === 'string' && o.pythonPath.trim().length > 0
        ? o.pythonPath.trim()
        : DEFAULT_PYTHON;

    this.rootPid = Number.isInteger(Number(o.rootPid)) && Number(o.rootPid) >= 0
      ? Number(o.rootPid)
      : process.pid;

    this.sweepMs = Number.isFinite(Number(o.sweepMs)) && Number(o.sweepMs) > 0
      ? Math.max(MIN_SWEEP_MS, Math.floor(Number(o.sweepMs)))
      : DEFAULTS.sweepMs;

    this.timeoutMs = Number.isFinite(Number(o.timeoutMs)) && Number(o.timeoutMs) > 0
      ? Math.floor(Number(o.timeoutMs))
      : DEFAULTS.timeoutMs;

    // budgetMs = 0 is legal and means "every sweep counts as slow" (used by the probe).
    this.budgetMs = Number.isFinite(Number(o.budgetMs)) && Number(o.budgetMs) >= 0
      ? Number(o.budgetMs)
      : DEFAULTS.budgetMs;

    this.maxConsecutiveSlow =
      Number.isFinite(Number(o.maxConsecutiveSlow)) && Number(o.maxConsecutiveSlow) >= 1
        ? Math.floor(Number(o.maxConsecutiveSlow))
        : DEFAULTS.maxConsecutiveSlow;

    /** @type {Map<string,{pid:number,name:string}>} path -> owner (last good sweep) */
    this._map = new Map();
    /** @type {import('node:child_process').ChildProcess|null} */
    this._child = null;
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
    /** @type {{cmd:string,resolve:(v:any)=>void,timer:any}|null} one serialized command slot */
    this._pending = null;
    /** @type {Promise<any>|null} in-flight sweep (coalesced) */
    this._inflight = null;
    /** @type {Promise<boolean>|null} in-flight start (coalesced) */
    this._starting = null;

    this._available = false;
    this._disabled = false;
    this._closed = false;
    this._slowStreak = 0;
    this._startedOnce = false;

    // counters exposed by stats()
    this._sweeps = 0;
    this._members = 0;
    this._files = 0;
    this._denied = 0;
    this._lastMs = 0;
    this._lastAt = 0;
    this._sumMs = 0;
    this._nMs = 0;
    this._lastError = '';
    this._psutilVersion = null;
    this._childPid = null;
    this._stderrTail = '';
  }

  /* ------------------------------------------------------------------ *
   * lifecycle
   * ------------------------------------------------------------------ */

  /**
   * Spawn the bridge and handshake (`ping`). Returns FALSE — never rejects — when the
   * interpreter, psutil or the bridge is unavailable (CONTRACTS-PHASE2.md §3).
   * Resolves `true` only after the bridge has answered a readiness line.
   * @returns {Promise<boolean>}
   */
  async start() {
    try {
      if (this._child && this._available === true) return true;
      if (this._starting) return await this._starting;
      this._starting = this._startOnce().finally(() => {
        this._starting = null;
      });
      return await this._starting;
    } catch (err) {
      this.log.warn(`[c-cleaner] HandleIndex.start failed: ${errText(err)}`);
      return false;
    }
  }

  async _startOnce() {
    this._closed = false;
    this._disabled = false; // a fresh start re-arms the budget watchdog
    this._slowStreak = 0;
    this._stderrTail = '';

    let child;
    try {
      child = spawn(this.pythonPath, ['-u', '-c', BRIDGE, String(this.rootPid)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      // spawn() throws synchronously only for invalid arguments, not for a missing binary.
      this.log.warn(
        `[c-cleaner] HandleIndex.start: could not spawn "${this.pythonPath}": ${errText(err)}`,
      );
      this._available = false;
      return false;
    }

    this._child = child;
    this._available = false;
    this._childPid = Number.isInteger(child.pid) ? child.pid : null;

    let exited = false;
    const onGone = (why) => {
      if (exited) return;
      exited = true;
      this._available = false;
      this._stopTimer();
      if (this._child === child) this._child = null;
      if (this._pending) {
        const e = this._pending;
        this._pending = null;
        clearTimeout(e.timer);
        e.resolve(null);
      }
      if (!this._closed) {
        this.log.warn(`[c-cleaner] HandleIndex: python bridge ${why}`);
      } else {
        this.log.debug(`[c-cleaner] HandleIndex: python bridge ${why}`);
      }
    };

    child.on('error', (err) => {
      this.log.warn(
        `[c-cleaner] HandleIndex.start: spawn "${this.pythonPath}" failed (${
          err && err.code ? err.code : 'ERROR'
        }: ${errText(err)})`,
      );
      onGone(`could not be started (${err && err.code ? err.code : 'ERROR'})`);
    });
    child.on('exit', (code, signal) => {
      onGone(`exited (code ${code === null ? 'null' : code}, signal ${signal === null ? 'null' : signal})`);
    });
    // A dead child turns every write into an async EPIPE on these streams; swallow them
    // so the host process never sees an unhandled 'error' event.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (stream && typeof stream.on === 'function') {
        stream.on('error', (err) => {
          this.log.debug(`[c-cleaner] HandleIndex: bridge stream error: ${errText(err)}`);
        });
      }
    }
    if (child.stdout) child.stdout.setEncoding('utf8');
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this._stderrTail = (this._stderrTail + String(chunk)).slice(-2000);
      });
    }
    if (child.stdout) {
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += String(chunk);
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const lineText = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          this._handleLine(lineText);
        }
        if (buf.length > 1024 * 1024) buf = ''; // never grow unbounded on garbage
      });
    }

    const hello = await this._command('ping');
    if (!hello || hello.ready !== true || hello.ok !== true) {
      const why = hello && hello.error ? hello.error : 'no readiness response from the bridge';
      this.log.warn(
        `[c-cleaner] HandleIndex.start: python/psutil bridge unavailable (${why})${
          this._stderrTail ? ` stderr=${this._stderrTail.trim()}` : ''
        }; handle attribution stays unavailable (available=false)`,
      );
      this._failChild('bridge unavailable');
      return false;
    }

    this._available = true;
    this._startedOnce = true;
    this._psutilVersion = typeof hello.psutil === 'string' ? hello.psutil : null;
    this.log.info(
      `[c-cleaner] HandleIndex.start: python ${hello.python} / psutil ${hello.psutil} ` +
        `(child pid ${hello.pid}), root ${this.rootPid}, sweep every ${this.sweepMs} ms, ` +
        `budget ${this.budgetMs} ms x ${this.maxConsecutiveSlow} (CONTRACTS-PHASE2 §0: ~2 s CPU per sweep)`,
    );

    this._startTimer();
    // Warm the cache once, out of band (mirrors ProcessTree.start()'s immediate refresh).
    this.sweep().catch(() => {});
    return true;
  }

  /**
   * Send `quit`, then force-kill if the child is still alive shortly after. Idempotent:
   * a second call is a logged no-op. The cache survives (lookup() keeps answering) but
   * `stats().available` becomes false — no fresh data can arrive.
   */
  stop() {
    try {
      this._stopTimer();
      this._available = false;
      this._closed = true;
      const child = this._child;
      this._child = null;
      if (!child) {
        this.log.debug('[c-cleaner] HandleIndex.stop: no child (idempotent no-op)');
        return;
      }
      if (this._pending) {
        const e = this._pending;
        this._pending = null;
        clearTimeout(e.timer);
        e.resolve(null);
      }
      try {
        child.stdin.write('quit\n');
        child.stdin.end();
      } catch (err) {
        this.log.debug(`[c-cleaner] HandleIndex.stop: quit write failed: ${errText(err)}`);
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill();
          this.log.warn('[c-cleaner] HandleIndex.stop: bridge ignored quit, killed');
        } catch (err) {
          this.log.debug(`[c-cleaner] HandleIndex.stop: kill failed: ${errText(err)}`);
        }
      }, 750);
      if (typeof killTimer.unref === 'function') killTimer.unref();
      if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(killTimer);
      } else {
        child.once('exit', () => clearTimeout(killTimer));
      }
      this._childPid = null;
      this.log.debug('[c-cleaner] HandleIndex.stop: quit sent, bridge stopping');
    } catch (err) {
      this.log.debug(`[c-cleaner] HandleIndex.stop failed: ${errText(err)}`);
    }
  }

  /* ------------------------------------------------------------------ *
   * lookups (synchronous, cache-only)
   * ------------------------------------------------------------------ */

  /**
   * Cache-only lookup. SYNC, never spawns, never throws.
   * @param {string} filePath
   * @returns {{pid:number,name:string}|null}
   */
  lookup(filePath) {
    try {
      if (typeof filePath !== 'string' || filePath.length === 0) return null;
      const hit = this._map.get(normKey(filePath));
      if (!hit) return null;
      return { pid: hit.pid, name: hit.name };
    } catch (err) {
      this.log.debug(`[c-cleaner] HandleIndex.lookup failed: ${errText(err)}`);
      return null;
    }
  }

  /**
   * ProcessTree.handleProbe seam (lib/process-tree.js:311). Never throws.
   * If the cache is COLD (no sweep has ever completed), awaits one sweep first — which
   * either joins the in-flight sweep or issues the first one; the coalescing in sweep()
   * makes that at most one extra sweep per instance, and the same promise is shared by
   * every concurrent probe. When the index is disabled, the cold cache is not warmed
   * (that is the point of disabling) and the last good cache is served as-is.
   * @param {string} filePath
   * @returns {Promise<{pid:number,name:string}|null>}
   */
  async probe(filePath) {
    try {
      if (typeof filePath !== 'string' || filePath.length === 0) return null;
      const hit = this.lookup(filePath);
      if (hit) return hit;
      const cold = this._lastAt === 0;
      if (cold && !this._disabled && this._available === true) {
        await this.sweep();
        return this.lookup(filePath);
      }
      return null;
    } catch (err) {
      this.log.debug(`[c-cleaner] HandleIndex.probe failed: ${errText(err)}`);
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * sweeping
   * ------------------------------------------------------------------ */

  /**
   * Rebuild the handle->owner cache. Idempotent and never concurrent: concurrent calls
   * share one in-flight promise. Never throws.
   * @returns {Promise<{ok:boolean,members:number,files:number,denied:number,ms:number,error?:string}>}
   */
  async sweep() {
    if (this._inflight) return this._inflight;
    if (this._disabled) {
      return {
        ok: false,
        members: 0,
        files: 0,
        denied: 0,
        ms: 0,
        error: `disabled (sweep exceeded budgetMs=${this.budgetMs} ${this.maxConsecutiveSlow}x)`,
      };
    }
    if (!this._child || this._available !== true) {
      return { ok: false, members: 0, files: 0, denied: 0, ms: 0, error: 'not started' };
    }
    this._inflight = this._sweepOnce().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  async _sweepOnce() {
    const t0 = Date.now();
    let res = null;
    let thrown = '';
    try {
      res = await this._command('sweep');
    } catch (err) {
      thrown = errText(err);
    }
    const ms = Date.now() - t0;
    this._sweeps += 1; // a sweep command was issued

    if (!res || res.ok !== true) {
      const error = thrown || (res && res.error ? String(res.error) : 'no response from bridge');
      this._lastError = error;
      this.log.warn(`[c-cleaner] HandleIndex.sweep: failed after ${ms} ms (${error})`);
      return { ok: false, members: 0, files: 0, denied: 0, ms, error };
    }

    // Replace the whole cache — no stale entries (CONTRACTS-PHASE2.md §3).
    const next = new Map();
    const raw = res.map && typeof res.map === 'object' ? res.map : {};
    for (const [key, value] of Object.entries(raw)) {
      const pid = Number(value && value.pid);
      if (!Number.isInteger(pid) || pid < 0) continue;
      const k = normKey(key);
      if (k.length === 0 || next.has(k)) continue;
      const name = value && typeof value.name === 'string' && value.name.length > 0 ? value.name : '';
      next.set(k, { pid, name });
    }
    this._map = next;

    const members = Number.isFinite(Number(res.members)) ? Number(res.members) : 0;
    const files = Number.isFinite(Number(res.files)) ? Number(res.files) : 0;
    const denied = Number.isFinite(Number(res.denied)) ? Number(res.denied) : 0;
    this._members = members;
    this._files = files;
    this._denied = denied;
    this._lastMs = ms;
    this._lastAt = Date.now();
    this._sumMs += ms;
    this._nMs += 1;
    this._lastError = '';

    this.log.debug(
      `[c-cleaner] HandleIndex.sweep: ${members} member(s), ${files} open file(s) -> ` +
        `${next.size} unique path(s), denied=${denied}, ${ms} ms wall (bridge ${res.ms} ms)`,
    );
    this._checkBudget(ms);
    return { ok: true, members, files, denied, ms };
  }

  /** Auto-disable (§3): budgetMs exceeded maxConsecutiveSlow times in a row. */
  _checkBudget(ms) {
    if (this._disabled) return;
    if (ms > this.budgetMs) {
      this._slowStreak += 1;
    } else {
      this._slowStreak = 0;
    }
    if (this._slowStreak >= this.maxConsecutiveSlow) {
      this._disabled = true;
      this._stopTimer();
      this.log.warn(
        `[c-cleaner] HandleIndex: DISABLED after ${this._slowStreak} consecutive sweeps over ` +
          `budgetMs=${this.budgetMs} (last ${ms} ms); no further sweeps, lookup() keeps serving ` +
          `the last good cache of ${this._map.size} path(s)`,
      );
    }
  }

  /* ------------------------------------------------------------------ *
   * diagnostics
   * ------------------------------------------------------------------ */

  /**
   * @returns {{available:boolean, sweeps:number, files:number, denied:number,
   *            lastMs:number, lastAt:number, avgMs:number, disabled:boolean}}
   */
  stats() {
    return {
      available: this._available === true,
      sweeps: this._sweeps,
      files: this._files,
      denied: this._denied,
      lastMs: this._lastMs,
      lastAt: this._lastAt,
      avgMs: this._nMs > 0 ? Math.round(this._sumMs / this._nMs) : 0,
      disabled: this._disabled === true,
    };
  }

  /* ------------------------------------------------------------------ *
   * internals
   * ------------------------------------------------------------------ */

  _startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.sweep().catch(() => {});
    }, this.sweepMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  _stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Issue one command; resolves with the child's JSON line, or null on any failure. */
  _command(cmd) {
    return new Promise((resolve) => {
      const child = this._child;
      if (!child || child.exitCode !== null || child.signalCode !== null || !child.stdin || child.stdin.destroyed) {
        resolve(null);
        return;
      }
      const entry = {
        cmd,
        resolve: (v) => resolve(v),
        timer: null,
      };
      this._pending = entry;
      entry.timer = setTimeout(() => {
        if (this._pending === entry) this._pending = null;
        this.log.warn(
          `[c-cleaner] HandleIndex.${cmd}: timed out after ${this.timeoutMs} ms` +
            (this._stderrTail ? ` stderr=${this._stderrTail.trim()}` : ''),
        );
        this._failChild('command timeout'); // never let a late line desync the next sweep
        resolve(null);
      }, this.timeoutMs);
      if (typeof entry.timer.unref === 'function') entry.timer.unref();
      try {
        child.stdin.write(`${cmd}\n`);
      } catch (err) {
        clearTimeout(entry.timer);
        if (this._pending === entry) this._pending = null;
        this.log.warn(`[c-cleaner] HandleIndex.${cmd}: write failed: ${errText(err)}`);
        resolve(null);
      }
    });
  }

  _handleLine(lineText) {
    const text = String(lineText).replace(/\r$/, '').trim();
    if (text.length === 0) return;
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch (err) {
      this.log.debug(
        `[c-cleaner] HandleIndex: non-JSON line from bridge (${errText(err)}): ${text.slice(0, 200)}`,
      );
      return;
    }
    if (msg && msg.bye === true) return; // quit acknowledgement, no command is waiting on it
    const entry = this._pending;
    if (!entry) {
      this.log.debug(`[c-cleaner] HandleIndex: unsolicited bridge line: ${text.slice(0, 200)}`);
      return;
    }
    this._pending = null;
    clearTimeout(entry.timer);
    entry.resolve(msg);
  }

  /** Tear the child down (timeout/unusable). Idempotent. */
  _failChild(reason) {
    this._available = false;
    this._stopTimer();
    const child = this._child;
    this._child = null;
    this._childPid = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    this.log.debug(`[c-cleaner] HandleIndex: bridge torn down (${reason})`);
  }
}
