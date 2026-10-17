/**
 * Lead probe: real C: -> E: junction migration against lib/symlink-migrate.js.
 * Creates a synthetic "stubborn directory" on the real C: volume, migrates it, proves the
 * bytes physically left C:, proves the junction redirects, then undoes it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { StateDB } from '../lib/state-db.js';
import {
  inspectDirectory,
  migrateDirectory,
  undoMigration,
  MIGRATION_STATE,
  walkTree,
  targetRootOf,
} from '../lib/symlink-migrate.js';

const C_ROOT = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';
const log = { debug() {}, info() {}, warn() {}, error() {} };

const cfg = resolveConfig({
  migrateTargetRoot: 'E:\\dsh_escape_cache\\migrated',
});
console.log('isWindows        =', cfg.isWindows);
console.log('targetRootOf()   =', targetRootOf(cfg));
console.log('escapeRoot       =', cfg.escapeRoot);
console.log('real C: Temp is a junction? =', (() => {
  try { return fs.lstatSync(C_ROOT).isSymbolicLink(); } catch (e) { return 'stat failed: ' + e.code; }
})());

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3mig-'));
const db = new StateDB(path.join(dbDir, 'state.db'));

const id = Date.now().toString(36);
const src = path.join(C_ROOT, 'p3_stubborn_' + id);

function mkTree() {
  fs.mkdirSync(path.join(src, 'deep', 'deeper'), { recursive: true });
  for (let i = 0; i < 4; i += 1) fs.writeFileSync(path.join(src, 'deep', 'deeper', `f${i}.bin`), Buffer.alloc(4096, i));
  fs.writeFileSync(path.join(src, 'top.txt'), 'top-level');
}

try {
  fs.rmSync(src, { recursive: true, force: true });
  mkTree();
  console.log('\n=== created stubborn dir ===');
  console.log('src =', src, '| is junction?', fs.lstatSync(src).isSymbolicLink());
  console.log('walk =', JSON.stringify(walkTree(src)));

  // ---- 1. inspection gate ----
  const plan = inspectDirectory(src, cfg);
  console.log('\n=== inspectDirectory ===');
  console.log(JSON.stringify(plan, null, 0));
  if (!plan.ok) throw new Error('expected migratable, got ' + plan.code);

  // ---- 2. real migration ----
  const result = await migrateDirectory(src, { cfg, log, db });
  console.log('\n=== migrateDirectory ===');
  console.log(JSON.stringify(result, null, 0));
  if (!result.ok) throw new Error('migration failed: ' + result.code + ' ' + result.reason);

  // ---- 3. prove the physical state ----
  const st = fs.lstatSync(src);
  console.log('\n=== post-migration state ===');
  console.log('source lstat.isSymbolicLink =', st.isSymbolicLink());
  console.log('source stat.isDirectory (follows) =', fs.statSync(src).isDirectory());
  console.log('readlink =', fs.readlinkSync(src));
  console.log('target exists on E: =', fs.existsSync(result.target));
  console.log('target tree =', JSON.stringify(walkTree(result.target)));

  // write through the junction -> must land physically on E:
  fs.writeFileSync(path.join(src, 'through-junction.txt'), 'lands on E');
  console.log(
    'write through junction landed at target =',
    fs.existsSync(path.join(result.target, 'through-junction.txt')),
  );

  // realpath proves the redirect resolves off C:
  console.log('realpath(src) =', fs.realpathSync(src));
  console.log('realpath starts with E: =', fs.realpathSync(src).toUpperCase().startsWith('E:'));

  // ---- 4. journal state ----
  const row = db.getMigrationBySource(src);
  console.log('\n=== journal ===');
  console.log('state =', row.state, '| files =', row.file_count, '| bytes =', row.byte_count, '| method =', row.method);

  // ---- 5. undo ----
  const undone = await undoMigration(src, { cfg, log, db });
  console.log('\n=== undoMigration ===');
  console.log(JSON.stringify(undone, null, 0));
  console.log('after undo: source is junction? =', fs.lstatSync(src).isSymbolicLink());
  console.log('after undo: source walk =', JSON.stringify(walkTree(src)));
  console.log('after undo: target gone? =', !fs.existsSync(result.target));
  console.log('after undo: journal state =', db.getMigrationBySource(src).state);
} finally {
  try { fs.rmSync(src, { recursive: true, force: true }); } catch {}
  try {
    const r = db.getMigrationBySource(src);
    if (r && fs.existsSync(r.target_path)) fs.rmSync(r.target_path, { recursive: true, force: true });
  } catch {}
  db.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
}
console.log('\nOK');
