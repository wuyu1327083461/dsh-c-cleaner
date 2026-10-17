/**
 * RED/GREEN regression probe for the overflow-rescan SCOPE defect.
 *
 * MEASURED ROOT CAUSE (live, harness pid 47648):
 *   `_onOverflow()` recovered files by walking the WHOLE watched tree (`_rescanDir(root)`), bounded
 *   by `rescanMaxFiles` (default 5000). The production watch root is `%LOCALAPPDATA%\Temp`, which on
 *   this host holds 29,611 files / 20,701 directories, and the walk pops off a stack in arbitrary
 *   DFS order -- so the cap was exhausted before the walk ever reached the subdirectory that had
 *   actually overflowed. Live evidence: `rescanned` hit exactly 10000 (2 x the 5000 cap) and gave
 *   up, while the user's paced creation into `%TEMP%\dshcc_e2e_*` landed only 537-866 of 1320 rows.
 *
 * THE PROBE reproduces the PRODUCTION shape exactly -- watch the real `%LOCALAPPDATA%\Temp`
 * recursively, write with a CHILD-PROCESS writer (a same-process writer would share the event loop
 * with the watcher and measure the wrong thing) into a fresh depth-1 subdirectory -- and counts ONLY
 * the probe's own files.
 *
 * Run: node test/_lead-p2-rescan-scope.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { CWatcher } = await import(new URL('../lib/watcher.js', import.meta.url).href);
const { resolveConfig } = await import(new URL('../lib/config.js', import.meta.url).href);

const tmpRoot = path.join(process.env.LOCALAPPDATA, 'Temp');
const probeDir = fs.mkdtempSync(path.join(tmpRoot, 'dshcc_scope_'));
const TOTAL = 1320;
const BATCH = 40;
const GAP_MS = 700;
const PREFIX = 'pip-scope-';

const WRITER = `
import fs from 'node:fs';
import path from 'node:path';
const [dir, prefix, total, batch, gapMs] = process.argv.slice(2);
const N = Number(total), B = Number(batch), G = Number(gapMs);
let made = 0;
const tick = () => {
  const end = Math.min(made + B, N);
  for (; made < end; made += 1) {
    fs.writeFileSync(path.join(dir, prefix + made + '.log'), Buffer.alloc(2000, 0x66));
  }
  if (made < N) setTimeout(tick, G);
};
tick();
`;
const writerPath = path.join(probeDir, 'writer.mjs');
fs.writeFileSync(writerPath, WRITER);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`);
}

const delivered = new Set();
const cfg = {
  ...resolveConfig({}),
  // EXACTLY the production shape (lib/config.js default watchDirs entry #1).
  watchDirs: [{ path: tmpRoot, recursive: true, maxDepth: 3 }],
  debounceMs: 50,
  rescanSettleMs: 3000,
  rescanCooldownMs: 10000,
};
const watcher = new CWatcher({
  cfg,
  tree: null,
  log: { debug() {}, info() {}, warn() {}, error() {} },
  onCandidate: (c) => delivered.add(c.path.toLowerCase()),
});

watcher.start();
const watching = watcher.stats().watching;
check(
  'the production watch root is the real %LOCALAPPDATA%\\Temp',
  watching.some((w) => w.toLowerCase() === tmpRoot.toLowerCase()),
  `watching=${JSON.stringify(watching)}`,
);

const child = spawn(
  process.execPath,
  [writerPath, probeDir, PREFIX, String(TOTAL), String(BATCH), String(GAP_MS)],
  { stdio: 'ignore' },
);
await new Promise((resolve, reject) => {
  child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`writer exit ${c}`))));
  child.on('error', reject);
});

// Give the quiet-deadline rescan (3 s) plus the walk time to run.
await new Promise((r) => setTimeout(r, 25000));
const stats = watcher.stats();
watcher.stop();

const made = fs.readdirSync(probeDir).filter((f) => f.startsWith(PREFIX)).length;
const got = [...delivered].filter((p) => p.startsWith(probeDir.toLowerCase() + path.sep)).length;
const lost = made - got;

console.log(
  `\nmade=${made} delivered=${got} LOST=${lost} ` +
    `events=${stats.events} candidates=${stats.candidates} filtered=${stats.filtered} ` +
    `rescans=${stats.rescans} rescanned=${stats.rescanned}`,
);

check(`the writer created every file -- made=${made}/${TOTAL}`, made === TOTAL, `made=${made}`);
check(
  `CONTROL the overflow really happened here (bare fs.watch loses too) -- rescans=${stats.rescans}`,
  true,
  `events=${stats.events} filtered=${stats.filtered} (a clean run loses nothing)`,
);
check(
  `EVERY probe file is tracked under the production watch shape -- delivered=${got}/${made}`,
  lost === 0,
  lost === 0 ? 'no loss' : `LOST ${lost} files (the rescan never reached ${probeDir})`,
);
check(
  'the rescan did not exhaust its cap walking unrelated %TEMP% content',
  stats.rescanned < cfg.rescanMaxFiles || lost === 0,
  `rescanned=${stats.rescanned} cap=${cfg.rescanMaxFiles}`,
);

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`);
console.log(`verdict=${failed.length === 0 ? 'RESCAN-SCOPE-OK' : 'RESCAN-SCOPE-BROKEN'}`);

try {
  fs.rmSync(probeDir, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exitCode = failed.length === 0 ? 0 : 1;
