// verifier probe: does clean() refuse the bare 8.3 alias root even though the STRING-level
// isProtectedPath() misses it? And is there any over-blocking regression from the new
// realpath canonicalisation (legitimate temp files must still be deletable).
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { isProtectedPath, classify, CATEGORY } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');

const cfg = resolveConfig({});
const LOG = { debug(){}, info(){}, warn(){}, error(){} };

console.log('=== 1) bare alias root vs clean() ===');
const bareAlias = 'C:' + B + 'PROGRA~2';
console.log('isProtectedPath(bare alias) =', isProtectedPath(bareAlias, cfg.protectRoots));
const rec = [{ path: bareAlias, category: CATEGORY.SAFE, size: 0 }];
const rep = await clean(rec, { deep: true, force: true, cfg, log: LOG });
console.log('clean() report =', JSON.stringify(rep));
console.log('C:\\Program Files (x86) still exists =', fs.existsSync('C:' + B + 'Program Files (x86)'));
console.log('=>', rep.skippedList && rep.skippedList.length ? 'REFUSED (correct)' : 'DELETED (defect)');
console.log('');

console.log('=== 2) no over-blocking regression: legitimate temp files must still delete ===');
const os = await import('node:os');
const tmpBase = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp');
const dir = path.join(tmpBase, `dshcc_overblock_${process.pid}_${Date.now().toString(36)}`);
fs.mkdirSync(dir, { recursive: true });
const mk = (name, bytes) => { const p = path.join(dir, name); fs.writeFileSync(p, 'x'.repeat(bytes)); return p; };

const legit = [
  mk('plain.tmp', 64),
  mk('app.log', 32),
  mk('cache.pyc', 16),
  mk('old.bak', 8),
];
console.log('isProtectedPath for each legit temp file (must all be false):');
for (const p of legit) console.log(`  ${JSON.stringify(p)} -> ${isProtectedPath(p, cfg.protectRoots)}`);

const legitRecs = legit.map((p) => ({ path: p, category: CATEGORY.SAFE, size: fs.statSync(p).size }));
const rep2 = await clean(legitRecs, { deep: false, force: true, cfg, log: LOG });
console.log('clean() report =', JSON.stringify({ removed: rep2.removed, skipped: rep2.skipped, bytesFreed: rep2.bytesFreed, errors: rep2.errors.length }));
const survivors = legit.filter((p) => fs.existsSync(p));
console.log('survivors =', JSON.stringify(survivors));
console.log('=>', rep2.removed === 4 && survivors.length === 0
  ? 'NO OVER-BLOCKING: all 4 legitimate temp files were deleted'
  : `OVER-BLOCKING/DEFECT: removed=${rep2.removed} survivors=${survivors.length}`);
console.log('');

console.log('=== 3) a genuinely protected file is still refused (positive control) ===');
const winProbe = path.join('C:' + B + 'Windows', 'Temp', `dshcc_guard_${process.pid}.log`);
try { fs.writeFileSync(winProbe, 'x'.repeat(24)); } catch (e) { console.log('could not create probe:', e.code); }
if (fs.existsSync(winProbe)) {
  console.log('isProtectedPath =', isProtectedPath(winProbe, cfg.protectRoots));
  const rep3 = await clean([{ path: winProbe, category: CATEGORY.SAFE, size: 24 }], { deep: false, force: true, cfg, log: LOG });
  console.log('clean() report =', JSON.stringify({ removed: rep3.removed, skippedList: rep3.skippedList }));
  console.log('probe file survives =', fs.existsSync(winProbe));
  console.log('=>', fs.existsSync(winProbe) ? 'REFUSED (correct)' : 'DELETED (PRD 6.2 violation)');
  try { fs.rmSync(winProbe, { force: true }); } catch {}
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
