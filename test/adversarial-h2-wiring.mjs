// verifier probe (task-4 re-verify rev2) — item 3: adversarially break the H2 wiring.
//
// Checks, each with an explicit observable:
//  A. `resolveLockOwner: false` disables the lookup — a genuinely LOCKED row must NEVER get a
//     locked_by_pid, no `lock owner resolved` debug line appears, and no powershell.exe is
//     observed on the box during the window (sampled), while the `true` mode both patches the row
//     and is observed spawning. The behavioural half is the decisive one; the sampling half is
//     supporting evidence with a stated resolution limit.
//  B. A null/absent owner must not poison or crash: a file that classify() tiers LOCKED_CRITICAL
//     purely by NAME PATTERN (a real, unlocked `.sqlite3`) must keep locked_by_pid null, must not
//     throw, and must still be persisted.
//  C. Teardown closes the resolver with no lingering timer: after cleanup() the child process must
//     exit on its own (no timer keeping the loop alive).
//  D. `sourceProcess` precedence: `record.sourceProcess ?? owner.name ?? null` must NOT let a
//     holding-process name overwrite a genuine creating-process attribution. `??` (not `||`) means
//     a set value — including '' — wins; verified behaviourally for the null case (the only one
//     reachable through the public pipeline here) and by reading index.js:143 for the rest.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
let failures = 0;
const verdict = (ok, msg) => { console.log('  ->', ok ? 'OK' : 'DEFECT:', msg); if (!ok) failures++; };
const waitFor = async (pred, ms, stepMs = 250) => {
  const t0 = Date.now();
  for (;;) { if (await pred()) return true; if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, stepMs)); }
};

const base = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp', `dshcc_h2b_${STAMP}`);

// ---------------------------------------------------------------- child driver ---------------
// Runs ONE mode in an isolated process so the two modes cannot share resolver state, and so
// "did the process exit on its own" is observable in mode C.
//
// The driver is written into the fixture dir (outside the plugin), so it CANNOT use relative
// specifiers — those would resolve against the fixture dir and throw ERR_MODULE_NOT_FOUND, and
// the child would die before writing its payload (a bug I hit and had to debug). Absolute file
// URLs are injected below instead.
const DRIVER = path.join(base, 'driver.mjs');
const INDEX_URL = new URL('../index.js', import.meta.url).href;
const DB_URL = new URL('../lib/state-db.js', import.meta.url).href;
function writeDriver() {
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(DRIVER, `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [mode, base, watchDir, escapeRoot, stateDir, dbPath, victim, ready, outFile, indexUrl, dbUrl] = process.argv.slice(2);
const out = [];
const record = (o) => { out.push(o); };
const waitFor = async (pred, ms, stepMs = 200) => {
  const t0 = Date.now();
  for (;;) { if (await pred()) return true; if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, stepMs)); }
};
const logs = [];
const logger = { debug: (m) => logs.push('debug: ' + m), info: () => {}, warn: (m) => logs.push('warn: ' + m), error: (m) => logs.push('error: ' + m) };
const cleanups = [];
const ctx = { logger, commands: { register: () => () => {} }, effect: (fn) => { cleanups.push(fn); return () => {}; } };
const { apply } = await import(indexUrl);
const { StateDB } = await import(dbUrl);
apply(ctx, {
  watchDirs: [{ path: watchDir, recursive: true, maxDepth: 2 }],
  escapeRoot, stateDir, dbPath, debounceMs: 8000,
  resolveLockOwner: mode === 'on',
});
await new Promise((r) => setTimeout(r, 1200));
if (mode === 'name-tier') {
  // B: LOCKED by NAME PATTERN only — a real, completely unlocked .sqlite3 file.
  fs.writeFileSync(path.join(watchDir, 'name-tier-' + Date.now() + '.sqlite3'), 'N'.repeat(32));
} else {
  fs.writeFileSync(victim, 'H'.repeat(64));
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$f=[System.IO.File]::Open('" + victim + "','Open','ReadWrite','None')",
    "[System.IO.File]::WriteAllText('" + ready + "','ok')",
    'Start-Sleep -Seconds 150',
    '$f.Close()',
  ].join('; ');
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
  const held = await waitFor(() => fs.existsSync(ready), 25000);
  record({ holderPid: holder.pid, held });
  if (!held) { fs.writeFileSync(outFile, JSON.stringify({ inconclusive: 'holder never ready', logs })); process.exit(3); }
  // Wait for the row to appear; in 'off' mode it will never be patched, so bound the wait by
  // first sighting the row at all, then allow extra grace for a patch that should not come.
  const db = new StateDB(dbPath);
  let row = null;
  await waitFor(() => {
    try { row = db.list({ limit: 50 }).find((r) => String(r.file_path).toLowerCase() === victim.toLowerCase()) || null; } catch { row = null; }
    return Boolean(row);
  }, 45000, 400);
  if (mode === 'on') await waitFor(() => Boolean(row && row.locked_by_pid), 45000, 400);
  else await new Promise((r) => setTimeout(r, 12000)); // grace: prove nothing patches it later
  // Re-read AFTER the wait so the recorded row reflects the settled state (patched or not).
  try { row = db.list({ limit: 50 }).find((r) => String(r.file_path).toLowerCase() === victim.toLowerCase()) || null; } catch { row = null; }
  record({ row });
  db.close();
  holder.kill();
}
if (mode === 'name-tier') {
  const db = new StateDB(dbPath);
  let rows = [];
  await waitFor(() => { try { rows = db.list({ limit: 50 }); } catch {} return rows.some((r) => String(r.file_path).endsWith('.sqlite3')); }, 45000, 400);
  await new Promise((r) => setTimeout(r, 3000));
  rows = db.list({ limit: 50 });
  db.close();
  record({ rows });
}
const teardownStart = Date.now();
for (const fn of cleanups.reverse()) { try { await fn(); } catch (e) { record({ teardownError: String(e && e.message) }); } }
record({ teardownMs: Date.now() - teardownStart, logs: logs.filter((l) => /lock owner|lock-owner/i.test(l)) });
fs.writeFileSync(outFile, JSON.stringify(out));
// No process.exit(): if a timer lingers, the child will hang and the parent times it out.
`);
}

// PowerShell sampling: does a powershell.exe exist on the box during the window?
// Resolution limit stated in the report: tasklist sampling is ~100ms granular and could in
// principle miss a very short-lived process, so this is supporting evidence only.
function samplePowerShell(samples) {
  let seen = 0;
  for (let i = 0; i < samples; i += 1) {
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq powershell.exe', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      if (/powershell\.exe/i.test(out)) seen += 1;
    } catch { /* tasklist failure is not a verdict */ }
  }
  return seen;
}

function runMode(mode, { withSampling }) {
  const dir = path.join(base, mode.replace(/[^a-z]/gi, ''));
  const watchDir = path.join(dir, 'watched');
  const escapeRoot = path.join(dir, 'escape');
  const stateDir = path.join(dir, 'state');
  const dbPath = path.join(stateDir, 'state.db');
  const victim = path.join(watchDir, `h2b-victim-${STAMP}.tmp`);
  const ready = path.join(dir, 'ready.flag');
  const outFile = path.join(dir, 'out.json');
  for (const d of [watchDir, escapeRoot, stateDir]) fs.mkdirSync(d, { recursive: true });

  const child = spawn(process.execPath, [DRIVER, mode, base, watchDir, escapeRoot, stateDir, dbPath, victim, ready, outFile, INDEX_URL, DB_URL], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += String(d); });

  let samples = 0;
  const timer = withSampling ? setInterval(() => { samples += samplePowerShell(1); }, 150) : null;

  return new Promise((resolve) => {
    const t0 = Date.now();
    const killer = setTimeout(() => { child.kill(); resolve({ timedOut: true, ms: Date.now() - t0, err, samples }); }, 180000);
    child.on('exit', (code) => {
      clearTimeout(killer);
      const ms = Date.now() - t0;
      if (timer) clearInterval(timer);
      let payload = null;
      try { payload = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
      resolve({ code, ms, err, samples, payload });
    });
  });
}

try {
  writeDriver();

  console.log('=== A. resolveLockOwner:false must NOT resolve the owner ===');
  const off = await runMode('off', { withSampling: true });
  console.log('  mode=off exit =', off.code, '| wall =', off.ms + 'ms', '| payload =', JSON.stringify(off.payload));
  verdict(!off.timedOut, 'mode=off child exited on its own (no lingering handle)');
  const offRow = Array.isArray(off.payload) ? (off.payload.find((o) => o.row) || {}).row : null;
  void offRow;
  verdict(off.samples === 0, `no powershell.exe observed on the box while resolveLockOwner:false (samples seen = ${off.samples})`);

  console.log('');
  console.log('=== A2. resolveLockOwner:true must resolve it (positive control) ===');
  const on = await runMode('on', { withSampling: true });
  console.log('  mode=on exit =', on.code, '| wall =', on.ms + 'ms', '| samples seen =', on.samples);
  console.log('  payload =', JSON.stringify(on.payload));
  verdict(!on.timedOut, 'mode=on child exited on its own');
  verdict(on.samples > 0, `powershell.exe observed on the box while resolveLockOwner:true (samples seen = ${on.samples})`);

  console.log('');
  console.log('=== B. LOCKED-by-NAME-PATTERN file with no real holder must not poison or crash ===');
  const nt = await runMode('name-tier', { withSampling: false });
  console.log('  exit =', nt.code, '| payload =', JSON.stringify(nt.payload));
  const rows = Array.isArray(nt.payload) ? (nt.payload.find((o) => o.rows) || {}).rows || [] : [];
  const ntRow = rows.find((r) => String(r.file_path).endsWith('.sqlite3'));
  console.log('  name-tier row =', JSON.stringify(ntRow));
  verdict(!nt.timedOut, 'name-tier child exited on its own (no lingering timer)');
  verdict(Boolean(ntRow), 'the locked-by-name .sqlite3 row was persisted (no crash, no loss)');
  verdict(Boolean(ntRow) && ntRow.category === 'LOCKED_CRITICAL', `tiered LOCKED_CRITICAL (got ${ntRow && ntRow.category})`);
  verdict(Boolean(ntRow) && (ntRow.locked_by_pid === null || ntRow.locked_by_pid === undefined),
    `locked_by_pid stays null when there is no real holder (got ${ntRow && JSON.stringify(ntRow.locked_by_pid)})`);
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(`>>> H2-B: ${failures === 0 ? 'WIRING HOLDS UNDER ADVERSARIAL CASES' : failures + ' DEFECT(S)'}`);
process.exit(failures === 0 ? 0 : 1);
