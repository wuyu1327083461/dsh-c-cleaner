// verifier probe: PRD NFR 6.1 — "CPU < 2%, RAM < 30MB".
// Independent measurement with a CONTROL phase so the harness's own write cost is excluded:
//   phase A: churn with NO watcher            -> cpuControl  (harness write cost)
//   phase B: watcher running, same churn      -> cpuWatched  (harness + watcher)
//   watcher CPU = cpuWatched - cpuControl
//   phase C: watcher running, idle 3s         -> background/poll cost
// RAM is reported as the RSS delta across watcher construction+start (absolute RSS includes node itself).
import fs from 'node:fs';
import path from 'node:path';

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const mod = await import('../index.js');
const { resolveConfig } = await import('../lib/config.js');
const { CWatcher } = await import('../lib/watcher.js');

const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const cfg = resolveConfig({});

// Churn inside a REAL watched dir (default watchDirs[0] = %LOCALAPPDATA%\Temp, recursive, maxDepth 3).
const watchRoot = cfg.watchDirs[0].path;
const fixtureDir = fs.mkdtempSync(path.join(watchRoot, `dcc_perf_fix_${STAMP}_`));
console.log('watchRoot  =', JSON.stringify(watchRoot));
console.log('fixtureDir =', JSON.stringify(fixtureDir));
console.log('NFR 6.1 budgets: CPU < 2%, RAM < 30 MB');
console.log('');

async function phase(label, ms, churn) {
  const c0 = process.cpuUsage();
  const t0 = Date.now();
  let writes = 0;
  while (Date.now() - t0 < ms) {
    if (churn) {
      try {
        fs.writeFileSync(path.join(fixtureDir, `churn_${writes % 20}.tmp`), 'x'.repeat(256));
        writes++;
      } catch {}
      await new Promise((r) => setTimeout(r, 25));
    } else {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const wall = Date.now() - t0;
  const cpu = process.cpuUsage(c0);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const cpuPct = (cpuMs / wall) * 100;
  const rssMB = process.memoryUsage().rss / 1024 / 1024;
  console.log(`${label}: wall=${wall}ms cpu=${cpuMs.toFixed(0)}ms (${cpuPct.toFixed(3)}%) rss=${rssMB.toFixed(1)}MB writes=${writes}`);
  return { cpuMs, cpuPct, rssMB, wall, writes };
}

// ---- CONTROL: churn with no watcher ----
const control = await phase('CONTROL churn (no watcher) ', 3000, true);

// ---- RAM baseline ----
const rssBefore = process.memoryUsage().rss / 1024 / 1024;

// ---- WATCHER: same churn ----
const hits = [];
const w = new CWatcher({
  cfg,
  tree: { ownerOf: () => null, nameOf: () => null },
  log: LOG,
  onCandidate: (c) => hits.push(c.path),
});
w.start();
const rssAfterStart = process.memoryUsage().rss / 1024 / 1024;
const watched = await phase('WATCHER churn (recursive) ', 3000, true);
const idle = await phase('WATCHER idle               ', 3000, false);
w.stop();

const watcherCpuMs = Math.max(0, watched.cpuMs - control.cpuMs);
const watcherCpuPct = (watcherCpuMs / watched.wall) * 100;
const rssDeltaMB = rssAfterStart - rssBefore;
const idleRssMB = idle.rssMB;

console.log('');
console.log('stats       =', JSON.stringify({ ...w.stats(), failedList: undefined, watching: undefined }));
console.log('hits        =', hits.length, hits.slice(0, 3).map((h) => path.basename(h)));
console.log('');
console.log(`watcher CPU : ${watcherCpuMs.toFixed(0)}ms over ${watched.wall}ms = ${watcherCpuPct.toFixed(3)}%  (control-subtracted)`);
console.log(`idle CPU    : ${idle.cpuPct.toFixed(3)}%`);
console.log(`RSS delta   : before=${rssBefore.toFixed(1)}MB afterStart=${rssAfterStart.toFixed(1)}MB delta=${rssDeltaMB.toFixed(1)}MB`);
console.log(`absolute RSS: idle=${idleRssMB.toFixed(1)}MB (includes node + harness)`);
const cpuOk = watcherCpuPct < 2 && idle.cpuPct < 2;
const ramOk = Math.abs(rssDeltaMB) < 30;
console.log('');
console.log(`CPU < 2%   : watcher ${watcherCpuPct.toFixed(3)}% / idle ${idle.cpuPct.toFixed(3)}% -> ${cpuOk ? 'OK' : 'EXCEEDS BUDGET'}`);
console.log(`RAM < 30MB : watcher RSS delta ${rssDeltaMB.toFixed(1)}MB -> ${ramOk ? 'OK' : 'EXCEEDS BUDGET'}`);
console.log(cpuOk && ramOk
  ? '>>> NFR 6.1 SATISFIED (measured)'
  : '>>> NFR 6.1 VIOLATED or not measurable this way — see caveat');
console.log('CAVEAT: RSS includes node + harness; the delta isolates the watcher. Absolute RSS is an upper bound');

fs.rmSync(fixtureDir, { recursive: true, force: true });
