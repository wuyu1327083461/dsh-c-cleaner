/**
 * Probe: is `fs.renameSync(p, p)` a SIDE-EFFECT-FREE delete-permission test?
 * Checks content, size, mtime, ctime, atime before/after, on both a plain file
 * and a directory (isLocked is only used for files, but the helper may be reused).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccprobe2_'));
const f = path.join(dir, 'doc.txt');
fs.writeFileSync(f, 'hello-world-'.repeat(100));

function snap(p) {
  const st = fs.statSync(p);
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    atimeMs: st.atimeMs,
    ino: st.ino,
    nlink: st.nlink,
    hash: (() => {
      const b = fs.readFileSync(p);
      let h = 0;
      for (const x of b) h = (h * 31 + x) >>> 0;
      return h;
    })(),
  };
}

const before = snap(f);
await new Promise((r) => setTimeout(r, 30));
fs.renameSync(f, f);
const after = snap(f);

console.log('before', JSON.stringify(before));
console.log('after ', JSON.stringify(after));
console.log('size same   :', before.size === after.size);
console.log('content same:', before.hash === after.hash);
console.log('ino same    :', before.ino === after.ino);
console.log('mtime same  :', before.mtimeMs === after.mtimeMs, before.mtimeMs, after.mtimeMs);
console.log('ctime moved :', before.ctimeMs !== after.ctimeMs);
console.log('exists      :', fs.existsSync(f));

// directory variant
const d = path.join(dir, 'sub');
fs.mkdirSync(d);
const dbefore = fs.statSync(d);
let dirRes;
try {
  fs.renameSync(d, d);
  dirRes = 'ok';
} catch (err) {
  dirRes = err.code;
}
const dafter = fs.statSync(d);
console.log('dir self-rename:', dirRes, '| still dir:', fs.statSync(d).isDirectory(), '| ctime moved:', dbefore.ctimeMs !== dafter.ctimeMs);

// also: what does unlink-ability look like right after a self-rename? (sanity)
fs.unlinkSync(f);
console.log('unlink after self-rename: ok');

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* ignore */
}
