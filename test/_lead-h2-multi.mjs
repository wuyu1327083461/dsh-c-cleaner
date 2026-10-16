// Lead: the resolver works with ONE path but returned an empty map with TWO paths.
// Hypothesis: a multi-path batch makes the PowerShell call fail, so nothing is cached.
// This isolates it and prints the resolver's own debug output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LockOwnerResolver } from '../lib/lock-owner.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-h2-two-'));
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

const log = {
  debug: (m) => console.log('  [debug]', m),
  info: (m) => console.log('  [info]', m),
  warn: (m) => console.log('  [warn]', m),
  error: (m) => console.log('  [error]', m),
};

for (const [label, paths] of [
  ['ONE path (locked)', [victim]],
  ['ONE path (free)', [free]],
  ['TWO paths (locked + free)', [victim, free]],
]) {
  console.log(`\n=== ${label} ===`);
  const r = new LockOwnerResolver({ log, batchWindowMs: 100 });
  const t0 = Date.now();
  const map = await r.resolve(paths);
  console.log(`  elapsed ${Date.now() - t0}ms  stats=${JSON.stringify(r.stats())}`);
  for (const p of paths) console.log(`  get(${path.basename(p)}) = ${JSON.stringify(map.get(p))}`);
  r.close();
  await new Promise((res) => setTimeout(res, 300));
}

holder.kill();
setTimeout(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(0);
}, 1500);
