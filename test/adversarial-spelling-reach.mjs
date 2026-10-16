// verifier probe: are the A1 "spelling misses" LIVE bypasses or cosmetic?
// A miss only matters if the spelling can actually reach the real protected file.
// Windows historically strips trailing dots/spaces in path components, so test reachability
// with existsSync / openSync / realpath, and then whether clean() would act on such a record.
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { isProtectedPath, classify } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');
const { resolveConfig } = await import('../lib/config.js');
const cfg = resolveConfig({});
const LOG = { debug() {}, info() {}, warn() {}, error() {} };

const REAL = 'C:' + B + 'Windows' + B + 'notepad.exe';
console.log('real target exists =', fs.existsSync(REAL), '| isProtectedPath(real) =', isProtectedPath(REAL, cfg.protectRoots));

const spellings = [
  ['trailing space in component', 'C:' + B + 'Windows ' + B + 'notepad.exe'],
  ['trailing dot in component', 'C:' + B + 'Windows.' + B + 'notepad.exe'],
  ['trailing space on file', REAL + ' '],
  ['trailing dot on file', REAL + '.'],
  ['device prefix', B + B + '?' + B + REAL],
  ['device + UNC', B + B + '?' + B + 'UNC' + B + 'localhost' + B + 'C$' + B + 'Windows' + B + 'notepad.exe'],
  ['8.3 alias of Program Files', 'C:' + B + 'PROGRA~1' + B + 'evil.exe'],
];

for (const [label, sp] of spellings) {
  let exists = null, realpath = null, open = null, prot = null, cat = null;
  try { exists = fs.existsSync(sp); } catch (e) { exists = `THREW ${e.code}`; }
  try { realpath = fs.realpathSync.native(sp); } catch (e) { realpath = `THREW ${e.code}`; }
  try { fs.closeSync(fs.openSync(sp, 'r')); open = 'readable'; } catch (e) { open = e.code; }
  try { prot = isProtectedPath(sp, cfg.protectRoots); } catch (e) { prot = `THREW ${e.code}`; }
  try { cat = classify({ path: sp, size: 1, mtimeMs: Date.now() }, { cfg }).category; } catch (e) { cat = `THREW ${e.code}`; }

  const reachesReal = typeof realpath === 'string' && realpath.toLowerCase() === REAL.toLowerCase();
  const verdict = reachesReal && prot === false ? '*** LIVE BYPASS (reaches the real protected file, guard says false)' : 'cosmetic (spelling does not reach the real file)';
  console.log(`\n${label}`);
  console.log(`  spelling    = ${JSON.stringify(sp)}`);
  console.log(`  existsSync  = ${exists}`);
  console.log(`  realpath    = ${realpath}`);
  console.log(`  openSync r  = ${open}`);
  console.log(`  isProtected = ${prot} | classify = ${cat}`);
  console.log(`  --> ${verdict}`);
}

// Decisive step: can clean() actually delete through a spelling that defeats the guard?
// Use a sacrificial file that genuinely sits INSIDE a protected root but is regenerable:
// we do NOT touch real system files. Instead prove the mechanism on a temp-created file
// placed under a root we add to protectRoots, mimicking the protection semantics.
const ROOT = path.join('C:' + B + 'ProgramData', `dshcc_spell_victim_${process.pid}`);
fs.mkdirSync(ROOT, { recursive: true });
const victim = path.join(ROOT, 'victim.tmp');
fs.writeFileSync(victim, 'x'.repeat(32));
const shortSpelling = victim.replace(/^C:\\ProgramData/, 'C:' + B + 'PROGRA~3');
const roots = [ROOT];
console.log('\n--- decisive: clean() through a guard-defeating spelling ---');
console.log('protectRoots      =', JSON.stringify(roots));
console.log('victim real path  =', JSON.stringify(victim));
console.log('victim spelling   =', JSON.stringify(shortSpelling));
console.log('isProtected(real) =', isProtectedPath(victim, roots), '| isProtected(spelling) =', isProtectedPath(shortSpelling, roots));
const rec = { path: shortSpelling, size: 32, category: 'SAFE_TO_DELETE', isLocked: false, lockedByPid: null, lockedByProcess: null, reason: 'probe', sourceProcess: 'verifier', mtimeMs: Date.now() };
const rep = await clean([rec], { deep: false, force: true, cfg: { ...cfg, protectRoots: roots }, log: LOG });
console.log('clean() report    =', JSON.stringify(rep));
console.log('victim still exists =', fs.existsSync(victim));
if (!fs.existsSync(victim)) {
  console.log('>>> REAL DEFECT: clean() DELETED a file inside a protectRoot via the 8.3 spelling');
} else {
  console.log('>>> refused / kept');
}
fs.rmSync(ROOT, { recursive: true, force: true });
