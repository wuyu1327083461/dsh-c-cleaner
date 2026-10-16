// verifier probe (task-4 re-verify rev2): can I instrument PowerShell spawns hermetically?
// lib/lock-owner.js does `import { execFile } from 'node:child_process'`. If that binding is LIVE,
// patching child_process.execFile lets me count/steer spawns without a real PowerShell.
import { execFile } from 'node:child_process';
import cp from 'node:child_process';

let called = 0;
const orig = cp.execFile;
cp.execFile = function patched(...args) {
  called += 1;
  return orig.apply(this, args);
};

execFile(process.execPath, ['-e', '0'], () => {});
await new Promise((r) => setTimeout(r, 600));

console.log('called =', called);
console.log(called > 0
  ? '=> LIVE BINDING: patching child_process.execFile DOES intercept the ESM import'
  : '=> SNAPSHOT BINDING: patching does NOT intercept; need a different instrumentation');
