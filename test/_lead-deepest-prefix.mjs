// Lead: the LAST A1 gap. Current fix realpaths the PARENT only; when the parent itself does not
// exist (alias in a NON-LEAF component, e.g. C:\PROGRA~1\SomeApp\a.dll), realpath throws ENOENT and
// the alias survives into the comparison.
//
// Robust recipe: walk UP to the longest EXISTING ancestor, realpath that, re-append the remainder.
// This is the standard "realpath the deepest real prefix" pattern.
import fs from 'node:fs';
import path from 'node:path';
import { isProtectedPath } from '../lib/classifier.js';

// ---------- candidate fix ----------
function realpathDeepest(p) {
  const s = String(p);
  let cur = path.win32.resolve(s);
  const tail = [];
  // climb until realpath succeeds, collecting the components we peeled off
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      if (tail.length === 0) return real;
      return path.win32.join(real, ...tail.reverse());
    } catch {
      const parent = path.win32.dirname(cur);
      if (parent === cur) return s;            // reached the root and still threw: give up
      tail.push(path.win32.basename(cur));
      cur = parent;
    }
  }
}

// Prove the gap is REAL by building an actual protected-root file whose spelling carries an alias
// in an intermediate component. I cannot write to C:\Program Files, so use a protectRoot-like
// directory I CAN create and register it via the cfg.protectRoots argument.
const PROBE_ROOT = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp\\dshcc-deep-alias-probe';
fs.rmSync(PROBE_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(PROBE_ROOT, 'SomeApp'), { recursive: true });

console.log('=== build a real file under a protected root ===');
const TRUE_PATH = path.join(PROBE_ROOT, 'SomeApp', 'a.dll');
fs.writeFileSync(TRUE_PATH, 'x'.repeat(64));
console.log('  true path   :', TRUE_PATH, 'size', fs.statSync(TRUE_PATH).size);

// The dangerous spelling: an alias in an INTERMEDIATE component, leaf missing from disk.
// Simulate by using a nonexistent leaf under a REAL intermediate alias.
const aliasSpelling = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp\\dshcc-deep-alias-probe\\SomeApp\\a.dll';
console.log('  spelling    :', aliasSpelling);

console.log('\n=== the exact structural case: alias parent + missing leaf ===');
const cases = [
  'C:\\PROGRA~1\\SomeApp\\a.dll',                 // alias dir exists, leaf does not
  'C:\\PROGRA~1\\evil.exe',                       // alias dir exists, leaf does not (already works)
  'C:\\PROGRA~1\\SomeApp\\nested\\deep.dll',      // two missing components after the alias
  'C:\\PROGRA~2\\Nope\\b.dll',
  'C:\\Windows\\System32\\drivers\\etc\\hosts',   // control: fully real
  'C:\\Windows\\notepad.exe',                     // control
];
for (const c of cases) {
  const dir = path.dirname(c);
  let parentReal = null;
  try { parentReal = fs.realpathSync.native(dir); } catch (e) { parentReal = `THREW ${e.code}`; }
  const deep = realpathDeepest(c);
  console.log(`  ${c}`);
  console.log(`      realpath(parent)  = ${parentReal}`);
  console.log(`      realpathDeepest() = ${deep}`);
}

console.log('\n=== proof the gap is NOT cosmetic: deepest-prefix expansion ===');
// Now the real demonstration. Take a path where an INTERMEDIATE component is an alias.
// C:\PROGRA~1 IS a live alias; C:\Program Files\SomeApp does not exist here, but if it did, the
// file would be inside C:\Program Files. realpathDeepest resolves the alias regardless.
for (const c of ['C:\\PROGRA~1\\SomeApp\\a.dll', 'C:\\PROGRA~1\\SomeApp\\nested\\deep.dll']) {
  const deep = realpathDeepest(c);
  const protectedNow = isProtectedPath(c);
  const protectedDeep = /^c:\\program files\\/i.test(deep);
  console.log(`  ${JSON.stringify(c)}`);
  console.log(`      current isProtectedPath            = ${protectedNow}`);
  console.log(`      realpathDeepest()                  = ${deep}`);
  console.log(`      deepest form lands in C:\\Program Files = ${protectedDeep}`);
  console.log(`      >>> ${protectedDeep && !protectedNow ? 'REAL GAP: current code MISSES a path that is provably inside a protected root' : 'covered'}`);
}

fs.rmSync(PROBE_ROOT, { recursive: true, force: true });
