// Can we discover a leaked fs.watch handle from inside the process, even when it is not in
// our own registry? This decides how to stop phantom generations that were born before the
// registry existed (their code has no `watcherRegistry().add(this)`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-handles-'));
console.log('dir:', dir);

const a = fs.watch(dir, { persistent: false }, () => {});
const b = fs.watch(dir, { persistent: false }, () => {});

const seen = [];
for (const key of ['_getActiveHandles', 'getActiveResourcesInfo', '_getActiveRequests']) {
  const fn = process[key];
  seen.push(`${key}: ${typeof fn}`);
}
console.log(seen.join(' | '));

if (typeof process._getActiveHandles === 'function') {
  const handles = process._getActiveHandles();
  console.log('total active handles:', handles.length);
  const summary = {};
  const fswatchers = [];
  for (const h of handles) {
    const name = h && h.constructor ? h.constructor.name : typeof h;
    summary[name] = (summary[name] || 0) + 1;
    if (name === 'FSWatcher') {
      fswatchers.push({
        hasClose: typeof h.close === 'function',
        hasRef: typeof h.ref === 'function',
        keys: Object.keys(h).slice(0, 8),
      });
    }
  }
  console.log('handle types:', JSON.stringify(summary));
  console.log('FSWatcher objects found:', JSON.stringify(fswatchers, null, 1));
  console.log('DISCOVERABLE:', fswatchers.length >= 2);
} else {
  console.log('DISCOVERABLE: false (no _getActiveHandles)');
}

a.close();
b.close();
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {}
process.exitCode = 0;
