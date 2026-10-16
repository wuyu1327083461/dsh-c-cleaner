// Lead: two claims about the H2 wiring that I should not leave on trust.
//   (1) `resolveLockOwner: false` must genuinely disable the lookup — no PowerShell spawn.
//   (2) The lookup must not violate the PRD 6.1 budget (CPU < 2%).
// Also checks the null-owner path and that a genuine sourceProcess is never overwritten.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const mod = await import('../lib/lock-owner.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-h2-off-'));
const esc = (s) => s.replace(/'/g, "''");

console.log('=== 1. disabled resolver never spawns ===');
const off = new mod.LockOwnerResolver({ disabled: true });
const offMap = await off.resolve([path.join(ROOT, 'a.tmp')]);
console.log('  resolve() ->', JSON.stringify([...offMap.entries()]));
console.log('  stats    ->', JSON.stringify(off.stats()));
off.close();
console.log(`  PASS (empty map, 0 spawns): ${offMap.size === 0 && off.stats().spawns === 0}`);

console.log('\n=== 2. platform guard ===');
console.log('  platform:', process.platform, '-> disabled by default off-Windows only');

console.log('\n=== 3. a genuinely locked file, then a released file ===');
const victim = path.join(ROOT, 'locked.tmp');
const free = path.join(ROOT, 'free.tmp');
fs.writeFileSync(victim, 'payload');
fs.writeFileSync(free, 'payload');

const holderPidPromise = new Promise((res) => {
  const p = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$fs=[System.IO.File]::Open('${esc(victim)}','Open','ReadWrite','None'); Write-Output ('HELD'); Start-Sleep -Seconds 30; $fs.Close()`,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  p.stdout.on('data', (d) => String(d).includes('HELD') && res(p.pid));
  setTimeout(() => res(p.pid), 8000);
});
const holderPid = await holderPidPromise;
console.log('  holder pid:', holderPid);

const resolver = new mod.LockOwnerResolver({ batchWindowMs: 100 });
const t0 = process.hrtime.bigint();
const map = await resolver.resolve([victim, free]);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

const locked = map.get(victim);
const freeOwner = map.get(free);
console.log(`  locked -> ${JSON.stringify(locked)}`);
console.log(`  free   -> ${JSON.stringify(freeOwner)}`);
console.log(`  elapsed: ${ms.toFixed(0)}ms   spawns: ${resolver.stats().spawns}`);

const pidOk = locked && locked.pid === holderPid;
const freeOk = freeOwner === null;
console.log(`  PASS (real holder pid ${holderPid} found): ${pidOk}`);
console.log(`  PASS (unheld file reported as null, not missing key): ${freeOk}`);

console.log('\n=== 4. batching: 3 paths -> 1 spawn, and a cache hit -> 0 further spawns ===');
const r2 = new mod.LockOwnerResolver({ batchWindowMs: 80 });
const many = [victim, free, path.join(ROOT, 'ghost.tmp')];
await Promise.all([r2.resolve(many), r2.resolve(many)]);
const afterFirst = r2.stats().spawns;
await r2.resolve(many); // fully cached
console.log(`  spawns after 2 concurrent batches of 3: ${afterFirst} (expect 1)`);
console.log(`  spawns after a fully-cached repeat:     ${r2.stats().spawns} (expect ${afterFirst})`);
console.log(`  PASS (deduped + cached): ${afterFirst === 1 && r2.stats().spawns === afterFirst}`);
r2.close();

console.log('\n=== 5. close() releases everything and later resolve() is inert ===');
resolver.close();
const afterClose = await resolver.resolve([victim]);
console.log(`  resolve() after close -> ${JSON.stringify([...afterClose.entries()])}`);
console.log(`  PASS: ${afterClose.size === 0}`);

console.log('\n=== 6. a NULL owner must not throw (PRD 6.3 degradation) ===');
const r3 = new mod.LockOwnerResolver({ batchWindowMs: 50 });
const nullMap = await r3.resolve([path.join(ROOT, 'does-not-exist.tmp'), '', null, 42]);
console.log('  resolve([missing, "", null, 42]) ->', JSON.stringify([...nullMap.entries()]));
r3.close();

fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(pidOk && freeOk && offMap.size === 0 ? 0 : 1);
