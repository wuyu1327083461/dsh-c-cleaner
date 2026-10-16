// verifier probe (task-4 re-verify rev2) — H2 END-TO-END, written independently of lead's script.
//
// Claim under test (lead message, item 1): the Windows Restart Manager resolver is REACHABLE FROM
// PRODUCTION WIRING — i.e. index.js apply() -> onCandidate -> enrichOwner -> LockOwnerResolver ->
// db.upsert patches a real holder PID into the persisted row. Testing lib/lock-owner.js in
// isolation would NOT prove that, so this probe drives apply() itself and reads the row back out
// of the plugin's OWN state.db.
//
// ORDER MATTERS (a bug I hit first time): CWatcher does NOT scan at start() — it only reacts to
// fs.watch events. A victim created BEFORE apply() is therefore never seen and the probe would
// report a phantom defect. So: start apply() first, then create the victim, then lock it.
//
// Self-reports `inconclusive` (never a vacuous pass) if PowerShell or a genuine exclusive handle
// is unavailable on this host.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const STAMP = `${process.pid}_${Date.now().toString(36)}`;

let failures = 0;
const verdict = (ok, msg) => { console.log('  ->', ok ? 'OK' : 'DEFECT:', msg); if (!ok) failures++; };
const waitFor = async (pred, ms, stepMs = 250) => {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
};

// Fixture lives in %LOCALAPPDATA%\Temp (never the escape root, so the watcher treats it as an escape).
const base = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp', `dshcc_h2e2e_${STAMP}`);
const watchDir = path.join(base, 'watched');
const escapeRoot = path.join(base, 'escape');
const stateDir = path.join(base, 'state');
fs.mkdirSync(watchDir, { recursive: true });
fs.mkdirSync(escapeRoot, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
if (base.includes(' ')) { console.log('SKIP: fixture path contains a space; -Command quoting would need rework'); process.exit(0); }

const victim = path.join(watchDir, `h2-victim-${STAMP}.tmp`);
const ready = path.join(base, `dcc-ready-${STAMP}`); // OUTSIDE watchDir, so it is never a candidate

console.log('=== fixtures ===');
console.log('  watchDir =', watchDir);
console.log('  victim   =', victim, '(created AFTER apply())');

const silent = { debug: (...a) => console.log("   [debug]", ...a), info: (...a) => console.log("   [info]", ...a), warn: (...a) => console.log("   [warn]", ...a), error: (...a) => console.log("   [error]", ...a) };
const cleanups = [];
const ctx = {
  logger: silent,
  commands: { register: () => () => {} },
  effect: (fn) => { cleanups.push(fn); return () => {}; },
};

let holder = null;
let holderErr = '';

try {
  const { apply } = await import('../index.js');
  const { StateDB } = await import('../lib/state-db.js');
  const dbPath = path.join(stateDir, 'state.db');

  // A long debounce buys PowerShell time to take the handle before classify() runs.
  apply(ctx, {
    watchDirs: [{ path: watchDir, recursive: true, maxDepth: 2 }],
    escapeRoot,
    stateDir,
    dbPath,
    debounceMs: 8000,
    resolveLockOwner: true,
  });
  console.log('=== apply() started (production wiring) ===');

  // Let the fs.watch handle arm before creating anything it must observe.
  await new Promise((r) => setTimeout(r, 1200));

  // --- create the victim, then immediately take a REAL exclusive handle from a LIVE child ----
  fs.writeFileSync(victim, 'H'.repeat(64));
  const psBody = [
    `$ErrorActionPreference='Stop'`,
    `$f=[System.IO.File]::Open('${victim}','Open','ReadWrite','None')`,
    `[System.IO.File]::WriteAllText('${ready}','ok')`,
    `Start-Sleep -Seconds 150`,
    `$f.Close()`,
  ].join('; ');
  holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psBody], { windowsHide: true });
  holder.stderr.on('data', (d) => { holderErr += String(d); });

  const held = await waitFor(() => fs.existsSync(ready), 25000);
  if (!held) {
    console.log(`INCONCLUSIVE: PowerShell could not take an exclusive handle (stderr=${JSON.stringify(holderErr.slice(0, 300))})`);
    console.log('>>> H2 E2E: inconclusive');
    process.exit(0);
  }
  console.log('=== holder ===');
  console.log('  holder pid =', holder.pid, '| exclusive handle confirmed');

  let probeOpen = 'opened (NOT locked)';
  try { const fd = fs.openSync(victim, 'r+'); fs.closeSync(fd); } catch (e) { probeOpen = `threw ${e.code}`; }
  console.log('  local openSync r+ =', probeOpen);
  if (!probeOpen.startsWith('threw')) {
    console.log('INCONCLUSIVE: the exclusive handle did not take effect, so "locked" cannot be asserted');
    console.log('>>> H2 E2E: inconclusive');
    process.exit(0);
  }

  // --- read the row back from the plugin's OWN db ---------------------------------------------
  const db = new StateDB(dbPath);
  let row = null;
  let lastRows = [];
  const found = await waitFor(() => {
    try {
      lastRows = db.list({ limit: 50 });
      row = lastRows.find((r) => String(r.file_path).toLowerCase() === victim.toLowerCase()) || null;
    } catch { row = null; }
    return Boolean(row && row.locked_by_pid);
  }, 90000, 500);

  console.log('=== persisted row ===');
  console.log('  row count =', lastRows.length);
  for (const r of lastRows) console.log('   row:', JSON.stringify(r));
  if (row) console.log('  matched row =', JSON.stringify(row));

  verdict(found, 'production wiring persisted a LOCKED row carrying a real holder pid within the bounded wait');
  verdict(Boolean(row) && row.category === 'LOCKED_CRITICAL', `the row is tiered LOCKED_CRITICAL (got ${row && row.category})`);
  verdict(Boolean(row) && Number(row.locked_by_pid) === Number(holder.pid),
    `locked_by_pid equals the REAL holder pid (expected ${holder.pid}, got ${row && row.locked_by_pid})`);
  verdict(Boolean(row) && typeof row.source_process === 'string' && row.source_process.length > 0,
    `source_process names a holder process (got ${row && JSON.stringify(row.source_process)})`);

  db.close();
} finally {
  try { holder?.kill(); } catch {}
  for (const fn of cleanups.reverse()) { try { await fn(); } catch {} }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(`>>> H2 E2E: ${failures === 0 ? 'PRODUCTION WIRING PROVEN' : failures + ' DEFECT(S)'}`);
process.exit(failures === 0 ? 0 : 1);
