// Re-test handle discoverability with PERSISTENT watchers (the plugin uses fs.watch with the
// default persistent:true). If persistent FSWatcher handles are enumerable, a new generation
// can close watchers leaked by a generation that predates the registry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-persist-'));
console.log('dir:', dir);

console.log('baseline handles:', JSON.stringify(process.getActiveResourcesInfo()));

const a = fs.watch(dir, {}, () => {});
const b = fs.watch(dir, {}, () => {});
console.log('after 2 PERSISTENT fs.watch (resources):', JSON.stringify(process.getActiveResourcesInfo()));

if (typeof process._getActiveHandles === 'function') {
  const handles = process._getActiveHandles();
  const summary = {};
  const found = [];
  for (const h of handles) {
    const name = h && h.constructor ? h.constructor.name : typeof h;
    summary[name] = (summary[name] || 0) + 1;
    if (/FSWatcher|StatWatcher/i.test(name)) {
      found.push({ name, hasClose: typeof h.close === 'function', proto: Object.getOwnPropertyNames(Object.getPrototypeOf(h) || {}).slice(0, 12) });
    }
  }
  console.log('total handles:', handles.length);
  console.log('handle types:', JSON.stringify(summary));
  console.log('watcher-like:', JSON.stringify(found, null, 1));
  console.log('DISCOVERABLE:', found.length >= 2);
} else {
  console.log('DISCOVERABLE: false (no _getActiveHandles)');
}

a.close();
b.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exitCode = 0;
