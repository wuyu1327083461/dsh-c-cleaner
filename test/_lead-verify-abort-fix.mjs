// Lead: does my detection method actually catch the libuv abort? Run RAW fs.watch on the 8.3 alias
// WITH a real filesystem event (both conditions the verifier identified), and compare to the
// fixed CWatcher doing the identical thing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The child must live next to this file so its relative '../lib/...' imports resolve.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, '_lead-raw-abort-child.mjs');

const childSrc = `
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const mode = process.argv[3];
let candidates = 0;
if (mode === 'raw') {
  // RAW fs.watch, spelling passed verbatim, recursive:false
  fs.watch(dir, { recursive: false, persistent: false }, () => { candidates += 1; });
} else {
  const { CWatcher } = await import('../lib/watcher.js');
  const { ProcessTree } = await import('../lib/process-tree.js');
  const { resolveConfig } = await import('../lib/config.js');
  const log = { debug(){}, info(){}, warn(){}, error(){} };
  const cfg = resolveConfig({});
  const tree = new ProcessTree({ rootPid: process.pid, log });
  await tree.refresh();
  const w = new CWatcher({ cfg: { ...cfg, debounceMs: 200, watchDirs: [{ path: dir, recursive: false, maxDepth: 1 }] }, tree, log, onCandidate(){ candidates += 1; } });
  w.start();
}
// (b) fire a real filesystem event UNDER the watched directory
await new Promise((r) => setTimeout(r, 400));
const victim = path.join(dir, 'lead-raw-abort-probe-' + Date.now() + '.tmp');
try { fs.writeFileSync(victim, 'x'.repeat(32)); } catch (e) { console.log('WRITE-FAILED ' + e.code); }
await new Promise((r) => setTimeout(r, 900));
try { fs.rmSync(victim, { force: true }); } catch {}
console.log(JSON.stringify({ ok: true, candidates }));
`;

function run(label, mode, spelling) {
  fs.writeFileSync(CHILD, childSrc);
  process.stdout.write(`  ${label.padEnd(46)} `);
  try {
    const out = execFileSync(process.execPath, [CHILD, spelling, mode], { encoding: 'utf8', timeout: 30000, cwd: HERE });
    const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
    console.log(`exit 0   ${line}`);
    return { exit: 0, out };
  } catch (e) {
    const code = e.status ?? e.signal;
    const blob = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    const a = blob.split(/\r?\n/).find((l) => /Assertion|abort/i.test(l)) ?? '';
    console.log(`exit ${code}  ${a.trim()}`);
    if (String(code) === '3221226505') console.log('        >>> 0xC0000409 libuv fail-fast ABORT  (my detector WORKS)');
    return { exit: code, out: blob };
  }
}

console.log('=== A: RAW fs.watch, verbatim 8.3 spelling + a real event (the ORIGINAL defect) ===');
run('raw fs.watch on "C:\\\\PROGRA~3"', 'raw', 'C:\\PROGRA~3');
run('raw fs.watch on "C:\\\\ProgramData" (control)', 'raw', 'C:\\ProgramData');

console.log('\n=== B: the FIXED CWatcher, same spellings + same real event ===');
run('CWatcher on "C:\\\\PROGRA~3"', 'fixed', 'C:\\PROGRA~3');
run('CWatcher on "C:\\\\PROGRA~1"', 'fixed', 'C:\\PROGRA~1');
run('CWatcher on "C:\\\\ProgramData" (control)', 'fixed', 'C:\\ProgramData');

fs.rmSync(CHILD, { force: true });
console.log('\n=== verdict ===');
console.log('  If A aborts 3221226505 and B exits 0, the fix is CONFIRMED on this host.');
