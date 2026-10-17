/**
 * Probe: THE LIVE DEFECT — a directory containing a file another process holds exclusively.
 *
 * Before the fix, `migrateDirectory` copied the tree to E:, `fs.rmSync(source)` threw EPERM
 * after deleting part of it, and the recovery deleted the verified copy — losing files that
 * existed in neither tree. The user saw `已拒绝（EPERM）：move failed: EPERM ...`.
 *
 * After the fix: the occupancy pre-flight refuses BEFORE copying, the source is untouched,
 * nothing exists at the target, and the answer names the busy files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const results = [];
async function check(name, fn) {
  try {
    const out = await fn();
    results.push({ name, ok: true, detail: out ?? '' });
    console.log(`PASS ${name}${out ? ` :: ${out}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String(err && err.message) });
    console.log(`FAIL ${name} :: ${err && err.message}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

const { migrateDirectory, undoMigration, MIGRATION_STATE } = await import('../lib/symlink-migrate.js');
const { resolveConfig } = await import('../lib/config.js');
const { StateDB } = await import('../lib/state-db.js');

const stamp = `${process.pid}_${Date.now().toString(36)}`;
const srcRoot = 'C:/Users/kiuhg/AppData/Local/Temp';
const work = path.join(srcRoot, `dcc_busy_${stamp}`);
const targetRoot = `E:/dsh_escape_cache/mig_busy_${stamp}`;
const dbPath = path.join(os.tmpdir(), `dcc_busy_${stamp}.db`);

fs.mkdirSync(path.join(work, 'nested'), { recursive: true });
const fileNames = ['a1.bin', 'a2.bin', 'a3.bin', 'nested/b1.bin', 'nested/b2.bin', 'nested/zz_locked.bin', 'zz1.bin', 'zz2.bin'];
for (const n of fileNames) fs.writeFileSync(path.join(work, n), n.repeat(400));
const lockedPath = path.join(work, 'nested', 'zz_locked.bin');

const cfg = resolveConfig({ migrateTargetRoot: targetRoot }, process.env);
const db = new StateDB(dbPath);

// Hold the file exclusively from another process.
const psFile = path.join(os.tmpdir(), `hold_${stamp}.ps1`);
fs.writeFileSync(psFile, `
$ErrorActionPreference = 'Stop'
$fs = [System.IO.File]::Open('${lockedPath.replace(/'/g, "''")}', 'Open', 'Read', 'None')
Write-Output 'HELD'
Start-Sleep -Seconds 20
$fs.Close()
`);
const holder = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve) => {
  let buf = '';
  holder.stdout.on('data', (d) => { buf += d.toString(); if (buf.includes('HELD')) resolve(); });
  setTimeout(resolve, 6000);
});

const countFiles = (root) => {
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full); else n += 1;
    }
  };
  walk(root);
  return n;
};

const beforeCount = countFiles(work);

check('pre-flight refuses a busy directory without moving anything', () => {
  const r = migrateDirectory(work, { cfg, log: silentLog, db });
  return r.then((res) => {
    assert(!res.ok, 'migration should have been refused');
    assert(res.code === 'FILES_IN_USE', `want FILES_IN_USE, got ${res.code} (${res.reason})`);
    assert(/held open by another process/.test(res.reason), `reason should name the cause: ${res.reason}`);
    assert(/zz_locked\.bin/.test(res.reason), `reason should name the busy file: ${res.reason}`);
    return `refused: ${res.code}`;
  });
});

const r1 = await migrateDirectory(work, { cfg, log: silentLog, db });
check('source is fully intact after the refusal', () => {
  assert(!r1.ok, 'should be refused');
  const afterCount = countFiles(work);
  assert(afterCount === beforeCount, `source lost files: ${beforeCount} -> ${afterCount}`);
  assert(fs.existsSync(lockedPath), 'the locked file itself is gone');
  for (const n of fileNames) assert(fs.existsSync(path.join(work, n)), `missing source file ${n}`);
  return `${afterCount}/${beforeCount} files intact`;
});

check('nothing was copied to the target volume', () => {
  const exists = fs.existsSync(targetRoot);
  assert(!exists, `target root should not exist, but ${targetRoot} does (leftover copy)`);
  return 'target root absent';
});

check('the refusal happens at PLANNING time, so no journal row is written', () => {
  const rec = db.getMigrationBySource(path.resolve(work));
  assert(rec === null || rec === undefined, `a refused plan must not be journalled, got ${JSON.stringify(rec)}`);
  assert(db.listInterruptedMigrations().length === 0, 'a refusal must not look like a crash window');
  assert(db.listMigrations(10).length === 0, `no journal rows expected yet, got ${db.listMigrations(10).length}`);
  return 'no row written';
});

// Release the lock and prove the same directory migrates cleanly afterwards.
holder.kill();
await new Promise((r) => setTimeout(r, 1500));

await check('after the holder exits, the same directory migrates and undoes cleanly', async () => {
  const moved = await migrateDirectory(work, { cfg, log: silentLog, db });
  assert(moved.ok, `migration should now succeed: ${moved.code} ${moved.reason}`);
  assert(moved.method === 'copy', `want copy method, got ${moved.method}`);
  assert(fs.lstatSync(work).isSymbolicLink(), 'source is not a junction');
  const targetPath = fs.readlinkSync(work);
  assert(countFiles(targetPath) === beforeCount, `target holds ${countFiles(targetPath)} of ${beforeCount}`);
  const undone = await undoMigration(work, { cfg, log: silentLog, db });
  assert(undone.ok, `undo should succeed: ${undone.code} ${undone.reason}`);
  assert(!fs.lstatSync(work).isSymbolicLink(), 'undo left a junction');
  assert(countFiles(work) === beforeCount, `undo restored ${countFiles(work)} of ${beforeCount}`);
  assert(!fs.existsSync(targetPath), 'undo left the target behind');
  const rec = db.getMigrationBySource(path.resolve(work));
  assert(rec.state === MIGRATION_STATE.RESTORED, `want RESTORED, got ${rec.state}`);
  return `${beforeCount} files round-tripped`;
});

// cleanup
try { holder.kill(); } catch { /* ignore */ }
try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(targetRoot, { recursive: true, force: true }); } catch { /* ignore */ }
try { db.close(); } catch { /* ignore */ }
try { fs.rmSync(dbPath, { force: true }); } catch { /* ignore */ }
try { fs.rmSync(psFile, { force: true }); } catch { /* ignore */ }

const fail = results.filter((r) => !r.ok).length;
console.log(`\nSUMMARY pass=${results.length - fail} fail=${fail} total=${results.length} verdict=${fail ? 'RED' : 'GREEN'}`);
process.exit(fail ? 1 : 0);
