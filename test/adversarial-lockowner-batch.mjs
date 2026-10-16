// verifier probe (task-4 re-verify rev3) — item 2: PERMANENT REGRESSION GUARD for batch ownership.
//
// Guards the defect the Lead fixed at lib/lock-owner.js:103: `$paths = @($env:CC_RM_PATHS |
// ConvertFrom-Json)` collapses a JSON ARRAY into one space-joined item, so a batch of N>1 paths
// produced `ERR|RmGetList|6` for every path and cached nothing. A future edit must not silently
// reintroduce a non-enumerating parse.
//
// The invariant that catches it: `resolve(paths)` must return a map with an entry for EVERY
// requested path. A MISSING KEY means "we could not ask" (lib/lock-owner.js JSDoc) and is exactly
// what the old bug produced, so key-presence — not just "some path resolved" — is the assertion.
// Also exercises maxBatch chunking (>25 paths) and the production batch window.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { LockOwnerResolver } from '../lib/lock-owner.js';

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
let failures = 0;
const verdict = (ok, msg) => { console.log('  ->', ok ? 'OK' : 'DEFECT:', msg); if (!ok) failures++; };

// --- fixtures: real, exclusively-held files ------------------------------------------------------
const base = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp', `dshcc_batch_${STAMP}`);
fs.mkdirSync(base, { recursive: true });
const holders = [];
const heldPaths = [];
const lockFile = (p) => {
  fs.writeFileSync(p, 'B'.repeat(48));
  const flag = `${p}.ready`;
  const ps = [
    `$ErrorActionPreference='Stop'`,
    `$f=[System.IO.File]::Open('${p}','Open','ReadWrite','None')`,
    `[System.IO.File]::WriteAllText('${flag}','ok')`,
    `Start-Sleep -Seconds 240`,
    `$f.Close()`,
  ].join('; ');
  const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
  holders.push({ c, p, flag });
};
const waitReady = async (flag, ms) => { const t0 = Date.now(); while (!fs.existsSync(flag) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 200)); return fs.existsSync(flag); };

const reset = () => { for (const h of holders) { try { h.c.kill(); } catch {} } holders.length = 0; heldPaths.length = 0; };

try {
  // ---------------------------------------------------------------- case 1: exactly 2 paths
  console.log('=== case 1: a 2-path batch must answer BOTH paths (the original defect) ===');
  const a = path.join(base, 'held-a.tmp');
  const b = path.join(base, 'held-b.tmp');
  lockFile(a); lockFile(b); heldPaths.push(a, b);
  const okA = await waitReady(`${a}.ready`, 25000);
  const okB = await waitReady(`${b}.ready`, 25000);
  if (!(okA && okB)) {
    console.log('INCONCLUSIVE: could not take both exclusive handles');
    console.log('>>> BATCH OWNERSHIP: inconclusive');
    process.exit(0);
  }
  const holderPids = { [a.toLowerCase()]: holders[0].c.pid, [b.toLowerCase()]: holders[1].c.pid };

  const r1 = new LockOwnerResolver({ batchWindowMs: 60, timeoutMs: 20000 });
  const m1 = await r1.resolve([a, b]);
  console.log('  map size =', m1.size, '| spawns =', r1.stats().spawns);
  for (const p of [a, b]) console.log(`   ${path.basename(p)}: has key = ${m1.has(p)} value = ${JSON.stringify(m1.get(p))}`);
  verdict(m1.size === 2, `EVERY requested path is a key in the returned map (size ${m1.size}, expected 2 — a missing key IS the old defect)`);
  verdict(m1.has(a) && m1.has(b), 'both held paths have keys');
  for (const p of [a, b]) {
    const o = m1.get(p);
    verdict(Boolean(o) && Number(o.pid) === Number(holderPids[p.toLowerCase()]),
      `${path.basename(p)} reports ITS OWN holder pid (got ${o && o.pid}, want ${holderPids[p.toLowerCase()]})`);
  }
  r1.close();

  // ------------------------------------------------- case 2: batch window shares ONE spawn
  console.log('');
  console.log('=== case 2: separate resolve() calls inside one window share a single spawn ===');
  const r2 = new LockOwnerResolver({ batchWindowMs: 250, timeoutMs: 20000 });
  const [m2a, m2b] = await Promise.all([r2.resolve([a]), r2.resolve([b])]);
  console.log('  spawns =', r2.stats().spawns, '| a:', JSON.stringify(m2a.get(a)), '| b:', JSON.stringify(m2b.get(b)));
  verdict(r2.stats().spawns === 1, `two queued calls coalesced into ONE PowerShell spawn (spawns = ${r2.stats().spawns})`);
  verdict(m2a.has(a) && m2b.has(b), 'each caller still got its own path answered by the shared flush');
  r2.close();

  // ------------------------------------------------- case 3: >25 paths exercises maxBatch
  console.log('');
  console.log('=== case 3: >25 paths crosses maxBatch and the chunked answers must not drop keys ===');
  const c1 = path.join(base, 'held-c.tmp');
  lockFile(c1); heldPaths.push(c1);
  if (!(await waitReady(`${c1}.ready`, 25000))) { console.log('INCONCLUSIVE: third holder never ready'); console.log('>>> BATCH OWNERSHIP: inconclusive'); process.exit(0); }
  const c1Pid = holders[holders.length - 1].c.pid;

  const many = [a, b, c1];
  for (let i = 0; i < 27; i += 1) many.push(path.join(base, `absent-${i}.tmp`)); // never created
  const r3 = new LockOwnerResolver({ batchWindowMs: 40, timeoutMs: 60000 });
  const m3 = await r3.resolve(many);
  const missing = many.filter((p) => !m3.has(p));
  console.log('  requested =', many.length, '| keys returned =', m3.size, '| missing keys =', missing.length, '| spawns =', r3.stats().spawns);
  verdict(many.length > 25, `the batch really did exceed maxBatch=25 (requested ${many.length})`);
  verdict(r3.stats().spawns >= 2, `chunking produced more than one spawn (spawns = ${r3.stats().spawns})`);
  verdict(missing.length === 0, `${many.length} requested paths ALL present as keys (missing = ${missing.length})`);
  for (const [p, want] of [[a, holderPids[a.toLowerCase()]], [b, holderPids[b.toLowerCase()]], [c1, c1Pid]]) {
    const o = m3.get(p);
    verdict(Boolean(o) && Number(o.pid) === Number(want),
      `${path.basename(p)} answered in a ${many.length}-path batch with its own pid (got ${o && o.pid}, want ${want})`);
  }
  const absentValues = many.slice(3).map((p) => m3.get(p));
  console.log('  absent paths all report null (nobody holds them):', absentValues.every((v) => v === null));
  verdict(absentValues.every((v) => v === null), 'nonexistent paths answer null — a REAL answer, not a dropped key');
  verdict(absentValues.every((v) => v === null), 'nonexistent paths in a batch do not poison the held ones (checked above)');
  r3.close();
} finally {
  reset();
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(`>>> BATCH OWNERSHIP: ${failures === 0 ? 'EVERY REQUESTED PATH ANSWERED (regression guard holds)' : failures + ' DEFECT(S)'}`);
process.exit(failures === 0 ? 0 : 1);
