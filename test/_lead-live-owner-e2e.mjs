// Lead probe: is the LIVE harness process running the version of index.js that resolves lock
// owners? It can only be answered from outside the harness: create a file that is genuinely
// locked (FileShare.None holder in another process), let the LIVE plugin classify it through its
// own watcher, then read the live DB row.
//
//   row.locked_by_pid != null  -> the live generation includes the LockOwnerResolver wiring
//   row.locked_by_pid == null and is_locked == 1 -> still the pre-17:58 generation (old module graph)
//
// It refuses to report a verdict unless the lock is verified held first, and always cleans up.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB = 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';
const TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';
const dir = path.join(TEMP, `dshcc_liveown_${process.pid}`);
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, 'held-exclusively.tmp');
fs.writeFileSync(target, 'lead live owner probe\n');

// Holder: PowerShell holds a real FileShare.None handle so openSync('r+') must fail EBUSY.
const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
  $p = ${JSON.stringify(target)}
  $fs = [System.IO.File]::Open($p, 'Open', 'ReadWrite', 'None')
  Write-Output "HOLDING:$PID"
  Start-Sleep -Seconds 60
  $fs.Close()
`], { stdio: ['ignore', 'pipe', 'pipe'] });

let holderLine = '';
ps.stdout.on('data', (b) => { holderLine += b.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  // Wait for the holder to actually take the handle.
  for (let i = 0; i < 40 && !/HOLDING:/.test(holderLine); i += 1) await sleep(250);
  const holderPid = (holderLine.match(/HOLDING:(\d+)/) || [])[1];
  if (!holderPid) {
    console.log('PROBE ABORT (exit 2): holder never reported HOLDING — cannot judge anything.');
    ps.kill();
    process.exit(2);
  }

  // Positive control: prove the lock is real before judging the plugin.
  let lockObserved = false;
  try { fs.openSync(target, 'r+'); } catch (err) { lockObserved = err.code === 'EBUSY' || err.code === 'EPERM'; }
  console.log(`holder pid ${holderPid} | openSync('r+') on the held file -> ${lockObserved ? 'EBUSY (lock is REAL)' : 'NO THROW (lock is NOT exclusive — aborting)'}`);
  if (!lockObserved) {
    console.log('PROBE ABORT (exit 2): instrument cannot detect the lock; refusing to report a verdict.');
    ps.kill();
    process.exit(2);
  }

  // Give the LIVE plugin: watcher debounce (cfg.debounceMs 3000) + classify + upsert +
  // LockOwnerResolver batch window (250 ms) + one PowerShell spawn/Add-Type (~3.5 s).
  console.log('waiting ~14s for the live plugin to classify and enrich the row ...');
  await sleep(14000);

  const db = new DatabaseSync(DB, { readOnly: true });
  const row = db.prepare('SELECT file_path, category, is_locked, locked_by_pid, source_process, last_checked_at FROM tracked_files WHERE file_path = ?').get(target);
  const total = db.prepare('SELECT COUNT(*) c FROM tracked_files')[0] ?? db.prepare('SELECT COUNT(*) AS c FROM tracked_files').get();
  db.close();

  console.log('--- live DB row for the locked file ---');
  console.log(row ? JSON.stringify(row, null, 1) : '(no row at all)');
  console.log(`row count now: ${total.c}`);

  let verdict;
  if (!row) verdict = 'NO ROW — the live watcher did not persist this candidate (inconclusive for the owner question).';
  else if (row.locked_by_pid != null) verdict = `LIVE GENERATION HAS THE OWNER RESOLVER: locked_by_pid=${row.locked_by_pid}, source_process=${row.source_process}`;
  else if (row.is_locked) verdict = 'LIVE GENERATION IS STALE: the row is locked (is_locked=1) but locked_by_pid is null, so the running process still holds the pre-change module graph.';
  else verdict = 'inconclusive: the row is not even marked locked.';
  console.log(`\nVERDICT: ${verdict}`);

  ps.kill();
  await sleep(500);
  try { fs.rmSync(dir, { recursive: true, force: true }); console.log(`cleanup: ${fs.existsSync(dir) ? 'FAILED' : 'removed ' + dir}`); }
  catch (err) { console.log(`cleanup failed: ${err.message}`); }
  process.exit(0);
};

main();
