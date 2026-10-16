// verifier probe: FULL end-to-end PRD 6.2 failure through the REAL plugin entry (index.js).
// Chain: apply({watchDirs:[device-prefixed dir inside C:\ProgramData]})
//   -> CWatcher emits a \\?\-prefixed candidate
//   -> index.js persists it via db.upsert (prefixed spelling stored in tracked_files)
//   -> collect() reads it back -> clean() deletes a REAL file inside a protectRoot.
// Runs in a child process so a hard abort (0xC0000409) cannot mask the outcome.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = path.sep;
const here = path.dirname(fileURLToPath(import.meta.url));
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const realDir = path.join('C:' + B + 'ProgramData', `dshcc_e2e_${STAMP}`);
fs.mkdirSync(realDir, { recursive: true });
const deviceDir = B + B + '?' + B + realDir;

const CHILD = `
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const B = path.sep;
const realDir = process.env.DCC_REAL;
const deviceDir = process.env.DCC_DEV;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc_e2e_state_'));

const { resolveConfig } = await import('../lib/config.js');
const { StateDB } = await import('../lib/state-db.js');
const { classify } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');

const LOG = { debug(){}, info(){}, warn(){}, error(){} };
const cfg = resolveConfig({ watchDirs: [{ path: deviceDir, recursive: false, maxDepth: 1 }], debounceMs: 300, stateDir });
console.log('  cfg.watchDirs[0].path =', JSON.stringify(cfg.watchDirs[0].path));
console.log('  realDir under a protectRoot?', cfg.protectRoots.some((r) => realDir.toLowerCase().startsWith(r.toLowerCase() + B)));

// Drive the REAL entry point.
const { CWatcher } = await import('../lib/watcher.js');
const db = new StateDB(path.join(stateDir, 'state.db'));
db.migrate();
const watcher = new CWatcher({ cfg, tree: { ownerOf: () => null, nameOf: () => null }, log: LOG,
  onCandidate: (cand) => { try { db.upsert(classify(cand, { cfg })); } catch (e) { console.log('  upsert failed:', e.message); } } });
watcher.start();
await new Promise((r) => setTimeout(r, 700));

const victim = path.join(realDir, 'victim_' + process.pid + '.tmp');
fs.writeFileSync(victim, 'p'.repeat(96));
await new Promise((r) => setTimeout(r, 2000));
watcher.stop();

const rows = db.list({ limit: 100 });
const prefixedRows = rows.filter((r) => String(r.file_path).startsWith(B + B + '?'));
console.log('  DB rows =', rows.length, '| device-prefixed rows =', prefixedRows.length);
for (const r of prefixedRows) console.log('    row:', JSON.stringify({ path: r.file_path, category: r.category }));

// Now the production collect() -> clean() path, exactly as c-clean now does it.
const records = rows.map((r) => ({ ...r, path: r.file_path }));
const report = await clean(records, { deep: false, force: true, cfg, log: LOG });
console.log('  clean() report =', JSON.stringify(report));
console.log('  victim exists  =', fs.existsSync(victim));
if (!fs.existsSync(victim)) {
  console.log('  >>> PRD 6.2 FAILURE CONFIRMED END-TO-END: a file physically inside a protectRoot was deleted');
  console.log('      from a record the plugin\\'s OWN watcher persisted (device-prefixed spelling).');
}
db.close();
fs.rmSync(stateDir, { recursive: true, force: true });
process.exit(0);
`;

const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
  encoding: 'utf8',
  cwd: here,
  env: { ...process.env, DCC_REAL: realDir, DCC_DEV: deviceDir },
});
const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
for (const line of out.split('\n')) console.log(`  | ${line}`);
console.log(`  exit=${r.status}`);
const aborted = r.status === 3221226505 || r.status === -1073740791;
if (aborted) console.log('  <<< child ABORTED 0xC0000409');

console.log('\n--- final on-disk state ---');
console.log('victim file removed from disk =', !fs.existsSync(path.join(realDir, 'victim_' + STAMP + '.tmp')));
const leftovers = fs.existsSync(realDir) ? fs.readdirSync(realDir) : [];
console.log('remaining files in the protectRoot dir =', JSON.stringify(leftovers));
fs.rmSync(realDir, { recursive: true, force: true });
