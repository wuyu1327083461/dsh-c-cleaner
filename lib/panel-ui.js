/**
 * panel-ui — serve the glass panel and translate its REST dialect into this plugin's own API.
 *
 * ## Why this module exists
 *
 * The panel UI (UI_SPEC §1-4) was built as a standalone document whose only backend contract is a
 * small REST dialect: `POST <base>/api/<verb>` with `{args:[...]}`, and FLAT result objects
 * (`{ok, cleaned, skipped, freed_bytes}`, `{ok, target, bytes_moved}`, ...). It knows nothing
 * about this plugin's `{ok, value}` envelope or its `SAFE_TO_DELETE`/`CAUTION_CACHE` category
 * names.
 *
 * Rather than rewrite a 2500-line, already-verified interface into React components (guaranteed
 * visual drift), the plugin serves that document as-is from a SECOND prefix route and adapts the
 * dialect here.
 *
 * ## Two prefix routes, not one
 *
 * `@deepseek-ai/dsh-host-webserver` supports only `kind:'exact'|'prefix'` and THROWS on a
 * duplicate `(kind, path)`. `match()` is longest-prefix-wins, so `/c-cleaner/ui` and the existing
 * `/c-cleaner/api` coexist without either shadowing the other: a request to
 * `/c-cleaner/ui/api/get_state` does not start with `/c-cleaner/api/`.
 *
 * The panel document lives at `/c-cleaner/ui/index.html`, and its `REST_BASE='api/'` is a RELATIVE
 * path — so from that document the browser resolves `api/get_state` to
 * `/c-cleaner/ui/api/get_state` on its own. The document needs no edit for this to line up, and
 * because the iframe inherits the host page's origin the same-origin fence below passes.
 *
 * ## The fence
 *
 * `/clean` deletes files, so every request goes through the same `isTrustedApiRequest` gate the
 * shipped API uses (loopback host, no cross-site `Sec-Fetch-Site`, Origin equal to the host). The
 * panel is reachable from any page on the machine, so this is not optional.
 *
 * @module dsh-c-cleaner/lib/panel-ui
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isTrustedApiRequest,
  readJsonBody,
  writeJson,
  BodyTooLargeError,
  findDeadRows,
  findStaleRows,
} from './web-api.js';
import { buildSnapshot, buildLiveItem, defaultRules, normPath } from './panel-snapshot.js';
import { findCandidates as findMigrateCandidates } from './symlink-migrate.js';
import { compileSignatureGlobs, signatureListFrom } from './watcher.js';

/** The panel document + dialect live under this prefix, next to `/c-cleaner/api`. */
export const PANEL_UI_PREFIX = '/c-cleaner/ui';

/** Panel rules are small and user-scoped; they live next to the state DB. */
const RULES_BASENAME = 'panel-rules.json';

/** How many live watcher events the adapter will hand back per poll. */
const LIVE_DEFAULT_LIMIT = 50;

/** UI env switches -> the plugin env vars each one owns, and the escape subdirectory they share. */
const ENV_GROUPS = Object.freeze([
  { key: 'temp', label: 'TEMP / TMP', vars: ['TEMP', 'TMP', 'TMPDIR'], subdir: 'temp' },
  { key: 'pip', label: 'PIP_CACHE_DIR', vars: ['PIP_CACHE_DIR'], subdir: 'pip' },
  { key: 'hf', label: 'HF_HOME / UV_CACHE', vars: ['HF_HOME', 'UV_CACHE_DIR'], subdir: 'huggingface' },
]);

/** Resolved location of the panel document. */
function htmlPath() {
  return fileURLToPath(new URL('../ui/index.html', import.meta.url));
}

/** Absolute path of the rules file for this config. */
function rulesPath(cfg) {
  const dir = (cfg && cfg.stateDir) || path.join((cfg && cfg.dshHome) || '', 'plugins', 'c_cleaner');
  return path.join(dir, RULES_BASENAME);
}

/**
 * Read the persisted panel rules, layered over the defaults so a partial or corrupt file can
 * never leave a switch `undefined` (an `undefined` watch switch would silently disable a whole
 * watch root).
 *
 * @param {object} cfg
 * @param {object} [log]
 * @returns {object} the six rule keys.
 */
export function readRules(cfg, log = null) {
  const base = defaultRules();
  try {
    const raw = fs.readFileSync(rulesPath(cfg), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const key of Object.keys(base)) {
        if (typeof parsed[key] === 'boolean') base[key] = parsed[key];
      }
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      log?.warn?.(`c-cleaner: could not read panel rules: ${err.message || err}`);
    }
  }
  return base;
}

/** Persist the panel rules. Returns the value actually written (defaults for unknown keys). */
export function writeRules(cfg, incoming, log = null) {
  const next = defaultRules();
  if (incoming && typeof incoming === 'object') {
    for (const key of Object.keys(next)) {
      if (typeof incoming[key] === 'boolean') next[key] = incoming[key];
    }
  }
  try {
    const file = rulesPath(cfg);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (err) {
    log?.warn?.(`c-cleaner: could not persist panel rules: ${err?.message || err}`);
  }
  return next;
}

/**
 * The env switches the panel shows, in the panel's own vocabulary.
 *
 * The plugin hijacks nine variables; the panel exposes three switches. A switch is "on" only when
 * EVERY variable it owns points at the escape root — the same all-or-nothing semantics
 * `EnvHijacker.status()` uses, so a half-applied group never reads as enabled.
 *
 * @param {object} cfg
 * @returns {Array<{key:string,label:string,target:string,enabled:boolean,vars:string[]}>}
 */
export function envGroups(cfg) {
  const escapeRoot = (cfg && cfg.escapeRoot) || '';
  return ENV_GROUPS.map((group) => {
    const subdir = (cfg && cfg.envMap && cfg.envMap[group.vars[0]]) || group.subdir;
    const target = escapeRoot ? path.join(escapeRoot, subdir) : path.join('E:\\dsh_escape_cache', subdir);
    const enabled = group.vars.every((name) => process.env[name] === target);
    return { key: group.key, label: group.label, target, enabled, vars: [...group.vars] };
  });
}

/**
 * Turn one switch on or off by writing `process.env` directly.
 *
 * `EnvHijacker` has no per-variable setter (it only does a whole-map `install()`/`restore()`), so
 * the toggle is implemented here. The value the switch must restore to when turned back on is the
 * escape-root path itself — not the pre-hijack value — because the plugin's whole point is that
 * these variables point at E:. The pre-hijack values stay in the hijacker's own map, which is what
 * `cleanup()` restores at teardown.
 *
 * @param {object} cfg
 * @param {string} key - one of `temp` | `pip` | `hf`.
 * @param {boolean} enabled
 * @returns {{ok:boolean, key:string, enabled:boolean, error?:string}}
 */
export function applyEnvSwitch(cfg, key, enabled) {
  const group = ENV_GROUPS.find((g) => g.key === String(key || '').toLowerCase());
  if (!group) return { ok: false, key: String(key), enabled: false, error: `未知的环境变量开关：${key}` };
  const subdir = (cfg && cfg.envMap && cfg.envMap[group.vars[0]]) || group.subdir;
  const escapeRoot = (cfg && cfg.escapeRoot) || '';
  if (!escapeRoot) return { ok: false, key: group.key, enabled: false, error: 'escape root 未配置' };
  const target = path.join(escapeRoot, subdir);
  try {
    if (enabled) {
      fs.mkdirSync(target, { recursive: true });
      for (const name of group.vars) process.env[name] = target;
    } else {
      for (const name of group.vars) delete process.env[name];
    }
  } catch (err) {
    return { ok: false, key: group.key, enabled: false, error: (err && err.message) || String(err) };
  }
  return { ok: true, key: group.key, enabled: !!enabled };
}

/** Read and parse a JSON request body. Empty body resolves to `{}`. */
/** JSON response helper; mirrors the shipped API's headers. */
/** `body.args[i]`, falling back to a named field. The panel always sends `{args:[...]}`. */function argOf(body, index, name) {
  const args = Array.isArray(body?.args) ? body.args : [];
  if (args.length > index && args[index] !== undefined) return args[index];
  if (name && body && body[name] !== undefined) return body[name];
  return undefined;
}

/**
 * Split the panel's requested paths into tracked files, directories, and unknowns.
 *
 * The panel shows 🟡 rows as ONE directory each (that is the whole point of the aggregation), and
 * its clean button can send those directories. `filterRequestedPaths` only knows DB rows, so a
 * directory would land in `rejected` with a misleading "not tracked" reason. Directories are
 * therefore separated here and refused with the honest reason instead — cleaning never recurses
 * into a directory, that is what the mklink button is for.
 *
 * @returns {{accepted:Array<{path:string,row:object}>, directories:string[], rejected:string[]}}
 */
export function resolveRequested(paths, rows) {
  const fileByKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = normPath(row?.file_path);
    if (key && !fileByKey.has(key)) fileByKey.set(key, row);
  }
  const accepted = [];
  const directories = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of Array.isArray(paths) ? paths : []) {
    const p = typeof raw === 'string' ? raw.trim() : '';
    if (!p) continue;
    const key = normPath(p);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const row = fileByKey.get(key);
    if (row) {
      accepted.push({ path: p, row });
      continue;
    }
    let isDir = false;
    try {
      isDir = fs.statSync(p).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) directories.push(p);
    else rejected.push(p);
  }
  return { accepted, directories, rejected };
}

/** One skipped entry in the panel's shape. */
function skipEntry(p, reason, pid) {
  return { path: p, pid: Number(pid) || 0, reason: String(reason || '未知原因') };
}

/**
 * Register the panel document + dialect under `PANEL_UI_PREFIX`.
 *
 * @param {object} ctx - a Cordis context that can reach `webServer` (scoped inject, not `get`).
 * @param {object} deps - the plugin's own capabilities:
 *   `{cfg, log, db, trackedRows, clean, migrate, forgetRows, status, refresh, escapeWritable,
 *     hostPid, watcherStats, liveEvents}`
 * @returns {() => void} disposer.
 */
export function registerPanelUi(ctx, deps) {
  const log = deps?.log ?? null;
  const webServer = ctx?.get?.('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    log?.warn?.('c-cleaner: webServer unavailable; panel UI not served');
    return () => {};
  }

  const cfg = deps?.cfg ?? null;
  const trustedHosts = Array.isArray(cfg?.trustedHosts) ? cfg.trustedHosts : [];
  const fence = (req) => isTrustedApiRequest(req, trustedHosts);

  const rows = async () => {
    try {
      return typeof deps?.trackedRows === 'function' ? await deps.trackedRows() : [];
    } catch (err) {
      log?.warn?.(`c-cleaner: panel could not list tracked rows: ${err?.message || err}`);
      return [];
    }
  };

  // The document is read from disk once and re-read only when its mtime moves, so a normal poll
  // loop does not stat-and-read 90 KB per request.
  let cachedHtml = null;
  let cachedMtime = -1;
  const loadHtml = () => {
    const file = htmlPath();
    const stat = fs.statSync(file);
    if (cachedHtml !== null && stat.mtimeMs === cachedMtime) return cachedHtml;
    cachedHtml = fs.readFileSync(file, 'utf8');
    cachedMtime = stat.mtimeMs;
    return cachedHtml;
  };

  const serveHtml = (res) => {
    let body;
    try {
      body = loadHtml();
    } catch (err) {
      writeJson(res, 500, { ok: false, error: `panel document unavailable: ${(err && err.message) || err}` });
      return;
    }
    try {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.end(body);
    } catch {
      /* client hung up */
    }
  };

  /** The full panel snapshot: the same shape `ui_bridge.py` served. */
  const snapshot = async () => {
    const rules = readRules(cfg, log);
    const raw = await rows();
    let items = [];
    try {
      items = buildSnapshot(raw, { rules, cfg });
    } catch (err) {
      log?.warn?.(`c-cleaner: panel snapshot build failed: ${err?.message || err}`);
      items = [];
    }
    const stats = typeof deps?.watcherStats === 'function' ? deps.watcherStats() : null;
    return {
      ok: true,
      files: items,
      env: envGroups(cfg),
      rules,
      watching_pid: Number(deps?.hostPid) || process.pid,
      dsh_home: (cfg && cfg.dshHome) || null,
      escape_root: (cfg && cfg.escapeRoot) || null,
      migrate_root: (cfg && cfg.escapeRoot) ? path.join(cfg.escapeRoot, 'migrated') : null,
      use_recycle_bin: !(cfg && cfg.useRecycleBin === false),
      db_path: (cfg && cfg.dbPath) || null,
      total_rows: raw.length,
      total_items: items.length,
      /* The panel starts on built-in Mock data and only adopts a snapshot when `files` is
         non-empty. Real data can legitimately be EMPTY (no watched writes yet), and rendering a
         stale Mock list forever is worse than rendering "nothing tracked" — so the adapter marks
         its answer authoritative and the panel honours an empty list from an authoritative
         source. */
      authoritative: true,
      served_by: 'dsh-c-cleaner/panel-ui.js',
      scanned_at: new Date().toISOString(),
      watcher: {
        enabled: !!(stats && Array.isArray(stats.watching) && stats.watching.length > 0),
        stats: stats || null,
      },
    };
  };

  const handler = async (req, res) => {
    try {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: panel requests must come from the local host' });
        return;
      }

      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
      const method = (req.method ?? 'GET').toUpperCase();

      // --- the document itself -------------------------------------------------------------
      if (pathname === PANEL_UI_PREFIX || pathname === `${PANEL_UI_PREFIX}/index.html`) {
        if (method !== 'GET' && method !== 'HEAD') {
          writeJson(res, 405, { ok: false, error: 'GET only' });
          return;
        }
        serveHtml(res);
        return;
      }

      if (!pathname.startsWith(`${PANEL_UI_PREFIX}/api/`)) {
        writeJson(res, 404, { ok: false, error: `no such route: ${pathname}` });
        return;
      }
      const verb = pathname.slice(`${PANEL_UI_PREFIX}/api/`.length);

      // --- get_state ------------------------------------------------------------------------
      if (verb === 'get_state' || verb === 'getState') {
        writeJson(res, 200, await snapshot());
        return;
      }

      if (method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const tooLarge = err instanceof BodyTooLargeError;
        writeJson(res, tooLarge ? 413 : 400, {
          ok: false,
          error: tooLarge ? 'selection too large for one request' : 'request body is not valid JSON',
        });
        return;
      }

      // --- clean ----------------------------------------------------------------------------
      if (verb === 'clean' || verb === 'execute_clean') {
        const requested = argOf(body, 0, 'paths');
        const mode = String(argOf(body, 1, 'mode') || 'trash').toLowerCase();
        const wipe = mode === 'wipe' || mode === 'force' || mode === 'hard';
        const current = await rows();
        const { accepted, directories, rejected } = resolveRequested(requested, current);

        const skipped = [];
        for (const p of directories) {
          skipped.push(skipEntry(p, '是目录，清理只处理文件（目录请用 mklink 搬家）', 0));
        }
        for (const p of rejected) {
          skipped.push(skipEntry(p, '不在 %TEMP% / %LOCALAPPDATA% / %APPDATA% 监听范围内，或未被跟踪', 0));
        }

        if (accepted.length === 0) {
          writeJson(res, 200, {
            ok: true,
            cleaned: [],
            skipped,
            freed_bytes: 0,
            mode: wipe ? 'wipe' : 'trash',
            note: '没有收到任何可清理的文件路径',
          });
          return;
        }

        const records = accepted.map(({ path: p, row }) => ({
          path: p,
          size: Number(row.file_size) || 0,
          category: row.category,
          isLocked: !!row.is_locked,
          lockedByPid: row.locked_by_pid ?? null,
          lockedByProcess: row.source_process ?? null,
          reason: 'panel',
          sourceProcess: row.source_process ?? null,
          mtimeMs: row.last_checked_at ?? Date.now(),
        }));

        let report = { removed: 0, skipped: 0, bytesFreed: 0, skippedList: [], removedPaths: [], gonePaths: [] };
        try {
          report = (await deps.clean(records, { deep: true, force: wipe, cfg, log })) || report;
        } catch (err) {
          // `clean()` is contractually non-throwing, but a broken dep must not produce a bare 500
          // that the panel renders as "清理失败" with no detail.
          writeJson(res, 200, {
            ok: false,
            error: `清理失败：${(err && err.message) || err}`,
            cleaned: [],
            skipped,
            freed_bytes: 0,
            mode: wipe ? 'wipe' : 'trash',
          });
          return;
        }

        const pidByKey = new Map();
        for (const { path: p, row } of accepted) pidByKey.set(normPath(p), row.locked_by_pid ?? 0);

        const cleaned = [...(report.removedPaths ?? [])];
        for (const s of report.skippedList ?? []) {
          skipped.push(skipEntry(s.path, s.reason, pidByKey.get(normPath(s.path)) ?? 0));
        }

        if (typeof deps.forgetRows === 'function') {
          try {
            const dead = [...(report.removedPaths ?? []), ...(report.gonePaths ?? [])];
            if (dead.length > 0) deps.forgetRows(dead);
          } catch (err) {
            log?.warn?.(`c-cleaner: could not drop cleaned rows: ${err?.message || err}`);
          }
        }

        writeJson(res, 200, {
          ok: true,
          cleaned,
          skipped,
          freed_bytes: Number(report.bytesFreed) || 0,
          mode: wipe ? 'wipe' : 'trash',
        });
        return;
      }

      // --- migrate --------------------------------------------------------------------------
      if (verb === 'migrate' || verb === 'migrate_to_e_drive_symlink') {
        const wanted = String(argOf(body, 0, 'path') || '');
        if (!wanted) {
          writeJson(res, 200, { ok: false, error: '没有指定要迁移的目录' });
          return;
        }
        const current = await rows();
        // FENCE: only a directory the plugin itself currently offers may be migrated. Recomputing
        // the candidate list here means the panel cannot talk the server into moving an arbitrary
        // path (the same gate `lib/web-api.js` applies to `/migrate`).
        let offered = [];
        try {
          offered = findMigrateCandidates(current, cfg) || [];
        } catch (err) {
          writeJson(res, 200, { ok: false, error: `无法计算可迁移目录：${(err && err.message) || err}` });
          return;
        }
        const key = normPath(wanted);
        const match = offered.find((c) => normPath(c.path) === key);
        if (!match) {
          writeJson(res, 200, {
            ok: false,
            error: '该目录不在当前可迁移候选内（未达迁移门槛、已被保护，或不是监听根下的独立目录）',
          });
          return;
        }
        let result = null;
        try {
          result = await deps.migrate(match.path, { cfg, log, db: deps.db });
        } catch (err) {
          writeJson(res, 200, { ok: false, error: `迁移失败：${(err && err.message) || err}` });
          return;
        }
        if (!result || result.ok !== true) {
          writeJson(res, 200, {
            ok: false,
            error: String(result?.reason || result?.code || '迁移被拒绝'),
            target: result?.target ?? null,
            bytes_moved: 0,
          });
          return;
        }
        writeJson(res, 200, {
          ok: true,
          target: result.target ?? match.target ?? null,
          bytes_moved: Number(result.bytes) || 0,
          files: Number(result.files) || 0,
        });
        return;
      }

      // --- unmigrate -------------------------------------------------------------------------
      if (verb === 'unmigrate') {
        const wanted = String(argOf(body, 0, 'path') || '');
        if (!wanted) {
          writeJson(res, 200, { ok: false, error: '没有指定要撤销的目录' });
          return;
        }
        // FENCE: only a path this plugin actually migrated (state LINKED) may be reversed. The
        // migration record is the authority, not the request, so the panel can never aim an undo
        // at a directory the plugin never moved (mirrors `lib/web-api.js`'s `/unmigrate`).
        const record =
          typeof deps.migrationRecordFor === 'function' ? deps.migrationRecordFor(wanted) : null;
        if (!record || record.state !== 'LINKED') {
          writeJson(res, 200, {
            ok: false,
            error: '没有该目录的已完成迁移记录，无法撤销',
          });
          return;
        }
        if (typeof deps.undoMigration !== 'function') {
          writeJson(res, 200, { ok: false, error: '撤销迁移不可用' });
          return;
        }
        let result = null;
        try {
          result = await deps.undoMigration(record.source_path, { cfg, log, db: deps.db });
        } catch (err) {
          writeJson(res, 200, { ok: false, error: `撤销失败：${(err && err.message) || err}` });
          return;
        }
        if (!result || result.ok !== true) {
          writeJson(res, 200, {
            ok: false,
            error: String(result?.reason || result?.code || '撤销被拒绝'),
            restored: false,
          });
          return;
        }
        writeJson(res, 200, {
          ok: true,
          restored: true,
          source: result.source ?? record.source_path,
          bytes_moved: Number(result.bytes) || 0,
          files: Number(result.files) || 0,
        });
        return;
      }

      // --- purge ---------------------------------------------------------------------------
      /* "清理过期条目": drop tracked rows that can never be acted on again — the file is gone,
         or the row never passed the PRD §3.2 ownership gate. The old panel had this button and
         the glass panel replaced it, so the capability has to come along. This NEVER touches a
         file on disk; it is pure bookkeeping. */
      if (verb === 'purge') {
        if (typeof deps.forgetRows !== 'function') {
          writeJson(res, 200, { ok: false, error: '状态库不可用，无法清理过期条目' });
          return;
        }
        const current = await rows();
        let doomed = [];
        let bytes = 0;
        let dead = 0;
        try {
          const signatureGlobs = compileSignatureGlobs(signatureListFrom(cfg));
          const admitCritical = cfg?.admitCriticalNames !== false;
          const found = findStaleRows(current, signatureGlobs, admitCritical);
          const ghosts = findDeadRows(current);
          doomed = [...new Set([...found.stale, ...ghosts.dead])];
          bytes = Number(found.bytes) || 0;
          dead = ghosts.dead.length;
        } catch (err) {
          writeJson(res, 200, { ok: false, error: `无法判定过期条目：${(err && err.message) || err}` });
          return;
        }
        if (doomed.length === 0) {
          writeJson(res, 200, { ok: true, forgotten: 0, bytes: 0, dead: 0, note: '没有过期条目' });
          return;
        }
        let forgotten = 0;
        try {
          forgotten = deps.forgetRows(doomed);
        } catch (err) {
          writeJson(res, 200, { ok: false, error: `清理过期条目失败：${(err && err.message) || err}` });
          return;
        }
        log?.info?.(
          `panel purge: forgot ${forgotten} tracked row(s) — ${dead} whose file no longer exists; ` +
            'no file was touched',
        );
        writeJson(res, 200, { ok: true, forgotten, bytes, dead });
        return;
      }

      // --- refresh --------------------------------------------------------------------------
      if (verb === 'refresh') {
        try {
          if (typeof deps.refresh === 'function') await deps.refresh();
        } catch (err) {
          log?.warn?.(`c-cleaner: panel refresh failed: ${err?.message || err}`);
        }
        const snap = await snapshot();
        // The panel's refresh button only needs the count, but returning the whole snapshot lets
        // it re-render the list in the same round trip.
        snap.locked = snap.files.filter((f) => f.category === 'locked').length;
        writeJson(res, 200, snap);
        return;
      }

      // --- save_rules -----------------------------------------------------------------------
      if (verb === 'saveRules' || verb === 'save_rules') {
        const incoming = argOf(body, 0, 'rules') ?? body;
        const written = writeRules(cfg, incoming, log);
        writeJson(res, 200, { ok: true, rules: written });
        return;
      }

      // --- set_env --------------------------------------------------------------------------
      if (verb === 'setEnv' || verb === 'set_env') {
        const key = argOf(body, 0, 'key');
        const enabled = argOf(body, 1, 'enabled');
        const out = applyEnvSwitch(cfg, key, enabled === true);
        writeJson(res, out.ok ? 200 : 200, out);
        return;
      }

      // --- poll_events ----------------------------------------------------------------------
      if (verb === 'poll_events') {
        const after = Number(argOf(body, 0, 'after')) || 0;
        const limitRaw = argOf(body, 1, 'limit');
        const limit = limitRaw === undefined ? LIVE_DEFAULT_LIMIT : Math.max(0, Number(limitRaw) || 0);
        const stats = typeof deps?.watcherStats === 'function' ? deps.watcherStats() : null;
        const enabled = !!(stats && Array.isArray(stats.watching) && stats.watching.length > 0);
        if (limit === 0) {
          // `primeLiveCursor()` sends `[0, 0]` to learn the current cursor WITHOUT replaying the
          // backlog — otherwise every page refresh would re-insert rows that are already listed.
          writeJson(res, 200, { ok: true, cursor: cursorNow(), items: [], stats, enabled });
          return;
        }
        const out = typeof deps?.liveEvents === 'function' ? deps.liveEvents(after, limit) : { cursor: 0, events: [] };
        const items = [];
        for (const ev of out.events || []) {
          const item = buildLiveItem(ev.record);
          if (item) items.push(item);
        }
        writeJson(res, 200, { ok: true, cursor: out.cursor, items, stats, enabled });
        return;
      }

      writeJson(res, 404, { ok: false, error: `no such verb: ${verb}` });
    } catch (err) {
      // A throw out of an HTTP handler is a hung request or a body-less 500; answer explicitly.
      writeJson(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  };

  const cursorNow = () => {
    const out = typeof deps?.liveEvents === 'function' ? deps.liveEvents(0, 0) : null;
    return Number(out?.cursor) || 0;
  };

  const dispose = webServer.register({ kind: 'prefix', path: PANEL_UI_PREFIX, handler });
  return typeof dispose === 'function' ? dispose : () => {};
}

export default { PANEL_UI_PREFIX, registerPanelUi, readRules, writeRules, envGroups, applyEnvSwitch, resolveRequested };
