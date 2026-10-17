// Reproduce exactly the plugin's shape: TWO watchers on the SAME dir,
// {recursive:false, persistent:false}, then unref().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-two-'));
function show(tag){
  const h = process._getActiveHandles().filter(x => x?.constructor?.name === 'FSWatcher');
  const r = process.getActiveResourcesInfo().filter(x => /FS|Event/i.test(x));
  console.log(`${tag}: handles=${process._getActiveHandles().length} FSWatcher=${h.length} res=${JSON.stringify(r)}`);
}
show('before');
const a = fs.watch(dir, { recursive: false, persistent: false }, () => {});
a.unref();
show('after 1st unref');
const b = fs.watch(dir, { recursive: false, persistent: false }, () => {});
b.unref();
show('after 2nd unref');
const c = fs.watch(dir, { recursive: false, persistent: true }, () => {});
show('after 3rd (persistent, no unref)');
a.close(); b.close(); c.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exitCode = 0;
