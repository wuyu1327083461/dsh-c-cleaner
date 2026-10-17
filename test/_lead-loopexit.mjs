// Does persistent:false ALONE keep the loop alive? (i.e. is unref() redundant?)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-exit-'));
const t0 = Date.now();
const w = fs.watch(dir, { recursive: false, persistent: false }, () => {});
// deliberately NO unref()
setTimeout(() => { console.log('timer fired, elapsed', Date.now() - t0); }, 200).unref();
process.on('exit', () => console.log('EXIT after', Date.now() - t0, 'ms with persistent:false + NO unref'));
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
// no explicit close, no exitCode: if persistent:false truly does not hold the loop, we exit here
