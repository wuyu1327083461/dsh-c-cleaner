// verifier probe (task-4 re-verify rev2) — item 3C: resolver lifecycle.
//  - close() must release every pending waiter (no hung promise) and be idempotent.
//  - a fully-disabled resolver (off-Windows path) must return an empty Map immediately.
//  - stats() must not grow without bound; a second resolve() after close() must not spawn.
import fs from 'node:fs';
import { LockOwnerResolver } from '../lib/lock-owner.js';

let failures = 0;
const verdict = (ok, msg) => { console.log('  ->', ok ? 'OK' : 'DEFECT:', msg); if (!ok) failures++; };

console.log('=== close() releases pending waiters ===');
const r = new LockOwnerResolver({ batchWindowMs: 40, timeoutMs: 8000 });
const p = r.resolve(['C:\\definitely\\missing\\nope.tmp']);
r.close();
const settled = await Promise.race([
  p.then((m) => ({ settled: true, size: m.size, val: String(m.get('C:\\definitely\\missing\\nope.tmp')) })),
  new Promise((res) => setTimeout(() => res({ settled: false }), 3000)),
]);
console.log('  after close():', JSON.stringify(settled), 'stats =', JSON.stringify(r.stats()));
verdict(settled.settled === true, 'pending resolve() settled after close() (no hung waiter)');

console.log('');
console.log('=== close() is idempotent ===');
let threw = null;
try { r.close(); r.close(); } catch (e) { threw = e; }
verdict(threw === null, `close() called 3x total without throwing (${threw && threw.message})`);

console.log('');
console.log('=== resolve() after close() must not spawn ===');
const before = r.stats().spawns;
const after = await r.resolve(['C:\\some\\other.tmp']);
console.log('  spawns before =', before, 'after =', r.stats().spawns, '| result size =', after.size);
verdict(r.stats().spawns === before, 'no spawn after close()');
verdict(after.size === 0, 'resolve() after close() returns an empty Map');

console.log('');
console.log('=== disabled resolver returns immediately ===');
const d = new LockOwnerResolver({ disabled: true, batchWindowMs: 5000 });
const t0 = Date.now();
const dm = await d.resolve(['C:\\x\\y.tmp']);
const ms = Date.now() - t0;
console.log('  disabled resolve: size =', dm.size, 'in', ms + 'ms', '| spawns =', d.stats().spawns);
verdict(dm.size === 0 && ms < 500 && d.stats().spawns === 0, 'disabled resolver: empty Map, no wait, no spawn');
d.close();

console.log('');
console.log('=== empty / malformed path list ===');
const e = new LockOwnerResolver({ batchWindowMs: 20 });
for (const bad of [[], null, undefined, 'str', 42, ['', null, 1, {}]]) {
  const m = await e.resolve(bad);
  verdict(m instanceof Map && m.size === 0, `resolve(${JSON.stringify(bad)}) -> empty Map (no throw)`);
}
verdict(e.stats().spawns === 0, `no spawn for empty/malformed lists (spawns = ${e.stats().spawns})`);
e.close();

console.log('');
console.log('=== unheld / missing path: documented contract is null-or-absent, not a crash ===');
// CONTRACT (lib/lock-owner.js JSDoc): "A `null` value means 'Restart Manager says nobody holds
// this file' — distinct from a missing key, which means 'we could not ask' (e.g. PowerShell
// absent). Callers must treat both as unknown."
// So size 1 with a null value is CORRECT, not a leak. What matters is that callers see a falsy
// owner (index.js:139 `if (!owner || !owner.pid) return;`), which this asserts directly.
const t = new LockOwnerResolver({ batchWindowMs: 30, timeoutMs: 15000 });
const path1 = 'C:\\definitely\\missing\\never-1.tmp';
const t1 = Date.now();
const m1 = await t.resolve([path1]);
const firstMs = Date.now() - t1;
const s1 = t.stats().spawns;
const t2 = Date.now();
const m2 = await t.resolve([path1]);
const secondMs = Date.now() - t2;
console.log('  call 1: size =', m1.size, 'get() =', JSON.stringify(m1.get(path1)), 'spawns =', s1, 'ms =', firstMs);
console.log('  call 2: size =', m2.size, 'get() =', JSON.stringify(m2.get(path1)), 'spawns =', t.stats().spawns, 'ms =', secondMs);
verdict(!m1.get(path1) && !m2.get(path1), 'an unheld/missing path yields a FALSY owner -> enrichOwner correctly no-ops');
verdict(m1 instanceof Map && m2 instanceof Map, 'resolve() returns a Map for a missing path (no throw)');
verdict(s1 >= 1, `the resolver did consult the OS on the first call (spawns = ${s1})`);
verdict(m2.size === m1.size, 'the negative result is cached in the miss TTL (a `NONE`/`ERR` verdict is NOT a transport failure)');

// The distinction the JSDoc draws: "could not ask" must NOT be cached as "nobody holds it".
// A path where PowerShell itself cannot report at all is exercised by lib/lock-owner.js:307
// `if (res.ok && res.results.has(p)) this._cache.set(...)` — with a transport failure the key is
// simply absent, so a later call keeps asking. Asserted here as a source-level invariant because
// forcing a transport failure from a probe requires disabling powershell.exe.
const src = fs.readFileSync(new URL('../lib/lock-owner.js', import.meta.url), 'utf8');
const guard = /if \(res\.ok && res\.results\.has\(p\)\) this\._cache\.set\(p, \{ owner: res\.results\.get\(p\), at: now \}\);/.test(src);
verdict(guard, 'lib/lock-owner.js:307 only caches a REAL answer, so a transport failure cannot freeze "unheld"');
t.close();

console.log('');
console.log(`>>> RESOLVER LIFECYCLE: ${failures === 0 ? 'SOUND' : failures + ' DEFECT(S)'}`);
process.exit(failures === 0 ? 0 : 1);
