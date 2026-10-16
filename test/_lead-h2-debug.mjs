// Lead: why did the resolver return no keys for a genuinely locked file in _lead-h2-cache.mjs,
// when the e2e proof found the holder? Capture the resolver's own debug output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LockOwnerResolver } from '../lib/lock-owner.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-h2-dbg-'));
const victim = path.join(ROOT, 'locked.tmp');
fs.writeFileSync(victim, 'payload');
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
console.log('holder pid:', holder.pid, 'victim:', victim);

const log = {
  debug: (m) => console.log('  [debug]', m),
  info: (m) => console.log('  [info]', m),
  warn: (m) => console.log('  [warn]', m),
  error: (m) => console.log('  [error]', m),
};

console.log('\n=== resolve() with debug logging ===');
const r = new LockOwnerResolver({ log, batchWindowMs: 100 });
const t0 = Date.now();
const map = await r.resolve([victim]);
console.log(`  elapsed ${Date.now() - t0}ms  stats=${JSON.stringify(r.stats())}`);
console.log('  map:', JSON.stringify([...map.entries()]));

console.log('\n=== second resolve (was the first cached?) ===');
const t1 = Date.now();
const map2 = await r.resolve([victim]);
console.log(`  elapsed ${Date.now() - t1}ms  stats=${JSON.stringify(r.stats())}`);
console.log('  map:', JSON.stringify([...map2.entries()]));

console.log('\n=== raw PowerShell RM call, run by hand ===');
const { execFileSync } = await import('node:child_process');
const psScript = fs.readFileSync(new URL('../lib/lock-owner.js', import.meta.url), 'utf8');
const start = psScript.indexOf('Add-Type');
const end = psScript.indexOf('export class LockOwnerResolver');
console.log('  (script source between Add-Type and the class is what runs; length', end - start, 'chars)');
console.log(readBlock(psScript).slice(0, 4000));

function readBlock(src) {
  const i = src.indexOf('const CCH_RM');
  const j = src.indexOf('export class LockOwnerResolver');
  return src.slice(i, j);
}

const out = execFileSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command',
   `${readBlock(psScript)}\n$r = [CcRm]::Who([string]'${esc(victim)}'); Write-Output $r`],
  { encoding: 'utf8', windowsHide: true, timeout: 60000 },
);
console.log('  RAW OUTPUT:', JSON.stringify(out));

holder.kill();
setTimeout(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(0);
}, 1500);
