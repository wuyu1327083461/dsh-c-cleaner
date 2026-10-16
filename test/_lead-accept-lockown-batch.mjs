// Lead acceptance test for the multi-path batching fix in lib/lock-owner.js.
//
// WHY THIS TEST EXISTS: `PS_SCRIPT` used `@($env:CC_RM_PATHS | ConvertFrom-Json)`, which collapses a
// JSON array of N>1 elements into ONE space-joined string. Restart Manager was therefore asked about
// a nonexistent combined path and answered `ERR|RmGetList|6` for EVERY path in the batch. Production
// happened to call `resolve([record.path])` one path at a time, so the bug only showed up through the
// batching API — which is exactly what `maxBatch: 25` exists to do.
//
// This test drives the REAL resolver class through its public `resolve()` API with 1, 2, 3 and 30
// paths, and asserts:
//   * a file held with FileShare.None is reported as HIT with the holder's pid,
//   * an unheld file is reported as `null` (genuinely unheld, NOT "could not ask"),
//   * a nonexistent path does not poison the batch,
//   * a 30-path call (crossing maxBatch=25, so it must chunk into 2 spawns) resolves every path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LockOwnerResolver } from '../lib/lock-owner.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-h2-accept-'));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

const esc = (s) => s.replace(/'/g, "''");
const held = path.join(ROOT, 'held.tmp');
fs.writeFileSync(held, 'payload');
// Exclude the batch window so each `resolve()` call is one deterministic spawn.
const resolver = new LockOwnerResolver({ batchWindowMs: 60, timeoutMs: 20000 });

let holder = null;
try {
  // A genuine OS-level lock: FileShare.None means even a read is denied.
  holder = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
     `$fs=[System.IO.File]::Open('${esc(held)}','Open','ReadWrite','None'); Write-Output 'HELD'; Start-Sleep -Seconds 90; $fs.Close()`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ready = await new Promise((res) => {
    holder.stdout.on('data', (d) => String(d).includes('HELD') && res(true));
    setTimeout(() => res(false), 10000);
  });
  console.log(`holder pid: ${holder.pid}  ready: ${ready}  root: ${ROOT}\n`);
  if (!ready) throw new Error('holder never reported HELD');
  await new Promise((r) => setTimeout(r, 400));

  // --- case 1: ONE path (the shape production uses) ---
  {
    const m = await resolver.resolve([held]);
    const o = m.get(held);
    check('1-path: held file reported HIT with a positive pid',
      !!o && o.pid === holder.pid,
      `got ${JSON.stringify(o)} expected pid ${holder.pid}`);
  }

  // --- case 2: TWO paths in one batch (the shape that was broken) ---
  {
    const free = path.join(ROOT, 'free.tmp');
    fs.writeFileSync(free, 'payload');
    resolver.clear();
    const m = await resolver.resolve([held, free]);
    const oh = m.get(held), of = m.get(free);
    check('2-path: held file still reported HIT in a batch',
      !!oh && oh.pid === holder.pid, `got ${JSON.stringify(oh)}`);
    check('2-path: unheld file reported null (genuinely unheld)',
      m.has(free) && of === null, `has=${m.has(free)} value=${JSON.stringify(of)}`);
    // The old bug made every entry an error, so `resolve` cached nothing and the map came back
    // PARTIAL. A missing key means "we could not ask" — that must not happen here.
    check('2-path: map covers both requested paths (no silent dropout)',
      m.size === 2, `size=${m.size} keys=${JSON.stringify([...m.keys()].map((k) => path.basename(k)))}`);
  }

  // --- case 3: THREE paths — held + unheld + nonexistent ---
  {
    const free = path.join(ROOT, 'free2.tmp');
    const ghost = path.join(ROOT, 'does-not-exist.tmp');
    fs.writeFileSync(free, 'payload');
    resolver.clear();
    const m = await resolver.resolve([held, free, ghost]);
    check('3-path: batch of 3 resolves all three',
      m.size === 3, `size=${m.size}`);
    check('3-path: held still HIT (a ghost in the batch does not poison it)',
      !!m.get(held) && m.get(held).pid === holder.pid, `got ${JSON.stringify(m.get(held))}`);
  }

  // --- case 4: 30 paths, crossing maxBatch=25 so the resolver must chunk ---
  {
    const many = [];
    for (let i = 0; i < 29; i += 1) {
      const p = path.join(ROOT, `bulk-${i}.tmp`);
      fs.writeFileSync(p, 'x');
      many.push(p);
    }
    many.push(held); // the held one last, so it lands in the SECOND chunk
    resolver.clear();
    const before = resolver.stats().spawns;
    const m = await resolver.resolve(many);
    const spawns = resolver.stats().spawns - before;
    check('30-path: every path gets an answer (chunked at maxBatch=25)',
      m.size === 30, `size=${m.size}`);
    check('30-path: held path in the SECOND chunk is still HIT',
      !!m.get(held) && m.get(held).pid === holder.pid,
      `got ${JSON.stringify(m.get(held))}`);
    check('30-path: actually chunked into 2 spawns, not 30',
      spawns === 2, `spawns=${spawns}`);
    check('30-path: unheld entries are null, not missing',
      m.get(many[0]) === null, `got ${JSON.stringify(m.get(many[0]))}`);
  }
} finally {
  try { holder?.kill(); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY pass=${results.length - failed.length} fail=${failed.length} total=${results.length}`);
for (const f of failed) console.log(`  FAILED: ${f.name}`);

setTimeout(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(failed.length === 0 ? 0 : 1);
}, 2000);
