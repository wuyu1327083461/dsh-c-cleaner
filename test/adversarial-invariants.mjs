// verifier probe: cleaner safety invariants (PRD §6.2) via INPUT SPELLING, independent of the
// known normalizePath weakness. Checks whether commonly-cited spellings are handled correctly,
// and whether a protectRoot ITSELF (not a child) is refused.
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { classify, isProtectedPath } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const cfg = resolveConfig({});
const LOG = { debug() {}, info() {}, warn() {}, error() {} };

// A writable directory under C:\ProgramData (a DEFAULT protectRoot), so the guard MUST fire.
const realRoot = path.join('C:' + B + 'ProgramData', `dshcc_inv_${STAMP}`);
fs.mkdirSync(realRoot, { recursive: true });
console.log('protectRoot (writable) =', JSON.stringify(realRoot));
console.log('isProtected(root itself, as a default protectRoot)?', isProtectedPath('C:' + B + 'ProgramData', cfg.protectRoots));
console.log('');

// ---- Part 1: spelling matrix, each pointing at a REAL file inside protectRoot ----
const victim = path.join(realRoot, `victim_${STAMP}.tmp`);
fs.writeFileSync(victim, 'q'.repeat(32));
const parent = path.dirname(realRoot);
const leaf = path.basename(realRoot);
const rel = path.relative(process.cwd(), victim);

const spellings = [
  ['long form (baseline)', victim],
  ['lowercase drive+all lower', victim.toLowerCase()],
  ['ALL UPPERCASE', victim.toUpperCase()],
  ['forward slashes (mixed)', victim.replace(/\\/g, '/')],
  ['dotdot segment', path.join(parent, '..', leaf, path.basename(victim))],
  ['trailing separator-ish dot', victim + '.'],
  ['relative path from cwd', rel],
  ['device prefix', B + B + '?' + B + victim],
  ['dot slash prefix', '.' + B + rel],
];

console.log('--- Part 1: spelling recognition (file REALLY exists inside the protectRoot) ---');
console.log(`${'spelling'.padEnd(30)} ${'protected?'.padEnd(11)} ${'exists?'.padEnd(8)} realpath`);
const rows = [];
for (const [label, sp] of spellings) {
  let prot = null, ex = false, real = '-';
  try { prot = isProtectedPath(sp, cfg.protectRoots); } catch (e) { prot = `THREW ${e.code || e.message}`; }
  try { ex = fs.existsSync(sp); } catch {}
  try { real = fs.realpathSync.native(sp); } catch (e) { real = `(THREW ${e.code})`; }
  rows.push({ label, sp, prot, ex });
  console.log(`${label.padEnd(30)} ${String(prot).padEnd(11)} ${String(ex).padEnd(8)} ${real}`);
}

// ---- Part 2: decisive clean() for any spelling that (a) exists and (b) is NOT protected ----
console.log('');
console.log('--- Part 2: decisive clean() for unrecognised-but-existing spellings ---');
const dangerous = rows.filter((r) => r.ex === true && r.prot === false);
if (!dangerous.length) {
  console.log('none: every existing spelling was recognised as protected');
} else {
  for (const d of dangerous) {
    const f = fs.existsSync(d.sp) ? d.sp : null;
    if (!f) continue;
    const c = classify({ path: d.sp, size: 32, mtimeMs: Date.now() }, { cfg });
    let rep;
    try {
      rep = await clean([{ ...c, sourceProcess: 'verifier-inv' }], { deep: false, force: true, cfg, log: LOG });
    } catch (e) {
      rep = `THREW ${e.code || e.message}`;
      console.log(`  ${d.label}: clean() THREW (PRD 6.3 violation) ${e.code || e.message}`);
      continue;
    }
    const gone = !fs.existsSync(d.sp);
    console.log(`  ${d.label}: classify=${c.category} report=${JSON.stringify(rep)} DELETED=${gone}`);
    if (gone) {
      console.log(`  >>> REAL DEFECT: clean() deleted a file inside the protectRoot via spelling "${d.label}"`);
      // restore so later spellings still have a victim
      try { fs.writeFileSync(victim, 'q'.repeat(32)); } catch {}
    }
  }
}

// ---- Part 3: is a protectRoot ITSELF refused? ----
console.log('');
console.log('--- Part 3: record pointing AT a protectRoot directory ---');
const dirRecord = classify({ path: realRoot, size: 0, mtimeMs: Date.now() }, { cfg });
let dirRep;
try {
  dirRep = await clean([{ ...dirRecord, sourceProcess: 'verifier-inv' }], { deep: true, force: true, cfg, log: LOG });
} catch (e) {
  dirRep = `THREW ${e.code || e.message}`;
}
console.log('classify(protectRoot dir) =', dirRecord.category, '|', JSON.stringify(dirRecord.reason));
console.log('clean() report            =', JSON.stringify(dirRep));
console.log('protectRoot still exists  =', fs.existsSync(realRoot));
if (!fs.existsSync(realRoot)) console.log('>>> REAL DEFECT: a protectRoot directory itself was destroyed');
else console.log('(custom protectRoot is NOT in cfg.protectRoots, so refusal would come from the hardcoded blacklist only)');

// cleanup
try { fs.rmSync(realRoot, { recursive: true, force: true }); } catch {}
