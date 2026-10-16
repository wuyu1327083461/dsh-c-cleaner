// Lead: read the LIVE plugin state DB (read-only) to confirm the running plugin is still storing rows.
// Written to disk rather than inlined with `node -e`, because bash quoting mangles Windows backslash
// paths — a lesson this project has now relearned three times.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const dbPath = 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';
console.log('db exists        :', fs.existsSync(dbPath));
console.log('db size          :', fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0);
for (const suffix of ['-wal', '-shm']) {
  const p = dbPath + suffix;
  console.log(`  ${suffix.padEnd(4)} exists   :`, fs.existsSync(p), fs.existsSync(p) ? `${fs.statSync(p).size} bytes` : '');
}

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
  console.log('\nopened read-only : true');
} catch (e) {
  console.log('\nreadOnly open FAILED:', e.message);
  console.log('retrying read-write (WAL recovery may need it) ...');
  db = new DatabaseSync(dbPath);
  console.log('opened read-write : true');
}

const rows = db.prepare('SELECT category, COUNT(*) AS c, COALESCE(SUM(file_size),0) AS b FROM tracked_files GROUP BY category ORDER BY category').all();
console.log('\n=== live rows by category ===');
let total = 0, totalBytes = 0;
for (const r of rows) {
  total += r.c; totalBytes += r.b;
  console.log(`  ${String(r.category).padEnd(16)} ${String(r.c).padStart(4)} file(s)  ${r.b} bytes`);
}
console.log(`  ${'TOTAL'.padEnd(16)} ${String(total).padStart(4)} file(s)  ${totalBytes} bytes`);

const recent = db.prepare('SELECT file_path, category, is_locked, file_size FROM tracked_files ORDER BY id DESC LIMIT 5').all();
console.log('\n=== 5 most recent rows ===');
for (const r of recent) console.log(`  [${r.category}] locked=${r.is_locked} ${r.file_size}B  ${r.file_path}`);

const cols = db.prepare('PRAGMA table_info(tracked_files)').all().map((c) => c.name);
console.log('\ntracked_files columns:', JSON.stringify(cols));
console.log('PRD §5 order match   :', JSON.stringify(cols) === JSON.stringify([
  'id', 'file_path', 'file_size', 'category', 'is_locked', 'locked_by_pid', 'source_process', 'created_at', 'last_checked_at',
]));

const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tracked_files' ORDER BY name").all().map((r) => r.name);
console.log('indexes              :', JSON.stringify(idx));

db.close();
console.log('\nclosed.');
