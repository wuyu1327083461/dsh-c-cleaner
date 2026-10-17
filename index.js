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
import fs from 'node:fs';
import { resolveConfig, NOOP_LOG } from './lib/config.js';
import { EnvHijacker } from './lib/env-hijack.js';
import { ProcessTree } from './lib/process-tree.js';
import { HandleIndex } from './lib/handle-index.js';
import { CWatcher, stopAllWatchers, closeAllRawWatchers } from './lib/watcher.js';
import { classify } from './lib/classifier.js';
import { LockOwnerResolver } from './lib/lock-owner.js';
import { StateDB } from './lib/state-db.js';
import { registerCommands } from './lib/commands.js';
import { registerWebApi, findDeadRows } from './lib/web-api.js';
import { recoverClientGraph } from './lib/client-graph.js';
import { targetRootOf } from './lib/symlink-migrate.js';
import { installSessionHook } from './lib/session-hook.js';

export const name = 'c-cleaner';

/** Log prefix; see {@link makeLogger} for why it is applied idempotently. */
const PREFIX = '[c-cleaner]';

/** The command runtime is the only hard service dependency; everything else is internal. */
export const inject = ['commands'];

/**
 * Upper bound on rows the startup prune will stat.
 *
 * The prune must never become a startup cost that scales with a runaway table, and a profile
 * can hold tens of thousands of rows. Capping the SCAN (not the drop) means the worst case is
 * one bounded pass; repeated startups converge, and /purge remains the explicit whole-table
 * sweep.
 */
const PRUNE_SCAN_LIMIT = 20000;

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
 * Process-global slot holding the ACTIVE generation's disposer.
 *
 * A module-scope binding would NOT work: HMR re-imports this module body for every reload, so
 * each generation would get a fresh (empty) variable and could never see its predecessor.
 * `Symbol.for` + `globalThis` is process-global, so every generation shares one slot.
 *
 * WHY THIS EXISTS (measured, not theoretical): the harness watches this repo as an HMR module
 * root, and HMR re-runs `apply()` on every file event. The previous generation is *supposed* to
 * be torn down first — HMR does `registry.delete(plugin)` then awaits the old fibers — and its
 * disposer does fire in the common case. But it does not fire for EVERY re-entry: a live probe
 * counted two simultaneously open watcher sets (`START live=2`, one unpaired start) and a file
 * the current generation provably rejects still reached the database, admitted by the leftover
 * generation's stale gate. A leaked watcher is not a cosmetic leak — it keeps admitting files
 * with whatever gate logic it was born with, so a fix to the gate would appear not to work.
 *
 * The guard makes `apply()` re-entrant-safe on its own: before building anything, it disposes
 * whatever previous generation is still registered. When HMR disposes correctly the slot is
 * already empty and this is a no-op, so it is a safety net and not a second teardown path.
 */
const ACTIVE_GENERATION = Symbol.for('@local/dsh-c-cleaner.active-generation');

/**
 * Cordis plugin entry point.
 *
 * @param {object} ctx - Cordis context with the `commands` service injected.
 * @param {object} [config] - validated user config (see {@link Config}).
 */
export function apply(ctx, config = {}) {
  const previous = globalThis[ACTIVE_GENERATION];
  if (previous && typeof previous.dispose === 'function') {
    try {
      previous.dispose();
    } catch {
      // A failed teardown must never block the new generation from starting.
    }
  }
  globalThis[ACTIVE_GENERATION] = null;

  // Belt-and-braces on top of the disposer call above: stop ANY watcher still registered as live
  // in this process, including one leaked by a generation whose disposer never ran. The registry
  // is keyed by `Symbol.for` (process-global), so a module generation re-imported by HMR still
  // sees watchers created by its predecessors. Without this, a leaked watcher keeps monitoring
  // and keeps admitting files under the gate rules it was born with.
  try {
    const leaked = stopAllWatchers();
    if (leaked > 0) {
      ctx?.logger?.warn?.(`[c-cleaner] stopped ${leaked} leaked watcher(s) from a previous generation`);
    }
  } catch {
    // Never let cleanup of a predecessor block this generation from starting.
  }

  // Last line of defence, and the one that actually cures the measured phantom-watcher leak:
  // close every RAW `fs.FSWatcher` handle any earlier generation left open. This needs no
  // `CWatcher` instance and no cooperation from the leaking generation, so it also catches a
  // watcher whose `close()` threw (that handle is deliberately kept in the raw registry) and a
  // watcher born before the instance registry existed. See the header note in lib/watcher.js.
  try {
    const closedRaw = closeAllRawWatchers();
    if (closedRaw > 0) {
      ctx?.logger?.warn?.(
        `[c-cleaner] closed ${closedRaw} raw watcher handle(s) left open by an earlier generation`,
      );
    }
  } catch {
    // As above: a failed sweep must never block startup.
  }

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

  /* Drop rows whose file no longer exists. Measured on a real profile: 18 648 of 18 809 rows
   * were dead, so 一键清理 spent its entire run re-validating files that were already gone and
   * the panel rendered tens of thousands of rows nothing could ever act on. Bookkeeping only —
   * no file is touched — and detached, so startup never waits on it. */
  if (db) {
    void (async () => {
      try {
        const rowsNow = db.list({ limit: PRUNE_SCAN_LIMIT });
        if (rowsNow.length === 0) return;
        const found = findDeadRows(rowsNow, (p) => fs.existsSync(p));
        if (found.dead.length === 0) return;
        const dropped = db.removeByPath(found.dead);
        log.info(
          `state table prune: forgot ${dropped} row(s) whose file no longer exists ` +
            `(scanned ${found.scanned}, ${found.alive} kept) — no file was touched`,
        );
      } catch (err) {
        log.warn(`state table prune skipped: ${err?.message || String(err)}`);
      }
    })();
  }

  // --- PRD 3.2: monitoring --------------------------------------------------
  // PRD §3.2 rule #1 is "a handle reverse-lookup attributes the file to a dsh-tree PID".
  // `HandleIndex` supplies that lookup through the `handleProbe` seam; it keeps ONE python
  // child alive and answers from a periodically rebuilt cache. Measured on this host, one
  // handle sweep costs ~2.0 s of CPU over an ~11-member tree (~145 ms per process, because
  // psutil's open_files() walks the system handle table), so it is OFF unless `handleIndex`
  // is enabled: at 60 s that is already ~3 % of a core, over the PRD §6.1 budget, and at the
  // 5 s poll interval it is impossible. Rule #2 (session window + signature) is the gate
  // that runs by default; enabling this upgrades attribution for rule #1 at a measured cost.
  const handleIndex = cfg.handleIndex
    ? new HandleIndex({
        log,
        pythonPath: cfg.pythonPath,
        rootPid: process.pid,
        sweepMs: cfg.handleSweepMs,
      })
    : null;
  if (handleIndex) void handleIndex.start();

  const tree = new ProcessTree({
    rootPid: process.pid,
    pollIntervalMs: cfg.pollIntervalMs,
    log,
    handleProbe: handleIndex ? (filePath) => handleIndex.probe(filePath) : null,
  });
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
    collect: async () => (db ? rowsToClassified(db.list({ limit: db.count() })) : []),
  });

  // --- PRD 4 (`ui`): the Client panel's data and action API ------------------
  // The panel is a React component in a Client slot; it cannot read SQLite or run a
  // sweep, so both go through one fenced HTTP prefix.
  //
  // The route MUST be registered through a scoped `ctx.inject(['webServer'], ...)`, not a
  // bare `ctx.get('webServer')`. `webServer` is a Cordis Service, and `ctx.get(name)` with
  // the default `strict = true` returns `undefined` until the PROVIDING fiber is active
  // (`@deepseek-ai/cordis/lib/index.js:756-770`: `if (strict && impl.fiber.state !== 2) return`).
  // On a COLD BOOT this plugin's fiber can reach this line before the web server's fiber has
  // gone active, so a bare `get` returned undefined, `registerWebApi` degraded to a no-op, and
  // the panel answered `HTTP 404 (no JSON body)` while the Host half otherwise worked. It only
  // appeared to work earlier because HMR re-ran `apply()` long after boot. MEASURED: on the
  // freshly restarted harness (pid 41388) every verb 404'd; a `touch index.js` forced a
  // re-apply and `state GET`/`refresh POST` immediately returned 200. Scoped `inject` runs the
  // callback when the service arrives, so the route registers on the FIRST boot too — this is
  // exactly what the shipped `dsh-gitbash-shell/src/index.js:2493` does for its own routes.
  //
  // NOTE: adding `'webServer'` to the plugin's TOP-LEVEL `inject` would be wrong — that would
  // stall the env hijack and the watcher until the web server came up, for no benefit.
  // The panel cleans exactly the rows it is served, so a hard-coded row cap silently hides files
  // from the user. Measured live: 6345 tracked rows, `/state` served the top 5000 by size, so
  // 1345 cleanable files were unreachable from the UI. Size the query from the real row count.
  const trackedRows = async () => {
    if (!db) return [];
    return db.list({ limit: db.count() });
  };

  // --- PRD §7 Phase 3: the session-close silent clean hook (`post_session_close`) ----------
  // The host has no event by that name; `lib/session-hook.js` documents the mapping to
  // `session/disposed` and its verified call site. Off unless `sessionCloseClean: true`.
  const sessionHook = installSessionHook(ctx, {
    cfg,
    log,
    trackedRows,
    refresh: async () => {
      await tree.refresh();
    },
    clean: async (records, opts) => {
      const { clean } = await import('./lib/cleaner.js');
      return clean(records, opts);
    },
  });

  /**
   * This GENERATION's claim on the panel route. A module-generation-local binding, so an HMR
   * re-import cannot confuse it with a predecessor's claim; the process-global slot below is
   * what lets a generation release a predecessor's route.
   */
  let webApiClaim = null;
  const webApiDeps = {
    cfg,
    log,
    db,
    refresh: async () => {
      await tree.refresh();
    },
    trackedRows,
    forgetRows: (paths) => {
      // Bookkeeping only: dropping a stale tracking row never deletes a file. Guarded
      // because a purge request must not be able to crash the panel API when the state
      // store failed to open (db === null) or the method is missing on an older build.
      if (!db || typeof db.removeByPath !== 'function') return 0;
      return db.removeByPath(paths);
    },
    clean: async (records, opts) => {
      const { clean } = await import('./lib/cleaner.js');
      return clean(records, opts);
    },
    status: () => hijacker.status(),
    // --- PRD §3.4 / §7 Phase 3: junction migration --------------------------
    // Bound here rather than imported at the top so the module (and its filesystem work) is
    // only loaded when the route is actually used; `apply()` stays cheap on a cold boot.
    migrationTargetRoot: targetRootOf(cfg),
    migrationHistory: () => {
      if (!db || typeof db.listMigrations !== 'function') return [];
      try {
        return db.listMigrations(50);
      } catch (err) {
        log.debug(`migration history unavailable: ${err?.message || String(err)}`);
        return [];
      }
    },
    migrationRecordFor: (sourcePath) => {
      if (!db || typeof db.getMigrationBySource !== 'function') return null;
      try {
        return db.getMigrationBySource(sourcePath);
      } catch (err) {
        log.debug(`migration lookup failed for ${sourcePath}: ${err?.message || String(err)}`);
        return null;
      }
    },
    migrate: async (dirPath, opts) => {
      const { migrateDirectory } = await import('./lib/symlink-migrate.js');
      return migrateDirectory(dirPath, opts);
    },
    undoMigration: async (sourcePath, opts) => {
      const { undoMigration } = await import('./lib/symlink-migrate.js');
      return undoMigration(sourcePath, opts);
    },
    escapeWritable: () => {
      // The panel shows this so a read-only E: is visible before a sweep, not after.
      try {
        fs.accessSync(cfg.escapeRoot, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };

  // Register the route the moment `webServer` becomes active. Guarded twice: the outer try
  // protects `apply()` from a Cordis version without scoped `inject`, the inner one keeps a
  // registration failure from escaping into the fiber (an exception there would tear down the
  // whole plugin, env hijack included).
  //
  // The route disposer is ALSO parked in a process-global slot, for the same reason the watcher
  // registry exists: `webServer.register` THROWS on a duplicate `(kind, path)`, so if a
  // generation whose fiber was never disposed still holds the route, the new generation's
  // `register` throws, gets swallowed by the catch below, and the panel is served by the OLD
  // generation's handler — the route would look "registered" while running stale code. Disposing
  // any predecessor route first makes registration deterministic.
  const WEB_API_ROUTE = Symbol.for('@local/dsh-c-cleaner.web-api-route');
  /** Monotonic stamp so a superseded generation can tell it no longer owns the route. */
  const routeStamp = (globalThis[WEB_API_ROUTE]?.stamp ?? 0) + 1;
  /**
   * Release a route left behind by a predecessor generation.
   *
   * `WebServer.register` returns `() => table.delete(route.path)` — it deletes by PATH, not by
   * object identity (`@deepseek-ai/dsh-web-host-webserver/lib/index.js`, the `register` method).
   * So a superseded generation whose fiber teardown runs LATE would delete the route the NEW
   * generation just installed, leaving the panel 404 again. Every disposal below is therefore
   * ownership-checked: a generation only ever releases a route it still owns.
   */
  const releaseStaleRoute = () => {
    const stale = globalThis[WEB_API_ROUTE];
    if (stale && typeof stale.dispose === 'function') {
      try {
        stale.dispose();
      } catch {
        /* a predecessor's route disposer failing must not block ours */
      }
    }
    globalThis[WEB_API_ROUTE] = null;
  };

  try {
    if (typeof ctx.inject !== 'function') throw new TypeError('ctx.inject is not available');
    ctx.inject(['webServer'], (webCtx) => {
      /** This generation's own claim on the route slot. */
      const claim = { stamp: routeStamp, dispose: null };
      webApiClaim = claim;
      try {
        releaseStaleRoute();
        claim.dispose = registerWebApi(webCtx, webApiDeps);
        globalThis[WEB_API_ROUTE] = claim;
        log.info('panel api registered at /c-cleaner/api');
      } catch (err) {
        log.warn(`panel api registration failed: ${err?.message || String(err)}`);
      }
      // The route belongs to the injected child fiber, so dispose it with that scope. Ownership
      // is re-checked: a LATE teardown of a superseded generation must not delete the route a
      // newer generation installed (see `releaseStaleRoute`).
      webCtx.effect(() => () => {
        if (globalThis[WEB_API_ROUTE] === claim) {
          try {
            claim.dispose?.();
          } catch {
            /* the route disposer is already gone with the child fiber */
          }
          globalThis[WEB_API_ROUTE] = null;
        }
        webApiClaim = null;
      }, 'dsh-c-cleaner: panel api route');
    });
  } catch (err) {
    log.warn(`panel api wiring failed (no scoped inject): ${err?.message || String(err)}`);
  }

  // --- PRD 7 Phase 2: make the Client half reachable without a restart -------
  // `dsh-client-modules` caches the parsed `dsh.client` verdict for a loader row forever and
  // never invalidates it, so a plugin that was installed BEFORE it grew a Client half stays out
  // of the browser bundle graph (measured: `/plugins/<id>/client.js` -> 404 while the Host half
  // hot-reloads normally). lib/client-graph.js drops that one stale entry and asks the registry
  // to reprocess our own row; it no-ops, with a logged reason, on any unfamiliar internals.
  if (cfg.recoverClientGraph) {
    try {
      recoverClientGraph(ctx, log);
    } catch (err) {
      log.warn(`client graph recovery failed: ${err?.message || String(err)}`);
    }
  }

  // --- teardown: leave the process exactly as we found it -------------------
  let disposed = false;
  const cleanup = () => {
    // Idempotent: the re-entrancy guard in `apply()` may dispose this generation out-of-band,
    // and Cordis/HMR may run the fiber's own teardown afterwards. Running the body twice would
    // double-close the database and double-dispose the API, so the latch is load-bearing.
    if (disposed) return;
    disposed = true;
    // Is THIS generation still the active one? A newer generation may already have superseded
    // us (the re-entrancy guard in `apply()` disposes a leftover generation, and Cordis may also
    // run a late teardown). `process.env` is PROCESS-global, so a superseded generation restoring
    // its own pre-install values would silently undo the live hijack of the generation that
    // replaced it. Everything else below owns only this generation's private resources, so only
    // the env restore is conditional.
    const stillActive = globalThis[ACTIVE_GENERATION]?.dispose === cleanup;
    if (stillActive) {
      globalThis[ACTIVE_GENERATION] = null;
    }
    try {
      // Only release the route if THIS generation still owns it. `register`'s disposer deletes by
      // PATH, so an unconditional dispose here would let a superseded generation delete the route
      // a newer generation just installed, leaving the panel 404 — the very failure being fixed.
      if (globalThis[WEB_API_ROUTE] === webApiClaim) {
        webApiClaim?.dispose?.();
        globalThis[WEB_API_ROUTE] = null;
      }
      webApiClaim = null;
    } catch (err) {
      log.warn(`panel api dispose failed: ${err?.message}`);
    }
    try {
      sessionHook?.dispose();
    } catch (err) {
      log.warn(`session hook dispose failed: ${err?.message}`);
    }
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
      handleIndex?.stop();
    } catch (err) {
      log.warn(`handle index stop failed: ${err?.message}`);
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
    if (stillActive) {
      try {
        hijacker.restore();
      } catch (err) {
        log.warn(`env restore failed: ${err?.message}`);
      }
    }
  };

  // Publish this generation's disposer BEFORE the first effect is registered, so a reload
  // arriving while `apply()` is still running can still find and tear us down.
  globalThis[ACTIVE_GENERATION] = { dispose: cleanup };

  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup);
  else ctx.on?.('dispose', cleanup);

  log.info('ready — run `c-clean status`');
}

export { resolveConfig, Config };
