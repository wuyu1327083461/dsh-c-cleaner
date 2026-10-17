/**
 * Host half of the PRD 4 UI: the fenced JSON API the Client panel talks to.
 *
 * The panel is a React component in a Client slot (`client.js`); it cannot read the
 * state DB or drive a sweep directly, so every read and every mutation goes through
 * these routes. Design constraints, in order of importance:
 *
 *   1. **Fenced, because `/clean` deletes files.** A DSH GUI is reachable from any
 *      page on the machine (`127.0.0.1:3080`), so a route that deletes files must
 *      not be callable by a random web page. The fence is the one the shipped
 *      plugin `dsh-better-sidebar` uses on every one of its routes: the `Host`
 *      header must name loopback (or a configured trusted authority), and when the
 *      browser sends an `Origin` it must be same-host or the Electron shell. A
 *      `cross-site` `Sec-Fetch-Site` is refused outright.
 *   2. **One route, prefix kind.** `webServer.register` throws on a duplicate
 *      `(kind, path)` pair, so a single `/c-cleaner/api` prefix keeps the surface
 *      small and collision-free.
 *   3. **Never throw out of the handler.** An exception in an HTTP handler is a
 *      hang or a 500 with no body; every path answers JSON with an explicit
 *      `{ok:false,error}` instead.
 *
 * @module dsh-c-cleaner/lib/web-api
 */

import fs from 'node:fs';
import { compileSignatureGlobs, signatureListFrom, classifyName } from './watcher.js';
import { findCandidates as findMigrateCandidates, inspectDirectory } from './symlink-migrate.js';

/** @type {readonly string[]} */
export const API_PREFIX = '/c-cleaner/api';

/** The Electron desktop shell serves the GUI from this scheme, not from loopback. */
const SHELL_APP_ORIGIN = 'dsh-app://app';

/**
 * Request bodies are JSON objects; refuse anything larger so a hostile page cannot make
 * the host buffer unbounded data.
 *
 * MEASURED DEFECT this value fixes (live, harness pid 47648): the panel sent every selected
 * path as a JSON array, and the real selection was 1693 paths / **146 525 bytes**. The old
 * 64 KiB cap rejected it, and because the oversize branch called `req.destroy()` the browser
 * never received a response at all — the panel showed the bare transport string
 * `Failed to fetch` on 一键清理已选, which is unactionable. A boundary probe
 * (`test/_lead-body-limit-probe.mjs`) pins it exactly: 780 paths / 65 361 B -> HTTP 200;
 * 790 paths / 66 327 B -> transport failure.
 *
 * The ceiling is now derived from the shape the panel actually sends: a `%TEMP%` row set is
 * bounded by the tracked table, and a path is at most a few hundred bytes, so 4 MiB covers
 * roughly 48 000 paths — far beyond any real `%TEMP%` population — while still bounding what
 * a single request can make the host buffer. The fence (`isTrustedApiRequest`: loopback Host,
 * `sec-fetch-site` refusal, Origin == Host) is what keeps untrusted callers out; this is a
 * memory ceiling, not the security boundary.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Distinct error for an oversize body, so the handler can answer 413 instead of a generic
 * 500 and the client can render a real message.
 */
class BodyTooLargeError extends Error {
  /** @param {number} limit */
  constructor(limit) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
    this.code = 'E_BODY_TOO_LARGE';
    this.limit = limit;
  }
}

/**
 * @param {object} headers - Node request headers.
 * @param {string} name - lower-case header name.
 * @returns {string|undefined}
 */
function header(headers, name) {
  const value = headers?.[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse a `Host`-style authority into a URL, or `undefined` when unparsable.
 * @param {string} authority
 * @returns {URL|undefined}
 */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} hostname
 * @returns {boolean} whether the hostname names the local loopback authority.
 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Whether the request authority matches a `trustedHosts` entry (exact, or the
 * same host on any port when the entry carries no port).
 * @param {URL} hostUrl
 * @param {readonly string[]} trustedHosts
 * @returns {boolean}
 */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port;
    return port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}

/**
 * Decide whether one request may reach this plugin's routes.
 *
 * Mirrors `dsh-better-sidebar`'s `isTrustedApiRequest` rather than inventing a
 * scheme, so the two agree on what "the GUI" means.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {readonly string[]} trustedHosts - non-loopback authorities this deployment serves.
 * @returns {boolean}
 */
export function isTrustedApiRequest(req, trustedHosts = []) {
  const headers = req?.headers ?? {};
  const host = header(headers, 'host');
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  // A cross-site request is never ours: the panel is same-origin by construction.
  if (header(headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(headers, 'origin');
  if (origin === undefined) return true;
  if (origin === SHELL_APP_ORIGIN) return true;
  try {
    return new URL(origin).hostname === hostUrl.hostname;
  } catch {
    return false;
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} code - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 */
function writeJson(res, code, payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (err) {
    body = JSON.stringify({ ok: false, error: { code: 'unserializable', message: String(err?.message || err) } });
    code = 500;
  }
  try {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // The panel is same-origin; this documents that no other origin is invited.
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    /* the client hung up — nothing useful left to do */
  }
}

/**
 * Read and parse a JSON request body, bounded by {@link MAX_BODY_BYTES}.
 *
 * On an oversize body this REJECTS with a {@link BodyTooLargeError} but deliberately does NOT
 * `req.destroy()`. Measured defect: destroying the socket meant the browser got no response at
 * all and reported only `Failed to fetch`, so the panel could not say what was wrong. Draining
 * the rest of the stream lets the handler answer a real 413 with a readable message.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>} the parsed object, or `{}` when the body is empty.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      if (over) return; // keep draining so the response can be delivered, but stop buffering
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        reject(new BodyTooLargeError(MAX_BODY_BYTES));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => {
      if (!over) reject(err);
    });
    req.on('end', () => {
      if (over) return; // already rejected; the handler answers 413
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new Error('request body must be a JSON object'));
        }
        resolve(parsed);
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err?.message || String(err)}`));
      }
    });
  });
}

/**
 * Coerce a client-supplied path list into the exact strings the DB holds.
 *
 * The client may only act on paths the plugin already tracks, so every requested
 * path is matched against the persisted rows and anything unknown is DROPPED
 * rather than passed to the cleaner. That is the difference between "clean what
 * the panel shows" and "clean whatever a page feels like naming".
 *
 * @param {unknown} paths - client-supplied value.
 * @param {Array<object>} rows - current `TrackedRow[]`.
 * @returns {{accepted: string[], rejected: string[]}}
 */
export function filterRequestedPaths(paths, rows) {
  const known = new Map();
  for (const row of rows) {
    if (typeof row?.file_path === 'string') known.set(row.file_path.toLowerCase(), row.file_path);
  }
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  const list = Array.isArray(paths) ? paths : [];
  for (const raw of list) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const resolved = known.get(raw.trim().toLowerCase());
    if (resolved === undefined) {
      rejected.push(raw.trim());
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    accepted.push(resolved);
  }
  return { accepted, rejected };
}

/**
 * Which PERSISTED 🟢 rows would the PRD §3.2 gate reject today?
 *
 * Why this exists: rows recorded before the noise gate was wired (Phase 1) are still
 * in the table, and the panel default-checks every 🟢 row — so the pre-gate noise
 * (`Win11SDK_*.msi`, installer `.cab` payloads, `Microsoft.VisualStudio.*.dll`) is the
 * set one `一键清理已选` click would delete. PRD §7 Phase 2's stated goal is to remove
 * exactly that other-software interference, so it has to be removable from the view too.
 *
 * Deliberately conservative, because this is a *retrospective* decision:
 *   - Only `SAFE_TO_DELETE` rows are candidates. 🔴 `LOCKED_CRITICAL` and 🟡
 *     `CAUTION_CACHE` rows carry information the user needs (the §3.3 holder, the
 *     cache location) and are never purged.
 *   - Only rule #2's NAME half plus the §3.3 valve are applied, via the watcher's own
 *     exported `classifyName`. Rule #1 (handle reverse-lookup) describes the process
 *     tree at the instant of the event and is unknowable for a historical row, so it is
 *     never asserted here.
 *   - The credential valve is applied with the SAME `admitCriticalNames` config, so a
 *     `credentials.json` row survives the purge exactly as it survives the gate.
 *
 * @param {Array<{file_path:string, category:string, file_size?:number}>} rows
 * @param {RegExp[]} signatureGlobs - compiled by the watcher's `compileSignatureGlobs`
 * @param {boolean} [admitCritical] - `cfg.admitCriticalNames`
 * @returns {{stale: string[], bytes: number, scanned: number, kept: number}}
 */
/**
 * Rows whose file provably no longer exists anywhere.
 *
 * `findStaleRows` answers "this row never belonged to us" (the PRD §3.2 noise gate). This
 * answers a different and much larger question: the row was legitimate, the file has since
 * been deleted by something else, and the row will never be actionable again. Left behind,
 * these rows dominate the table — measured on a real profile: 18 648 of 18 809 rows were
 * dead, so 一键清理 spent its whole run re-validating files that were already gone and the
 * panel rendered 18 000 rows that could never be cleaned.
 *
 * Existence is injected so the caller owns the I/O (and the tests can stay deterministic);
 * the default probes the real filesystem.
 *
 * @param {Array<object>} rows
 * @param {(filePath: string) => boolean} [exists]
 * @returns {{dead: string[], alive: number, scanned: number}}
 */
export function findDeadRows(rows, exists) {
  const probe = typeof exists === 'function' ? exists : (p) => fs.existsSync(p);
  const list = Array.isArray(rows) ? rows : [];
  const dead = [];
  let alive = 0;
  for (const row of list) {
    const filePath = row?.file_path;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      alive += 1;
      continue;
    }
    let present = true;
    try {
      present = probe(filePath) === true;
    } catch {
      present = true; // an unreadable path is treated as alive: forgetting it would hide a real file
    }
    if (present) alive += 1;
    else dead.push(filePath);
  }
  return { dead, alive, scanned: list.length };
}

export function findStaleRows(rows, signatureGlobs, admitCritical = true) {
  const stale = [];
  let bytes = 0;
  let kept = 0;
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const filePath = row?.file_path;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      kept += 1;
      continue;
    }
    // Never purge anything the user must still see as locked or as a cache holder.
    if (row?.category !== 'SAFE_TO_DELETE') {
      kept += 1;
      continue;
    }
    const { pass } = classifyName(filePath, signatureGlobs, admitCritical);
    if (pass) {
      kept += 1;
      continue;
    }
    stale.push(filePath);
    bytes += Number.isFinite(row.file_size) ? row.file_size : 0;
  }
  return { stale, bytes, scanned: list.length, kept };
}

/**
 * Register the panel's HTTP API.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} deps - wiring from `index.js`.
 * @param {object} deps.cfg - resolved config (see `resolveConfig`).
 * @param {object} deps.log - plugin logger.
 * @param {object|null} deps.db - `StateDB`, or null when unavailable.
 * @param {() => Promise<void>} [deps.refresh] - re-poll the process tree.
 * @param {() => Promise<Array<object>>} [deps.collect] - persisted rows as `Classified[]`.
 * @param {() => Promise<Array<object>>} [deps.trackedRows] - raw `TrackedRow[]`.
 * @param {(paths: string[]) => number} [deps.forgetRows] - drop rows from the table only.
 * @param {(paths: string[], opts: object) => Promise<object>} [deps.clean] - run a sweep.
 * @param {() => object} [deps.status] - hijack status snapshot.
 * @returns {() => void} disposer (a no-op when there is no `webServer`).
 */
export function registerWebApi(ctx, deps) {
  const { cfg, log } = deps;
  const webServer = ctx?.get?.('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    log?.warn?.('webServer service unavailable: the C-drive panel will not be served');
    return () => {};
  }

  /** Compiled ONCE, from the config, so the purged decision equals the live gate's. */
  const signatureGlobs = compileSignatureGlobs(signatureListFrom(cfg));
  const admitCritical = cfg?.admitCriticalNames !== false;

  /** Non-loopback authorities this deployment serves; empty means loopback only. */
  const trustedHosts = Array.isArray(cfg?.trustedHosts) ? cfg.trustedHosts : [];
  const fence = (req) => isTrustedApiRequest(req, trustedHosts);

  /**
   * Read the current persisted rows, or `[]` when the DB is gone.
   * @returns {Promise<Array<object>>}
   */
  const rows = async () => {
    if (typeof deps.trackedRows === 'function') return await deps.trackedRows();
    return [];
  };

  /**
   * @param {string} verb - path segment after the prefix (`state`, `refresh`, `clean`).
   * @returns {string}
   */
  const route = (verb) => `${API_PREFIX}/${verb}`;

  /**
   * The Phase 3 migration view for the panel: where migrations go, which directories are
   * eligible right now, and which past migrations never finished.
   *
   * `candidates` is derived from the persisted rows by the module's own gate (`inspectDirectory`
   * runs inside `findCandidates`), so a directory that the server would refuse is never offered
   * as a button. That parity is the point: an action the API then rejects reads as a broken UI.
   *
   * Never throws — a panel snapshot missing this field would blank the migration section.
   *
   * @returns {object}
   */
  const migrationsView = async () => {
    try {
      const current = await rows();
      const candidates = findMigrateCandidates(current, cfg);
      const history = typeof deps.migrationHistory === 'function' ? deps.migrationHistory() : [];
      const interrupted = (Array.isArray(history) ? history : []).filter(
        (m) => m && (m.state === 'PENDING' || m.state === 'MOVED'),
      );
      return {
        targetRoot: deps.migrationTargetRoot ?? null,
        candidates,
        interrupted,
        history: (Array.isArray(history) ? history : []).slice(0, 20),
      };
    } catch (err) {
      log?.debug?.(`panel api: migration view unavailable: ${err?.message || String(err)}`);
      return { targetRoot: null, candidates: [], interrupted: [], history: [], error: String(err?.message || err) };
    }
  };

  /**
   * Build the full panel snapshot.
   *
   * Both `GET /state` and `POST /refresh` return THIS shape. They must not drift: the panel
   * replaces its whole snapshot object from whichever verb it called, so a `refresh` payload
   * missing `hijack` rendered the header as "env hijack inactive" immediately after a refresh
   * — a false alarm about the escape root, on the panel's most load-bearing status line.
   *
   * @returns {Promise<object>}
   */
  const snapshot = async () => ({
    rows: await rows(),
    hijack: typeof deps.status === 'function' ? deps.status() : null,
    escapeRoot: cfg?.escapeRoot ?? null,
    useRecycleBin: cfg?.useRecycleBin !== false,
    escapeWritable: deps.escapeWritable ? deps.escapeWritable() : null,
    // PRD §3.4 / §7 Phase 3: what the panel may offer for a junction migration, and where.
    // Computed from the PERSISTED rows — never from a client-supplied path — so the panel can
    // only ever migrate a directory this plugin has already observed files inside.
    migrations: await migrationsView(),
  });

  const handler = async (req, res) => {
    if (!fence(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
    } catch {
      writeJson(res, 400, { ok: false, error: { code: 'bad-url', message: 'unparsable request url' } });
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();

    try {
      if (pathname === route('state')) {
        if (method !== 'GET') {
          writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'GET only' } });
          return;
        }
        writeJson(res, 200, { ok: true, value: await snapshot() });
        return;
      }

      if (pathname === route('refresh')) {
        if (method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } });
          return;
        }
        // Re-poll the dsh process tree so `sourceProcess` reflects the current tree,
        // then hand the panel a fresh snapshot in the same round trip. The response is the
        // SAME shape as GET /state — see `snapshot()` for why that is load-bearing.
        if (typeof deps.refresh === 'function') await deps.refresh();
        writeJson(res, 200, { ok: true, value: { ...(await snapshot()), refreshed: true } });
        return;
      }

      if (pathname === route('clean')) {
        if (method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } });
          return;
        }
        if (typeof deps.clean !== 'function') {
          writeJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'cleaner unavailable' } });
          return;
        }
        const body = await readJsonBody(req);
        const current = await rows();
        const requested = filterRequestedPaths(body.paths, current);
        if (requested.accepted.length === 0) {
          writeJson(res, 200, {
            ok: true,
            value: {
              report: { removed: 0, skipped: 0, bytesFreed: 0, errors: [], skippedList: [] },
              rejected: requested.rejected,
              note: 'no tracked path was selected',
            },
          });
          return;
        }
        // `deep` and `force` are honoured, but the CATEGORY selection always comes
        // from the persisted rows: the panel cannot promote a file's tier.
        const deep = body.deep === true;
        const force = body.force === true;
        const byPath = new Map(current.map((r) => [String(r.file_path).toLowerCase(), r]));
        const selected = requested.accepted
          .map((p) => byPath.get(p.toLowerCase()))
          .filter((r) => r !== undefined)
          .map((row) => ({
            path: row.file_path,
            size: row.file_size,
            category: row.category,
            isLocked: !!row.is_locked,
            lockedByPid: row.locked_by_pid ?? null,
            lockedByProcess: row.source_process ?? null,
            reason: 'panel',
            sourceProcess: row.source_process ?? null,
            mtimeMs: row.last_checked_at ?? Date.now(),
          }));
        const report = await deps.clean(selected, { deep, force, cfg, log });
        /* Rows whose file is really gone are dead weight: they cost a stat on every sweep,
         * they can never be cleaned, and their survivors crowd the panel. Forgetting them
         * here is bookkeeping about the CLEAN result only — a row is dropped when the file
         * provably does not exist any more, never because a delete failed (a failed delete
         * must keep its row so the user still sees the file they must close first). */
        let forgotten = 0;
        if (typeof deps.forgetRows === 'function') {
          try {
            const dead = [...(report.removedPaths ?? []), ...(report.gonePaths ?? [])];
            if (dead.length > 0) forgotten = deps.forgetRows(dead);
          } catch (err) {
            log?.warn?.(`c-cleaner: could not drop cleaned rows: ${(err && err.message) || err}`);
          }
        }
        const after = await rows();
        writeJson(res, 200, { ok: true, value: { report, rejected: requested.rejected, forgotten, rows: after } });
        return;
      }

      if (pathname === route('migrate')) {
        if (method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } });
          return;
        }
        if (typeof deps.migrate !== 'function') {
          writeJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'migration unavailable' } });
          return;
        }
        const body = await readJsonBody(req);
        const wanted = typeof body.path === 'string' ? body.path.trim() : '';
        if (wanted.length === 0) {
          writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'path required' } });
          return;
        }
        // FENCE: the panel may only migrate a directory the SERVER currently offers. Recomputed
        // here from the persisted rows rather than trusted from the request, so a scripted caller
        // cannot name an arbitrary directory (e.g. C:\Windows) and have it moved.
        const current = await rows();
        const offered = findMigrateCandidates(current, cfg);
        const match = offered.find((c) => String(c.path).toLowerCase() === wanted.toLowerCase());
        if (match === undefined) {
          writeJson(res, 200, {
            ok: true,
            value: {
              result: {
                ok: false,
                code: 'NOT_A_CANDIDATE',
                reason: `${wanted} is not currently offered for migration (it must be a tracked directory the PRD §6.2 blacklist and the volume rule both allow)`,
                source: wanted,
                bytes: 0,
                files: 0,
              },
              migrated: false,
              migrations: await migrationsView(),
            },
          });
          return;
        }
        // The directory's own gate runs again inside `migrate` (TOCTOU: the tree can change
        // between the candidate snapshot and the move), so the body is not re-validated here.
        const result = await deps.migrate(match.path, { cfg, log, db: deps.db });
        const after = await rows();
        writeJson(res, 200, {
          ok: true,
          value: { result, migrated: result?.ok === true, rows: after, migrations: await migrationsView() },
        });
        return;
      }

      if (pathname === route('unmigrate')) {
        if (method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } });
          return;
        }
        if (typeof deps.undoMigration !== 'function') {
          writeJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'migration undo unavailable' } });
          return;
        }
        const body = await readJsonBody(req);
        const wanted = typeof body.path === 'string' ? body.path.trim() : '';
        if (wanted.length === 0) {
          writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'path required' } });
          return;
        }
        // FENCE: only a path this plugin actually migrated (state LINKED) may be reversed. The
        // record is the authority, not the request, so `/unmigrate` can never be aimed at a
        // directory the plugin never moved.
        const record = typeof deps.migrationRecordFor === 'function' ? deps.migrationRecordFor(wanted) : null;
        if (!record || record.state !== 'LINKED') {
          writeJson(res, 200, {
            ok: true,
            value: {
              result: {
                ok: false,
                code: 'NO_MIGRATION',
                reason: `no completed migration recorded for ${wanted}`,
                source: wanted,
                bytes: 0,
                files: 0,
              },
              restored: false,
              migrations: await migrationsView(),
            },
          });
          return;
        }
        const result = await deps.undoMigration(record.source_path, { cfg, log, db: deps.db });
        const after = await rows();
        writeJson(res, 200, {
          ok: true,
          value: { result, restored: result?.ok === true, rows: after, migrations: await migrationsView() },
        });
        return;
      }

      if (pathname === route('stale')) {
        if (method !== 'GET') {
          writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'GET only' } });
          return;
        }
        const current = await rows();
        const found = findStaleRows(current, signatureGlobs, admitCritical);
        writeJson(res, 200, {
          ok: true,
          value: { count: found.stale.length, bytes: found.bytes, scanned: found.scanned, kept: found.kept },
        });
        return;
      }

      if (pathname === route('purge')) {
        if (method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } });
          return;
        }
        if (typeof deps.forgetRows !== 'function') {
          writeJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'state store unavailable' } });
          return;
        }
        const current = await rows();
        const found = findStaleRows(current, signatureGlobs, admitCritical);
        /* Two independent kinds of dead row, both bookkeeping-only:
         *  - `stale`: never passed the PRD §3.2 ownership gate (pre-gate leftovers);
         *  - `dead` : the file is gone, so the row can never be acted on again.
         * Neither is a deletion order — this route never touches a file on disk. */
        const ghosts = findDeadRows(current);
        const doomed = [...new Set([...found.stale, ...ghosts.dead])];
        if (doomed.length === 0) {
          writeJson(res, 200, {
            ok: true,
            value: { forgotten: 0, bytes: 0, remaining: current.length, dead: 0, note: 'no stale tracked rows' },
          });
          return;
        }
        const forgotten = deps.forgetRows(doomed);
        const after = await rows();
        log?.info?.(
          `panel purge: forgot ${forgotten} tracked row(s) — ${found.stale.length} rejected by the PRD 3.2 gate, ` +
            `${ghosts.dead.length} whose file no longer exists; no file was touched`,
        );
        writeJson(res, 200, {
          ok: true,
          value: {
            forgotten,
            bytes: found.bytes,
            dead: ghosts.dead.length,
            remaining: after.length,
            rows: after,
          },
        });
        return;
      }

      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `no such route: ${pathname}` } });
    } catch (err) {
      // A throwing handler would otherwise leave the socket hanging.
      if (err?.code === 'E_BODY_TOO_LARGE') {
        writeJson(res, 413, {
          ok: false,
          error: {
            code: 'body-too-large',
            message: `selection too large for one request (limit ${Math.round((err.limit ?? MAX_BODY_BYTES) / 1024)} KiB) — use 清理全部可清理 in smaller batches`,
          },
        });
        return;
      }
      log?.warn?.(`panel api ${pathname} failed: ${err?.message || String(err)}`);
      writeJson(res, 500, { ok: false, error: { code: 'internal', message: String(err?.message || err) } });
    }
  };

  /**
   * Reclaim our own prefix route if an EARLIER module generation still holds it.
   *
   * `WebServer.register` throws on a duplicate `(kind, path)`. Measured live: after an HMR reload
   * the panel answered `500 database is not open` because a generation that had registered the
   * route BEFORE the process-global claim slot existed still owned `/c-cleaner/api`, so this
   * generation's `register` threw `webserver: duplicate prefix route "/c-cleaner/api"`, the throw
   * was swallowed by the caller, and every request kept reaching the OLD handler whose captured
   * `StateDB` had already been closed by its own teardown.
   *
   * The route table is a plain `Map` on the service (`WebServer.prefixes`), so a stale entry for
   * OUR OWN path can be removed directly. Only this plugin's own prefix is ever touched, so no
   * other plugin's route can be disturbed; if the internals are not shaped as expected the
   * reclaim is skipped and the ordinary `register` path still applies.
   *
   * @returns {boolean} whether a stale route was reclaimed.
   */
  const reclaimOwnRoute = () => {
    try {
      const table = webServer.prefixes;
      if (!(table instanceof Map) || !table.has(API_PREFIX)) return false;
      const stale = table.get(API_PREFIX);
      table.delete(API_PREFIX);
      log?.warn?.(
        `panel api: reclaimed ${API_PREFIX} from a stale module generation whose handler had ` +
          `outlived its database handle (stale kind=${stale?.kind ?? 'unknown'})`,
      );
      return true;
    } catch (err) {
      log?.debug?.(`panel api: route reclaim skipped: ${err?.message || String(err)}`);
      return false;
    }
  };
  reclaimOwnRoute();

  const dispose = webServer.register({ kind: 'prefix', path: API_PREFIX, handler });
  log?.info?.(`panel api registered at ${API_PREFIX}`);
  return typeof dispose === 'function' ? dispose : () => {};
}
