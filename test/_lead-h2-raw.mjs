// Lead: capture the RAW PowerShell stdout for the 1-path vs 2-path batch.
// The resolver caches nothing for a 2-path batch, so `parseOutput` must be receiving
// something it cannot parse. This prints exactly what comes back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-h2-raw-'));
const victim = path.join(ROOT, 'locked.tmp');
const free = path.join(ROOT, 'free.tmp');
fs.writeFileSync(victim, 'payload');
fs.writeFileSync(free, 'payload');
const esc = (s) => s.replace(/'/g, "''");

const holder = spawn(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command',
   `$fs=[System.IO.File]::Open('${esc(victim)}','Open','ReadWrite','None'); Write-Output 'HELD'; Start-Sleep -Seconds 60; $fs.Close()`],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
await new Promise((res) => {
  holder.stdout.on('data', (d) => String(d).includes('HELD') && res());
  setTimeout(res, 8000);
});
console.log('holder pid:', holder.pid);

// Reconstruct PS_SCRIPT exactly as the module builds it, by importing the module source
// and slicing the script out (it is not exported, so this keeps us honest).
const src = fs.readFileSync(new URL('../lib/lock-owner.js', import.meta.url), 'utf8');
const start = src.indexOf('const PS_SCRIPT = `');
const end = src.indexOf('`;\n\n/** `execFile` as a promise');
let PS_SCRIPT = src.slice(start + 'const PS_SCRIPT = `'.length, end);

console.log('  PS_SCRIPT length:', PS_SCRIPT.length);
console.log('  contains CC_RM_PATHS:', PS_SCRIPT.includes('CC_RM_PATHS'));

function run(paths) {
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
        env: { ...process.env, CC_RM_PATHS: JSON.stringify(paths) } },
      (err, stdout, stderr) => resolve({ err, stdout, stderr, child }),
    );
    void child;
  });
}

for (const [label, paths] of [
  ['ONE', [victim]],
  ['TWO', [victim, free]],
  ['THREE', [victim, free, path.join(ROOT, 'ghost.tmp')]],
]) {
  console.log(`\n=== ${label} :: CC_RM_PATHS = ${JSON.stringify(JSON.stringify(paths))} ===`);
  const { err, stdout, stderr } = await run(paths);
  console.log('  err    :', err ? `${err.code || ''} ${err.message}` : 'none');
  console.log('  stdout :', JSON.stringify(stdout));
  if (stderr && stderr.trim()) console.log('  stderr :', JSON.stringify(stderr.slice(0, 800)));
}

// Now test the hypothesis directly: how does PowerShell treat @($json | ConvertFrom-Json)?
console.log('\n=== hypothesis: @($json | ConvertFrom-Json) element count ===');
for (const label of ['ONE', 'TWO']) {
  const paths = label === 'ONE' ? [victim] : [victim, free];
  const probe = `$p = @($env:X | ConvertFrom-Json); Write-Output ("count=" + @($p).Count); foreach ($i in $p) { Write-Output ("item=" + [string]$i) }`;
  const out = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe],
      { timeout: 20000, windowsHide: true, encoding: 'utf8', env: { ...process.env, X: JSON.stringify(paths) } },
      (e, so, se) => resolve({ so, se, e }));
  });
  console.log(`  ${label}:`, JSON.stringify(out.so), out.e ? `ERR ${out.e.message}` : '');
}

holder.kill();
setTimeout(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(0);
}, 1500);
