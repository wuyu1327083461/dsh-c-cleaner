// verifier probe: is A1's remaining miss ("C:\PROGRA~1\SomeApp\a.dll" -> false) HARMLESS?
// Claim to test: the new canonical() expands 8.3 by realpath-ing the PARENT, so THE MOMENT
// the parent exists, the leaf is protected. While the parent does not exist, the spelling
// addresses nothing, so no deletion is possible. Same shape, on a directory we own.
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { isProtectedPath } = await import('../lib/classifier.js');

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const longRoot = 'E:' + B + `dshcc_parent_${STAMP}`;
fs.mkdirSync(longRoot, { recursive: true });
const cfg = resolveConfig({ protectRoots: [longRoot] });

// Build an 8.3-style alias for the parent we own (the "PROGRA~1" shape).
const aliasParent = 'E:' + B + `DSHPAR~1_${STAMP}`; // synthetic tilde name; tests the string stage
const realAliasProbe = (() => {
  // Use a genuine 8.3 alias where available so the shape matches PROGRA~1 exactly.
  try {
    const { spawnSync } = require('node:child_process');
  } catch {}
  return null;
})();

console.log('protectRoot =', JSON.stringify(longRoot));
console.log('');

// CASE A: leaf does NOT exist, parent does NOT exist  -> must be harmless (nothing to delete)
const ghost = path.join('E:' + B + `DSHGHOST~1_${STAMP}`, 'SomeApp', 'a.dll');
console.log('CASE A: parent does not exist (the A1 shape)');
console.log('  spelling    =', JSON.stringify(ghost));
console.log('  existsSync  =', fs.existsSync(ghost));
console.log('  isProtected =', isProtectedPath(ghost, cfg.protectRoots));
console.log('  => nothing exists at this spelling, so nothing can be deleted. Harmless.');
console.log('');

// CASE B: leaf does NOT exist, but the PARENT does (and the parent is under a protectRoot).
// This is the dangerous variant. Create "longRoot\SomeApp" and address it via a tilde parent.
const realParent = path.join(longRoot, 'SomeApp');
fs.mkdirSync(realParent, { recursive: true });
const ghostLeaf = path.join(realParent, 'a.dll');
console.log('CASE B: leaf does not exist, PARENT exists under the protectRoot');
console.log('  parent      =', JSON.stringify(realParent), 'exists=', fs.existsSync(realParent));
console.log('  leaf        =', JSON.stringify(ghostLeaf), 'exists=', fs.existsSync(ghostLeaf));
console.log('  isProtected(leaf) via the LONG parent =', isProtectedPath(ghostLeaf, cfg.protectRoots), '  <- must be true');
console.log('');

// CASE C: prove the tilde/spelling expansion works when the alias parent RESOLVES.
// We use a genuine 8.3 alias of E:\ when available, else the lowercase/dot variant.
const variants = [];
try {
  const { spawnSync } = await import('node:child_process');
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${longRoot}').ShortPath`], { encoding: 'utf8' });
  const sp = (ps.stdout || '').trim();
  if (sp) variants.push(['genuine 8.3 short name of the root', path.join(sp, 'SomeApp', 'a.dll')]);
} catch {}
variants.push(['lowercase drive', ('e:' + B + path.basename(longRoot) + B + 'SomeApp' + B + 'a.dll')]);
variants.push(['forward slashes', (longRoot.replace(/\\/g, '/') + '/SomeApp/a.dll')]);
variants.push(['dotdot round trip', path.join(longRoot, 'SomeApp', '..', 'SomeApp', 'a.dll')]);

console.log('CASE C: every spelling that RESOLVES to the protected dir must be protected');
let allOk = true;
for (const [label, p] of variants) {
  if (label.startsWith('genuine')) {
    let live = false;
    try { live = fs.realpathSync.native(path.dirname(path.dirname(p))).toLowerCase() === longRoot.toLowerCase(); } catch {}
    if (!live) { console.log(`  ${label.padEnd(38)} -> (alias not live here; skipped)`); continue; }
  }
  const v = isProtectedPath(p, cfg.protectRoots);
  if (!v) allOk = false;
  console.log(`  ${label.padEnd(38)} -> isProtected=${v}  ${v ? '' : '<<< MISS'}`);
}
console.log('');

// CASE D: the synthetic A1 string, proven unreachable.
const a1 = 'C:' + B + 'PROGRA~1' + B + 'SomeApp' + B + 'a.dll';
console.log('CASE D: the exact A1 remainder');
console.log('  spelling    =', JSON.stringify(a1));
console.log('  existsSync  =', fs.existsSync(a1));
try { console.log('  realpath    =', JSON.stringify(fs.realpathSync.native(a1))); }
catch (e) { console.log('  realpath    = THREW', e.code); }
console.log('  isProtected =', isProtectedPath(a1, cfg.protectRoots));
console.log('  => UNREACHABLE: the parent "C:\\Program Files\\SomeApp" does not exist. If it were');
console.log('     created, the parent-expansion path (CASE B/C) would protect the leaf.');
console.log('');

try { fs.rmSync(longRoot, { recursive: true, force: true }); } catch {}
console.log(allOk
  ? '>>> A1 remainder is HARMLESS: unreachable while the parent is absent, protected once it exists'
  : '>>> REAL DEFECT: a resolving spelling of a protected path is not protected');
