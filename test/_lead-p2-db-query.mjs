// Lead-owned read-only DB inspection helper.
// RUN: node test/_lead-p2-db-query.mjs [<LIKE pattern>]
import { DatabaseSync } from 'node:sqlite';

const DB = 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';
const like = process.argv[2] ?? '%valve_leak%';

const db = new DatabaseSync(DB);
try {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((t) => t.name);
  console.log(`tables: ${tables.join(', ')}`);

  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    console.log(`\n[${t}] columns: ${cols.join(', ')}`);
  }

  const rows = db
    .prepare(
      'SELECT id, file_path, file_size, category, is_locked, locked_by_pid, source_process, created_at, last_checked_at ' +
        'FROM tracked_files WHERE file_path LIKE ? ORDER BY last_checked_at DESC LIMIT 20',
    )
    .all(like);
  console.log(`\nrows matching ${like}: ${rows.length}`);
  for (const r of rows) console.log(JSON.stringify(r));
} finally {
  db.close();
}
