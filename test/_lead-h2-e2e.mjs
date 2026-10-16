// Lead: END-TO-END proof of H2 — does a genuinely locked file end up with a real
// locked_by_pid in a state DB, through the production `apply()` wiring?
//
// PRD §3.3 requires the LOCKED_CRITICAL tier to surface the holding process NAME + PID.
// Before this change `locked_by_pid` was never populated by anything.
//
// Method: start a PowerShell holder that opens a file with FileShare.None (a real Win32
// lock), then run the plugin's apply() against a mock ctx with a temp DB and feed the
// locked file through onCandidate by copying it into a watched Temp directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-h2-proof-'));
const ESCAPE = path.join(ROOT, 'escape');
const STATE = path.join(ROOT, 'state');
const DB = path.join(STATE, 'state.db');
const WATCH = path.join(ROOT, 'watch');
fs.mkdirSync(WATCH, { recursive: true });

const mod = await import('../index.js');

console.log('=== setup ===');
console.log('  escape root :', ESCAPE);
console.log('  state db    :', DB);

// A PowerShell holder that CREATES a file and keeps a FileShare.None handle on it.
// It must create it: a lock that is already held cannot be re-written to generate the
// fs event the watcher needs, so the holder owns both the creation and the lock.
const victim = path.join(WATCH, 'held-by-powershell.tmp');
const ready = path.join(ROOT, 'watcher-ready.flag');
const holderScript = `
$p = '${victim.replace(/'/g, "''")}'
$flag = '${ready.replace(/'/g, "''")}'
# Wait until the plugin's watcher is up, so the CREATE event is actually observed.
$n = 0
while (-not (Test-Path $flag) -and $n -lt 200) { Start-Sleep -Milliseconds 100; $n++ }
[System.IO.File]::WriteAllText($p, 'locked payload')
$fs = [System.IO.File]::Open($p, 'Open', 'ReadWrite', 'None')
Write-Output ('HELD ' + $p)
Start-Sleep -Seconds 40
$fs.Close()
`;
const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', holderScript], {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const holderPid = holder.pid;
console.log('  holder      : powershell.exe pid', holderPid);

// The DB must exist before apply() so we can read it back after teardown.
fs.mkdirSync(STATE, { recursive: true });

const disposers = [];
const ctx = {
  effect(cb) {
    const d = cb();
    if (typeof d === 'function') disposers.push(d);
    return () => {};
  },
  on() {},
  get: () => undefined,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

const captured = [];
const fakeCtx = {
  ...ctx,
  // `registerCommands(ctx, deps)` reads `ctx.commands` as a service PROPERTY (not ctx.get).
  commands: {
    register(def) {
      captured.push(def);
      return () => {};
    },
  },
  get(name) {
    return name === 'commands' ? this.commands : undefined;
  },
};

// `cfg.escapeRoot`/`dbPath`/`watchDirs` must point into our sandbox, and the watcher must
// watch OUR directory so a real fs event produces the candidate.
mod.apply(fakeCtx, {
  escapeRoot: ESCAPE,
  stateDir: STATE,
  dbPath: DB,
  watchDirs: [{ path: WATCH, recursive: false, maxDepth: 1 }],
  debounceMs: 200,
  resolveLockOwner: true,
});

console.log('  command registered:', captured.map((c) => c.name).join(','));
console.log('  db exists after apply:', fs.existsSync(DB));

// Release the holder now that the watcher is armed, so its CREATE event is observed.
fs.writeFileSync(ready, 'go');
await new Promise((res) => {
  holder.stdout.on('data', (d) => String(d).includes('HELD') && res());
  setTimeout(res, 15000);
});
console.log('  victim created and locked:', fs.existsSync(victim));

console.log('\n=== waiting for watcher -> classify -> persist -> RM enrichment ===');
const deadline = Date.now() + 30000;
let row = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const db = new DatabaseSync(DB, { readOnly: true });
    const found = db.prepare('SELECT file_path, category, is_locked, locked_by_pid, source_process FROM tracked_files WHERE file_path = ?').all(victim);
    db.close();
    if (found.length && found[0].locked_by_pid) {
      row = found[0];
      break;
    }
    if (found.length) row = found[0];
  } catch {
    /* db may be locked by the writer; retry */
  }
}

console.log('\n=== RESULT: the persisted row for a genuinely locked file ===');
if (row) {
  console.log('  ' + JSON.stringify(row));
} else {
  console.log('  (no row found at all)');
}

const pass =
  row &&
  row.category === 'LOCKED_CRITICAL' &&
  Number(row.is_locked) === 1 &&
  row.locked_by_pid === holderPid;
console.log(`\n  holder pid expected : ${holderPid}`);
console.log(`  locked_by_pid actual: ${row ? row.locked_by_pid : 'n/a'}`);
console.log(`  source_process      : ${row ? row.source_process : 'n/a'}`);
console.log(pass ? '\nH2 PROOF: PASS' : '\nH2 PROOF: FAIL');

// teardown
for (const d of disposers) {
  try {
    d();
  } catch {}
}
try {
  holder.kill();
} catch {}
try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch {}
process.exit(pass ? 0 : 1);
