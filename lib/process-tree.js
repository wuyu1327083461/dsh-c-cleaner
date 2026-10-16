// lib/process-tree.js — dsh-c-cleaner / watch-tracker
//
// Implements the FROZEN contract in CONTRACTS.md §5 exactly:
//
//   export class ProcessTree {
//     constructor({ rootPid = process.pid, pollIntervalMs = 5000, log })
//     async refresh(): Promise<{ count:number, total:number }>
//     pids(): Set<number>
//     isTreeMember(pid: number): boolean
//     nameOf(pid: number): string | null
//     snapshot(): Array<{ pid:number, ppid:number, name:string }>
//     start(): void
//     stop(): void
//     async ownerOf(filePath: string): Promise<{ pid:number, name:string } | null>
//   }
//
// Design notes
// ------------
// * Enumeration is ONE `powershell.exe` spawn per refresh (never one per file, per
//   CONTRACTS §5). Node 24.19.0 on this host: ~1.0-1.2 s wall clock, ~412 processes,
//   `ConvertTo-Json -Compress` returns a single object (not an array) when exactly one
//   process matches and an empty string when none do — both are handled below.
// * `.unref()` on the poll timer so the harness process can still exit (CONTRACTS §5).
// * Off-Windows / PowerShell missing: refresh() never throws; it logs and keeps the
//   previous snapshot (a stale tree beats an empty tree for attribution).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** PowerShell one-liner that dumps the process table as compact JSON. */
const PS_PROCESS_SELECT =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';

/** argv for the single enumeration spawn. */
const PS_PROCESS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', PS_PROCESS_SELECT];

/** PowerShell cold start is slow on this host (measured ~1.0 s); give it room. */
const ENUM_TIMEOUT_MS = Number(process.env.CC_PROCESS_ENUM_TIMEOUT_MS) || 30000;
const ENUM_MAX_BUFFER = 16 * 1024 * 1024;

/** Default log sink: silent, so the module never crashes on a missing logger. */
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
 * Parse the `ConvertTo-Json -Compress` payload into pid -> {pid, ppid, name}.
 * Tolerates: empty output, a bare object (single row), an array, and garbage rows.
 * @param {string} stdout
 * @returns {Map<number, {pid:number, ppid:number, name:string|null}>}
 */
function parseProcessTable(stdout) {
  const table = new Map();
  const text = String(stdout == null ? '' : stdout).trim();
  if (text.length === 0) return table;

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // PowerShell may prepend a warning line to stdout in exotic configurations.
    const start = text.search(/[[{]/);
    if (start < 0) return table;
    data = JSON.parse(text.slice(start));
  }

  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const pid = Number(row.ProcessId);
    if (!Number.isInteger(pid) || pid < 0) continue;
    const ppid = Number(row.ParentProcessId);
    const name = typeof row.Name === 'string' && row.Name.length > 0 ? row.Name : null;
    table.set(pid, { pid, ppid: Number.isInteger(ppid) ? ppid : -1, name });
  }
  return table;
}

/**
 * Build the ppid -> [pid] child index for the whole process table.
 * @param {Map<number, {pid:number, ppid:number}>} table
 */
function buildChildIndex(table) {
  const children = new Map();
  for (const rec of table.values()) {
    let list = children.get(rec.ppid);
    if (!list) {
      list = [];
      children.set(rec.ppid, list);
    }
    list.push(rec.pid);
  }
  return children;
}

/**
 * Recursive descendant set of `rootPid`, INCLUDING `rootPid` itself.
 * Iterative BFS with a visited set (immune to pid cycles / pid 0 self-parenting).
 * @param {number} rootPid
 * @param {Map<number, number[]>} children
 * @returns {Set<number>}
 */
function collectTree(rootPid, children) {
  const members = new Set();
  if (!Number.isInteger(rootPid) || rootPid < 0) return members;

  members.add(rootPid); // CONTRACTS §5: the root is always part of its own tree.
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    const kids = children.get(pid);
    if (!kids) continue;
    for (const kid of kids) {
      if (members.has(kid)) continue;
      members.add(kid);
      queue.push(kid);
    }
  }
  return members;
}

export class ProcessTree {
  /**
   * @param {{rootPid?:number, pollIntervalMs?:number, log?:object,
   *          handleProbe?:(filePath:string)=>Promise<{pid:number,name?:string}|null>}} [opts]
   *   `handleProbe` is an OPTIONAL injection seam (not part of CONTRACTS §5) for a
   *   future handle->pid backend. When absent, ownerOf() honestly returns null.
   */
  constructor({ rootPid = process.pid, pollIntervalMs = 5000, log, handleProbe = null } = {}) {
    this.rootPid = Number(rootPid);
    this.pollIntervalMs = Number.isFinite(Number(pollIntervalMs)) && Number(pollIntervalMs) > 0
      ? Number(pollIntervalMs)
      : 5000;
    this.log = normalizeLog(log);
    this.handleProbe = typeof handleProbe === 'function' ? handleProbe : null;

    /** @type {Map<number, {pid:number, ppid:number, name:string|null}>} full cached table */
    this._procs = new Map();
    /** @type {Map<number, number[]>} ppid -> children */
    this._children = new Map();
    /** @type {Set<number>} recursive descendant set of rootPid (root included) */
    this._tree = new Set([this.rootPid]);
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
    /** @type {Promise<{count:number,total:number}>|null} in-flight refresh (coalesced) */
    this._inflight = null;
    this._lastResult = { count: 1, total: 0 };
    this._refreshes = 0;
  }

  /**
   * Enumerate the process table once, rebuild the cached snapshot and the tree.
   * Never rejects: on failure it logs, keeps the previous snapshot and still reports
   * `rootPid` as a member (the tracked root is the harness process itself).
   * @returns {Promise<{count:number, total:number}>} count = tree size, total = all processes
   */
  async refresh() {
    if (this._inflight) return this._inflight; // coalesce concurrent polls
    this._inflight = this._refreshOnce().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  async _refreshOnce() {
    let stdout;
    try {
      const res = await execFileAsync('powershell.exe', PS_PROCESS_ARGS, {
        encoding: 'utf8',
        timeout: ENUM_TIMEOUT_MS,
        maxBuffer: ENUM_MAX_BUFFER,
        windowsHide: true,
      });
      stdout = res.stdout;
    } catch (err) {
      this.log.warn(
        `[c-cleaner] ProcessTree.refresh: powershell enumeration failed (${
          err && err.code ? err.code : 'ERROR'
        }: ${err && err.message ? err.message : String(err)}); keeping previous snapshot of ${
          this._procs.size
        } processes`,
      );
      this._tree.add(this.rootPid);
      this._lastResult = { count: this._tree.size, total: this._procs.size };
      return this._lastResult;
    }

    let table;
    try {
      table = parseProcessTable(stdout);
    } catch (err) {
      this.log.warn(
        `[c-cleaner] ProcessTree.refresh: could not parse process JSON (${
          err && err.message ? err.message : String(err)
        }); keeping previous snapshot`,
      );
      this._tree.add(this.rootPid);
      this._lastResult = { count: this._tree.size, total: this._procs.size };
      return this._lastResult;
    }

    this._procs = table;
    this._children = buildChildIndex(table);
    // collectTree() always includes rootPid itself, even when the enumeration did not
    // report it (race with a short-lived process, or a filtered query) — the tracked
    // root is the harness process, so its membership is true by definition.
    this._tree = collectTree(this.rootPid, this._children);
    this._refreshes += 1;
    this._lastResult = { count: this._tree.size, total: this._procs.size };

    if (!table.has(this.rootPid)) {
      this.log.warn(
        `[c-cleaner] ProcessTree.refresh: rootPid ${this.rootPid} not present in the process table ` +
          `(${table.size} processes); tree reports ${this._tree.size} member(s)`,
      );
    }
    this.log.debug(
      `[c-cleaner] ProcessTree.refresh: ${this._lastResult.count} tree member(s) of ${
        this._lastResult.total
      } process(es), root=${this.rootPid}`,
    );
    return this._lastResult;
  }

  /**
   * Recursive descendant PIDs of the tracked root, root included.
   * Returns a COPY so callers cannot mutate internal state.
   * @returns {Set<number>}
   */
  pids() {
    return new Set(this._tree);
  }

  /** @param {number} pid @returns {boolean} */
  isTreeMember(pid) {
    return this._tree.has(Number(pid));
  }

  /**
   * Executable name for a pid from the cached snapshot (no spawn).
   * @param {number} pid @returns {string|null}
   */
  nameOf(pid) {
    const rec = this._procs.get(Number(pid));
    return rec && typeof rec.name === 'string' && rec.name.length > 0 ? rec.name : null;
  }

  /**
   * The cached process table as a plain array, sorted by pid for determinism.
   * NOTE: this is the WHOLE table (tree members are a subset); filter with
   * `isTreeMember()` when only the dsh tree is wanted. Documented because the
   * CONTRACTS §5 return type does not say which of the two it is.
   * @returns {Array<{pid:number, ppid:number, name:string|null}>}
   */
  snapshot() {
    return [...this._procs.values()]
      .map((rec) => ({ pid: rec.pid, ppid: rec.ppid, name: rec.name }))
      .sort((a, b) => a.pid - b.pid);
  }

  /** Start polling; no-op when already started. Timer is unref'd (CONTRACTS §5). */
  start() {
    if (this._timer) return;
    this.refresh().catch(() => {}); // warm the cache immediately
    this._timer = setInterval(() => {
      this.refresh().catch((err) => {
        this.log.debug(
          `[c-cleaner] ProcessTree poll error: ${err && err.message ? err.message : String(err)}`,
        );
      });
    }, this.pollIntervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    this.log.debug(`[c-cleaner] ProcessTree.start: polling every ${this.pollIntervalMs} ms`);
  }

  /** Stop polling; idempotent. Counters/snapshot are retained. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      this.log.debug('[c-cleaner] ProcessTree.stop: polling stopped');
    }
  }

  /**
   * BEST-EFFORT owner lookup for a file path. NEVER throws; returns null when the
   * owner cannot be determined.
   *
   * HONEST LIMITATION: Windows offers no cheap Node-native way to map an open file
   * handle back to its owning PID. Doing it properly needs either ETW handle events
   * (`Microsoft-Windows-Kernel-File`) or Sysinternals `handle64.exe`, i.e. extra
   * tooling and (for `handle64.exe`) a process spawn PER FILE — which CONTRACTS §5
   * and PRD §6.1 (CPU < 2 %) explicitly forbid.
   *
   * Therefore the default implementation has no owner data to report and returns
   * null; it never fabricates a pid. A real backend can be injected through the
   * optional `handleProbe` constructor seam (used by tests / future ETW wiring):
   * its result is accepted only when the pid exists in the cached process table.
   *
   * @param {string} filePath
   * @returns {Promise<{pid:number, name:string}|null>}
   */
  async ownerOf(filePath) {
    try {
      if (typeof filePath !== 'string' || filePath.length === 0) return null;
      if (!this.handleProbe) return null;
      const hit = await this.handleProbe(filePath);
      if (!hit || typeof hit !== 'object') return null;
      const pid = Number(hit.pid);
      if (!Number.isInteger(pid)) return null;
      const rec = this._procs.get(pid);
      if (!rec) return null; // unknown pid -> refuse to guess
      const name = typeof hit.name === 'string' && hit.name.length > 0 ? hit.name : rec.name;
      if (!name) return null;
      return { pid, name };
    } catch (err) {
      this.log.debug(
        `[c-cleaner] ProcessTree.ownerOf(${filePath}) failed: ${
          err && err.message ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Diagnostics only (not in CONTRACTS §5). */
  info() {
    return {
      rootPid: this.rootPid,
      pollIntervalMs: this.pollIntervalMs,
      started: this._timer !== null,
      refreshes: this._refreshes,
      treeSize: this._tree.size,
      total: this._procs.size,
    };
  }
}
