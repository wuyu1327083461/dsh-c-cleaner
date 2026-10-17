// What CATEGORY did the live process assign to the uniquely-named leaked installer?
// If it is LOCKED_CRITICAL with is_locked=0 and no source_process, the §3.3 valve admitted
// it (the credential-name path) -- which the TIGHT regex on disk cannot do, proving the
// running process holds the pre-fix module generation.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2] ?? 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db', { readOnly: true });
const like = process.argv[3] ?? '%Configuration%';

console.log(JSON.stringify(db.prepare(
  'select id, file_path, category, is_locked, locked_by_pid, source_process, file_size, created_at from tracked_files where file_path like ? order by id desc limit 6'
).all(like), null, 1));
