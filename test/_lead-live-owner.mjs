// Lead probe (read-only): does the LIVE installed plugin populate the holder columns?
// Reads the live state DB the running harness process is writing to.
import { DatabaseSync } from 'node:sqlite';

const DB = 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';
const db = new DatabaseSync(DB, { readOnly: true });
const q = (s) => db.prepare(s).all();

const total = q('SELECT COUNT(*) c FROM tracked_files')[0].c;
const lockedRows = q("SELECT COUNT(*) c FROM tracked_files WHERE category='LOCKED_CRITICAL'")[0].c;
const withPid = q('SELECT COUNT(*) c FROM tracked_files WHERE locked_by_pid IS NOT NULL')[0].c;
const withProc = q('SELECT COUNT(*) c FROM tracked_files WHERE source_process IS NOT NULL')[0].c;
const newest = q('SELECT MAX(last_checked_at) m FROM tracked_files')[0].m;

console.log(JSON.stringify({ DB, total, lockedRows, withPid, withProc, newest }, null, 1));

if (withProc > 0) {
  console.log('--- sample rows that DO carry an owner ---');
  for (const r of q('SELECT file_path, category, locked_by_pid, source_process FROM tracked_files WHERE source_process IS NOT NULL LIMIT 5')) {
    console.log(' ', JSON.stringify(r));
  }
}
db.close();
