// PRD 6.1: isolate the PLUGIN's marginal CPU. The test harness's own synchronous writes are
// not the plugin's cost, so run the identical workload twice: once with no watcher (baseline),
// once with the watcher attached. Report the delta.
import fs from 'node:fs';
import path from 'node:path';
import { ProcessTree } from '../lib/process-tree.js';
import { CWatcher } from '../lib/watcher.js';
import { resolveConfig } from '../lib/config.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const cfg = resolveConfig({ pollIntervalMs: 5000 });
const CTEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';

function cpuMs() {
  const c = process.cpuUsage();
  return (c.user + c.system) / 1000;
}

async function run({ withWatcher, label }) {
  const dir = fs.mkdtempSync(path.join(CTEMP, 'cc-cpu-'));
  const churn = path.join(dir, 'churn');
  fs.mkdirSync(churn, { recursive: true });

  const tree = new ProcessTree({ rootPid: process.pid, pollIntervalMs: 5000, log });
  await tree.refresh();

  let candidates = 0;
  let watcher = null;
  if (withWatcher) {
    watcher = new CWatcher({
      cfg: { ...cfg, debounceMs: 300, watchDirs: [{ path: churn, recursive: true, maxDepth: 2 }] },
      tree, log, onCandidate: () => { candidates += 1; },
    });
    watcher.start();
  }

  const startCpu = cpuMs();
  const t0 = Date.now();
  let writes = 0;
  while (Date.now() - t0 < 10000) {
    fs.writeFileSync(path.join(churn, `pip-cpu-${writes}.log`), 'x'.repeat(256));
    writes += 1;
    await new Promise((r) => setTimeout(r, 100));
  }
  const elapsed = Date.now() - t0;
  const used = cpuMs() - startCpu;
  const stats = watcher ? watcher.stats() : null;
  watcher?.stop();
  tree.stop();
  fs.rmSync(dir, { recursive: true, force: true });

  return { label, elapsed, writes, used, candidates, stats };
}

const base = await run({ withWatcher: false, label: 'baseline (no watcher)' });
const withW = await run({ withWatcher: true, label: 'with watcher' });

const basePct = (base.used / base.elapsed) * 100;
const withPct = (withW.used / withW.elapsed) * 100;
const marginalMs = withW.used - base.used;
const marginalPct = (marginalMs / withW.elapsed) * 100;

console.log('=== PRD 6.1 CPU, isolated from the test harness\'s own I/O ===');
console.log(`baseline : ${base.elapsed}ms, ${base.writes} writes, cpu ${base.used.toFixed(1)}ms => ${basePct.toFixed(2)}%`);
console.log(`watcher  : ${withW.elapsed}ms, ${withW.writes} writes, cpu ${withW.used.toFixed(1)}ms => ${withPct.toFixed(2)}%`);
console.log(`           candidates emitted = ${withW.candidates}, stats = ${JSON.stringify(withW.stats)}`);
console.log('');
console.log(`PLUGIN MARGINAL CPU : ${marginalMs.toFixed(1)} ms over ${withW.elapsed} ms`);
console.log(`                    = ${marginalPct.toFixed(2)} %   (PRD <= 2%) -> ${marginalPct <= 2 ? 'PASS' : 'FAIL'}`);
console.log('');
console.log('The absolute figure includes fs.writeFileSync of 100 files by the harness itself,');
console.log('which the plugin does not cause. The marginal figure is the plugin\'s true cost.');
