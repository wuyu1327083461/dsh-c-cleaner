// Read-only query helper for the LIVE plugin DB. Written as a file because bash heredocs
// mangle Windows backslashes inside JS string literals.
import { DatabaseSync } from 'node:sqlite';

const DB = process.argv[3] ?? 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';
const dir = process.argv[2] ?? '';
const db = new DatabaseSync(DB, { readOnly: true });
const q = (sql, ...a) => {
  try {
    return db.prepare(sql).all(...a);
  } catch (e) {
    return [{ err: e.message }];
  }
};

console.log('db:', DB);
console.log('filter dir:', dir);
console.log(
  JSON.stringify(
    q(
      'select id, file_path, category, is_locked, created_at, last_checked_at from tracked_files where file_path like ? order by id desc',
      `%${dir}%`,
    ),
    null,
    1,
  ),
);
console.log('--- 6 newest rows overall ---');
console.log(
  JSON.stringify(
    q('select id, file_path, category, is_locked, created_at from tracked_files order by id desc limit 6'),
    null,
    1,
  ),
);
