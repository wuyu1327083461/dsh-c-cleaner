// Lead: PROTOTYPE the fix recipe for the junction defect, then hand the owner a PROVEN recipe.
//
// Root cause (lib/classifier.js:177-179):
//   function canonical(p, { expandShortNames: expand = true } = {}) {
//     const s = canonicalString(p);
//     return expand && s.includes('~') ? expandShortNames(s) : s;   // syscall ONLY when '~' present
//   }
// A junction/reparse-point path contains no '~', so realpath never runs on it.
//
// expandShortNames() (lib/classifier.js:160-174) ALREADY walks up to the longest existing prefix and
// realpath-s it — the exact routine that catches a junction. So the fix is to let it run whenever a
// resolution is possible, not only for '~' spellings.
//
// This probe replicates the routine verbatim and shows it resolves the junction. It also times the
// added syscall so PRD §6.1 (CPU <2%) can be judged with numbers instead of optimism.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REAL_LOCAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';

// ---- verbatim copy of the current routine (from lib/classifier.js:160-174) ----
function expandShortNames(s) {
  if (!/^[a-z]:\\/i.test(s)) return s;
  const parts = s.split('\\');
  for (let i = parts.length; i >= 2; i -= 1) {
    let real = null;
    try {
      real = fs.realpathSync.native(parts.slice(0, i).join('\\'));
    } catch {
      continue;
    }
    if (!real) continue;
    return [real, ...parts.slice(i)].join('\\').toLowerCase().replace(/\\+$/, '');
  }
  return s;
}
// ---- proposed: run it always (drive-absolute paths), not only on '~' ----
function canonicalFixed(s) {
  const lower = String(s).toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
  return /^[a-z]:\\/.test(lower) ? expandShortNames(lower) : lower;
}

const holder = fs.mkdtempSync(path.join(REAL_LOCAL_TEMP, 'dshcc-lead-fixproto-'));
const junction = path.join(holder, 'innocent-cache');
const victimName = `dshcc-lead-fixproto-${process.pid}.log`;
const realVictim = path.join('C:\\Windows\\Temp', victimName);
fs.writeFileSync(realVictim, 'P'.repeat(48));
execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, 'C:\\Windows\\Temp'], { windowsHide: true });
const viaJunction = path.join(junction, victimName);

console.log('=== the junction case ===');
console.log('  via junction               :', viaJunction);
console.log('  current routine result     :', expandShortNames(viaJunction.toLowerCase()));
console.log('  FIXED routine result       :', canonicalFixed(viaJunction));
const fixedResolved = canonicalFixed(viaJunction);
const caught = fixedResolved.startsWith('c:\\windows\\');
console.log(`  >>> FIXED routine resolves the junction into C:\\Windows : ${caught ? 'YES — the defect is fixed by this recipe' : 'NO — recipe insufficient'}`);

console.log('\n=== it must NOT break the cases that already work ===');
const regression = [
  'C:\\Windows\\notepad.exe',
  'C:\\PROGRA~1\\evil.exe',
  'C:\\PROGRA~1\\SomeApp\\a.dll',
  'C:\\Windows\\Temp\\..\\notepad.exe',
  '\\\\?\\C:\\Windows\\notepad.exe',
  'C:\\Users\\kiuhg\\AppData\\Local\\Temp\\some-new-file.tmp',
  'E:\\dsh_escape_cache\\temp\\x.tmp',
];
for (const p of regression) {
  const lower = p.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
  console.log(`  ${JSON.stringify(p)}`);
  console.log(`      FIXED -> ${canonicalFixed(p)}`);
}

console.log('\n=== PRD 6.1 cost: time the added syscall ===');
const N = 2000;
const samples = [];
for (let i = 0; i < 50; i += 1) samples.push(path.join(REAL_LOCAL_TEMP, `dshcc-perf-${process.pid}-${i}.tmp`));
// existing files: the honest common case (a delete candidate exists on disk)
const made = [];
for (const s of samples) { try { fs.writeFileSync(s, 'x'); made.push(s); } catch { /* */ } }

let t0 = process.hrtime.bigint();
for (let i = 0; i < N; i += 1) canonicalFixed(made[i % made.length]);
let t1 = process.hrtime.bigint();
const fixedNs = Number(t1 - t0) / N;

t0 = process.hrtime.bigint();
for (let i = 0; i < N; i += 1) { const s = made[i % made.length].toLowerCase(); s.includes('~') ? expandShortNames(s) : s; }
t1 = process.hrtime.bigint();
const currentNs = Number(t1 - t0) / N;

console.log(`  current (no '~' -> no syscall) : ${currentNs.toFixed(0)} ns/call`);
console.log(`  fixed   (always realpath)      : ${fixedNs.toFixed(0)} ns/call`);
console.log(`  added cost                     : ${(fixedNs - currentNs).toFixed(0)} ns/call`);
console.log(`  one syscall per call is expected; at ~1us/call, 10k candidates cost ~${(fixedNs / 1e6 * 10000).toFixed(1)} ms total`);

for (const s of made) { try { fs.rmSync(s, { force: true }); } catch { /* */ } }
try { execFileSync('cmd.exe', ['/c', 'rmdir', junction], { windowsHide: true }); } catch { /* */ }
try { fs.rmSync(holder, { recursive: true, force: true }); } catch { /* */ }
try { fs.rmSync(realVictim, { force: true }); } catch { /* */ }
console.log('\n  (cleaned up: junction, holder, victim, perf files)');
