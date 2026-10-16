// verifier probe: category-selection semantics (PRD §3.3 + §4 + §7).
// PRD says: 🟢 SAFE is deleted by default, 🟡 CAUTION only with --deep, 🔴 LOCKED is
// "锁定置灰（不可选）" — NEVER deletable. lib/cleaner.js:452-460 implements that as a
// category gate. This probe drives clean() directly with forged categories to confirm the
// gate is on CATEGORY, not on the caller, and that unknown/absent categories fail closed.
import fs from 'node:fs';
import path from 'node:path';

const { resolveConfig } = await import('../lib/config.js');
const { CATEGORY } = await import('../lib/config.js').then((m) => m).catch(() => ({})).then(async (m) => {
  const c = await import('../lib/classifier.js');
  return m.CATEGORY ? m : { CATEGORY: c.CATEGORY };
});
const { clean } = await import('../lib/cleaner.js');
const LOG = { debug(){}, info(){}, warn(){}, error(){} };
const cfg = resolveConfig({});
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const dir = path.join(process.env.LOCALAPPDATA || '', 'Temp', `dshcc_cat_${STAMP}`);
fs.mkdirSync(dir, { recursive: true });
let failures = 0;
const verdict = (ok, msg) => { console.log('  ->', ok ? 'OK' : 'DEFECT:', msg); if (!ok) failures++; };

async function trial(label, category, opts, expectDeleted) {
  const f = path.join(dir, `${label.replace(/[^a-z0-9]+/gi, '_')}.tmp`);
  fs.writeFileSync(f, 'C'.repeat(40));
  const rec = { path: f, category, size: 40 };
  const rep = await clean([rec], { ...opts, cfg, log: LOG });
  const deleted = !fs.existsSync(f);
  const ok = deleted === expectDeleted;
  const reason = rep.skippedList?.[0]?.reason;
  console.log(`  ${label.padEnd(42)} deleted=${String(deleted).padEnd(5)} removed=${rep.removed} skipped=${rep.skipped}${reason ? '\n      reason: ' + reason : ''}`);
  if (!ok) failures++;
  return { deleted, rep };
}

console.log('CATEGORY=SAFE, no flags  -> must DELETE (PRD §4 default):');
await trial('SAFE, default', 'SAFE_TO_DELETE', {}, true);
console.log('');
console.log('CATEGORY=CAUTION -> only with --deep (PRD §4):');
await trial('CAUTION, default (no --deep)', 'CAUTION_CACHE', {}, false);
await trial('CAUTION, --deep', 'CAUTION_CACHE', { deep: true }, true);
console.log('');
console.log('CATEGORY=LOCKED -> NEVER, at any flag combination (PRD §3.3 严禁删除):');
await trial('LOCKED, default', 'LOCKED_CRITICAL', {}, false);
await trial('LOCKED, --deep', 'LOCKED_CRITICAL', { deep: true }, false);
await trial('LOCKED, --force', 'LOCKED_CRITICAL', { force: true }, false);
await trial('LOCKED, --deep --force', 'LOCKED_CRITICAL', { deep: true, force: true }, false);
console.log('');
console.log('MALFORMED categories must FAIL CLOSED (not delete):');
await trial('category = undefined', undefined, {}, false);
await trial('category = null', null, {}, false);
await trial('category = "" (empty string)', '', {}, false);
await trial('category = "GARBAGE"', 'GARBAGE', { deep: true, force: true }, false);
await trial('category = "safe_to_delete" (wrong case)', 'safe_to_delete', { deep: true, force: true }, false);
console.log('');
console.log('FORGED SAFE on a LOCKED file (a real exclusive lock is held):');
{
  const { spawn } = await import('node:child_process');
  const f = path.join(dir, 'forged_safe_locked.tmp');
  fs.writeFileSync(f, 'F'.repeat(40));
  const script = `$ErrorActionPreference='Stop'; $f=[System.IO.File]::Open('${f.replace(/\\/g, '\\\\')}','Open','ReadWrite','None'); [System.IO.File]::WriteAllText('${f.replace(/\\/g, '\\\\')}.ready','ok'); Start-Sleep -Seconds 45; $f.Close()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore' });
  const t0 = Date.now();
  while (!fs.existsSync(f + '.ready') && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
  const held = fs.existsSync(f + '.ready');
  console.log('  exclusive lock held =', held);
  // The record LIES: claims SAFE, but the file is locked right now.
  const rep = await clean([{ path: f, category: 'SAFE_TO_DELETE', size: 40 }], { force: true, cfg, log: LOG });
  const deleted = !fs.existsSync(f);
  console.log('  clean() report =', JSON.stringify({ removed: rep.removed, skipped: rep.skipped, skippedList: rep.skippedList }));
  verdict(!deleted, `instant re-validation beat the forged category: locked file deleted=${deleted}`);
  try { child.kill(); } catch {}
  try { fs.rmSync(f + '.ready', { force: true }); } catch {}
  try { fs.rmSync(f, { force: true }); } catch {}
}

console.log('');
console.log(`>>> ${failures === 0 ? 'CATEGORY GATE CORRECT: LOCKED never selectable, CAUTION only with --deep, malformed fails closed' : failures + ' DEFECT(S) in the category gate'}`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
