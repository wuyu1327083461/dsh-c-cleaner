// Isolate which option hides an FSWatcher from _getActiveHandles / getActiveResourcesInfo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-matrix-'));
const cases = [
  ['persistent:true,  no unref', () => { const w = fs.watch(dir, { persistent: true }, () => {}); return w; }],
  ['persistent:true,  unref',    () => { const w = fs.watch(dir, { persistent: true }, () => {}); w.unref(); return w; }],
  ['persistent:false, no unref', () => { const w = fs.watch(dir, { persistent: false }, () => {}); return w; }],
  ['persistent:false, unref',    () => { const w = fs.watch(dir, { persistent: false }, () => {}); w.unref(); return w; }],
];
for (const [label, make] of cases) {
  const w = make();
  const handles = process._getActiveHandles().filter(h => h?.constructor?.name === 'FSWatcher');
  const res = process.getActiveResourcesInfo().filter(r => /FS|Event/i.test(r));
  console.log(`${label.padEnd(26)} activeHandles_FSWatcher=${handles.length} activeResources=${JSON.stringify(res)}`);
  w.close();
}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exitCode = 0;
