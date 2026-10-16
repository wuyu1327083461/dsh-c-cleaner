// Lead: settle the three open hardening items H1 (malformed watchDirs -> TypeError), H2 (locked_by_pid),
// H3 (unvalidated debounceMs/sessionWindowMs). The decisive question for H1/H3 is whether the config the
// running plugin sees can EVER reach resolveConfig unvalidated: cordis validates with runtime.Config
// BEFORE apply(), so if our Standard Schema drops/repairs malformed shapes, H1/H3 are unreachable in
// production and are only a direct-API hazard.
import { Config } from '../lib/config-schema.js';
import { resolveConfig } from '../lib/config.js';

const cases = [
  ['watchDirs: [null]', { watchDirs: [null] }],
  ['watchDirs: [5]', { watchDirs: [5] }],
  ['watchDirs: ["C:\\\\ok"]', { watchDirs: ['C:\\ok'] }],
  ['watchDirs: 5 (not array)', { watchDirs: 5 }],
  ['watchDirs: "C:\\\\x" (string)', { watchDirs: 'C:\\x' }],
  ['debounceMs: "abc"', { debounceMs: 'abc' }],
  ['debounceMs: -5', { debounceMs: -5 }],
  ['debounceMs: NaN', { debounceMs: NaN }],
  ['sessionWindowMs: -1', { sessionWindowMs: -1 }],
  ['sessionWindowMs: "x"', { sessionWindowMs: 'x' }],
  ['envMap: "nope"', { envMap: 'nope' }],
  ['envMap: {TEMP: 7}', { envMap: { TEMP: 7 } }],
  ['protectRoots: [null]', { protectRoots: [null] }],
  ['maxBatch: 0', { maxBatch: 0 }],
  ['pollIntervalMs: 1', { pollIntervalMs: 1 }],
];

let blocked = 0, passed = 0, threw = 0;
console.log('=== gate 1: does the Standard Schema reject or repair it? ===');
for (const [label, input] of cases) {
  let verdict, value = null;
  const r = Config['~standard'].validate(input);
  if (r && r.issues) { verdict = `REJECTED (${r.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`; blocked += 1; }
  else { value = r.value; verdict = 'ACCEPTED'; }
  console.log(`  ${label.padEnd(28)} -> ${verdict}`);
  if (value !== null) {
    console.log(`  ${''.padEnd(28)}    value: ${JSON.stringify(value)}`);
  }
  // gate 2: if it got through, does resolveConfig survive it?
  if (value !== null) {
    try {
      const cfg = resolveConfig(value);
      const summary = { watchDirs: cfg.watchDirs, debounceMs: cfg.debounceMs, sessionWindowMs: cfg.sessionWindowMs, maxBatch: cfg.maxBatch, envMapKeys: Object.keys(cfg.envMap).length };
      console.log(`  ${''.padEnd(28)}    resolveConfig OK: ${JSON.stringify(summary)}`);
      passed += 1;
    } catch (e) {
      console.log(`  ${''.padEnd(28)}    resolveConfig THREW: ${e.constructor.name}: ${e.message}`);
      threw += 1;
    }
  }
}

console.log(`\n=== verdict ===`);
console.log(`  rejected by schema : ${blocked}  <- unreachable in production (cordis validates before apply)`);
console.log(`  accepted + survived: ${passed}`);
console.log(`  accepted + THREW   : ${threw}  <- real H1/H3 hazard`);
console.log(threw === 0
  ? '  => H1/H3 NOT reachable through the plugin config path: the schema blocks or repairs every malformed shape.'
  : '  => H1/H3 REACHABLE: a schema-accepted config still crashes resolveConfig.');

// H2: locked_by_pid — show what the live DB actually holds, to quantify the gap honestly.
console.log('\n=== H2: is locked_by_pid / source_process ever populated? ===');
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db', { readOnly: true });
  const q = (sql) => db.prepare(sql).all();
  const rows = q(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN locked_by_pid IS NOT NULL THEN 1 ELSE 0 END) AS with_pid,
      SUM(CASE WHEN source_process IS NOT NULL THEN 1 ELSE 0 END) AS with_proc,
      SUM(CASE WHEN category='LOCKED_CRITICAL' THEN 1 ELSE 0 END) AS locked_cat
    FROM tracked_files`);
  console.log('  ', JSON.stringify(rows[0]));
  const sample = q(`SELECT file_path, category, is_locked, locked_by_pid, source_process FROM tracked_files WHERE category='LOCKED_CRITICAL' LIMIT 3`);
  for (const s of sample) console.log('   sample:', JSON.stringify(s));
  db.close();
} catch (e) {
  console.log('   db read failed:', e.code || e.message);
}
