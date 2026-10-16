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
