/**
 * Isolate the variable that makes the LIVE harness lose ~half of a paced creation.
 *
 * Measured so far (`test/_lead-p2-paced-loss.mjs`):
 *   QUIET  dedicated dir, recursive:false            -> 1320/1320 delivered, 0 lost
 *   PROD   real %TEMP%, recursive:true, files at ROOT -> 1320/1320 of the probe's own files
 * But the LIVE harness stored only 541-701 of 1320 when the probe wrote into a SUBDIRECTORY of
 * %TEMP% while the watcher used the production `recursive:true, maxDepth:3` shape.
 *
 * This probe holds pacing, writer and file count constant and varies ONE thing at a time:
 *   D0  files at the ROOT of the watched dir, recursive:false
 *   D1  files in a depth-1 SUBDIR,       recursive:false   <- would prove depth handling
 *   D2  files in a depth-1 SUBDIR,       recursive:true    <- the production shape
 *   D3  files in a depth-1 SUBDIR,       recursive:true, watching %TEMP% itself (real topology)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { CWatcher } = await import(new URL('../lib/watcher.js', import.meta.url).href);
const { resolveConfig } = await import(new URL('../lib/config.js', import.meta.url).href);

const tmpRoot = path.join(process.env.LOCALAPPDATA, 'Temp');
const root = fs.mkdtempSync(path.join(tmpRoot, 'dshcc_iso_'));
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });

const WRITER = `
import fs from 'node:fs';
import path from 'node:path';
const [dir, total, batch, gapMs] = process.argv.slice(2);
const N = Number(total), B = Number(batch), G = Number(gapMs);
let made = 0;
const tick = () => {
  const end = Math.min(made + B, N);
  for (; made < end; made += 1) {
    fs.writeFileSync(path.join(dir, 'pip-iso-' + made + '.log'), Buffer.alloc(2000, 0x66));
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

async function arm(label, watchDir, writeDir, recursive, maxDepth) {
  const delivered = new Set();
  const cfg = {
    ...resolveConfig({}),
    watchDirs: [{ path: watchDir, recursive, maxDepth }],
    debounceMs: 50,
    rescanSettleMs: 3000,
  };
  const watcher = new CWatcher({
    cfg,
    tree: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onCandidate: (c) => delivered.add(c.path),
  });
  watcher.start();
  const statsBefore = watcher.stats();
  await runWriter(writeDir, 1320, 40, 700);
  await new Promise((r) => setTimeout(r, 20000));
  const stats = watcher.stats();
  watcher.stop();
  const made = fs.readdirSync(writeDir).filter((f) => f.endsWith('.log')).length;
  const lost = made - delivered.size;
  console.log(
    `${label.padEnd(4)} recursive=${String(recursive).padEnd(5)} depth=${watchDir === writeDir ? 0 : 1} ` +
      `made=${made} delivered=${delivered.size} LOST=${lost} ` +
      `events=${stats.events} candidates=${stats.candidates} filtered=${stats.filtered} ` +
      `rescans=${stats.rescans} rescanned=${stats.rescanned} watching=${stats.watching.length}`,
  );
  return { made, delivered: delivered.size, lost, stats, watching: statsBefore.watching };
}

const d0 = await arm('D0', root, root, false, 1);
const d1 = await arm('D1', root, path.join(root, 'sub'), false, 1);
const d2 = await arm('D2', root, path.join(root, 'sub'), true, 3);
const d3 = await arm('D3', tmpRoot, path.join(root, 'sub'), true, 3);

console.log('');
for (const [k, a] of Object.entries({ D0: d0, D1: d1, D2: d2, D3: d3 })) {
  console.log(`${k}: watching=${JSON.stringify(a.watching)} LOST=${a.lost}/${a.made}`);
}
console.log('');
if (d1.lost > 0) console.log('=> DEPTH handling loses files: a depth-1 subdir under a NON-recursive watch is dropped.');
else console.log('=> non-recursive + depth-1 subdir is FINE (files at depth 1 are not watched at all unless recursive; check watching list).');
if (d2.lost > d0.lost) console.log('=> recursive:true itself loses files.');
if (d3.lost > d2.lost) console.log('=> watching the REAL %TEMP% (noise) loses files.');
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = 0;
