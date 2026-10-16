// Lead: PROVE the multi-path batching defect was REACHABLE FROM PRODUCTION.
//
// The defect: PS_SCRIPT parsed `$env:CC_RM_PATHS` with `@($env:CC_RM_PATHS | ConvertFrom-Json)`, which
// collapses an N>1 element JSON array into ONE space-joined string. Restart Manager was therefore
// asked about a nonexistent combined path and answered `ERR|RmGetList|6` for EVERY path in the batch
// (proven in _lead-h2-raw.mjs: ONE -> HIT, TWO -> ERR|RmGetList|6).
//
// index.js's `enrichOwner` calls `owners.resolve([record.path])` — ONE path per call — so at first
// glance the batch path looked dead. But `resolve()` QUEUES and flushes after `batchWindowMs` (250ms
// in production), so two locked rows discovered within that window land in ONE spawn. That is the
// reachability argument, and this test measures it instead of asserting it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LockOwnerResolver } from '../lib/lock-owner.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-h2-reach-'));
const esc = (s) => s.replace(/'/g, "''");
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

// Three separately-locked files, each with its OWN holder process, so a batch must report 3 distinct
// pids — a space-joined single path could never produce any of them.
const victims = [];
const holders = [];
for (let i = 0; i < 3; i += 1) {
  const v = path.join(ROOT, `reach-${i}.tmp`);
  fs.writeFileSync(v, 'payload');
  victims.push(v);
}
const ready = victims.map((_, i) => path.join(ROOT, `ready-${i}`));

for (let i = 0; i < victims.length; i += 1) {
  const h = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$fs=[System.IO.File]::Open('${esc(victims[i])}','Open','ReadWrite','None'); [System.IO.File]::WriteAllText('${esc(ready[i])}','ok'); Start-Sleep -Seconds 90; $fs.Close()`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  holders.push(h);
}
const t0 = Date.now();
while (ready.some((r) => !fs.existsSync(r)) && Date.now() - t0 < 25000) await new Promise((r) => setTimeout(r, 200));
const allHeld = ready.every((r) => fs.existsSync(r));
console.log(`root: ${ROOT}`);
console.log(`holders: ${holders.map((h) => h.pid).join(', ')}  all exclusive: ${allHeld}\n`);
if (!allHeld) { console.log('INCONCLUSIVE: could not take all exclusive handles'); process.exit(0); }

try {
  // Production's batchWindowMs is 250. Fire the three calls the way enrichOwner does — one path
  // each, in the same tick — and let the resolver's own queue do the coalescing.
  const resolver = new LockOwnerResolver({ batchWindowMs: 250, timeoutMs: 20000 });
  const before = resolver.stats().spawns;
  const maps = await Promise.all(victims.map((v) => resolver.resolve([v])));
  const spawns = resolver.stats().spawns - before;

  check('REACHABILITY: 3 single-path production-shaped calls coalesce into ONE spawn',
    spawns === 1, `spawns=${spawns}`);

  const owners = victims.map((v, i) => maps[i].get(v));
  check('REACHABILITY: all three batches got an answer (no ERR|RmGetList dropout)',
    owners.every((o) => o && o.pid), `got ${JSON.stringify(owners.map((o) => (o && o.pid) || null))}`);

  const gotPids = owners.map((o) => (o && o.pid) || 0);
  check('REACHABILITY: each path reports ITS OWN holder pid (batch of 3 stayed distinct)',
    gotPids.every((p, i) => p === holders[i].pid),
    `got ${JSON.stringify(gotPids)} expected ${JSON.stringify(holders.map((h) => h.pid))}`);
} finally {
  for (const h of holders) { try { h.kill(); } catch {} }
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY pass=${results.length - failed.length} fail=${failed.length} total=${results.length}`);
setTimeout(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(failed.length === 0 ? 0 : 1);
}, 1500);
