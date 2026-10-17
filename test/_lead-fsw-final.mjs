// DEFINITIVE: with the plugin's exact options (recursive:false, persistent:false) + unref(),
// can a NEW module generation find the leaked FSWatcher via process._getActiveHandles(), and
// does close() actually stop delivery? This decides whether an in-process reaper is possible.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fin-'));
let fired = 0;
const w = fs.watch(dir, { recursive: false, persistent: false }, (eventType, filename) => {
  void eventType; void filename; fired += 1;
});
w.unref();
await new Promise((r) => setTimeout(r, 60));

const handles = process._getActiveHandles();
console.log('handle ctors:', JSON.stringify(handles.map((h) => (h && h.constructor && h.constructor.name) || typeof h)));
console.log('active resources:', JSON.stringify(process.getActiveResourcesInfo()));
const fsw = handles.filter((h) => h && h.constructor && h.constructor.name === 'FSWatcher');
console.log('FSWatcher found by scan:', fsw.length);
for (const h of fsw) {
  const l = h._events && h._events.change;
  console.log('  listener src:', typeof l === 'function' ? l.toString().replace(/\s+/g, ' ').slice(0, 80) : 'none');
}

fs.writeFileSync(path.join(dir, 'x.txt'), 'hi');
await new Promise((r) => setTimeout(r, 600));
console.log('delivered before close:', fired);

for (const h of fsw) {
  try { h.close(); console.log('  closed via scan'); } catch (e) { console.log('  close failed:', e.message); }
}
fired = 0;
fs.writeFileSync(path.join(dir, 'y.txt'), 'hi');
await new Promise((r) => setTimeout(r, 600));
console.log('delivered after scan-close:', fired);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = 0;
