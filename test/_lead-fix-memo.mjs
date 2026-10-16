// Lead: the added realpath is 91us/call, NOT the ~1us I assumed — that is 100x my estimate and it
// matters for PRD 6.1 (CPU <2%). Before handing a recipe to the owner, measure the memoized variant:
// delete candidates overwhelmingly share a parent directory, so caching resolution PER DIRECTORY
// should collapse thousands of syscalls into a handful.
//
// Also correct my previous prototype's flaw: it replaced canonicalString() (which strips the
// \\?\ device prefix) instead of keeping it, so '\\?\C:\Windows\notepad.exe' came back still
// prefixed. The real fix keeps stage 1 and only changes the stage-2 CONDITION.
import fs from 'node:fs';
import path from 'node:path';

const REAL_LOCAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';

// ---- stage 1 verbatim-ish (device prefix strip + lexical normalisation) ----
function canonicalString(s) {
  let v = String(s).replace(/\//g, '\\');
  v = v.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/i, '').replace(/^\\\\\.\\/i, '');
  return v.replace(/\\+$/, '').toLowerCase();
}
// ---- stage 2: longest-existing-prefix realpath (from lib/classifier.js:160-174) ----
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

console.log('=== the full fixed canonical(), keeping stage 1 ===');
const fullFixed = (p) => { const s = canonicalString(p); return /^[a-z]:\\/.test(s) ? expandShortNames(s) : s; };
for (const p of ['\\\\?\\C:\\Windows\\notepad.exe', 'C:\\PROGRA~1\\SomeApp\\a.dll', 'C:\\Windows\\Temp\\..\\notepad.exe', 'C:\\Windows\\notepad.exe']) {
  console.log(`  ${JSON.stringify(p)}`);
  console.log(`      -> ${fullFixed(p)}`);
}

// ---- memoized variant: cache the resolved DIRNAME ----
const dirMemo = new Map();
function canonicalMemo(p) {
  const s = canonicalString(p);
  if (!/^[a-z]:\\/.test(s)) return s;
  const dir = s.slice(0, s.lastIndexOf('\\'));
  let resolvedDir = dirMemo.get(dir);
  if (resolvedDir === undefined) {
    resolvedDir = expandShortNames(dir);
    if (dirMemo.size > 4096) dirMemo.clear();
    dirMemo.set(dir, resolvedDir);
  }
  const base = s.slice(s.lastIndexOf('\\') + 1);
  return resolvedDir ? `${resolvedDir}\\${base}` : s;
}

console.log('\n=== correctness of the memoized variant (must equal the unmemoized) ===');
const check = [
  'C:\\Windows\\notepad.exe',
  'C:\\PROGRA~1\\evil.exe',
  'C:\\PROGRA~1\\SomeApp\\a.dll',
  'C:\\Users\\kiuhg\\AppData\\Local\\Temp\\a.tmp',
  'E:\\dsh_escape_cache\\temp\\b.tmp',
];
let mismatches = 0;
for (const p of check) {
  const a = fullFixed(p), b = canonicalMemo(p);
  const same = a === b;
  if (!same) mismatches += 1;
  console.log(`  ${same ? 'same' : 'DIFF'}  ${JSON.stringify(p)}`);
  if (!same) console.log(`        full=${a}\n        memo=${b}`);
}
console.log(`  mismatches: ${mismatches}`);

console.log('\n=== PRD 6.1 cost: 3 variants over 2000 candidates sharing directories ===');
const dirs = [];
const files = [];
for (let d = 0; d < 8; d += 1) {
  const dir = path.join(REAL_LOCAL_TEMP, `dshcc-perf2-${process.pid}-${d}`);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* */ }
  dirs.push(dir);
  for (let f = 0; f < 250; f += 1) {
    const p = path.join(dir, `f${f}.tmp`);
    try { fs.writeFileSync(p, 'x'); files.push(p); } catch { /* */ }
  }
}
const N = files.length;
function timeIt(label, fn) {
  fn(files[0]); // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) fn(files[i]);
  const t1 = process.hrtime.bigint();
  const perCall = Number(t1 - t0) / N;
  console.log(`  ${label.padEnd(34)} ${perCall.toFixed(0).padStart(8)} ns/call   total ${(Number(t1 - t0) / 1e6).toFixed(1)} ms for ${N}`);
  return perCall;
}
const currentNs = timeIt('current (no ~ -> no syscall)', (p) => { const s = canonicalString(p); return s.includes('~') ? expandShortNames(s) : s; });
const fullNs = timeIt('always realpath', fullFixed);
const memoNs = timeIt('memoized per directory', canonicalMemo);
console.log(`\n  added cost vs current:`);
console.log(`    always realpath : ${(fullNs - currentNs).toFixed(0)} ns/call  -> ${(fullNs / 1e6 * 10000).toFixed(0)} ms per 10k candidates`);
console.log(`    memoized        : ${(memoNs - currentNs).toFixed(0)} ns/call  -> ${(memoNs / 1e6 * 10000).toFixed(0)} ms per 10k candidates`);
console.log(`    memo speedup    : ${(fullNs / memoNs).toFixed(1)}x cheaper than always-realpath`);

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
console.log('\n  (cleaned up perf dirs)');
