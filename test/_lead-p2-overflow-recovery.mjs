/**
 * Overflow recovery: does the null-filename rescan actually recover the files a Windows
 * directory-buffer overflow dropped?
 *
 * MEASURED CONTEXT. A burst of 600 files into one directory makes a BARE `fs.watch` deliver only
 * ~418 named events (`test/_lead-overflow-signal.mjs`), and the live end-to-end probe tracked only
 * 205/800 -- so the loss happens below this plugin, inside `ReadDirectoryChangesW`'s finite
 * buffer. libuv announces the overflow as a `change` event with a NULL filename, and `_onEvent`
 * used to discard exactly that as "directory-level, nothing to classify".
 *
 * This probe drives the SHIPPED CWatcher with a CHILD-PROCESS writer (mandatory: a synchronous
 * write loop in the same process starves the event loop, which measures Node's loop rather than
 * the watcher -- a first version of the burst probe was wrong for exactly this reason).
 *
 * A CONTROL run with `rescanOnOverflow:false` must LOSE files. Without that control the probe
 * would pass even if the burst happened not to overflow, i.e. it would prove nothing.
 *
 * Rooted at %LOCALAPPDATA%\Temp deliberately: os.tmpdir() is redirected by the plugin's own env
 * hijack into the escape root, which is a protectRoot, so a probe there would test the protection
 * veto instead of the recovery path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const mod = await import(new URL('../lib/watcher.js', import.meta.url).href);
const { CWatcher } = mod;
const cfgMod = await import(new URL('../lib/config.js', import.meta.url).href);
const { resolveConfig } = cfgMod;

const tmpRoot = path.join(process.env.LOCALAPPDATA, 'Temp');
const dir = fs.mkdtempSync(path.join(tmpRoot, 'dshcc_recover_'));

const WRITER = `
import fs from 'node:fs';
import path from 'node:path';
const [dir, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i += 1) {
  fs.writeFileSync(path.join(dir, 'pip-rec-' + i + '.log'), Buffer.alloc(2048, 0x64));
}
`;
const writerPath = path.join(dir, 'writer.mjs');
fs.writeFileSync(writerPath, WRITER);

function runWriter(sub, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writerPath, sub, String(count)], { stdio: 'ignore' });
    child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`writer exit ${c}`))));
    child.on('error', reject);
  });
}

const COUNT = 600;
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`);
}

async function runMode(label, overrides, waitMs) {
  const sub = path.join(dir, label);
  fs.mkdirSync(sub, { recursive: true });
  const delivered = new Set();
  const cfg = {
    ...resolveConfig({}),
    watchDirs: [{ path: sub, recursive: false, maxDepth: 1 }],
    debounceMs: 50,
    ...overrides,
  };
  const watcher = new CWatcher({
    cfg,
    tree: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onCandidate: (c) => delivered.add(path.basename(c.path)),
  });
  watcher.start();
  await runWriter(sub, COUNT);
  await new Promise((r) => setTimeout(r, waitMs));
  const stats = watcher.stats();
  watcher.stop();
  const created = fs.readdirSync(sub).filter((f) => f.endsWith('.log')).length;
  return { created, delivered: delivered.size, stats };
}

// --- RECOVERY ON (the shipped default) -------------------------------------
const on = await runMode('on', {}, 12000);
console.log(
  `recovery ON : created ${on.created}, delivered ${on.delivered}, ` +
    `rescans ${on.stats.rescans}, rescanned ${on.stats.rescanned}`,
);
check('recovery ON delivers EVERY file despite the overflow', on.delivered === on.created,
  `delivered=${on.delivered}/${on.created}`);
check('recovery ON actually ran a rescan (the null event was acted on)', on.stats.rescans > 0,
  `rescans=${on.stats.rescans} rescanned=${on.stats.rescanned}`);

// --- CONTROL: recovery OFF must LOSE files, or the probe proves nothing -----
const off = await runMode('off', { rescanOnOverflow: false }, 12000);
console.log(
  `recovery OFF: created ${off.created}, delivered ${off.delivered}, rescans ${off.stats.rescans}`,
);
check('CONTROL recovery OFF loses files (so the burst really overflows here)',
  off.delivered < off.created, `delivered=${off.delivered}/${off.created}`);
check('CONTROL recovery OFF ran no rescan', off.stats.rescans === 0, `rescans=${off.stats.rescans}`);

// --- cooldown bounds a SUSTAINED storm -------------------------------------
// A single burst cannot test the cooldown: the quiet deadline alone coalesces repeated overflow
// events into one scan, so the cooldown check is never consulted (a mutation that deletes it
// SURVIVED until this check was added). The cooldown only earns its place across SEPARATED
// bursts -- each burst goes quiet for longer than `rescanSettleMs`, so without the cooldown every
// burst schedules its own walk. Three bursts, settle 300 ms, cooldown 60 s: exactly ONE walk.
{
  const sub = path.join(dir, 'storm');
  fs.mkdirSync(sub, { recursive: true });
  const delivered = new Set();
  const cfg = {
    ...resolveConfig({}),
    watchDirs: [{ path: sub, recursive: false, maxDepth: 1 }],
    debounceMs: 50,
    rescanSettleMs: 300,
    rescanCooldownMs: 60000,
  };
  const watcher = new CWatcher({
    cfg,
    tree: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onCandidate: (c) => delivered.add(path.basename(c.path)),
  });
  watcher.start();
  for (let burst = 0; burst < 3; burst += 1) {
    await runWriter(sub, COUNT);
    await new Promise((r) => setTimeout(r, 1200)); // go quiet past settleMs, well inside cooldown
  }
  const stats = watcher.stats();
  watcher.stop();
  check(
    'the cooldown bounds a SUSTAINED storm to ONE walk (3 separated bursts)',
    stats.rescans === 1,
    `rescans=${stats.rescans} over 3 separated ${COUNT}-file bursts with a 60 s cooldown`,
  );
}

// --- stop() cancels an in-flight rescan ------------------------------------
{
  const sub = path.join(dir, 'stopped');
  fs.mkdirSync(sub, { recursive: true });
  const cfg = {
    ...resolveConfig({}),
    watchDirs: [{ path: sub, recursive: false, maxDepth: 1 }],
    debounceMs: 50,
    rescanCooldownMs: 0,
  };
  const watcher = new CWatcher({
    cfg,
    tree: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onCandidate: () => {},
  });
  watcher.start();
  const run = runWriter(sub, COUNT);
  await new Promise((r) => setTimeout(r, 800));
  let threw = null;
  try { watcher.stop(); } catch (err) { threw = err; } // teardown while the burst is still arriving
  const afterStop = watcher.stats();
  await run;
  await new Promise((r) => setTimeout(r, 1500));
  check(
    'stop() during a burst does not throw and cancels the pending walk',
    threw === null && afterStop.rescans === 0,
    `threw=${threw ? threw.message : 'no'} rescans=${afterStop.rescans} (settleMs 5000 > the 800 ms stop, so no walk may run)`,
  );
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`);
console.log(`verdict=${failed.length === 0 ? 'OVERFLOW-RECOVERY-OK' : 'OVERFLOW-RECOVERY-BROKEN'}`);
process.exitCode = failed.length === 0 ? 0 : 1;
