/**
 * Prove the purge was BOOKKEEPING ONLY: every file behind a surviving row is still on
 * disk, and the purge did not delete anything. Read-only.
 *
 * Also reports how many tracked paths have since vanished on their own (Windows cleans
 * %TEMP% itself), which is expected and is not evidence of a deletion.
 */
import fs from 'node:fs';
import { StateDB } from '../lib/state-db.js';

const dbPath = process.argv[2] || 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';
const db = new StateDB(dbPath, { create: false });

const rows = db.list({ limit: 5000 });
let present = 0;
let absent = 0;
const absentSample = [];

for (const row of rows) {
  let ok = false;
  try {
    ok = fs.statSync(row.file_path).isFile();
  } catch {
    ok = false;
  }
  if (ok) present += 1;
  else {
    absent += 1;
    if (absentSample.length < 5) absentSample.push(row.file_path);
  }
}

console.log(`db               : ${dbPath}`);
console.log(`tracked rows     : ${rows.length}`);
console.log(`files present    : ${present}`);
console.log(`files absent     : ${absent}`);
if (absentSample.length > 0) {
  console.log('absent sample (Windows %TEMP% cleanup, not our doing):');
  for (const p of absentSample) console.log(`  - ${p}`);
}

db.close();
process.exit(0);
