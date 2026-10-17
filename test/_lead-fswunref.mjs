// The plugin uses fs.watch(dir, {recursive, persistent:false}) then watcher.unref().
// Does such a handle remain enumerable for a NEW generation to find and close?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-unref-'));
function ours(){ return 'OURS'; }
const a = fs.watch(dir, { recursive: false, persistent: false }, () => ours());
a.unref();
const b = fs.watch(dir, { recursive: false, persistent: false }, () => {});
b.unref();
const info = process.getActiveResourcesInfo();
console.log('active resources:', JSON.stringify(info));
const handles = process._getActiveHandles();
const fsw = handles.filter(h => h?.constructor?.name === 'FSWatcher');
console.log('activeHandles total:', handles.length, '| FSWatcher count:', fsw.length);
for (const h of fsw) {
  const l = h._events?.change;
  console.log('  onchange-listener:', typeof l === 'function' ? l.toString().replace(/\s+/g,' ').slice(0,90) : 'none');
}
console.log('FINDABLE_VIA_UNREF:', fsw.length >= 2);
a.close(); b.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exitCode = 0;
