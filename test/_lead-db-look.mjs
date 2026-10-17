// Read-only look at the LIVE plugin DB to see what the running process actually recorded.
// Written as a file because bash+node -e mangles Windows backslashes in string literals.
import { DatabaseSync } from 'node:sqlite';

const DB = process.argv[2] ?? 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';
const db = new DatabaseSync(DB, { readOnly: true });
const q = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch (e) { return [{ err: e.message }]; } };

const DDL = q("select sql from sqlite_master where name='tracked_files'")[0]?.sql ?? '';
console.log('--- tracked_files DDL ---');
console.log(DDL);

const cols = q('pragma table_info(tracked_files)').map((c) => c.name);
console.log('\n--- columns ---');
console.log(JSON.stringify(cols));

const timeCol = cols.find((c) => /last|seen|first|time|mtime|updated/i.test(c));
console.log(`\n--- using time column: ${timeCol} ---`);

console.log('\n--- rows matching Configuration/Contoso (the leak signature) ---');
console.log(JSON.stringify(q(
  `select ${cols.join(', ')} from tracked_files where file_path like '%Configuration%' or file_path like '%Contoso%' limit 10`
), null, 1));

console.log('\n--- newest 8 rows overall (what the live process recorded last) ---');
console.log(JSON.stringify(q(
  `select file_path, category, is_locked${timeCol ? `, ${timeCol}` : ''} from tracked_files order by rowid desc limit 8`
), null, 1));

console.log('\n--- tier histogram ---');
console.log(JSON.stringify(q('select category, count(*) n from tracked_files group by category order by n desc'), null, 1));
