// Lead: definitive path-canonicalization recipe for the PRD 6.2 blacklist (A1 fix).
// Proves which spellings the CURRENT normalizePath misses, and that this recipe catches all of
// them while still ALLOWING legitimately cleanable Temp paths.
import path from 'node:path';
import fs from 'node:fs';

function isUnder(childNorm, rootNorm) {
  if (!rootNorm) return false;
  if (childNorm === rootNorm) return true;
  return childNorm.startsWith(rootNorm + '\\');
}

const DEVICE_PREFIX = /^\\\\[?.]\\/;
const USER_SHELL_DIR_RE = /[\\/]users[\\/][^\\/]+[\\/](desktop|documents|桌面|文档)([\\/]|$)/i;

// ---------- the recipe ----------
function canonicalString(p) {
  let s = String(p);
  s = s.replace(/\//g, '\\'); // forward slashes FIRST, before any prefix test

  if (/^\\\\\?\\unc\\/i.test(s)) {
    // \\?\UNC\server\share -> \\server\share. path.win32.resolve would invent a drive letter.
    s = '\\\\' + s.replace(/^\\\\\?\\unc\\/i, '');
    s = s.split('\\').map((seg) => seg.replace(/[. ]+$/, '') || seg).join('\\');
    return s.toLowerCase().replace(/\\+$/, '');
  }
  s = s.replace(DEVICE_PREFIX, '');          // \\?\C:\.. and \\.\C:\.. -> C:\..
  try { s = path.win32.resolve(s); } catch { /* keep */ }
  // Win32 strips trailing dots/spaces from EVERY component
  s = s.split('\\').map((seg) => seg.replace(/[. ]+$/, '') || seg).join('\\');
  return s.toLowerCase().replace(/\\+$/, '');
}

// Stage 2: expand 8.3 short names by realpath-ing the PARENT (the leaf may already be deleted).
function canonical(p, { expandShortNames = true } = {}) {
  let s = canonicalString(p);
  if (!expandShortNames || !s.includes('~')) return s;
  const dir = path.win32.dirname(s);
  const base = path.win32.basename(s);
  try {
    const real = fs.realpathSync.native(dir);
    if (real) return path.win32.join(real, base).toLowerCase().replace(/\\+$/, '');
  } catch { /* parent gone: string form is the best we have */ }
  return s;
}

// ---------- the OLD behaviour, copied verbatim from lib/classifier.js for comparison ----------
function oldNormalize(p) {
  let s;
  try { s = path.resolve(String(p)); } catch { s = String(p); }
  return s.replace(/[\\/]+$/, '').toLowerCase();
}

const ROOTS = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];
const oldRoots = ROOTS.map(oldNormalize);
const newRoots = ROOTS.map(canonicalString);

// path -> should it be REFUSED?
const TABLE = [
  ['C:\\Windows\\notepad.exe', true],
  ['C:\\Windows \\notepad.exe', true],           // trailing space (Win32 trims)
  ['C:\\Windows.\\notepad.exe', true],           // trailing dot (Win32 trims)
  ['C:\\Windows\\System32\\drivers\\etc\\hosts', true],
  ['\\\\?\\C:\\Windows\\notepad.exe', true],     // \\?\ device namespace
  ['\\\\.\\C:\\Windows\\notepad.exe', true],     // \\.\ device namespace
  ['//?/C:/Windows/notepad.exe', true],          // mixed slashes + namespace
  ['C:/Windows/notepad.exe', true],
  ['C:\\Program Files\\evil.exe', true],
  ['C:\\PROGRA~1\\evil.exe', true],              // 8.3 short name
  ['C:\\PROGRA~2\\evil.exe', true],
  ['C:\\PROGRA~1\\nonexistent-xyz.exe', true],   // short name AND the leaf is gone
  ['C:\\Users\\kiuhg\\Desktop\\x.txt', true],    // PRD 6.2 Desktop
  ['C:\\Users\\kiuhg\\Documents\\x.txt', true],  // PRD 6.2 Documents
  ['c:\\windows\\NOTEPAD.EXE', true],            // case
  // ---- must remain ALLOWED ----
  ['C:\\Users\\kiuhg\\AppData\\Local\\Temp\\pip-abc.tmp', false],
  ['C:\\Users\\kiuhg\\AppData\\Local\\Temp\\lead-live-proof.tmp', false],
  ['E:\\dsh_escape_cache\\temp\\x.tmp', false],
  ['\\\\?\\C:\\Users\\kiuhg\\AppData\\Local\\Temp\\pip-dev.tmp', false],
];

const refuse = (p, canon, roots) => roots.some((r) => isUnder(canon(p), r)) || USER_SHELL_DIR_RE.test(canon(p));

console.log('=== PRD 6.2 blacklist: OLD (current lib/classifier.js) vs NEW recipe ===');
let oldMissed = 0, newMissed = 0, newOver = 0;
for (const [p, want] of TABLE) {
  const oldGot = refuse(p, oldNormalize, oldRoots);
  const newGot = refuse(p, canonical, newRoots);
  if (want && !oldGot) oldMissed += 1;
  if (want && !newGot) newMissed += 1;
  if (!want && newGot) newOver += 1;
  const o = want === oldGot ? 'ok  ' : (oldGot ? 'OVER' : 'MISS');
  const n = want === newGot ? 'ok  ' : (newGot ? 'OVER' : 'MISS');
  console.log(`  want=${want ? 'REFUSE' : 'ALLOW '}  old=${o}  new=${n}  ${JSON.stringify(p)}`);
}

console.log('');
console.log(`OLD: ${oldMissed} protected spellings slipped through, and 0 false refusals`);
console.log(`NEW: ${newMissed} protected spellings slipped through, ${newOver} false refusals`);
console.log('');
console.log('UNC is treated as remote, not local: "\\\\\\\\?\\\\UNC\\\\server\\\\share\\\\x"');
console.log(`  -> ${JSON.stringify(canonical('\\\\?\\UNC\\server\\share\\x'))}  (not mapped onto a drive letter)`);
console.log('');
console.log(newMissed === 0 && newOver === 0 ? 'RECIPE OK — all 15 refusals caught, all 4 allows preserved.' : 'RECIPE NEEDS WORK');
