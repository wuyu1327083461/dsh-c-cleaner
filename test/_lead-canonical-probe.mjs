// Lead: pin down EXACTLY which spellings normalizePath() misses, and which canonicalization
// transforms would fix each class. No dependency on the plugin's internals beyond reading them.
import path from 'node:path';
import fs from 'node:fs';

// Copy of the current classifier implementation, verbatim.
function normalizePath(p) {
  let s;
  try { s = path.resolve(String(p)); } catch { s = String(p); }
  return s.replace(/[\\/]+$/, '').toLowerCase();
}
function isUnder(childNorm, rootNorm) {
  if (!rootNorm) return false;
  if (childNorm === rootNorm) return true;
  return childNorm.startsWith(rootNorm + '\\') || childNorm.startsWith(rootNorm + '/');
}
const ROOTS = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)'].map(normalizePath);

const cases = [
  'C:\\Windows\\notepad.exe',
  'C:\\Windows \\notepad.exe',
  'C:\\Windows.\\notepad.exe',
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  '\\\\?\\C:\\Windows\\notepad.exe',
  '\\\\.\\C:\\Windows\\notepad.exe',
  '//?/C:/Windows/notepad.exe',
  'C:/Windows/notepad.exe',
  'C:\\Program Files\\evil.exe',
  'C:\\PROGRA~1\\evil.exe',
  'C:\\PROGRA~2\\evil.exe',
  'C:\\Users\\kiuhg\\Desktop\\x.txt',
  'c:\\windows\\NOTEPAD.EXE',
];

console.log('=== current behaviour (verbatim copy of classifier.normalizePath) ===');
let missed = [];
for (const c of cases) {
  const n = normalizePath(c);
  const hit = ROOTS.some((r) => isUnder(n, r));
  if (!hit) missed.push(c);
  console.log(`  ${hit ? 'HIT ' : 'MISS'}  ${JSON.stringify(c)}\n        -> ${JSON.stringify(n)}`);
}
console.log(`\n  ${missed.length} of ${cases.length} miss.`);

// ---------- candidate canonicalization ----------
const DEVICE_PREFIX = /^\\\\[?.]\\/;
const UNC_DEVICE_PREFIX = /^\\\\\?\\UNC\\/i;

function canonical(p) {
  let s = String(p);
  // 1. strip Win32 device namespace prefixes
  if (UNC_DEVICE_PREFIX.test(s)) s = '\\\\' + s.slice(UNC_DEVICE_PREFIX.source.length, 0) + s.replace(UNC_DEVICE_PREFIX, '');
  s = s.replace(DEVICE_PREFIX, '');
  // 2. forward slashes -> backslashes
  s = s.replace(/\//g, '\\');
  // 3. resolve . and ..
  try { s = path.win32.resolve(s); } catch { /* keep */ }
  // 4. Win32 strips trailing dots and spaces from EVERY component
  s = s.split('\\').map((seg) => seg.replace(/[. ]+$/, '') || seg).join('\\');
  // 5. lowercase
  s = s.toLowerCase();
  return s.replace(/\\+$/, '');
}

console.log('\n=== candidate canonicalization (string-only, no fs) ===');
let missed2 = [];
for (const c of cases) {
  const n = canonical(c);
  const hit = ROOTS.some((r) => isUnder(n, r));
  if (!hit) missed2.push(c);
  console.log(`  ${hit ? 'HIT ' : 'MISS'}  ${JSON.stringify(c)} -> ${JSON.stringify(n)}`);
}
console.log(`\n  ${missed2.length} of ${cases.length} miss.  Remaining: ${JSON.stringify(missed2)}`);

// ---------- realpath expansion for 8.3 short names ----------
console.log('\n=== fs.realpathSync.native expands 8.3 short names ===');
for (const p of ['C:\\PROGRA~1', 'C:\\PROGRA~2', 'C:\\Windows', 'C:\\WINDOWS']) {
  try {
    console.log(`  ${p} -> ${JSON.stringify(fs.realpathSync.native(p))}`);
  } catch (e) {
    console.log(`  ${p} -> ERROR ${e.code}`);
  }
}

console.log('\n=== does the short name survive realpath WITH a child appended? ===');
for (const p of ['C:\\PROGRA~1\\nonexistent-xyz.exe', 'C:\\Windows\\notepad.exe', 'C:\\Windows\\System32\\drivers\\etc\\hosts']) {
  try {
    console.log(`  ${p} -> ${JSON.stringify(fs.realpathSync.native(p))}`);
  } catch (e) {
    console.log(`  ${p} -> ERROR ${e.code} (must fall back to parent realpath)`);
  }
}
