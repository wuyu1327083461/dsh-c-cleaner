import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-props-'));
const w = fs.watch(dir, {}, () => {});
const handles = process._getActiveHandles();
for (const h of handles) {
  if (h && h.constructor && h.constructor.name === 'FSWatcher') {
    console.log('own props:', JSON.stringify(Object.getOwnPropertyNames(h)));
    for (const k of Object.getOwnPropertyNames(h)) {
      const v = h[k];
      const t = typeof v;
      let s = '';
      try { s = t === 'object' && v ? JSON.stringify(Object.getOwnPropertyNames(v)) : String(v).slice(0, 60); } catch { s = '<circular>'; }
      console.log(`  ${k}: ${t} ${s}`);
    }
  }
}
w.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exitCode = 0;
