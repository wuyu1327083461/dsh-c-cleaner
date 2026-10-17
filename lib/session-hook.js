/**
 * lib/session-hook.js — PRD §7 Phase 3: 会话结束自动静默清理钩子 (`post_session_close`).
 *
 * ## The name in the PRD does not exist in the host; this is the event that does
 *
 * The PRD calls the hook `post_session_close`. No such event exists anywhere in the dsh tree —
 * a grep for the identifier over every `.js`/`.d.ts` in `@deepseek-ai/*` returns nothing, so it
 * is a conceptual name, not an API to call. The real seam is the Cordis event
 * **`session/disposed`**, dispatched per session by `SessionStore`:
 *
 *   - `@deepseek-ai/dsh-session/lib/index.js:1813` `emitDisposed(entry)` → line 1818 emits
 *     `"session/disposed"`, line 1821 `invokeContainedSessionObservers(...)`.
 *   - Reached from `detachEntered(entry)` (`@deepseek-ai/dsh-session/lib/index.js:1780`).
 *   - The listener shape is `ctx.on('session/disposed', (session) => …)`, carrying at least
 *     `session.id`. Verified against every shipped subscriber of the same event:
 *     `dsh-session-telemetry/lib/index.js:69`, `dsh-session-persistence-jsonl/lib/index.js:421`,
 *     `dsh-api-session-controller/lib/index.js:2876`,
 *     `dsh-session-projection-cache/lib/index.js:316`.
 *
 * So this module subscribes to `session/disposed` and calls it the session-close hook. The PRD
 * name is kept in the config key (`sessionCloseClean`) and in the docs so the requirement stays
 * traceable to the code that satisfies it.
 *
 * ## Why the listener is async, fire-and-forget, and cannot throw
 *
 * The host awaits listener promises and warns on rejection, so a slow listener delays session
 * teardown. Cleaning is not allowed to do that: the listener returns immediately and the sweep
 * runs detached. Every failure is caught and logged — a throwing listener cannot break the host,
 * but a plugin must not rely on that.
 *
 * ## Why cleaning on close is safe
 *
 * It only ever deletes rows the plugin itself classified `SAFE_TO_DELETE` and re-validates at
 * delete time, through `clean()`, which re-runs the §6.2 protected-path blacklist, the
 * directory/reparse refusal and the instant stat revalidation. This module adds no delete path of
 * its own — it is a scheduler in front of the existing, already-verified cleaner.
 *
 * @module dsh-c-cleaner/lib/session-hook
 */

/**
 * Session ids seen at `session/created`, with the time they appeared. Kept so a session that
 * existed for only a moment (the host creates and disposes throwaway sessions routinely) does not
 * trigger a sweep: cleaning is expensive and pointless on a session that never wrote anything.
 * Bounded, because an unbounded map on a long-running host is a leak.
 *
 * @type {Map<string, number>}
 */
const PROVISIONAL_LIMIT = 64;

/**
 * Install the session-close hook.
 *
 * @param {object} ctx - the Cordis context of the plugin.
 * @param {object} deps
 * @param {object} deps.cfg - resolved config (`sessionCloseClean`, `sessionCloseMinAgeMs`,
 *   `autoClean`).
 * @param {object} deps.log - logger with `info`/`warn`/`debug`/`error`.
 * @param {() => Promise<object[]>} deps.trackedRows - returns the persisted rows.
 * @param {(rows:object[], opts:object) => Promise<object>} deps.clean - the existing cleaner.
 * @param {() => Promise<object[]>} [deps.refresh] - optional re-collection before cleaning.
 * @returns {{dispose: () => void, sweep: (reason:string) => Promise<object|null>,
 *            isEnabled: () => boolean}}
 *   A handle whose `dispose()` unsubscribes. Never throws.
 */
export function installSessionHook(ctx, deps) {
  const cfg = deps?.cfg ?? {};
  const log = deps?.log ?? {};
  const trackedRows = typeof deps?.trackedRows === 'function' ? deps.trackedRows : null;
  const clean = typeof deps?.clean === 'function' ? deps.clean : null;
  const refresh = typeof deps?.refresh === 'function' ? deps.refresh : null;

  /** @type {Map<string, number>} session id -> first-seen ms. */
  const seenAt = new Map();
  /** Guards against two sessions disposed at once producing two concurrent sweeps. */
  let running = false;
  let disposed = false;

  /**
   * Map persisted `TrackedRow`s to the `Classified` shape `clean()` reads.
   *
   * This conversion is load-bearing and was a real defect: the rows in the state DB use the
   * PRD §5 column names (`file_path`, `file_size`), while `clean()` reads `rec.path`. Passing the
   * rows straight through meant every record failed its `typeof rec.path !== 'string'` guard and
   * the sweep reported "nothing removed" over a full table — a silent cleaner that cleaned
   * nothing. The mapping mirrors `lib/web-api.js` so both callers hand `clean()` the same shape.
   */
  const toClassified = (rows) => {
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row === null || typeof row !== 'object') continue;
      if (row.category !== 'SAFE_TO_DELETE') continue;
      const filePath = typeof row.file_path === 'string' ? row.file_path : '';
      if (filePath.length === 0) continue;
      out.push({
        path: filePath,
        size: Number.isFinite(row.file_size) ? row.file_size : 0,
        category: row.category,
        isLocked: !!row.is_locked,
        lockedByPid: row.locked_by_pid ?? null,
        lockedByProcess: row.source_process ?? null,
        reason: 'session-close',
        sourceProcess: row.source_process ?? null,
        mtimeMs: row.last_checked_at ?? Date.now(),
      });
    }
    return out;
  };

  const enabled = () => cfg.sessionCloseClean === true && cfg.enabled !== false && trackedRows !== null && clean !== null;

  const remember = (id) => {
    if (typeof id !== 'string' || id.length === 0) return;
    if (seenAt.size >= PROVISIONAL_LIMIT) {
      // Drop the oldest insertion (Map preserves insertion order) rather than growing forever.
      const oldest = seenAt.keys().next();
      if (!oldest.done) seenAt.delete(oldest.value);
    }
    seenAt.set(id, Date.now());
  };

  const callLog = (level, msg) => {
    try {
      if (typeof log[level] === 'function') log[level](msg);
    } catch {
      /* logging must never throw into the host */
    }
  };

  /**
   * Run one silent sweep. Public on the handle so the command layer and the tests can invoke
   * exactly the code the event invokes, instead of reimplementing it.
   *
   * @param {string} reason - why the sweep ran (session id, manual trigger, …) for the log line.
   * @returns {Promise<object|null>} the cleaner report, or null when nothing was done.
   */
  async function sweep(reason) {
    if (!enabled()) return null;
    if (running) {
      callLog('debug', `session-close sweep skipped (one is already running): ${reason}`);
      return null;
    }
    running = true;
    try {
      // Re-collect first: the point of cleaning at session end is to catch files that landed
      // since the last refresh, and a stale row list would clean yesterday's picture.
      if (refresh !== null) {
        try {
          await refresh();
        } catch (err) {
          callLog('warn', `session-close refresh failed (continuing with stored rows): ${err?.message ?? err}`);
        }
      }

      const rows = await trackedRows();
      const safe = toClassified(rows);
      if (safe.length === 0) {
        callLog('debug', `session-close sweep found nothing to clean: ${reason}`);
        return null;
      }

      const report = await clean(safe, { deep: false, force: false, cfg, log });
      const removed = Number(report?.removed ?? 0);
      const bytes = Number(report?.bytesFreed ?? 0);
      if (removed > 0) {
        callLog('info', `session-close silent clean (${reason}): removed ${removed} file(s), freed ${bytes} B`);
      } else {
        callLog('debug', `session-close silent clean (${reason}): nothing removed (${Number(report?.skipped ?? 0)} skipped)`);
      }
      return report ?? null;
    } catch (err) {
      // A background sweep must never surface as an unhandled rejection.
      callLog('warn', `session-close sweep failed: ${err?.message ?? err}`);
      return null;
    } finally {
      running = false;
    }
  }

  /** Handle one `session/disposed` event. Deliberately synchronous and non-throwing. */
  const onDisposed = (session) => {
    if (disposed) return;
    try {
      if (!enabled()) return;
      const id = typeof session?.id === 'string' ? session.id : String(session?.id ?? '');
      const first = seenAt.get(id);
      seenAt.delete(id);

      const minAge = Number.isFinite(cfg.sessionCloseMinAgeMs) ? cfg.sessionCloseMinAgeMs : 0;
      if (first !== undefined && minAge > 0 && Date.now() - first < minAge) {
        callLog('debug', `session-close sweep skipped for ${id}: session lived < ${minAge} ms`);
        return;
      }

      // Detached on purpose: the host awaits listener promises, and cleaning must not delay
      // session teardown. `sweep` contains its own try/catch, so this cannot reject.
      void sweep(`session ${id || '<unknown>'}`);
    } catch (err) {
      callLog('warn', `session-close handler failed: ${err?.message ?? err}`);
    }
  };

  /** Handle `session/created` so the minimum-age rule has a start time to measure from. */
  const onCreated = (session) => {
    if (disposed) return;
    try {
      remember(typeof session?.id === 'string' ? session.id : String(session?.id ?? ''));
    } catch {
      /* a bookkeeping miss only weakens the age heuristic; it never blocks a sweep */
    }
  };

  /** Install one subscriber and return its disposer, tolerating a ctx without `on`. */
  const subscribe = (event, handler) => {
    try {
      if (typeof ctx?.on !== 'function') return () => {};
      const off = ctx.on(event, handler);
      return typeof off === 'function' ? off : () => {};
    } catch (err) {
      callLog('warn', `session-hook could not subscribe to ${event}: ${err?.message ?? err}`);
      return () => {};
    }
  };

  const offCreated = subscribe('session/created', onCreated);
  const offDisposed = subscribe('session/disposed', onDisposed);

  if (enabled()) {
    callLog('info', 'session-close silent clean hook armed (session/disposed, the PRD post_session_close)');
  } else if (cfg.sessionCloseClean === true) {
    callLog('warn', 'sessionCloseClean is on but the hook cannot run (plugin disabled or deps missing)');
  }

  return {
    sweep,
    isEnabled: enabled,
    dispose() {
      if (disposed) return;
      disposed = true;
      seenAt.clear();
      try {
        offCreated();
      } catch {
        /* already gone */
      }
      try {
        offDisposed();
      } catch {
        /* already gone */
      }
    },
  };
}

export default installSessionHook;
