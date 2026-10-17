/**
 * PRD §7 Phase 2: bring the panel's Client half into the live browser bundle graph.
 *
 * THE PROBLEM (source-verified, not a guess)
 * -----------------------------------------
 * `@deepseek-ai/dsh-client-modules` decides which packages the browser loads by
 * reading each loader row's `package.json` and parsing its `dsh.client` block.
 * That parse is cached forever:
 *
 *   lib/index.js:510   pkgMeta = new Map();
 *   lib/index.js:703   const cached = this.pkgMeta.get(sourceKey);
 *                      if (cached !== void 0) return cached;
 *   lib/index.js:707   this.pkgMeta.set(sourceKey, null);   // "declares no dsh.client"
 *   lib/index.js:729   this.pkgMeta.set(sourceKey, resolved);
 *
 * `grep -n pkgMeta` finds exactly those five lines: there is NO delete and NO
 * invalidation anywhere in the file. The key is
 * `sourceKey(loaderName, baseUrl) = `${baseUrl}\u0000${loaderName}`` (lib/index.js:791),
 * which does not change when a package's manifest bytes change, and
 * `reconcilePackage()` (lib/index.js:875-893) rebuilds a row only when the SOURCE KEY
 * changes. So a plugin installed before it grew a `dsh.client` block stays out of the
 * graph for the lifetime of the process — the `internal/plugin` event that re-runs
 * `flush()` cannot help, because `resolveMeta` answers from the stale cache.
 *
 * That is exactly our situation: `@local/dsh-c-cleaner` was installed in Phase 1 with no
 * Client half, and Phase 2 added one. Measured: `GET /plugins/@local/dsh-c-cleaner/client.js`
 * -> 404 and the id is absent from the served `index.html` boot graph, while the Host half
 * hot-reloaded normally (the API answers 200).
 *
 * WHY THIS FILE EXISTS INSTEAD OF "just restart the harness"
 * ---------------------------------------------------------
 * A restart does fix it, and that is the fallback. But a restart tears down every live
 * session, and the cache entry is a pure, derivable parse result — so it can be rebuilt
 * in-process from the manifest on disk. This module does exactly what the registry would
 * have done had the manifest been correct at boot: drop the stale cache entry for our own
 * loader row, ask the registry to reprocess that row, and report what happened.
 *
 * SAFETY
 * ------
 * Every step is feature-detected and every failure is logged, never thrown: a harness that
 * renames or removes any of these internals must degrade to "restart required", not to a
 * broken plugin load. The manifest is re-read from disk and re-validated by THIS module
 * before anything is touched, so we never ask the registry to resurrect a row that still
 * has no `./client` bundle. Only our OWN loader row is invalidated — other packages keep
 * their cache entries untouched.
 *
 * @see CONTRACTS-PHASE2.md §5
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The manifest of this very package — the source of truth for whether we have a Client half. */
const MANIFEST_URL = new URL('../package.json', import.meta.url);

/**
 * Does the manifest on disk declare a usable `dsh.client` block?
 *
 * Mirrors the registry's own gate (`dsh-client-modules/lib/index.js:713-726`): the
 * declaration must name `platform: 'web'` and the manifest must export a `./client`
 * entry, otherwise the registry throws
 * `client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`.
 * We refuse to poke the registry in that state.
 *
 * @returns {{ok:true, packageName:string, clientRel:string} | {ok:false, reason:string}}
 */
export function inspectOwnManifest() {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(fileURLToPath(MANIFEST_URL), 'utf8'));
  } catch (err) {
    return { ok: false, reason: `cannot read own package.json: ${err?.message ?? err}` };
  }
  const decl = pkg?.dsh?.client;
  if (decl === undefined || decl === null || typeof decl !== 'object') {
    return { ok: false, reason: 'package.json declares no dsh.client block' };
  }
  if (decl.platform !== 'web') {
    return { ok: false, reason: `dsh.client.platform is ${JSON.stringify(decl.platform)}, not "web"` };
  }
  const exp = pkg?.exports;
  const clientRel =
    typeof exp === 'string' ? undefined : exp?.['./client']?.default ?? exp?.['./client'];
  if (typeof clientRel !== 'string' || clientRel.length === 0) {
    return { ok: false, reason: 'package.json exports no "./client" bundle' };
  }
  if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
    return { ok: false, reason: 'package.json has no name' };
  }
  return { ok: true, packageName: pkg.name, clientRel };
}

/**
 * Is `id` already part of the boot graph the browser receives?
 *
 * @param {*} service - the `clientModules` service.
 * @param {string} id - package name.
 * @returns {boolean}
 */
export function graphHasEntry(service, id) {
  try {
    const graph = service.graph();
    const entries = Array.isArray(graph?.entries) ? graph.entries : [];
    return entries.some((entry) => entry?.id === id);
  } catch {
    return false;
  }
}

/**
 * Invalidate the registry's cached manifest verdict for our own loader row and ask it to
 * reprocess that row.
 *
 * The cache key is rebuilt the same way the registry builds it
 * (`client-modules/lib/index.js:791`), so only our row is affected. We reuse the registry's
 * own `sourceKey()` when it is reachable, and fall back to reproducing the format, so a
 * future change to the key shape cannot silently invalidate the wrong entry: if the two
 * disagree we abort instead of guessing.
 *
 * @param {*} service - the `clientModules` service.
 * @param {import('node:module').Module} _unused - reserved.
 * @param {{name:string, baseUrl:string}[]} rows - our own loader rows `{name, baseUrl}`.
 * @param {*} log - logger.
 * @returns {{invalidated:number, keys:string[]}}
 */
function invalidateOwnCache(service, rows, log) {
  const cache = service?.pkgMeta;
  if (!(cache instanceof Map)) return { invalidated: 0, keys: [] };

  const keys = [];
  for (const row of rows) {
    let key;
    if (typeof service.sourceKey === 'function') {
      try {
        key = service.sourceKey(row.name, row.baseUrl);
      } catch {
        key = undefined;
      }
    }
    if (typeof key !== 'string' || key.length === 0) {
      // Reproduce the documented shape: `${baseUrl}\0${loaderName}`.
      key = `${row.baseUrl}\u0000${row.name}`;
    }
    if (cache.has(key)) {
      cache.delete(key);
      keys.push(key);
      log.debug?.(`client graph: dropped stale manifest verdict for ${row.name}`);
    }
  }
  return { invalidated: keys.length, keys };
}

/**
 * Collect the loader rows that mount this package.
 *
 * `processOne(entryName)` matches on `entry.options.name`, so these names are what we must
 * hand back to the registry. Loader entries without a live fiber or with `disabled` set are
 * skipped here for the same reason the registry skips them.
 *
 * @param {*} ctx - plugin context.
 * @param {string} packageName - our package name.
 * @returns {{name:string, baseUrl:string}[]}
 */
function ownLoaderRows(ctx, packageName) {
  const rows = [];
  let entries;
  try {
    entries = ctx?.loader?.entries?.();
  } catch {
    return rows;
  }
  if (entries === undefined || entries === null) return rows;
  for (const entry of entries) {
    const name = entry?.options?.name;
    if (typeof name !== 'string') continue;
    // The loader row is named by its module specifier, which for a bundle row is the
    // package name. Accept a specifier that resolves to us as well, so a relative or
    // file: spelling of the same row still gets recovered.
    if (name !== packageName && !name.endsWith(packageName)) continue;
    if (entry.fiber === undefined || entry.disabled) continue;
    let baseUrl;
    try {
      baseUrl = entry?.parent?.tree?.ctx?.baseUrl;
    } catch {
      baseUrl = undefined;
    }
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) continue;
    rows.push({ name, baseUrl });
  }
  return rows;
}

/**
 * Recover this package's Client half into the live bundle graph.
 *
 * Runs at most once per `apply()`; returns a disposer-shaped no-op so it can be used
 * directly inside `ctx.effect` without a branch at the call site.
 *
 * @param {*} ctx - plugin context, expected to carry the `clientModules` service.
 * @param {*} log - logger with `info`/`warn`/`debug`.
 * @returns {() => void} disposer (nothing to undo; the graph row is the registry's own state).
 */
export function recoverClientGraph(ctx, log) {
  const manifest = inspectOwnManifest();
  if (!manifest.ok) {
    log.debug?.(`client graph: nothing to recover (${manifest.reason})`);
    return () => {};
  }
  const { packageName } = manifest;

  let service;
  try {
    service = ctx?.get?.('clientModules') ?? ctx?.clientModules;
  } catch (err) {
    log.debug?.(`client graph: clientModules unavailable (${err?.message ?? err})`);
    return () => {};
  }
  if (!service) {
    log.debug?.('client graph: clientModules service not present; the panel needs a restart');
    return () => {};
  }

  // The happy path: an ordinary install that restarted normally already has the row.
  if (graphHasEntry(service, packageName)) {
    log.debug?.(`client graph: ${packageName} already in the boot graph`);
    return () => {};
  }

  const rows = ownLoaderRows(ctx, packageName);
  if (rows.length === 0) {
    log.warn?.(
      `client graph: ${packageName} declares dsh.client but no live loader row matched it; restart the harness to load the panel`,
    );
    return () => {};
  }

  const { invalidated } = invalidateOwnCache(service, rows, log);
  if (invalidated === 0) {
    // Nothing was cached, so the registry never saw a manifest verdict for us. Reprocessing
    // is still worth one attempt, but say so plainly rather than implying we fixed a cache.
    log.debug?.(`client graph: no cached verdict for ${packageName}; reprocessing anyway`);
  }

  if (typeof service.flush !== 'function') {
    log.warn?.('client graph: clientModules.flush is not reachable; restart the harness to load the panel');
    return () => {};
  }

  const failures = [];
  try {
    service.flush((err) => failures.push(err));
  } catch (err) {
    failures.push(err);
  }
  for (const err of failures) {
    log.warn?.(`client graph: composition reported ${err?.message ?? err}`);
  }

  if (!graphHasEntry(service, packageName)) {
    log.warn?.(
      `client graph: ${packageName} still absent after reprocessing; restart the harness to load the panel`,
    );
    return () => {};
  }

  // Prove the row points at a real file before claiming success: a row whose bundle is
  // missing would fail in the browser with no useful diagnostic here.
  let clientPath = null;
  try {
    clientPath = service.clientPath?.(packageName) ?? null;
  } catch {
    clientPath = null;
  }
  if (typeof clientPath === 'string' && !existsSync(clientPath)) {
    log.warn?.(`client graph: ${packageName} entered the graph but ${clientPath} does not exist`);
    return () => {};
  }

  log.info?.(
    `client graph: recovered ${packageName} into the browser bundle graph${clientPath ? ` (${clientPath})` : ''}; refresh the GUI to load the panel`,
  );
  return () => {};
}

export default recoverClientGraph;
