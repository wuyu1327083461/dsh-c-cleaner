/**
 * Why does PACED creation lose files?
 *
 * `test/_lead-e2e-scale.mjs` creates 1320 files in batches of 40 with 700 ms gaps, and the live
 * watcher tracked only 541-657 of them. My controlled burst probe recovers 600/600 with a single
 * child-process burst, so the question is whether the loss comes from the PACING itself or from
 * watching the real, noisy %TEMP% recursively.
 *
 * Two arms, identical pacing, identical child-process writer:
 *   QUIET  - one dedicated directory, `recursive:false` (what the recovery probe uses)
 *   PROD   - the real %LOCALAPPDATA%\Temp, `recursive:true, maxDepth:3` (the production default)
 *
 * The comparison decides whether this is a plugin defect or an OS/Temp-noise effect.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { CWatcher } = await import(new URL('../lib/watcher.js', import.meta.url).href);
const { resolveConfig } = await import(new URL('../lib/config.js', import.meta.url).href);

const tmpRoot = path.join(process.env.LOCALAPPDATA, 'Temp');
const root = fs.mkdtempSync(path.join(tmpRoot, 'dshcc_paced_'));

const WRITER = `
import fs from 'node:fs';
import path from 'node:path';
const [dir, total, batch, gapMs] = process.argv.slice(2);
const N = Number(total), B = Number(batch), G = Number(gapMs);
let made = 0;
const tick = () => {
  const end = Math.min(made + B, N);
  for (; made < end; made += 1) {
    fs.writeFileSync(path.join(dir, 'pip-paced-' + made + '.log'), Buffer.alloc(2000, 0x65));
  }
  if (made < N) setTimeout(tick, G);
};
tick();
`;
const writerPath = path.join(root, 'writer.mjs');
fs.writeFileSync(writerPath, WRITER);

function runWriter(sub, total, batch, gapMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writerPath, sub, String(total), String(batch), String(gapMs)], { stdio: 'ignore' });
    child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`writer exit ${c}`))));
    child.on('error', reject);
  });
}

async function arm(label, watchDir, recursive, maxDepth, settleMs) {
  const delivered = new Set();
  const cfg = {
    ...resolveConfig({}),
    watchDirs: [{ path: watchDir, recursive, maxDepth }],
    debounceMs: 50,
    rescanSettleMs: settleMs,
  };
  const watcher = new CWatcher({
    cfg,
    tree: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onCandidate: (c) => delivered.add(c.path),
  });
  watcher.start();
  await runWriter(watchDir, 1320, 40, 700);
  await new Promise((r) => setTimeout(r, 20000)); // settle + cooldown window
  const stats = watcher.stats();
  watcher.stop();
  const made = fs.existsSync(watchDir) ? fs.readdirSync(watchDir).filter((f) => f.endsWith('.log')).length : 0;
  console.log(
    `${label.padEnd(6)} recursive=${String(recursive).padEnd(5)} made=${made} delivered=${delivered.size} ` +
      `events=${stats.events} candidates=${stats.candidates} filtered=${stats.filtered} gated=${stats.gated} ` +
      `rescans=${stats.rescans} rescanned=${stats.rescanned} settle=${settleMs}`,
  );
  return { made, delivered: delivered.size, stats };
}

const quietDir = path.join(root, 'quiet');
fs.mkdirSync(quietDir, { recursive: true });
const quiet = await arm('QUIET', quietDir, false, 1, 3000);

const prod = await arm('PROD', tmpRoot, true, 3, 3000);

console.log('');
console.log(`QUIET loss: ${quiet.made - quiet.delivered} of ${quiet.made}`);
console.log(`PROD  loss: ${prod.made - prod.delivered} of ${prod.made} (real %TEMP%, recursive, includes all other software churn)`);
console.log(quiet.delivered === quiet.made ? 'QUIET: paced creation loses NOTHING in a dedicated dir' : 'QUIET: paced creation LOSES files even in a dedicated dir');
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = 0;
