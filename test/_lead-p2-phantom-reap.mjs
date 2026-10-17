// Lead-owned probe: does the RAW-HANDLE registry actually reap a leaked watcher?
//
// The measured problem: `fs.watch(dir, {recursive:false, persistent:false})` + `unref()`
// makes the handle INVISIBLE to `process._getActiveHandles()` and
// `process.getActiveResourcesInfo()`, so a watcher leaked by a module generation that
// predates the instance registry can never be found by scanning — yet it keeps
// delivering. The cure under test is the process-global RAW registry
// (`Symbol.for('@local/dsh-c-cleaner.raw-watchers')`), which stores the raw
// `fs.FSWatcher` objects so ANY later generation can close them directly.
//
// The probe deliberately does NOT use CWatcher for the "leaked" watcher: it creates a
// raw fs.watch exactly the way a pre-registry generation would have, registers it, and
// then asks the SHIPPED `closeAllRawWatchers()` to reap it.
//
// RUN: node test/_lead-p2-phantom-reap.mjs
import fs from 'node:fs';
import path from 'node:path';
import { closeAllRawWatchers, rawWatcherCount } from '../lib/watcher.js';

const REAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';
const RAW_REG = Symbol.for('@local/dsh-c-cleaner.raw-watchers');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stamp = `${process.pid}_${Date.now().toString(36)}`;
const dir = path.join(REAL_TEMP, `dshcc_reap_${stamp}`);
fs.mkdirSync(dir, { recursive: true });

// ---- the "leaked" watcher: raw fs.watch with the plugin's exact options -------------
let delivered = 0;
const leaked = fs.watch(dir, { recursive: false, persistent: false }, () => {
  delivered += 1;
});
leaked.unref();

// A pre-registry generation could not have registered it, but the shipped code path
// (CWatcher.start) now does. Simulate the registration the shipped code performs.
const reg = globalThis[RAW_REG] instanceof Set ? globalThis[RAW_REG] : (globalThis[RAW_REG] = new Set());
reg.add(leaked);

check('raw registry holds the leaked handle', rawWatcherCount() === 1, `count=${rawWatcherCount()}`);

// It must NOT be discoverable by scanning (that is why the registry is needed).
const scanned = process._getActiveHandles().filter((h) => h?.constructor?.name === 'FSWatcher');
check(
  'the leaked handle is INVISIBLE to _getActiveHandles (why scanning cannot work)',
  scanned.length === 0,
  `FSWatcher found by scan=${scanned.length}`,
);

// Prove it is live BEFORE the reap.
fs.writeFileSync(path.join(dir, 'before.txt'), 'x');
await sleep(700);
check('leaked watcher is live before the reap', delivered > 0, `delivered=${delivered}`);

// ---- THE REAP: exactly what a new generation's apply() now calls --------------------
const before = delivered;
const closed = closeAllRawWatchers();
check('closeAllRawWatchers() reported the handle', closed === 1, `closed=${closed}`);
check('raw registry is empty after the reap', rawWatcherCount() === 0, `count=${rawWatcherCount()}`);

fs.writeFileSync(path.join(dir, 'after.txt'), 'x');
await sleep(700);
check(
  'leaked watcher STOPPED delivering after the reap (the actual cure)',
  delivered === before,
  `delivered before=${before} after=${delivered}`,
);

// ---- idempotence: a second sweep must be a harmless no-op --------------------------
const second = closeAllRawWatchers();
check('a second sweep is a harmless no-op', second === 0, `closed=${second}`);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`);
console.log(`verdict=${failed.length === 0 ? 'PHANTOM-REAPABLE' : 'REAP-FAILED'}`);
process.exitCode = failed.length === 0 ? 0 : 1;
