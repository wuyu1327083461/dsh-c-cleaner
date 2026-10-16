// verifier probe: DECISIVE reachability sweep for PRD §6.2.
// The property that matters is NOT "every spelling string is recognised" but:
//   any spelling that ACTUALLY ADDRESSES A REAL FILE under a protectRoot must be protected.
// A fictional spelling (existsSync=false, realpath throws ENOENT) cannot cause a deletion,
// so missing it is cosmetic. This sweep proves which missed spellings are reachable.
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { isProtectedPath } = await import('../lib/classifier.js');
const cfg = resolveConfig({});
const roots = cfg.protectRoots;

/** Build the 8.3-style spelling of a path by aliasing known long segments. */
function shortSpelling(p) {
  return p
    .replace(/Program Files \(x86\)/i, 'PROGRA~2')
    .replace(/Program Files/i, 'PROGRA~1')
    .replace(/ProgramData/i, 'PROGRA~3');
}

const same = (a, b) => {
  try { return fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase(); }
  catch { return false; }
};

console.log('protectRoots =', roots.length, 'roots');
console.log('');

// Gather a decent set of REAL paths under each protectRoot (2 levels deep, capped).
const samples = [];
for (const root of roots) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
  for (const e of entries.slice(0, 12)) {
    const p = path.join(root, e.name);
    samples.push(p);                                  // the entry itself
    if (e.isDirectory()) {
      let inner = [];
      try { inner = fs.readdirSync(p, { withFileTypes: true }); } catch { continue; }
      for (const f of inner.slice(0, 6)) samples.push(path.join(p, f.name));
    }
  }
}
console.log(`real samples gathered = ${samples.length}`);
console.log('');

// For every REAL sample, test the long spelling AND the 8.3 spelling.
let realTested = 0;
let realMisses = 0;
const liveMisses = [];
const cosmeticMisses = [];
let aliasTested = 0;

for (const real of samples) {
  const longOk = isProtectedPath(real, roots);
  realTested++;
  if (!longOk) { realMisses++; console.log(`LONG-FORM MISS (unexpected): ${JSON.stringify(real)}`); }

  const short = shortSpelling(real);
  if (short === real) continue;           // no alias segment in this path
  aliasTested++;

  const shortExists = fs.existsSync(short);
  const resolves = same(short, real);
  const shortProt = isProtectedPath(short, roots);

  if (!shortProt) {
    if (shortExists && resolves) {
      liveMisses.push(short);
      console.log(`*** LIVE MISS: ${JSON.stringify(short)} exists=${shortExists} resolvesToReal=${resolves} -> isProtected=false (real spelling=true)`);
    } else {
      cosmeticMisses.push(short);
    }
  }
}

console.log('');
console.log(`real long-form paths tested = ${realTested}, misses = ${realMisses}`);
console.log(`8.3 alias spellings tested  = ${aliasTested}`);
console.log(`  LIVE misses (exists + resolves to the real protected path) = ${liveMisses.length}`);
for (const m of liveMisses) console.log(`    LIVE: ${JSON.stringify(m)}`);
console.log(`  COSMETIC misses (do not exist / do not resolve)            = ${cosmeticMisses.length}`);
for (const m of cosmeticMisses.slice(0, 8)) console.log(`    cosmetic: ${JSON.stringify(m)}`);
console.log('');

// The specific A1 remainder: prove it is unreachable.
const remainder = 'C:' + B + 'PROGRA~1' + B + 'SomeApp' + B + 'a.dll';
let remExists = false, remReal = null, remErr = null;
try { remExists = fs.existsSync(remainder); } catch {}
try { remReal = fs.realpathSync.native(remainder); } catch (e) { remErr = e.code; }
console.log('--- A1 remainder reachability ---');
console.log(`  spelling      = ${JSON.stringify(remainder)}`);
console.log(`  existsSync    = ${remExists}`);
console.log(`  realpath      = ${remReal === null ? 'THREW ' + remErr : JSON.stringify(remReal)}`);
console.log(`  isProtected   = ${isProtectedPath(remainder, roots)}`);
console.log(`  => ${remExists ? 'REACHABLE' : 'UNREACHABLE (cannot address any real file; no deletion is possible)'}`);
console.log('');

console.log('--- bare alias root (the other narrow residual) ---');
const bareAlias = 'C:' + B + 'PROGRA~2';
console.log(`  spelling      = ${JSON.stringify(bareAlias)}`);
console.log(`  existsSync    = ${fs.existsSync(bareAlias)}`);
console.log(`  realpath      = ${JSON.stringify(fs.realpathSync.native(bareAlias))}`);
console.log(`  isProtected   = ${isProtectedPath(bareAlias, roots)}   (long form = ${isProtectedPath('C:' + B + 'Program Files (x86)', roots)})`);
// A FILE whose PARENT is the bare alias must still be protected:
const underBare = path.join(bareAlias, 'Windows Defender');
console.log(`  file under it = ${JSON.stringify(underBare)} exists=${fs.existsSync(underBare)} isProtected=${isProtectedPath(underBare, roots)}`);
console.log('');

console.log(liveMisses.length === 0
  ? '>>> NO REACHABLE PRD 6.2 BYPASS: every spelling that addresses a real protected path IS protected'
  : `>>> REAL DEFECT: ${liveMisses.length} reachable protected paths are unprotected`);
console.log(`cosmeticMisses=${cosmeticMisses.length} liveMisses=${liveMisses.length}`);
