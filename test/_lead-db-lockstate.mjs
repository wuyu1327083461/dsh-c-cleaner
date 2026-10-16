// Lead: what does the LIVE DB actually record for lock state? Quantifies the H2 gap honestly.
// PRD 3.3 requires the LOCKED tier to surface the HOLDING PROCESS NAME + PID.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db', { readOnly: true });
const all = (sql) => db.prepare(sql).all();

console.log('=== lock-state accounting over every tracked row ===');
console.log('   ', JSON.stringify(all(`SELECT
    COUNT(*) AS total,
    SUM(is_locked) AS is_locked_true,
    SUM(CASE WHEN category='LOCKED_CRITICAL' AND is_locked=0 THEN 1 ELSE 0 END) AS locked_by_name_only,
    SUM(CASE WHEN locked_by_pid IS NOT NULL THEN 1 ELSE 0 END) AS with_pid,
    SUM(CASE WHEN source_process IS NOT NULL THEN 1 ELSE 0 END) AS with_proc
  FROM tracked_files`)[0]));

console.log('\n=== rows that ARE genuinely locked (is_locked=1) ===');
const genuinely = all(`SELECT file_path, category, is_locked, locked_by_pid, source_process
  FROM tracked_files WHERE is_locked=1 LIMIT 5`);
console.log(`    count shown: ${genuinely.length}`);
for (const r of genuinely) console.log('   ', JSON.stringify(r));

console.log('\n=== category breakdown ===');
for (const r of all(`SELECT category, COUNT(*) n, SUM(file_size) bytes FROM tracked_files GROUP BY category`)) {
  console.log('   ', JSON.stringify(r));
}

console.log('\n=== why source_process is null: ProcessTree.ownerOf() is documented best-effort ===');
console.log('    It returns null by design — Windows gives Node no cheap handle->PID mapping without ETW');
console.log('    or a per-file handle64.exe spawn, which PRD 6.1 (CPU <2%) forbids.');
db.close();
