// Lead: settle two anomalies from _lead-verify-junction-fix.mjs that look like MY probe's bugs.
//   (a) "C:\ProgramData\a\b.dat LEAK" — I called isProtectedPath(p) with ONE argument. The
//       signature is isProtectedPath(filePath, protectRoots, opts); with protectRoots undefined it
//       falls back to systemProtectedRoots(), which deliberately does NOT include ProgramData
//       (that entry comes from resolveConfig's cfg.protectRoots). So the probe tested the wrong
//       root list and the plugin may be innocent.
//   (b) The DB route persisted 0 rows — my upsert/list call shape was probably wrong.
import { classify, isProtectedPath } from '../lib/classifier.js';
import { resolveConfig } from '../lib/config.js';
import { StateDB } from '../lib/state-db.js';
import fs from 'node:fs';
import path from 'node:path';

const cfg = resolveConfig({});
const REAL_LOCAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';

console.log('=== (a) ProgramData: with the CORRECT argument the plugin is evaluated properly ===');
const probes = [
  'C:\\ProgramData\\a\\b.dat',
  'C:\\ProgramData',
  'C:\\Windows\\notepad.exe',
  'C:\\ProgramDataExtra\\x.txt',
  'C:\\ProgramData-old\\x.txt',
];
for (const p of probes) {
  const withCfg = isProtectedPath(p, cfg.protectRoots);
  const withDefault = isProtectedPath(p);
  console.log(`  ${JSON.stringify(p)}`);
  console.log(`      with cfg.protectRoots = ${withCfg}`);
  console.log(`      with system default   = ${withDefault}   (ProgramData absent by design)`);
}
// The decisive question: does the REAL production path protect ProgramData?
const rec = classify({ path: 'C:\\ProgramData\\dshcc-not-real\\x.tmp', size: 10, mtimeMs: Date.now(), sourceProcess: null }, { cfg });
console.log(`\n  classify() on a ProgramData path -> ${rec.category}`);
console.log(`  reason -> ${rec.reason}`);
console.log(`  >>> production path protects ProgramData: ${rec.category === 'LOCKED_CRITICAL' || /protected/i.test(rec.reason)}`);

console.log('\n=== (b) DB route: correct StateDB call shape ===');
const holder = fs.mkdtempSync(path.join(REAL_LOCAL_TEMP, 'ccl-db2-'));
const db = new StateDB(path.join(holder, 'route.db'));
db.migrate();
const target = path.join(REAL_LOCAL_TEMP, 'ccl-db2-row.tmp');
fs.writeFileSync(target, 'x'.repeat(24));
const upserted = db.upsert({
  file_path: target,
  file_size: 24,
  category: 'SAFE_TO_DELETE',
  is_locked: false,
  locked_by_pid: null,
  source_process: null,
});
console.log(`  upsert returned : ${upserted}`);
console.log(`  summary         : ${JSON.stringify(db.summary())}`);
const all = db.list({});
console.log(`  list({}) rows   : ${all.length}`);
const byCat = db.list({ category: 'SAFE_TO_DELETE' });
console.log(`  list({category}): ${byCat.length}`);
if (all.length) console.log(`  row path        : ${all[0].file_path}`);
console.log(`  >>> DB route usable for the acceptance probe: ${all.length > 0}`);
db.close();
try { fs.rmSync(holder, { recursive: true, force: true }); } catch { /* */ }
