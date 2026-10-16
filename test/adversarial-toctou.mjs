// verifier probe: TOCTOU / cache-poisoning against the NEW junction fix.
// lib/cleaner.js:502 claims the guard "must not depend on a cached resolve taken at classify
// time". That is a testable claim: classify()/guard a NORMAL directory, then REPLACE it with a
// junction into a protectRoot before clean() runs. If the fix honoured a stale memo, the
// junction would slip through and the protected file would be deleted.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { isProtectedPath, classify } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');
const LOG = { debug(){}, info(){}, warn(){}, error(){} };

const cfg = resolveConfig({});
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const base = path.join(process.env.LOCALAPPDATA || '', 'Temp');
let failures = 0;
const verdict = (ok, msg) => { console.log('  ->', ok ? 'OK' : 'DEFECT:', msg); if (!ok) failures++; };

console.log('=== TOCTOU 1: swap a benign dir for a junction AFTER the guard ran ===');
const holder = path.join(base, `dshcc_toctou_${STAMP}`);
fs.mkdirSync(holder, { recursive: true });
const victimReal = path.join('C:' + B + 'Windows', 'Temp', `dshcc_toctou_victim_${STAMP}.log`);
fs.writeFileSync(victimReal, 'V'.repeat(64));

// (1) A real, benign directory that is NOT a junction yet.
const dir = path.join(holder, 'cache');
fs.mkdirSync(dir, { recursive: true });
const fileBenign = path.join(dir, `victim_${STAMP}.log`);
fs.writeFileSync(fileBenign, 'V'.repeat(64));
console.log('  benign file   =', JSON.stringify(fileBenign));
console.log('  isProtected(benign)  =', isProtectedPath(fileBenign, cfg.protectRoots), '(must be false)');
const cls = classify({ path: fileBenign, size: 64 }, { cfg });
console.log('  classify(categorised BEFORE the swap) =', cls.category);
console.log('  -> now the attacker/tooling replaces the real dir with a junction');
for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
fs.rmdirSync(dir);
const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', dir, 'C:' + B + 'Windows' + B + 'Temp'], { encoding: 'utf8' });
if (!fs.existsSync(dir)) { console.log('  junction creation failed:', (r.stderr || r.stdout || '').trim()); process.exit(0); }
// The victim is now reachable under the SAME spelling via the new junction.
fs.writeFileSync(victimReal, 'V'.repeat(64));
const fileViaNowJunction = path.join(dir, path.basename(victimReal));
console.log('  junction      =', JSON.stringify(dir), '-> C:\\Windows\\Temp');
console.log('  same spelling now resolves to =', JSON.stringify(fs.realpathSync.native(fileViaNowJunction)));
console.log('  isProtected(spelling after swap) =', isProtectedPath(fileViaNowJunction, cfg.protectRoots));
const rep = await clean([{ path: fileViaNowJunction, category: cls.category, size: 64 }], { force: true, cfg, log: LOG });
console.log('  clean() report =', JSON.stringify({ removed: rep.removed, skipped: rep.skipped, bytesFreed: rep.bytesFreed, skippedList: rep.skippedList }));
const survives = fs.existsSync(victimReal);
verdict(survives, `stale-memo TOCTOU: protected victim survives=${survives}`);
try { fs.rmSync(victimReal, { force: true }); } catch {}
console.log('');

console.log('=== TOCTOU 2: same swap, 200 iterations (race the memo) ===');
let leaked = 0;
for (let i = 0; i < 200; i++) {
  const holder2 = path.join(base, `dshcc_toctou2_${STAMP}_${i}`);
  fs.mkdirSync(holder2, { recursive: true });
  const d2 = path.join(holder2, 'c');
  fs.mkdirSync(d2, { recursive: true });
  const vic = path.join('C:' + B + 'Windows', 'Temp', `dshcc_t2_${STAMP}_${i}.log`);
  fs.writeFileSync(vic, 'x'.repeat(8));
  const p = path.join(d2, path.basename(vic));
  // classify BEFORE the swap (populates any per-directory memo on the benign spelling)
  classify({ path: p, size: 8 }, { cfg });
  isProtectedPath(p, cfg.protectRoots);
  fs.rmdirSync(d2);
  spawnSync('cmd.exe', ['/c', 'mklink', '/J', d2, 'C:' + B + 'Windows' + B + 'Temp'], { encoding: 'utf8' });
  const rep2 = await clean([{ path: p, category: 'SAFE_TO_DELETE', size: 8 }], { force: true, cfg, log: LOG });
  if (rep2.removed > 0 && !fs.existsSync(vic)) leaked++;
  try { fs.rmSync(d2, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(holder2, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(vic, { force: true }); } catch {}
}
console.log('  iterations = 200; protected victims destroyed =', leaked);
verdict(leaked === 0, `200 consecutive TOCTOU races: destroyed=${leaked}`);
console.log('');

console.log('=== CONCURRENCY: 2 parallel clean() calls on distinct files ===');
const cdir = path.join(base, `dshcc_conc_${STAMP}`);
fs.mkdirSync(cdir, { recursive: true });
const f1 = path.join(cdir, 'a.tmp'); const f2 = path.join(cdir, 'b.tmp');
fs.writeFileSync(f1, 'a'.repeat(16)); fs.writeFileSync(f2, 'b'.repeat(16));
const [r1, r2] = await Promise.all([
  clean([{ path: f1, category: 'SAFE_TO_DELETE', size: 16 }], { force: true, cfg, log: LOG }),
  clean([{ path: f2, category: 'SAFE_TO_DELETE', size: 16 }], { force: true, cfg, log: LOG }),
]);
const okConc = !fs.existsSync(f1) && !fs.existsSync(f2) && r1.removed === 1 && r2.removed === 1;
console.log('  r1 =', JSON.stringify({ removed: r1.removed, bytesFreed: r1.bytesFreed }), 'r2 =', JSON.stringify({ removed: r2.removed, bytesFreed: r2.bytesFreed }));
verdict(okConc, `parallel clean() both succeeded and did not corrupt each other`);
try { fs.rmSync(cdir, { recursive: true, force: true }); } catch {}

console.log('');
console.log(`>>> ${failures === 0 ? 'NO TOCTOU/CACHE-POISONING DEFECT' : failures + ' DEFECT(S) FOUND'}`);
try { fs.rmSync(holder, { recursive: true, force: true }); } catch {}
