/**
 * dsh-c-cleaner — lock-owner resolver (PRD §3.3: "highlight the holding process name + PID").
 *
 * Why this module exists
 * ----------------------
 * `classify()` can only tell THAT a file is locked — `fs.openSync(p,'r+')` throwing EBUSY/EPERM
 * proves an exclusive handle exists but reveals nothing about who holds it. `ProcessTree.ownerOf()`
 * honestly returns `null` for the same reason: Windows gives Node no cheap handle→PID mapping, and
 * the alternatives (ETW kernel-file tracing, or spawning Sysinternals `handle64.exe` once per file)
 * are forbidden by PRD §6.1 (CPU <2%) and CONTRACTS §5.
 *
 * Windows' own "this file is in use" dialog solves this with the **Restart Manager** API
 * (`rstrtmgr.dll`): register the file paths in a session, then `RmGetList` returns the processes
 * holding them. It needs **no administrator rights, no native addon, and no external binary** —
 * only the DLL that ships with Windows. Verified on this host: it reports the real holder of an
 * exclusively-locked file, e.g. `Windows PowerShell:788` for a `FileShare.None` holder.
 *
 * Cost model (measured on this host, PRD §6.1 is the binding constraint)
 * ---------------------------------------------------------------------
 *   - one `powershell.exe` spawn + C# `Add-Type` compile ≈ 3.5 s WALL CLOCK, but ~0 CPU: the
 *     process is idle in the runtime, so it does not threaten the CPU budget.
 *   - `RmGetList` itself ≈ 140 ms per file in-process, ≈ 10 ms for a file nobody holds.
 * Therefore this resolver is built to spawn **at most one PowerShell per batch**, never one per
 * file, and to CACHE answers so a repeatedly-seen locked file costs nothing after the first look.
 * It is asynchronous and off the critical path: `classify()` never waits for it.
 *
 * Failure policy: never throw. Any failure (no PowerShell, no rstrtmgr.dll, timeout, unparsable
 * output) degrades to "owner unknown" and the caller leaves `locked_by_pid` as null — which is
 * exactly the honest state this module improves on, not a state it must exceed.
 *
 * @module dsh-c-cleaner/lib/lock-owner
 */

import { execFile } from 'node:child_process';

/** Defaults; all overridable so tests can trade wall clock for speed. */
const DEFAULTS = Object.freeze({
  /** Kill a stalled PowerShell after this long. Generous: first call compiles C#. */
  timeoutMs: 20000,
  /** A positive answer (pid found) stays valid this long. */
  hitTtlMs: 30000,
  /** A negative answer (`NONE`) is re-checked sooner — a lock can appear at any moment. */
  missTtlMs: 5000,
  /** Paths arriving within this window are merged into ONE PowerShell spawn. */
  batchWindowMs: 250,
  /** Hard cap on paths per spawn, so one batch can never balloon. */
  maxBatch: 25,
});

/**
 * The P/Invoke shim + call loop. Kept as one self-contained script because the C# type must be
 * compiled inside the same PowerShell process that uses it.
 *
 * Paths are passed as a single JSON array in an environment variable rather than interpolated into
 * the script: that keeps a path containing a quote, a backtick, `$`, or a newline from ever being
 * parsed as PowerShell code. (A previous probe interpolated a JS array literal into the script and
 * produced a syntax error — `@([...])` is read as a type literal — so the escaping is deliberate.)
 */
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CcRm {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  const int CCH_RM_MAX_APP_NAME = 255, CCH_RM_MAX_SVC_NAME = 63;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nSvcs, string[] svcs);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] arr, ref uint reasons);
  public static string Who(string path) {
    uint session; string key = Guid.NewGuid().ToString();
    int r = RmStartSession(out session, 0, key);
    if (r != 0) return "ERR|RmStartSession|" + r;
    try {
      string[] one = new string[] { path };
      r = RmRegisterResources(session, 1, one, 0, null, 0, null);
      if (r != 0) return "ERR|RmRegisterResources|" + r;
      uint needed = 0, count = 0, reasons = 0;
      r = RmGetList(session, out needed, ref count, null, ref reasons);
      if (r == 234) {
        count = needed; RM_PROCESS_INFO[] arr = new RM_PROCESS_INFO[count];
        r = RmGetList(session, out needed, ref count, arr, ref reasons);
        if (r != 0) return "ERR|RmGetList|" + r;
        List<string> hits = new List<string>();
        for (int i = 0; i < count; i++) hits.Add(arr[i].strAppName + "|" + arr[i].Process.dwProcessId);
        return hits.Count == 0 ? "NONE" : ("HIT|" + string.Join(";", hits));
      }
      if (r != 0) return "ERR|RmGetList|" + r;
      return "NONE";
    } finally { RmEndSession(session); }
  }
}
'@
$paths = @()
# Do NOT parse this with a pipeline into ConvertFrom-Json. With two or more paths in the JSON array,
# pipeline binding passes the whole string as ONE object and PowerShell emits a single space-joined
# string, so Restart Manager is asked about a nonexistent combined path and returns error 6 for every
# path in the batch. -InputObject keeps the array intact (verified for 0/1/2/3/25 paths).
if ($env:CC_RM_PATHS) { $o = ConvertFrom-Json -InputObject $env:CC_RM_PATHS; foreach ($i in @($o)) { $paths += [string]$i } }
foreach ($p in $paths) {
  try { $r = [CcRm]::Who([string]$p) } catch { $r = "ERR|exception|" + $_.Exception.Message }
  Write-Output ("CCRM|" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p)) + "|" + $r)
}
`;

/** `execFile` as a promise, with a hard timeout and no shell. */
function runPowerShell(paths, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
          env: { ...process.env, CC_RM_PATHS: JSON.stringify(paths) },
        },
        (err, stdout) => {
          if (err && !stdout) {
            done({ ok: false, error: err.code || err.message, results: new Map() });
            return;
          }
          done({ ok: true, results: parseOutput(stdout || '') });
        },
      );
      child.on('error', (err) => done({ ok: false, error: err.code || err.message, results: new Map() }));
    } catch (err) {
      done({ ok: false, error: err && err.message ? err.message : String(err), results: new Map() });
    }
  });
}

/**
 * Parse `CCRM|<base64 path>|<verdict>` lines.
 *
 * The path is base64 so that a path containing the delimiter, a backtick, or a newline survives
 * the round trip intact. Anything unparsable is skipped rather than guessed at.
 *
 * @param {string} stdout - PowerShell output.
 * @returns {Map<string, {pid:number, name:string}|null>} path -> owner (null = genuinely unheld).
 */
function parseOutput(stdout) {
  const out = new Map();
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('CCRM|')) continue;
    const first = line.indexOf('|', 5);
    if (first < 0) continue;
    const b64 = line.slice(5, first);
    const verdict = line.slice(first + 1);
    let decoded;
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      continue;
    }
    if (!decoded) continue;
    if (verdict === 'NONE' || verdict.startsWith('ERR|')) {
      out.set(decoded, null);
      continue;
    }
    if (!verdict.startsWith('HIT|')) continue;
    // `HIT|app|pid;app|pid` — first holder wins; a name may itself contain '|' so split on the
    // last one, and treat a missing name as empty rather than dropping the pid.
    const firstHit = verdict.slice(4).split(';')[0];
    const cut = firstHit.lastIndexOf('|');
    const name = cut < 0 ? '' : firstHit.slice(0, cut);
    const pid = cut < 0 ? Number(firstHit) : Number(firstHit.slice(cut + 1));
    if (!Number.isInteger(pid) || pid <= 0) {
      out.set(decoded, null);
      continue;
    }
    out.set(decoded, { pid, name: name || '' });
  }
  return out;
}

/**
 * Batched, cached, never-throwing lock-owner resolver.
 *
 * Usage: `const map = await resolver.resolve([pathA, pathB]); map.get(pathA)`.
 * A `null` value means "Restart Manager says nobody holds this file" — distinct from a missing key,
 * which means "we could not ask" (e.g. PowerShell absent). Callers must treat both as unknown.
 */
export class LockOwnerResolver {
  /**
   * @param {{log?:object, timeoutMs?:number, hitTtlMs?:number, missTtlMs?:number,
   *          batchWindowMs?:number, maxBatch?:number, disabled?:boolean}} [opts]
   */
  constructor(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    this.log = o.log ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.timeoutMs = pick(o.timeoutMs, DEFAULTS.timeoutMs);
    this.hitTtlMs = pick(o.hitTtlMs, DEFAULTS.hitTtlMs);
    this.missTtlMs = pick(o.missTtlMs, DEFAULTS.missTtlMs);
    this.batchWindowMs = pick(o.batchWindowMs, DEFAULTS.batchWindowMs);
    this.maxBatch = pick(o.maxBatch, DEFAULTS.maxBatch);
    /** Off-Windows or explicitly disabled: `resolve()` resolves to an empty Map immediately. */
    this.disabled = o.disabled === true || process.platform !== 'win32';

    /** @type {Map<string, {owner:{pid:number,name:string}|null, at:number}>} */
    this._cache = new Map();
    /** @type {string[]} paths waiting for the next spawn. */
    this._queue = [];
    /** @type {Map<string, Array<(v:Map<string,?>) => void>>} waiters per path. */
    this._waiters = new Map();
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
    this._spawns = 0;
    this._calls = 0;
    this._closed = false;
  }

  /** Diagnostics only — proves the batching/caching behaviour in tests. */
  stats() {
    return { spawns: this._spawns, calls: this._calls, cached: this._cache.size, queued: this._queue.length };
  }

  /**
   * Resolve owners for the given paths.
   *
   * @param {readonly string[]} paths - absolute file paths.
   * @returns {Promise<Map<string, {pid:number,name:string}|null>>} path -> owner or null.
   */
  resolve(paths) {
    const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.length > 0) : [];
    if (list.length === 0) return Promise.resolve(new Map());
    if (this.disabled || this._closed) return Promise.resolve(new Map());

    const out = new Map();
    const pending = [];
    const now = Date.now();
    for (const p of list) {
      this._calls += 1;
      const hit = this._cache.get(p);
      if (hit) {
        const ttl = hit.owner ? this.hitTtlMs : this.missTtlMs;
        if (now - hit.at < ttl) {
          out.set(p, hit.owner);
          continue;
        }
      }
      pending.push(p);
    }
    if (pending.length === 0) return Promise.resolve(out);

    const promises = pending.map(
      (p) =>
        new Promise((resolve) => {
          const bucket = this._waiters.get(p);
          if (bucket) bucket.push(resolve);
          else this._waiters.set(p, [resolve]);
        }),
    );

    for (const p of pending) if (!this._queue.includes(p)) this._queue.push(p);
    this._schedule();

    return Promise.all(promises).then(() => {
      for (const p of pending) {
        if (this._cache.has(p)) out.set(p, this._cache.get(p).owner);
      }
      return out;
    });
  }

  /** Arm the batch timer once; `.unref()` so a pending batch never keeps the host alive. */
  _schedule() {
    if (this._timer || this._closed) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this._flush();
    }, this.batchWindowMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** Drain the queue into at most one PowerShell spawn (chunked by `maxBatch`). */
  async _flush() {
    if (this._closed) return;
    while (this._queue.length > 0) {
      const batch = this._queue.splice(0, this.maxBatch);
      this._spawns += 1;
      const res = await runPowerShell(batch, this.timeoutMs);
      if (!res.ok) {
        this.log.debug(`[c-cleaner] LockOwnerResolver: rstrtmgr query failed (${res.error}) — leaving owners unknown`);
      }
      const now = Date.now();
      for (const p of batch) {
        // Only a REAL answer is cached. A transport failure must not poison the cache with a
        // "nobody holds it" verdict, or a transient PowerShell error would permanently hide owners.
        if (res.ok && res.results.has(p)) this._cache.set(p, { owner: res.results.get(p), at: now });
        const waiters = this._waiters.get(p) || [];
        this._waiters.delete(p);
        for (const w of waiters) w();
      }
    }
    // A path that arrived while the spawn was in flight needs a fresh timer.
    if (this._queue.length > 0) this._schedule();
  }

  /** Drop cached answers (used on teardown and by tests). */
  clear() {
    this._cache.clear();
  }

  /** Stop accepting work and release the timer. Safe to call more than once. */
  close() {
    this._closed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    for (const [, bucket] of this._waiters) for (const w of bucket) w();
    this._waiters.clear();
    this._queue.length = 0;
  }
}

/** Accept a finite number above zero, else the default. */
function pick(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default { LockOwnerResolver };
