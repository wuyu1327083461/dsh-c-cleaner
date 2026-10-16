// Lead: mimic adversarial-h2-e2e.mjs EXACTLY (debounce 8000 + a real exclusive handle) but with a
// VERBOSE logger, to find out whether the zero rows come from the lock, the long debounce, or the
// config. My 2s-debounce diag persisted 1 row fine, so one of these two deltas is the trigger.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEBOUNCE = Number(process.env.CC_DEBOUNCE || 8000);
const USE_LOCK = process.env.CC_LOCK !== '0';
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const base = path.join(process.env.LOCALAPPDATA || process.cwd(), 'Temp', `dshcc_mimic_${STAMP}`);
const watchDir = path.join(base, 'watched');
const escapeRoot = path.join(base, 'escape');
const stateDir = path.join(base, 'state');
for (const d of [watchDir, escapeRoot, stateDir]) fs.mkdirSync(d, { recursive: true });
const dbPath = path.join(stateDir, 'state.db');
console.log(`debounce=${DEBOUNCE} useLock=${USE_LOCK}\nwatchDir=${watchDir}`);

const lines = [];
const mk = (lvl) => (...a) => { const s = `[${lvl}] ${a.join(' ')}`; lines.push(s); };
const log = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };

const cleanups = [];
const ctx = {
  logger: log,
  commands: { register: () => () => {} },
  effect: (fn) => { cleanups.push(fn); return () => {}; },
};

const { apply } = await import('../index.js');
const { StateDB } = await import('../lib/state-db.js');

apply(ctx, { watchDirs: [{ path: watchDir, recursive: true, maxDepth: 2 }], escapeRoot, stateDir, dbPath, debounceMs: DEBOUNCE, resolveLockOwner: true });
await new Promise((r) => setTimeout(r, 1200));

const victim = path.join(watchDir, `h2-victim-${STAMP}.tmp`);
fs.writeFileSync(victim, 'H'.repeat(64));
console.log('victim written:', path.basename(victim));

let holder = null;
if (USE_LOCK) {
  const ready = path.join(base, `dcc-ready-${STAMP}`);
  holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ErrorActionPreference='Stop';$f=[System.IO.File]::Open('${victim}','Open','ReadWrite','None');[System.IO.File]::WriteAllText('${ready}','ok');Start-Sleep -Seconds 120;$f.Close()`],
    { windowsHide: true });
  const t0 = Date.now();
  while (!fs.existsSync(ready) && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
  console.log('exclusive handle ready:', fs.existsSync(ready));
  try { const fd = fs.openSync(victim, 'r+'); fs.closeSync(fd); console.log('openSync r+: opened (NOT locked!)'); }
  catch (e) { console.log('openSync r+: threw', e.code); }
}

// Poll the db exactly like the verifier's test does.
const db = new StateDB(dbPath);
let lastRows = [];
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  try { lastRows = db.list({ limit: 50 }); } catch (e) { console.log('list threw', e.message); }
  if (lastRows.length > 0) break;
}
console.log(`\n=== after ${'poll'} : rows = ${lastRows.length} ===`);
for (const r of lastRows) console.log('  ', JSON.stringify({ p: path.basename(r.file_path), cat: r.category, pid: r.locked_by_pid, sp: r.source_process }));

console.log('\n=== plugin log ===');
for (const l of lines) console.log('  ', l);

db.close();
try { holder?.kill(); } catch {}
for (const fn of cleanups.reverse()) { try { await fn(); } catch {} }
try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
setTimeout(() => process.exit(0), 500);
