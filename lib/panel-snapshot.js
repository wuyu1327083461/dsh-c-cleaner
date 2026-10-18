/**
 * panel-snapshot — translate persisted `tracked_files` rows into the
 * `TrackedFileItem[]` the glass panel renders (UI_SPEC §5).
 *
 * This is the JS twin of `ui_bridge.py`'s `SnapshotBuilder`. It exists because the panel is
 * served by the plugin itself now, so the snapshot has to be built in-process, next to the DB
 * and the real `inspectDirectory` gate, instead of by a separate Python bridge.
 *
 * Two behaviours are deliberate and load-bearing:
 *
 *   1. **CAUTION rows aggregate to one directory each.** The plugin's own `findCandidates`
 *      groups by `path.dirname`, which turns `uv-cache/wheels/<1000 .whl>` into 1000 rows that
 *      each refuse to migrate. The panel groups by *the first directory under a watch root*
 *      instead, so one 🟡 row == one migratable directory.
 *   2. **Paths are displayed in their C: spelling, never resolved through a junction.** A
 *      migrated directory is a reparse point on C: pointing at E:; `realpath` would print the E:
 *      path and destroy the one fact the row exists to convey ("already tunneled, but still
 *      occupying its C: slot").
 *
 * @module dsh-c-cleaner/lib/panel-snapshot
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectDirectory } from './symlink-migrate.js';

/** Plugin tier -> panel tier. */
export const CATEGORY_TO_UI = Object.freeze({
  SAFE_TO_DELETE: 'safe',
  CAUTION_CACHE: 'caution',
  LOCKED_CRITICAL: 'locked',
});

/** Mirrors `cfg.migrateMinBytes`; below this a directory gets no mklink button. */
export const DEFAULT_MIGRATE_MIN_BYTES = 10 * 1024 * 1024;

/** "忽略小于 1 MB 的碎片" threshold. */
export const IGNORE_SMALL_BYTES = 1024 * 1024;

/** Panel rule defaults; the same six keys `ui/index.html` keeps in `state.rules`. */
export function defaultRules() {
  return {
    watchTemp: true,
    watchLocal: true,
    watchRoaming: true,
    recheck: true,
    skipLocked: true,
    ignoreSmall: false,
  };
}

/** Normalise a path for COMPARISON ONLY (lowercase, backslashes, no trailing separator). */
export function normPath(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let s = p.trim().replace(/\//g, '\\');
  if (s.length > 3) s = s.replace(/\\+$/, '');
  return s.toLowerCase();
}

function components(p) {
  const s = typeof p === 'string' ? p.replace(/\//g, '\\') : '';
  return s.split('\\').filter((x) => x.length > 0 && x !== '.').length;
}

function isUnderOrEqual(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith('\\') ? parent : parent + '\\');
}

/**
 * Is this a junction / symlink? `lstatSync(...).isSymbolicLink()` is the only call that reports
 * the LINK — `statSync` follows it and reports the target's type (measured: a junction answers
 * `isSymbolicLink: true` from `lstatSync` and `isDirectory: true` from `statSync`).
 */
export function isReparsePoint(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Every watch root paired with the rule key that governs it, ordered SPECIFIC -> BROAD.
 *
 * `%LOCALAPPDATA%\Temp` is more specific than `%LOCALAPPDATA%` itself, so turning "watch %TEMP%"
 * off must beat "%LOCALAPPDATA% is still on" — otherwise a file under Temp slips through the
 * broader root and the switch does nothing.
 */
export function watchRootsAll() {
  const local = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  const pairs = [];
  if (local) pairs.push([path.join(local, 'Temp'), 'watchTemp']);
  if (local) pairs.push([local, 'watchLocal']);
  if (roaming) pairs.push([roaming, 'watchRoaming']);
  for (const name of ['TEMP', 'TMP']) {
    const v = process.env[name];
    if (v) pairs.push([v, 'watchTemp']);
  }
  const out = [];
  const seen = new Set();
  for (const [raw, key] of pairs) {
    const norm = normPath(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push([norm, key, displayPath(raw)]);
  }
  return out;
}

/** Watch roots currently enabled by `rules`. */
export function watchRoots(rules) {
  const out = [];
  for (const [root, key] of watchRootsAll()) {
    if (!rules || rules[key] !== false) out.push(root);
  }
  return out;
}

/**
 * Is `p` inside the CURRENTLY ENABLED watch scope? Decided by the most specific covering root,
 * so turning off `watchTemp` really does reject `%LOCALAPPDATA%\Temp\x.tmp`.
 */
export function insideWatchRoot(p, rules) {
  const norm = normPath(p);
  if (!norm) return false;
  let best = null;
  for (const [root, key] of watchRootsAll()) {
    if (isUnderOrEqual(norm, root) && (best === null || root.length > best[0].length)) best = [root, key];
  }
  if (best === null) return false;
  if (!rules) return true;
  return rules[best[1]] !== false;
}

/**
 * Which directory a tracked file belongs to for the CAUTION tier.
 *
 * Returns the first directory under its watch root (`%TEMP%\uv-cache\wheels\a.whl` ->
 * `%TEMP%\uv-cache`), or `''` when the file sits directly in a watch root (nothing of its own
 * to move — equivalent to the plugin's `dir === watchRoot` test).
 */
export function groupDirFor(p, rules) {
  const raw = typeof p === 'string' ? p.replace(/\//g, '\\').replace(/\\+$/, '') : '';
  if (!raw) return '';
  const norm = normPath(raw);
  if (!norm) return '';
  const roots = watchRoots(rules).slice().sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (norm === root || !isUnderOrEqual(norm, root)) continue;
    // Take the remainder from the ORIGINAL spelling so the group keeps its real casing; `norm`
    // is lowercase for comparison only.
    const rel = raw.slice(root.length).replace(/^\\+/, '');
    const parts = rel.split('\\').filter((x) => x.length > 0);
    if (parts.length <= 1) return ''; // the file sits directly in the watch root
    const group = raw.slice(0, raw.length - rel.length) + parts[0];
    if (rules && !insideWatchRoot(group, rules)) return '';
    return group;
  }
  const parent = path.dirname(raw);
  return components(parent) >= 3 ? parent : '';
}

/**
 * Restore the real on-disk casing segment by segment, stopping at the first reparse point.
 *
 * Unlike `realpathSync` this NEVER crosses a junction, so `Temp\ms-playwright\a` stays
 * `Temp\ms-playwright\a` (the C: entrance) instead of becoming the E: physical path.
 */
function fixCaseNoLink(p) {
  const cur = path.resolve(p);
  const parsed = path.parse(cur);
  let out = parsed.root;
  const parts = cur.slice(parsed.root.length).split(/[\\/]/).filter((x) => x.length > 0);
  for (const part of parts) {
    const candidate = path.join(out, part);
    if (isReparsePoint(candidate)) {
      out = candidate;
      break;
    }
    let real = null;
    try {
      const low = part.toLowerCase();
      for (const entry of fs.readdirSync(out)) {
        if (entry.toLowerCase() === low) {
          real = entry;
          break;
        }
      }
    } catch {
      real = null;
    }
    out = path.join(out, real || part);
  }
  return out;
}

/** Absolute, backslashed, drive-cased path for display. Never follows a junction. */
export function displayPath(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let s = p.trim().replace(/\//g, '\\');
  if (s.length > 3) s = s.replace(/\\+$/, '');
  if (/^[a-z]:/i.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

function ageLabel(mtimeMs) {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return '';
  const delta = Math.max(0, Date.now() - mtimeMs) / 1000;
  if (delta < 60) return '刚刚';
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
  return `${Math.floor(delta / 86400)} 天前`;
}

function describe(p, catUi, mtimeMs) {
  const ext = path.extname(p).toLowerCase();
  const age = ageLabel(mtimeMs);
  if (catUi === 'locked') return '🔒 受保护文件 · 删除会中断正在运行的进程';
  if (catUi === 'caution') return `驻留缓存 · 可 mklink 迁移至 E 盘${age ? `（写入于 ${age}）` : ''}`;
  const kind =
    { '.log': '日志文件', '.tmp': '一次性临时文件', '.pyc': '字节码缓存', '.bak': '备份残留' }[ext] || '临时文件';
  return age ? `${kind} · 写入于 ${age}` : kind;
}

function safeMtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Build the panel's file list.
 *
 * @param {object[]} rows - `tracked_files` rows (`{id, file_path, file_size, category, ...}`).
 * @param {object} [opts]
 * @param {object} [opts.rules] - the six panel rules; watch switches filter rows.
 * @param {object} [opts.cfg] - resolved plugin config (supplies `migrateMinBytes`, target root).
 * @param {number} [opts.migrateMinBytes]
 * @returns {object[]} `TrackedFileItem[]`, safe -> caution -> locked, each tier by size desc.
 */
export function buildSnapshot(rows, opts = {}) {
  const rules = opts.rules || defaultRules();
  const cfg = opts.cfg || null;
  const minBytes = Number.isFinite(opts.migrateMinBytes)
    ? opts.migrateMinBytes
    : Number.isFinite(cfg?.migrateMinBytes)
      ? cfg.migrateMinBytes
      : DEFAULT_MIGRATE_MIN_BYTES;

  const items = [];
  const cautionDirs = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const rawPath = typeof row?.file_path === 'string' ? row.file_path : '';
    if (!rawPath) continue;
    // A path outside the currently enabled watch scope is not the panel's business.
    if (!insideWatchRoot(rawPath, rules)) continue;

    const catUi = CATEGORY_TO_UI[String(row.category || '').trim().toUpperCase()] || 'safe';
    const size = Number(row.file_size) || 0;
    const pid = Number.isFinite(row.locked_by_pid) ? Number(row.locked_by_pid) : 0;
    const alive = !!row.is_locked || pidAlive(pid);
    const proc =
      (typeof row.source_process === 'string' && row.source_process.trim()) || 'unknown';

    if (catUi === 'caution') {
      const dir = groupDirFor(rawPath, rules);
      if (!dir) continue;
      const key = normPath(dir);
      let slot = cautionDirs.get(key);
      if (slot === undefined) {
        slot = {
          id: 'dir_' + crypto.createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 8),
          dir,
          size_bytes: 0,
          files: 0,
          sources: new Set(),
        };
        cautionDirs.set(key, slot);
      }
      slot.size_bytes += size;
      slot.files += 1;
      slot.sources.add(proc);
      continue;
    }

    // "忽略小于 1 MB 的碎片" hides SAFE crumbs only — a locked file or a migratable cache
    // directory is never hidden for being small.
    if (catUi === 'safe' && rules.ignoreSmall && size < IGNORE_SMALL_BYTES) continue;

    const mtimeMs = safeMtime(rawPath);
    let desc = describe(rawPath, catUi, mtimeMs);
    if (catUi === 'locked' && row.is_locked) {
      desc = `⚠️ WinError 32: 被 ${proc}` + (pid ? ` (PID: ${pid})` : '') + ' 占用';
    }
    // A file whose parent is already a junction lives on E: — it must read as 0 MB, exactly like
    // the panel's own optimistic update after a successful migration. Reporting the stale DB size
    // next to "不占C盘" would contradict the badge.
    const migrated = isReparsePoint(path.dirname(rawPath));
    items.push({
      id: `file_${row.id}`,
      path: displayPath(rawPath),
      description: desc,
      source_process: proc,
      pid,
      process_alive: !!alive,
      category: catUi,
      size_bytes: migrated ? 0 : size,
      checked: catUi === 'safe',
      can_symlink: false,
      symlink_migrated: migrated,
      lock_reason: catUi === 'locked' ? desc : null,
      _db_id: row.id,
    });
  }

  for (const slot of cautionDirs.values()) {
    // The SAME gate the real migration will re-run, so the panel never offers a button the
    // server is bound to refuse (that mismatch reads as a broken button).
    let verdict = { ok: false, code: 'INSPECT_FAILED', reason: '无法校验该目录' };
    try {
      verdict = inspectDirectory(slot.dir, cfg) || verdict;
    } catch (err) {
      verdict = { ok: false, code: 'INSPECT_FAILED', reason: (err && err.message) || String(err) };
    }
    const srcs = [...slot.sources].filter(Boolean).sort();
    // An already-migrated directory is a junction on C: pointing at E: — its bytes are no longer
    // C: occupancy, so it reports 0 MB and offers no second migration button.
    const migratedDir = isReparsePoint(slot.dir);
    const tooSmall = slot.size_bytes < minBytes;
    let why = '';
    if (migratedDir) {
      why = '已迁移至 E 盘（目录联接）';
    } else if (tooSmall) {
      why = `未达迁移门槛（${(slot.size_bytes / 1048576).toFixed(1)} MB < ${minBytes / 1048576} MB）`;
    } else if (!verdict.ok) {
      why = String(verdict.reason || verdict.code || '不可迁移');
    }
    items.push({
      id: slot.id,
      path: displayPath(slot.dir),
      description: migratedDir
        ? `已剪切至 E 盘并建立 mklink /J 目录联接 · ${slot.files} 个文件`
        : `驻留缓存目录 · ${slot.files} 个文件` + (srcs.length ? ` · 由 ${srcs.slice(0, 2).join('/')} 写入` : ''),
      source_process: srcs[0] || 'unknown',
      pid: 0,
      process_alive: false,
      category: 'caution',
      size_bytes: migratedDir ? 0 : slot.size_bytes,
      checked: false,
      can_symlink: !migratedDir && !!verdict.ok && !tooSmall,
      symlink_reason: why,
      symlink_target: verdict.ok ? verdict.target : null,
      symlink_migrated: migratedDir,
      lock_reason: null,
      _dir_path: slot.dir,
      _dir: true,
    });
  }

  if (['safe', 'caution', 'locked'].includes(opts.categoryFilter)) {
    return items.filter((i) => i.category === opts.categoryFilter);
  }
  const rank = { safe: 0, caution: 1, locked: 2 };
  items.sort((a, b) => {
    const d = (rank[a.category] ?? 3) - (rank[b.category] ?? 3);
    return d !== 0 ? d : (Number(b.size_bytes) || 0) - (Number(a.size_bytes) || 0);
  });
  return items;
}

/**
 * Translate ONE freshly classified candidate into a panel row, for the live push channel.
 *
 * The snapshot path (`buildSnapshot`) starts from persisted rows; this starts from the
 * `Classified` record the watcher just produced, so the row appears the moment the write lands
 * rather than on the next DB read. The `id` is derived from the path, so re-reporting the same
 * path replaces the row instead of duplicating it (the panel de-dupes by `id`).
 *
 * @param {object} record - a `lib/classifier.js` result (`{path,size,category,isLocked,...}`).
 * @returns {object|null} a `TrackedFileItem`, or `null` for a record with no path.
 */
export function buildLiveItem(record) {
  const rawPath = typeof record?.path === 'string' ? record.path : '';
  if (!rawPath) return null;
  const catUi = CATEGORY_TO_UI[String(record.category || '').trim().toUpperCase()] || 'safe';
  const pid = Number.isFinite(record.lockedByPid) ? Number(record.lockedByPid) : 0;
  const proc = (typeof record.sourceProcess === 'string' && record.sourceProcess.trim()) || 'unknown';
  const size = Number(record.size) || 0;
  const mtimeMs = Number(record.mtimeMs) || 0;
  const base = describe(rawPath, catUi, mtimeMs);
  const desc =
    catUi === 'locked'
      ? `⚡ 实时捕获 · 被 ${proc}` + (pid ? ` (PID: ${pid})` : '') + ' 占用'
      : `⚡ 实时捕获 · ${base}`;
  return {
    id: 'live_' + crypto.createHash('sha1').update(normPath(rawPath), 'utf8').digest('hex').slice(0, 10),
    path: displayPath(rawPath),
    description: desc,
    source_process: proc,
    pid,
    process_alive: !!record.isLocked || pidAlive(pid),
    category: catUi,
    size_bytes: size,
    checked: catUi === 'safe',
    can_symlink: false,
    symlink_migrated: isReparsePoint(path.dirname(rawPath)),
    lock_reason: catUi === 'locked' ? desc : null,
  };
}

export default { buildSnapshot, buildLiveItem, displayPath, normPath, isReparsePoint, groupDirFor, insideWatchRoot, watchRoots, watchRootsAll, defaultRules };
