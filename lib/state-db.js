/**
 * lib/state-db.js — SQLite-backed tracked-file state for dsh-c-cleaner.
 *
 * Implements CONTRACTS.md §9 (frozen signatures) against the PRD §5 schema.
 * Uses `node:sqlite` `DatabaseSync`, which is available with **no** experimental
 * flag on Node v24.19.0 (verified: `node -v` → v24.19.0,
 * `node -e "console.log(typeof require('node:sqlite').DatabaseSync)"` → function).
 *
 * Contract surface (do not change without telling the Lead):
 *   new StateDB(dbPath)  migrate()  upsert(rec)  upsertMany(recs)
 *   list(opts?)  summary()  removeByPath(paths)  close()
 *
 * `summary()` returns **bytes**; MB/GB formatting lives in commands.js.
 *
 * @typedef {object} TrackedRow
 * @property {number} id
 * @property {string} file_path
 * @property {number} file_size
 * @property {string} category
 * @property {boolean} is_locked       SQL BOOLEAN 0/1 surfaced as a real boolean
 * @property {number|null} locked_by_pid
 * @property {string|null} source_process
 * @property {string} created_at
 * @property {string|null} last_checked_at
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Category values written into the `category` column (== lib/config.js CATEGORY). */
export const CATEGORY = Object.freeze({
  SAFE: 'SAFE_TO_DELETE',
  CAUTION: 'CAUTION_CACHE',
  LOCKED: 'LOCKED_CRITICAL',
});

/** Short alias -> stored value, so `list({category:'SAFE'})` also works. */
const CATEGORY_ALIAS = Object.freeze({
  SAFE: CATEGORY.SAFE,
  SAFE_TO_DELETE: CATEGORY.SAFE,
  CAUTION: CATEGORY.CAUTION,
  CAUTION_CACHE: CATEGORY.CAUTION,
  LOCKED: CATEGORY.LOCKED,
  LOCKED_CRITICAL: CATEGORY.LOCKED,
});

/** summary() key -> stored category value. */
const SUMMARY_KEY = Object.freeze({
  SAFE: CATEGORY.SAFE,
  CAUTION: CATEGORY.CAUTION,
  LOCKED: CATEGORY.LOCKED,
});

/**
 * PRD §5 `CREATE TABLE`, verbatim, with the single edit required by CONTRACTS §9:
 * `CREATE TABLE` -> `CREATE TABLE IF NOT EXISTS` so `migrate()` is idempotent.
 */
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS tracked_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE NOT NULL,       -- C盘绝对路径
    file_size INTEGER NOT NULL,           -- 文件大小 (Bytes)
    category TEXT NOT NULL,               -- SAFE_TO_DELETE | CAUTION_CACHE | LOCKED_CRITICAL
    is_locked BOOLEAN DEFAULT 0,          -- 当前是否被占用
    locked_by_pid INTEGER,                -- 占用进程 PID
    source_process TEXT,                  -- 创建该文件的子进程名 (如 python.exe)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_checked_at TIMESTAMP             -- 最后一次状态刷新时间
)`;

/**
 * PRD §5's `tracked_files` DDL is **frozen** (no extra columns may be added to it), so Phase 3
 * keeps the junction-migration journal in a SEPARATE table rather than widening the frozen one.
 *
 * Why a journal at all: a migration is a multi-step operation across two volumes and a reparse
 * point. If the process dies between "data moved off" and "junction installed", the user's
 * directory has vanished from its own path, and only a record naming BOTH paths can recover it.
 * `source_path` is UNIQUE so a re-migrated path supersedes rather than duplicates its row.
 */
const CREATE_MIGRATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT UNIQUE NOT NULL,     -- 原 C 盘目录路径
    target_path TEXT NOT NULL,            -- E 盘迁移后的物理路径
    state TEXT NOT NULL,                  -- PENDING | MOVED | LINKED | FAILED | RESTORED
    file_count INTEGER DEFAULT 0,
    byte_count INTEGER DEFAULT 0,
    method TEXT,                          -- rename | copy
    error TEXT,                           -- 最后一次失败原因 (state = FAILED 时)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

/** Columns of `migrations`, in declaration order. */
const SELECT_MIGRATION_COLUMNS =
  'id, source_path, target_path, state, file_count, byte_count, method, error, created_at, updated_at';

const UPSERT_MIGRATION_SQL = `INSERT INTO migrations
    (source_path, target_path, state, file_count, byte_count, method, error, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT(source_path) DO UPDATE SET
    target_path = excluded.target_path,
    state = excluded.state,
    file_count = excluded.file_count,
    byte_count = excluded.byte_count,
    method = excluded.method,
    error = excluded.error,
    updated_at = CURRENT_TIMESTAMP`;

const UPSERT_SQL = `INSERT INTO tracked_files
    (file_path, file_size, category, is_locked, locked_by_pid, source_process, created_at, last_checked_at)
  VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT(file_path) DO UPDATE SET
    file_size = excluded.file_size,
    category = excluded.category,
    is_locked = excluded.is_locked,
    locked_by_pid = excluded.locked_by_pid,
    source_process = excluded.source_process,
    last_checked_at = CURRENT_TIMESTAMP`;

const DELETE_SQL = 'DELETE FROM tracked_files WHERE file_path = ?';

const SUMMARY_SQL = `SELECT category AS category,
       COUNT(*) AS count,
       COALESCE(SUM(file_size), 0) AS bytes
  FROM tracked_files
 GROUP BY category`;

/** TrackedRow column names, exactly the PRD §5 names, in PRD order. */
const SELECT_COLUMNS =
  'id, file_path, file_size, category, is_locked, locked_by_pid, source_process, created_at, last_checked_at';

function toInt(value, fallback = 0) {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function pidOrNull(value) {
  const n = toInt(value, NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Map one `migrations` row onto a plain object with stable key spelling. */
function toMigrationRow(row) {
  return {
    id: toInt(row.id, 0),
    source_path: String(row.source_path),
    target_path: String(row.target_path),
    state: String(row.state),
    file_count: toInt(row.file_count, 0),
    byte_count: toInt(row.byte_count, 0),
    method: row.method === null || row.method === undefined ? null : String(row.method),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    created_at: row.created_at === null || row.created_at === undefined ? null : String(row.created_at),
    updated_at: row.updated_at === null || row.updated_at === undefined ? null : String(row.updated_at),
  };
}

/** Map one SQL row onto a TrackedRow with exactly the PRD §5 column names. */
function toTrackedRow(row) {
  return {
    id: toInt(row.id, 0),
    file_path: String(row.file_path),
    file_size: toInt(row.file_size, 0),
    category: String(row.category),
    is_locked: row.is_locked === 1 || row.is_locked === true || row.is_locked === 1n,
    locked_by_pid: row.locked_by_pid === null || row.locked_by_pid === undefined ? null : toInt(row.locked_by_pid, 0),
    source_process: row.source_process === null || row.source_process === undefined ? null : String(row.source_process),
    created_at: row.created_at === null || row.created_at === undefined ? null : String(row.created_at),
    last_checked_at:
      row.last_checked_at === null || row.last_checked_at === undefined ? null : String(row.last_checked_at),
  };
}

/** Normalise a `list({category})` argument; unknown values are ignored (no filter). */
export function normalizeCategory(value) {
  if (typeof value !== 'string') return null;
  return CATEGORY_ALIAS[value.trim().toUpperCase()] ?? null;
}

export class StateDB {
  /** @param {string} dbPath absolute path to state.db (or ':memory:') */
  constructor(dbPath) {
    if (typeof dbPath !== 'string' || dbPath.length === 0) {
      throw new TypeError('StateDB: dbPath must be a non-empty string');
    }
    /** @type {string} */
    this.dbPath = dbPath;

    if (dbPath !== ':memory:') {
      // The state DB lives outside C: (PRD §5), so the directory may not exist yet.
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    /** @type {DatabaseSync} */
    this.db = new DatabaseSync(dbPath);

    // WAL lets `status` read while the watcher writes; all best-effort.
    for (const pragma of ['PRAGMA journal_mode = WAL', 'PRAGMA synchronous = NORMAL', 'PRAGMA busy_timeout = 5000']) {
      try {
        this.db.exec(pragma);
      } catch {
        /* pragma unsupported on this filesystem (e.g. FAT/network) — ignore */
      }
    }

    /** @type {Map<string, import('node:sqlite').StatementSync>} */
    this.statements = new Map();
    this.inTransaction = false;

    // migrate() is idempotent, so running it here makes the class safe on a fresh
    // path; an explicit migrate() from index.js wiring is a harmless no-op.
    this.migrate();
  }

  /** Compile-once cache; the SQL text is the cache key. */
  #stmt(sql) {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Re-entrant BEGIN/COMMIT wrapper (upsertMany inside an outer tx stays flat). */
  #tx(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* the original error is the interesting one */
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /** Create the state table (and its indexes) when absent. Idempotent. */
  migrate() {
    this.db.exec(CREATE_TABLE_SQL);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tracked_files_category ON tracked_files(category)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tracked_files_checked ON tracked_files(last_checked_at)');
    // Phase 3: the junction-migration journal lives beside the frozen PRD §5 table, never inside it.
    this.db.exec(CREATE_MIGRATION_TABLE_SQL);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_migrations_state ON migrations(state)');
  }

  /**
   * Insert or update one Classified record, keyed on the UNIQUE `file_path`.
   * `last_checked_at` is refreshed on both paths. Never throws on a malformed
   * record (the watcher calls this from an fs.watch callback): returns false.
   * @param {import('./classifier.js').Classified} rec
   * @returns {boolean} true when a row was written
   */
  upsert(rec) {
    if (!rec || typeof rec !== 'object') return false;
    const filePath = typeof rec.path === 'string' ? rec.path.trim() : '';
    if (filePath.length === 0) return false;

    // Fail-safe default: an unknown category must never masquerade as deletable.
    const category = normalizeCategory(rec.category) ?? CATEGORY.LOCKED;

    this.#stmt(UPSERT_SQL).run(
      filePath,
      toInt(rec.size, 0),
      category,
      rec.isLocked ? 1 : 0,
      pidOrNull(rec.lockedByPid),
      textOrNull(rec.sourceProcess),
    );
    return true;
  }

  /**
   * Transactional bulk upsert.
   * @param {Array<import('./classifier.js').Classified>} recs
   * @returns {number} rows written (malformed records are skipped)
   */
  upsertMany(recs) {
    if (!Array.isArray(recs) || recs.length === 0) return 0;
    return this.#tx(() => {
      let written = 0;
      for (const rec of recs) {
        if (this.upsert(rec)) written += 1;
      }
      return written;
    });
  }

  /**
   * @param {{ category?: string, limit?: number }} [opts] `category` accepts the
   *   stored value (`SAFE_TO_DELETE`) or the short alias (`SAFE`).
   * @returns {TrackedRow[]}
   */
  /**
   * Rows, largest first.
   *
   * The ORDER is by size DESCENDING because that is what the panel shows first, but the LIMIT is
   * NOT a display cap: the panel cleans exactly the rows it was served, so a row beyond the limit
   * is a file the user can never select (measured live: 6345 tracked rows, `/state` served 5000,
   * so 1345 cleanable files were invisible and unreachable). Callers must either raise the limit
   * past `count()` or page explicitly.
   *
   * @param {object} [opts]
   * @param {string} [opts.category] - tier filter (short alias or stored value).
   * @param {number} [opts.limit]    - maximum rows; `null`/omitted means no limit.
   */
  list(opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const category = normalizeCategory(options.category);
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : null;

    let sql = `SELECT ${SELECT_COLUMNS} FROM tracked_files`;
    /** @type {Array<string|number>} */
    const params = [];
    if (category !== null) {
      sql += ' WHERE category = ?';
      params.push(category);
    }
    sql += ' ORDER BY file_size DESC, file_path ASC';
    if (limit !== null) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    return this.#stmt(sql)
      .all(...params)
      .map(toTrackedRow);
  }

  /**
   * Total number of tracked rows, so a caller can size a `list()` request so that it covers the
   * whole table instead of silently truncating it.
   * @returns {number}
   */
  count() {
    const row = this.#stmt('SELECT COUNT(*) AS n FROM tracked_files').get();
    return toInt(row?.n, 0);
  }

  /**
   * Byte totals per category plus a grand total. All four keys are always
   * present, zeroed when the table has no rows for that category.
   * @returns {{ SAFE:{count:number,bytes:number}, CAUTION:{count:number,bytes:number},
   *             LOCKED:{count:number,bytes:number}, total:{count:number,bytes:number} }}
   */
  summary() {
    /** @type {Record<string, {count:number, bytes:number}>} */
    const out = {
      SAFE: { count: 0, bytes: 0 },
      CAUTION: { count: 0, bytes: 0 },
      LOCKED: { count: 0, bytes: 0 },
      total: { count: 0, bytes: 0 },
    };

    for (const row of this.#stmt(SUMMARY_SQL).all()) {
      const count = toInt(row.count, 0);
      const bytes = toInt(row.bytes, 0);

      out.total.count += count;
      out.total.bytes += bytes;

      for (const key of Object.keys(SUMMARY_KEY)) {
        if (SUMMARY_KEY[key] === row.category) {
          out[key].count += count;
          out[key].bytes += bytes;
        }
      }
    }
    return out;
  }

  /**
   * Forget tracked paths (used after a successful clean).
   * @param {string[]} paths
   * @returns {number} rows actually deleted
   */
  removeByPath(paths) {
    if (!Array.isArray(paths) || paths.length === 0) return 0;
    const unique = [...new Set(paths.filter((p) => typeof p === 'string' && p.length > 0))];
    if (unique.length === 0) return 0;
    const statement = this.#stmt(DELETE_SQL);
    return this.#tx(() => {
      let removed = 0;
      for (const p of unique) {
        const result = statement.run(p);
        removed += toInt(result?.changes, 0);
      }
      return removed;
    });
  }

  /* ---------------------- Phase 3: migration journal ---------------------- */

  /**
   * Journal a migration intent. Called BEFORE any byte moves, so an interrupted migration
   * always leaves a row naming both paths.
   * @param {{source:string, target:string, state?:string, files?:number, bytes?:number,
   *          method?:string|null, error?:string|null}} rec
   * @returns {number} the row id
   */
  recordMigration(rec) {
    if (!rec || typeof rec !== 'object') throw new TypeError('recordMigration: record required');
    const source = typeof rec.source === 'string' ? rec.source.trim() : '';
    const target = typeof rec.target === 'string' ? rec.target.trim() : '';
    if (source.length === 0) throw new TypeError('recordMigration: source required');
    if (target.length === 0) throw new TypeError('recordMigration: target required');

    this.#stmt(UPSERT_MIGRATION_SQL).run(
      source,
      target,
      textOrNull(rec.state) ?? 'PENDING',
      toInt(rec.files, 0),
      toInt(rec.bytes, 0),
      textOrNull(rec.method),
      textOrNull(rec.error),
    );
    const row = this.#stmt('SELECT id FROM migrations WHERE source_path = ?').get(source);
    return toInt(row?.id, 0);
  }

  /**
   * Advance a migration record. Only the fields present in `patch` are written, so a caller can
   * set `state` alone without clobbering the measured `byte_count`.
   *
   * `error` is special-cased: a transition to a healthy state (`LINKED`/`RESTORED`) CLEARS it,
   * because a stale failure message on a successful migration is worse than no message.
   *
   * @param {number} id
   * @param {{state?:string, files?:number, bytes?:number, method?:string|null, error?:string|null}} patch
   * @returns {boolean} true when a row changed
   */
  updateMigration(id, patch = {}) {
    const rowId = toInt(id, 0);
    if (rowId <= 0) return false;
    const p = patch && typeof patch === 'object' ? patch : {};

    /** @type {Array<string>} */
    const sets = [];
    /** @type {Array<string|number|null>} */
    const params = [];

    if (typeof p.state === 'string' && p.state.length > 0) {
      sets.push('state = ?');
      params.push(p.state);
    }
    if (Number.isFinite(p.files)) {
      sets.push('file_count = ?');
      params.push(toInt(p.files, 0));
    }
    if (Number.isFinite(p.bytes)) {
      sets.push('byte_count = ?');
      params.push(toInt(p.bytes, 0));
    }
    if (p.method === null || (typeof p.method === 'string' && p.method.length > 0)) {
      sets.push('method = ?');
      params.push(p.method);
    }
    if (typeof p.error === 'string') {
      sets.push('error = ?');
      params.push(p.error);
    } else if (p.error === null || p.state === 'LINKED' || p.state === 'RESTORED') {
      sets.push('error = ?');
      params.push(null);
    }

    if (sets.length === 0) return false;
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(rowId);

    const result = this.#stmt(`UPDATE migrations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return toInt(result?.changes, 0) > 0;
  }

  /**
   * @param {number} limit
   * @returns {Array<{id:number, source_path:string, target_path:string, state:string,
   *   file_count:number, byte_count:number, method:string|null, error:string|null,
   *   created_at:string|null, updated_at:string|null}>} newest first
   */
  listMigrations(limit = 100) {
    const max = Number.isInteger(limit) && limit > 0 ? limit : 100;
    return this.#stmt(
      `SELECT ${SELECT_MIGRATION_COLUMNS} FROM migrations ORDER BY id DESC LIMIT ?`,
    )
      .all(max)
      .map(toMigrationRow);
  }

  /**
   * The most recent record for one source path, or null.
   * @param {string} sourcePath
   */
  getMigrationBySource(sourcePath) {
    if (typeof sourcePath !== 'string' || sourcePath.length === 0) return null;
    const row = this.#stmt(
      `SELECT ${SELECT_MIGRATION_COLUMNS} FROM migrations WHERE source_path = ?`,
    ).get(sourcePath);
    return row ? toMigrationRow(row) : null;
  }

  /**
   * Records that are NOT in a terminal-good state: `LINKED` is healthy, `FAILED`/`RESTORED` are
   * settled, but `PENDING` and `MOVED` describe a migration that never finished — the crash
   * window. Only these need surfacing to the user.
   * @returns {Array<ReturnType<typeof toMigrationRow>>}
   */
  listInterruptedMigrations() {
    return this.#stmt(
      `SELECT ${SELECT_MIGRATION_COLUMNS} FROM migrations WHERE state IN ('PENDING','MOVED') ORDER BY id DESC`,
    )
      .all()
      .map(toMigrationRow);
  }

  /** Release the handle. Safe to call twice. */
  close() {
    try {
      this.statements.clear();
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

export default StateDB;
