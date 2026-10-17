/**
 * Probe: does `fs.rmSync(dir, {recursive:true})` delete SOME files before failing on a
 * locked one? If yes, the current moveDirectory recovery path (which deletes the verified
 * target copy on source-delete failure) would destroy data that exists in NEITHER tree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrm_'));
const src = path.join(dir, 'tree');
fs.mkdirSync(src);
fs.mkdirSync(path.join(src, 'nested'));

const names = ['a.bin', 'b.bin', 'nested/c.bin', 'nested/locked.bin', 'z.bin'];
for (const n of names) fs.writeFileSync(path.join(src, n), n.repeat(200));

// Hold ONE nested file from another process (the "z.bin" after it alphabetically, so the
// walker has to delete everything before it first).
const lockedPath = path.join(src, 'nested', 'locked.bin');
const holder = spawn(process.execPath, ['-e', `
const fs = require('fs');
const fd = fs.openSync(process.argv[1], 'r');
process.stdout.write('HELD\\n');
setTimeout(() => process.exit(0), 6000);
`, lockedPath], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => { holder.stdout.once('data', r); setTimeout(r, 2000); });

console.log('before:', fs.readdirSync(src), fs.readdirSync(path.join(src, 'nested')));

let err = null;
try {
  fs.rmSync(src, { recursive: true, force: false });
} catch (e) {
  err = e;
}
console.log('rmSync error:', err ? `${err.code} ${err.message}` : 'none');
console.log('src exists after:', fs.existsSync(src));
if (fs.existsSync(src)) {
  console.log('src contents after:', fs.readdirSync(src));
  const nested = path.join(src, 'nested');
  console.log('nested contents after:', fs.existsSync(nested) ? fs.readdirSync(nested) : 'GONE');
}
console.log('locked file still there:', fs.existsSync(lockedPath));

holder.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
