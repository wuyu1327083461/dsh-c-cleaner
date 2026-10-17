/**
 * Read-only live-DB report: totals per tier, newest rows, and a directory-substring query.
 * Usage: node test/_lead-db-report.mjs [dir-substring] [dbPath]
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const DB = process.argv[3] ?? 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';
const FILTER = process.argv[2] ?? null;

console.log('DB exists:', fs.existsSync(DB), DB);
const db = new DatabaseSync(DB, { readOnly: true });

console.log('tables:', db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name).join(', '));
console.log('total rows:', db.prepare('SELECT COUNT(*) c FROM tracked_files').get().c);
for (const r of db.prepare('SELECT category, COUNT(*) c, SUM(file_size) b FROM tracked_files GROUP BY category').all()) {
  console.log(`  ${r.category.padEnd(16)} ${String(r.c).padStart(6)}  ${Math.round(r.b / 1048576)} MB`);
}
console.log('--- newest 6 ---');
for (const r of db.prepare('SELECT id, file_path, category, is_locked, created_at FROM tracked_files ORDER BY id DESC LIMIT 6').all()) {
  console.log(`  ${r.id} ${r.category.padEnd(16)} lock=${r.is_locked} ${r.created_at}  ${r.file_path.slice(-78)}`);
}
if (FILTER) {
  console.log(`--- rows whose path contains ${JSON.stringify(FILTER)} ---`);
  const rows = db.prepare('SELECT id, file_path, category, is_locked, created_at FROM tracked_files WHERE file_path LIKE ?').all(`%${FILTER}%`);
  for (const r of rows) console.log(`  ${r.id} ${r.category.padEnd(16)} lock=${r.is_locked} ${r.created_at}  ${r.file_path}`);
  console.log(`  count=${rows.length}`);
}
db.close();
