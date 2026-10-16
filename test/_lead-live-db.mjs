// Lead: read the LIVE state.db that the installed plugin writes, and prove it is the plugin's own
// output (not a test artifact). Read-only.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const DB = 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';
console.log('db path     :', DB);
console.log('db exists   :', fs.existsSync(DB), fs.existsSync(DB) ? `${fs.statSync(DB).size} bytes` : '');
console.log('wal exists  :', fs.existsSync(DB + '-wal'), fs.existsSync(DB + '-shm') ? '(WAL mode active)' : '');

const db = new DatabaseSync(DB, { readOnly: true });
console.log('journal mode:', JSON.stringify(db.prepare('PRAGMA journal_mode').get()));
console.log('tables      :', JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)));
console.log('indexes     :', JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name)));
console.log('');
console.log('PRD 5 columns (pragma table_info, in order):');
for (const c of db.prepare('PRAGMA table_info(tracked_files)').all()) {
  console.log(`  ${c.cid}  ${c.name.padEnd(18)} ${c.type.padEnd(8)} notnull=${c.notnull} default=${c.dflt_value ?? 'NULL'}`);
}
console.log('');
const grouped = db.prepare('SELECT category, COUNT(*) n, SUM(file_size) b FROM tracked_files GROUP BY category ORDER BY category').all();
console.log('rows by category:', JSON.stringify(grouped));
console.log('total rows      :', JSON.stringify(db.prepare('SELECT COUNT(*) n FROM tracked_files').get()));
console.log('');
console.log('newest 8 rows written by the live plugin:');
for (const r of db.prepare('SELECT file_path, category, file_size, is_locked, source_process, created_at FROM tracked_files ORDER BY id DESC LIMIT 8').all()) {
  console.log(`  [${r.category}] ${r.file_size}B locked=${r.is_locked} src=${r.source_process ?? 'null'}\n      ${r.file_path}`);
}
db.close();
