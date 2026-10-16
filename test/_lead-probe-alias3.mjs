// Lead: does C:\PROGRA~3 actually resolve to C:\ProgramData on this host? That is the spelling the
// verifier used to trigger the libuv abort. Also survey short names via [Console]::WriteLine.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

console.log('=== direct probe of the spellings the verifier used ===');
for (const p of [
  'C:\\PROGRA~1', 'C:\\PROGRA~2', 'C:\\PROGRA~3', 'C:\\PROGRA~4',
  'C:\\ProgramData', 'C:\\Program Files', 'C:\\Program Files (x86)',
  'C:\\Users\\kiuhg\\AppData\\Local\\Temp',
]) {
  let real = null, err = null;
  try { real = fs.realpathSync.native(p); } catch (e) { err = e.code; }
  const exists = fs.existsSync(p);
  console.log(`  ${p.padEnd(42)} exists=${String(exists).padEnd(5)} realpath=${real ?? `ERR ${err}`}`);
}

console.log('\n=== is the abort reproducible? watch C:\\PROGRA~3 in a CHILD ===');
const child = `
import fs from 'node:fs';
import { CWatcher } from '../lib/watcher.js';
import { ProcessTree } from '../lib/process-tree.js';
import { resolveConfig } from '../lib/config.js';
const log = { debug(){}, info(){}, warn(){}, error(){} };
const cfg = resolveConfig({});
const dir = process.argv[2];
const tree = new ProcessTree({ rootPid: process.pid, log });
await tree.refresh();
const w = new CWatcher({ cfg: { ...cfg, watchDirs: [{ path: dir, recursive: false, maxDepth: 1 }] }, tree, log, onCandidate(){} });
const st = w.start();
console.log(JSON.stringify({ watching: st.watching, candidates: 0 }));
w.stop(); tree.stop();
`;
fs.writeFileSync('C:\\Users\\kiuhg\\AppData\\Local\\Temp\\_lead-abort-child.mjs', child.replace('C:\\Users\\kiuhg\\AppData\\Local\\Temp', 'F:\\\\work\\\\dsh-c-cleaner\\\\test'));

for (const spelling of ['C:\\PROGRA~3', 'C:\\ProgramData', 'C:\\PROGRA~1', 'C:\\Program Files']) {
  const f = 'F:\\work\\dsh-c-cleaner\\test\\_lead-abort-child.mjs';
  fs.writeFileSync(f, child);
  process.stdout.write(`  watchDir=${JSON.stringify(spelling).padEnd(22)} -> `);
  try {
    const out = execFileSync(process.execPath, [f, spelling], { encoding: 'utf8', timeout: 30000, cwd: 'F:\\work\\dsh-c-cleaner\\test' });
    const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
    console.log(`exit 0  ${line}`);
  } catch (e) {
    const code = e.status ?? e.signal;
    const blob = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    const a = blob.split(/\r?\n/).find((l) => /Assertion|abort/i.test(l)) ?? '';
    console.log(`exit ${code}  ${a.trim()}`);
    if (String(code) === '3221226505') console.log('        >>> 0xC0000409 libuv fail-fast ABORT');
  }
}
fs.rmSync('F:\\work\\dsh-c-cleaner\\test\\_lead-abort-child.mjs', { force: true });

console.log('\n=== short-name survey via [Console]::WriteLine ===');
const dirs = ['C:\\ProgramData', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\Users', 'C:\\Windows', 'C:\\Users\\kiuhg'];
const script = '$fso = New-Object -ComObject Scripting.FileSystemObject; foreach ($p in @(' +
  dirs.map((d) => `'${d}'`).join(',') + ')) { try { $s = $fso.GetFolder($p).ShortPath; [Console]::WriteLine($p + "|" + $s) } catch { [Console]::WriteLine($p + "|ERR") } }';
try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 });
  for (const line of out.split(/\r?\n/)) {
    const [long, short] = line.split('|');
    if (!long || !short) continue;
    console.log(`  ${short === 'ERR' ? 'ERR      ' : (short.toLowerCase() === long.toLowerCase() ? 'same     ' : 'GENUINE  ')} ${long.padEnd(28)} short=${short}`);
  }
} catch (e) {
  console.log('  powershell failed:', (e.stderr ?? '').slice(0, 200));
}
