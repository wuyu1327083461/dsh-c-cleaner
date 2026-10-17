import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateDB } from '../lib/state-db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdbm-'));
const db = new StateDB(path.join(dir, 't.db'));
try {
  db.migrate();
  console.log('migrate() second call: OK (idempotent)');

  const src = 'C:\\Users\\x\\AppData\\Local\\Temp\\stubborn';
  const dst = 'E:\\dsh_escape_cache\\migrated\\stubborn';
  const id = db.recordMigration({ source: src, target: dst, state: 'PENDING' });
  console.log('recordMigration id =', id);

  const row = db.getMigrationBySource(src);
  console.log('getMigrationBySource =', JSON.stringify(row));

  db.updateMigration(id, { state: 'MOVED', files: 3, bytes: 99, method: 'copy' });
  console.log('after MOVED  =', JSON.stringify(db.getMigrationBySource(src)));
  console.log('interrupted  =', JSON.stringify(db.listInterruptedMigrations().map((r) => [r.id, r.state])));

  db.updateMigration(id, { state: 'LINKED' });
  console.log('after LINKED =', JSON.stringify(db.getMigrationBySource(src)));
  console.log('interrupted  =', JSON.stringify(db.listInterruptedMigrations().map((r) => [r.id, r.state])));

  console.log('listMigrations =', JSON.stringify(db.listMigrations().map((r) => [r.id, r.state, r.method])));

  // re-record the same source: must supersede, not duplicate
  const id2 = db.recordMigration({ source: src, target: 'E:\\other\\stubborn', state: 'PENDING' });
  console.log('re-record id =', id2, '(same as first:', id2 === id, ')');
  console.log('rows for source =', db.listMigrations().filter((r) => r.source_path === src).length);
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('OK');
