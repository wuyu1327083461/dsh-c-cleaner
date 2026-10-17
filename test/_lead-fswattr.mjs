// Can we ATTRIBUTE an FSWatcher handle to our plugin from inside the process?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-attr-'));
function settleFn() { return 'OURS'; }
const w1 = fs.watch(dir, {}, () => settleFn());
const w2 = fs.watch(dir, {}, () => {});
for (const h of process._getActiveHandles()) {
  if (h?.constructor?.name === 'FSWatcher') {
    const oc = h._handle?.onchange;
    console.log('--- onchange type:', typeof oc, '| len:', typeof oc === 'function' ? oc.toString().length : 'n/a');
    if (typeof oc === 'function') {
      const s = oc.toString();
      console.log('    mentions settleFn:', s.includes('settleFn'));
      console.log('    first 160:', s.replace(/\s+/g, ' ').slice(0, 160));
    }
    console.log('    _events.change listeners:', h._events?.change ? h._events.change.toString().replace(/\s+/g,' ').slice(0,120) : 'none');
  }
}
w1.close(); w2.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exitCode = 0;
