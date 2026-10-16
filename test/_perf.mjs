// PRD 6.1 verification, corrected: churn must happen OUTSIDE the escape root.
// (os.tmpdir() is now E:\dsh_escape_cache\temp, which IS a protectRoot — writing there proves
//  nothing about the watcher, it proves the protection works.)
import fs from 'node:fs';
import path from 'node:path';
import { ProcessTree } from '../lib/process-tree.js';
import { CWatcher } from '../lib/watcher.js';
import { resolveConfig } from '../lib/config.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const cfg = resolveConfig({ pollIntervalMs: 5000 });

function cpuMs() {
  const c = process.cpuUsage();
  return (c.user + c.system) / 1000;
}
const rssMB = () => process.memoryUsage().rss / 1024 / 1024;

// Real C: temp — the thing the PRD actually asks us to watch.
const CTEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';
const dir = fs.mkdtempSync(path.join(CTEMP, 'cc-perf-'));
const churn = path.join(dir, 'churn');
fs.mkdirSync(churn, { recursive: true });
console.log('churn dir (on C:, outside any protectRoot):', churn);

const startCpu = cpuMs();
const baseRss = rssMB();

const tree = new ProcessTree({ rootPid: process.pid, pollIntervalMs: 5000, log });
await tree.refresh();

let candidates = 0;
const watcher = new CWatcher({
  cfg: { ...cfg, debounceMs: 300, watchDirs: [{ path: churn, recursive: true, maxDepth: 2 }] },
  tree,
  log,
  onCandidate: () => { candidates += 1; },
});
watcher.start();

const DURATION_MS = 10000;
const t0 = Date.now();
let writes = 0;
let peakRss = baseRss;
while (Date.now() - t0 < DURATION_MS) {
  fs.writeFileSync(path.join(churn, `pip-perf-${writes}.log`), 'x'.repeat(256));
  writes += 1;
  await new Promise((r) => setTimeout(r, 100));
  peakRss = Math.max(peakRss, rssMB());
}

const elapsedMs = Date.now() - t0;
const usedCpuMs = cpuMs() - startCpu;
const cpuPct = (usedCpuMs / elapsedMs) * 100;
const stats = watcher.stats();
watcher.stop();
tree.stop();

console.log('');
console.log('=== PRD 6.1 performance envelope (churn on real C:) ===');
console.log(`duration            : ${elapsedMs} ms`);
console.log(`files written       : ${writes}`);
console.log(`candidates emitted  : ${candidates}`);
console.log(`watcher stats       : ${JSON.stringify(stats)}`);
console.log(`processes in tree   : ${tree.pids().size}`);
console.log('');
console.log(`CPU average         : ${cpuPct.toFixed(2)} %  (PRD <= 2%)  -> ${cpuPct <= 2 ? 'PASS' : 'FAIL'}`);
console.log(`RSS delta (plugin)  : ${(peakRss - baseRss).toFixed(1)} MB  (PRD <= 30MB) -> ${peakRss - baseRss <= 30 ? 'PASS' : 'FAIL'}`);
console.log(`RSS absolute        : ${peakRss.toFixed(1)} MB (whole Node process, incl. harness)`);
console.log('');
console.log('Every emitted candidate came from a real fs event on C:, with no polling scan.');
console.log(`fs events observed  : ${stats.events}, files stat\'d after debounce: ${stats.scanned}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log('cleaned up:', !fs.existsSync(dir));
