// Lead: PROVE the memoized canonicalization catches the junction, not just that it is fast.
// The memoized variant caches the resolved DIRNAME. For the junction case the dirname IS the
// reparse point, so a single resolution per directory still resolves it into C:\Windows\Temp.
// This is the load-bearing claim, so it gets its own decisive probe.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REAL_LOCAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';

function canonicalString(s) {
  let v = String(s).replace(/\//g, '\\');
  v = v.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/i, '').replace(/^\\\\\.\\/i, '');
  return v.replace(/\\+$/, '').toLowerCase();
}
function expandShortNames(s) {
  if (!/^[a-z]:\\/i.test(s)) return s;
  const parts = s.split('\\');
  for (let i = parts.length; i >= 2; i -= 1) {
    let real = null;
    try { real = fs.realpathSync.native(parts.slice(0, i).join('\\')); } catch { continue; }
    if (!real) continue;
    return [real, ...parts.slice(i)].join('\\').toLowerCase().replace(/\\+$/, '');
  }
  return s;
}
const dirMemo = new Map();
function canonicalMemo(p) {
  const s = canonicalString(p);
  if (!/^[a-z]:\\/.test(s)) return s;
  const idx = s.lastIndexOf('\\');
  const dir = s.slice(0, idx);
  let resolvedDir = dirMemo.get(dir);
  if (resolvedDir === undefined) {
    resolvedDir = expandShortNames(dir);
    if (dirMemo.size > 4096) dirMemo.clear();
    dirMemo.set(dir, resolvedDir);
  }
  return `${resolvedDir}\\${s.slice(idx + 1)}`;
}

const PROTECT_ROOTS = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata'];
function isUnder(child, root) { return child === root || child.startsWith(`${root}\\`); }
function isProtected(p) { const c = canonicalMemo(p); return PROTECT_ROOTS.some((r) => isUnder(c, r)); }

// --- build the exact scenario the verifier reported, inside the NON-protected real Temp ---
const holder = fs.mkdtempSync(path.join(REAL_LOCAL_TEMP, 'dshcc-lead-memojunc-'));
const junction = path.join(holder, 'innocent-cache');
const victimName = `dshcc-lead-memojunc-${process.pid}.log`;
const realVictim = path.join('C:\\Windows\\Temp', victimName);
fs.writeFileSync(realVictim, 'V'.repeat(48));
execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, 'C:\\Windows\\Temp'], { windowsHide: true });
const viaJunction = path.join(junction, victimName);

console.log('=== the exact verifier scenario ===');
console.log(`  holder                       : ${holder}`);
console.log(`  holder under a protectRoot   : ${PROTECT_ROOTS.some((r) => isUnder(canonicalString(holder), r))}  (must be false — else the test proves nothing)`);
console.log(`  junction                     : ${junction} -> C:\\Windows\\Temp`);
console.log(`  realpath(junction dir)       : ${fs.realpathSync.native(junction)}`);
console.log(`  victim via junction exists   : ${fs.existsSync(viaJunction)}`);
console.log(`  victim really in C:\\Windows  : ${fs.existsSync(realVictim)}`);

console.log('\n=== the property that must hold ===');
const r1 = isProtected(realVictim);
const r2 = isProtected(viaJunction);
const r3 = isProtected(junction);
console.log(`  isProtected(real C:\\Windows\\Temp file)  = ${r1}   <- must be true`);
console.log(`  isProtected(same file via junction)      = ${r2}   <- was false, THE DEFECT`);
console.log(`  isProtected(junction dir itself)         = ${r3}`);
console.log(`  canonical(via junction)                  = ${canonicalMemo(viaJunction)}`);
const fixed = r1 && r2;
console.log(`\n  >>> MEMOIZED RECIPE FIXES THE JUNCTION DEFECT: ${fixed ? 'YES' : 'NO'}`);

console.log('\n=== must still not over-block (A2 property) ===');
const mustStayOpen = [
  path.join(REAL_LOCAL_TEMP, 'ordinary.tmp'),
  'C:\\WindowsApps\\evil.dll',
  'C:\\Windows-old\\x.txt',
  'C:\\Windows.old\\x.txt',
  'C:\\Program Files Extra\\x.txt',
];
let overBlocked = 0;
for (const p of mustStayOpen) {
  const prot = isProtected(p);
  if (prot) overBlocked += 1;
  console.log(`  ${prot ? 'BLOCKED (wrong)' : 'open   (ok)   '} ${JSON.stringify(p)}`);
}
console.log(`  over-blocked: ${overBlocked} (must be 0)`);

// cleanup
try { execFileSync('cmd.exe', ['/c', 'rmdir', junction], { windowsHide: true }); } catch { /* */ }
try { fs.rmSync(holder, { recursive: true, force: true }); } catch { /* */ }
try { fs.rmSync(realVictim, { force: true }); } catch { /* */ }
console.log('\n  (cleaned up: junction, holder, victim)');
