// Does `process.getActiveResourcesInfo()` expose FSWatcher handles? If it does, a plugin can
// DETECT leaked watchers even when they were born before the process-global registry existed
// (their code never registered them, so stopAllWatchers() cannot reach them).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-res-'));
console.log('dir:', dir);

console.log('baseline:', JSON.stringify(process.getActiveResourcesInfo()));

const a = fs.watch(dir, { persistent: false }, () => {});
const b = fs.watch(dir, { persistent: false }, () => {});
console.log('after 2 fs.watch:', JSON.stringify(process.getActiveResourcesInfo()));

const t = setTimeout(() => {}, 10_000);
if (typeof t.unref === 'function') t.unref();
console.log('after unref timer:', JSON.stringify(process.getActiveResourcesInfo()));

const count = (list) => list.filter((x) => /FSWatcher/i.test(x)).length;
console.log('FSWatcher count after 2 watches:', count(process.getActiveResourcesInfo()));

a.close();
console.log('after closing ONE:', JSON.stringify(process.getActiveResourcesInfo()));
b.close();
console.log('after closing BOTH:', JSON.stringify(process.getActiveResourcesInfo()));

clearTimeout(t);
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {}
process.exitCode = 0;
