// verifier probe: does a LITERAL '..' segment defeat the protection?
// NOTE: path.join/path.resolve NORMALIZE '..' away, so a naive test proves nothing.
// A meaningful test must confirm the OS actually resolves the literal string to the victim.
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { isProtectedPath } = await import('../lib/classifier.js');

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const cfg = resolveConfig({});
const root = path.join('C:' + B + 'ProgramData', `dshcc_dd_${STAMP}`);
fs.mkdirSync(root, { recursive: true });
const victim = path.join(root, `victim_${STAMP}.tmp`);
fs.writeFileSync(victim, 'd'.repeat(16));

// Build LITERAL '..' spellings that the OS resolves back to the victim.
const leaf = path.basename(root);
const spellings = [
  ['round trip: root/../root/file', 'C:' + B + 'ProgramData' + B + leaf + B + '..' + B + leaf + B + path.basename(victim)],
  ['via a sibling-less hop',        'C:' + B + 'ProgramData' + B + 'nonexistent' + B + '..' + B + leaf + B + path.basename(victim)],
  ['dotdot + device prefix',        B + B + '?' + B + 'C:' + B + 'ProgramData' + B + leaf + B + '..' + B + leaf + B + path.basename(victim)],
];

console.log('victim =', JSON.stringify(victim));
console.log('');
console.log(`${'spelling'.padEnd(34)} ${'protected?'.padEnd(11)} ${'exists?'.padEnd(8)} ${'realpath resolves to victim?'}`);
for (const [label, sp] of spellings) {
  let prot = null, ex = false, same = null, real = '-';
  try { prot = isProtectedPath(sp, cfg.protectRoots); } catch (e) { prot = `THREW ${e.code || e.message}`; }
  try { ex = fs.existsSync(sp); } catch {}
  try {
    real = fs.realpathSync.native(sp);
    same = real.toLowerCase() === fs.realpathSync.native(victim).toLowerCase();
  } catch (e) { real = `(THREW ${e.code})`; }
  console.log(`${label.padEnd(34)} ${String(prot).padEnd(11)} ${String(ex).padEnd(8)} ${same === null ? real : same}`);
  if (ex && prot === false && same === true) {
    console.log(`   >>> REAL DEFECT: literal '..' spelling resolves to the protected victim but is NOT protected`);
  }
}
// Also confirm what path.resolve does to each (why lexical normalisation "usually" saves it)
console.log('');
for (const [label, sp] of spellings) {
  console.log(`  path.resolve(${label}) = ${JSON.stringify(path.resolve(sp))}`);
}
fs.rmSync(root, { recursive: true, force: true });
