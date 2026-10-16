/**
 * dsh-c-cleaner — C 盘逃逸缓存清理插件 (C-drive escape cache cleaner).
 *
 * Implements the PRD in `产品需求与技术规格文档 (PRD).md` as a native Cordis plugin:
 *
 *   1. 环境变量劫持 (PRD 3.1) — redirect AI-toolchain cache/temp variables into a
 *      non-C: escape root for the lifetime of the harness process.
 *   2. C 盘逃逸监测 (PRD 3.2) — watch the C: directories that toolchains escape into.
 *   3. 三级分类 (PRD 3.3) — SAFE_TO_DELETE / CAUTION_CACHE / LOCKED_CRITICAL.
 *   4. 隔离清理 (PRD 3.4) — recycle-bin by default, re-validated at the last instant.
 *
 * The `c-clean` command (PRD 4) exposes `status`, `now [--deep] [--force]`.
 *
 * @module dsh-c-cleaner
 */

import { Config } from './lib/config-schema.js';
import { resolveConfig, NOOP_LOG } from './lib/config.js';
import { EnvHijacker } from './lib/env-hijack.js';
import { ProcessTree } from './lib/process-tree.js';
import { CWatcher } from './lib/watcher.js';
import { classify } from './lib/classifier.js';
import { LockOwnerResolver } from './lib/lock-owner.js';
import { StateDB } from './lib/state-db.js';
import { registerCommands } from './lib/commands.js';

export const name = 'c-cleaner';

/** Log prefix; see {@link makeLogger} for why it is applied idempotently. */
const PREFIX = '[c-cleaner]';

/** The command runtime is the only hard service dependency; everything else is internal. */
export const inject = ['commands'];

/**
 * Build a harness logger that also prefixes every line, so plugin output is greppable.
 *
 * The prefix is applied IDEMPOTENTLY: several lib/ modules were written to prefix their own
 * lines (`[c-cleaner] CWatcher.start: ...`) before this wrapper existed. Prefixing
 * unconditionally produced `[c-cleaner] [c-cleaner] ...`; detecting an existing prefix keeps
 * both call styles readable without rewriting the modules that already shipped.
 *
 * @param {object} ctx - Cordis context.
 * @returns {{debug:Function,info:Function,warn:Function,error:Function}} logger.
 */
function makeLogger(ctx) {
  const base = ctx?.logger ?? NOOP_LOG;
  const wrap = (level) => (msg, ...rest) => {
    const fn = base[level] ?? NOOP_LOG[level];
    const text = String(msg);
    const line = text.startsWith(PREFIX) ? text : `${PREFIX} ${text}`;
    try {
      fn.call(base, line, ...rest);
    } catch {
      /* a logger that throws must never take the plugin down */
    }
  };
  return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
}

/**
 * Turn persisted rows back into `Classified` records so `c-clean now` operates on the
 * monitored set rather than re-walking the disk (PRD 4: `now` must be fast).
 * @param {Array<object>} rows - `TrackedRow[]` from {@link StateDB.list}.
 * @returns {Array<object>} `Classified[]`.
 */
function rowsToClassified(rows) {
  return rows.map((row) => ({
    path: row.file_path,
    size: row.file_size,
    category: row.category,
    isLocked: !!row.is_locked,
    lockedByPid: row.locked_by_pid ?? null,
    lockedByProcess: row.source_process ?? null,
    reason: 'persisted',
    sourceProcess: row.source_process ?? null,
    mtimeMs: row.last_checked_at ?? Date.now(),
  }));
}

/**
 * Cordis plugin entry point.
 *
 * @param {object} ctx - Cordis context with the `commands` service injected.
 * @param {object} [config] - validated user config (see {@link Config}).
 */
export function apply(ctx, config = {}) {
  const log = makeLogger(ctx);
  const cfg = resolveConfig(config);

  log.info(`starting; escape root = ${cfg.escapeRoot}`);

  // --- PRD 3.1: environment hijack -----------------------------------------
  const hijacker = new EnvHijacker(cfg, log);
  const hijack = hijacker.install();
  if (hijack.ok) {
    log.info(`env hijack active: ${hijack.applied.length} variable(s) redirected`);
  } else {
    // Non-Windows or a mkdir failure: degrade, never throw (CONTRACTS §11).
    log.warn(`env hijack inactive: ${hijack.errors.join('; ') || 'no variables applied'}`);
  }

  // --- PRD 5: persistent state ---------------------------------------------
  let db = null;
  try {
    db = new StateDB(cfg.dbPath);
    db.migrate();
  } catch (err) {
    log.error(`state db unavailable at ${cfg.dbPath}: ${err?.message || String(err)}`);
    db = null;
  }

  // --- PRD 3.2: monitoring --------------------------------------------------
  const tree = new ProcessTree({ rootPid: process.pid, pollIntervalMs: cfg.pollIntervalMs, log });
  let watcher = null;

  // --- PRD 3.3: who holds a locked file -------------------------------------
  // `classify` is synchronous and cannot wait ~140 ms (plus a PowerShell start) for an answer, so
  // the owner is resolved AFTER the row is persisted and patched back in. Batched and cached by
  // `LockOwnerResolver`, and reached only for rows that are genuinely locked — a rare event — so
  // the PRD 6.1 budget is untouched by construction.
  const owners = cfg.resolveLockOwner
    ? new LockOwnerResolver({ log, timeoutMs: 20000, hitTtlMs: 30000, missTtlMs: 5000, batchWindowMs: 250 })
    : null;

  /**
   * Fill in `locked_by_pid` for a persisted LOCKED row without blocking the watcher.
   *
   * The harness gives Node no cheap handle-to-PID mapping, so `ProcessTree.ownerOf()` returns null
   * by design and this is the only source of a real holder. Failures here are cosmetic — the tier
   * and the path are already correct — so every error path is swallowed into a debug line.
   *
   * @param {object} record - the `Classified` row that was just upserted.
   */
  const enrichOwner = (record) => {
    if (!owners || !record?.isLocked || record.lockedByPid) return;
    void owners
      .resolve([record.path])
      .then((map) => {
        const owner = map.get(record.path);
        if (!owner || !owner.pid) return;
        // PRD §5's schema has no dedicated holder-name column and its DDL is fixed, so the name
        // rides in `source_process` — and only when nothing better already claimed that column,
        // so a genuine creating-process attribution is never overwritten by a holding one.
        db?.upsert({ ...record, lockedByPid: owner.pid, sourceProcess: record.sourceProcess ?? owner.name ?? null });
        log.debug(`lock owner resolved: ${record.path} held by ${owner.name || '?'}:${owner.pid}`);
      })
      .catch((err) => log.debug(`lock-owner lookup failed for ${record.path}: ${err?.message || String(err)}`));
  };

  const onCandidate = (candidate) => {
    try {
      const record = classify(candidate, { cfg, tree });
      db?.upsert(record);
      log.debug(`candidate ${record.category}: ${record.path} (${record.size} B)`);
      if (record.category === 'LOCKED_CRITICAL') enrichOwner(record);
      if (cfg.autoClean && record.category === 'SAFE_TO_DELETE') {
        // Phase 3 hook — only reachable when `autoClean: true` is set explicitly.
        void import('./lib/cleaner.js')
          .then(({ clean }) => clean([record], { deep: false, force: false, cfg, log }))
          .catch((err) => log.warn(`autoClean failed for ${record.path}: ${err?.message}`));
      }
    } catch (err) {
      // One bad candidate must never kill the watcher.
      log.warn(`failed to classify ${candidate?.path}: ${err?.message || String(err)}`);
    }
  };

  if (!cfg.enabled) {
    // `enabled: false` is documented as "no hijack AND no monitoring" — the hijacker already
    // refuses on its own, but monitoring is started from here, so the master switch has to be
    // honoured at this level too or the documented contract would be a lie.
    log.warn('plugin disabled by config: no env hijack, no monitoring');
  } else if (cfg.isWindows) {
    tree.start();
    watcher = new CWatcher({ cfg, tree, log, onCandidate });
    const started = watcher.start();
    log.info(`watching ${started.watching.length} director(ies)`);
  } else {
    log.warn('non-Windows host: filesystem monitoring disabled');
  }

  // --- PRD 4: the `c-clean` command ----------------------------------------
  const disposeCommands = registerCommands(ctx, {
    cfg,
    log,
    db,
    hijacker,
    tree,
    watcher,
    refresh: async () => {
      const result = await tree.refresh();
      log.debug(`process tree refreshed: ${result.count}/${result.total}`);
    },
    collect: async () => (db ? rowsToClassified(db.list({ limit: 5000 })) : []),
  });

  // --- teardown: leave the process exactly as we found it -------------------
  const cleanup = () => {
    try {
      watcher?.stop();
    } catch (err) {
      log.warn(`watcher stop failed: ${err?.message}`);
    }
    try {
      owners?.close();
    } catch (err) {
      log.warn(`lock-owner stop failed: ${err?.message}`);
    }
    try {
      tree.stop();
    } catch (err) {
      log.warn(`process tree stop failed: ${err?.message}`);
    }
    try {
      disposeCommands?.();
    } catch (err) {
      log.warn(`command dispose failed: ${err?.message}`);
    }
    try {
      db?.close();
    } catch (err) {
      log.warn(`db close failed: ${err?.message}`);
    }
    try {
      hijacker.restore();
    } catch (err) {
      log.warn(`env restore failed: ${err?.message}`);
    }
  };

  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup);
  else ctx.on?.('dispose', cleanup);

  log.info('ready — run `c-clean status`');
}

export { resolveConfig, Config };
