/**
 * Count live-DB rows per probe directory prefix, to separate "watcher missed them" from
 * "API did not serve them".
 * Usage: node test/_lead-dir-count.mjs <dir-substring> [dbPath]
 */
import { DatabaseSync } from 'node:sqlite';

const FILTER = process.argv[2] ?? 'dshcc_e2e_';
const DB = process.argv[3] ?? 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare('SELECT file_path FROM tracked_files WHERE file_path LIKE ?').all(`%${FILTER}%`);
const counts = new Map();
for (const r of rows) {
  const idx = r.file_path.indexOf(FILTER);
  const rest = r.file_path.slice(idx + FILTER.length);
  const dir = FILTER + (rest.split('\\')[0] ?? '');
  counts.set(dir, (counts.get(dir) ?? 0) + 1);
}
for (const [d, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)}  ${d}`);
console.log(`total rows matching ${JSON.stringify(FILTER)}: ${rows.length}`);
console.log('grand total tracked_files:', db.prepare('SELECT COUNT(*) n FROM tracked_files').get().n);
db.close();
