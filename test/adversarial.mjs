/**
 * dsh-c-cleaner — STEP 4 adversarial probe set (verifier-owned, exploratory).
 *
 * This is NOT the acceptance harness; test/run.js is. This file exists so every
 * adversarial finding in the verification report has a literal, re-runnable
 * repro command:
 *
 *   node /f/work/dsh-c-cleaner/test/adversarial.mjs
 *
 * It only reports; it never edits lib/. Run as a non-elevated user.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const { isProtectedPath, isLocked, classify } = await import(new URL('../lib/classifier.js', import.meta.url));
const { resolveConfig } = await import(new URL('../lib/config.js', import.meta.url));
const CFG = resolveConfig({});

let idx = 0;
const line = (label, value) => console.log(`[${String(++idx).padStart(2, '0')}] ${label.padEnd(34)} ${value}`);

/* ── Real Windows path spellings ─────────────────────────────────────────── */
// Each entry is [runtime path string, human label, expectation].
// "\0" is used for a literal backslash so the source survives any editor.
const B = '\\';
const S = (s) => s.split('/').join(B);
const CASES = [
  [S('C:/Windows/notepad.exe'), 'baseline (must be true)', true],
  [S('C:/Windows/notepad.exe') + ' ', 'trailing space after path', true],
  [S('C:/Windows /notepad.exe'), 'trailing space in component', true],
  [S('C:/Windows./notepad.exe'), 'trailing dot in component', true],
  ['?' + B.repeat(2) + S('C:/Windows/notepad.exe'), '\\\\?\\ extended-length prefix', true],
  [B.repeat(2) + '?' + B + 'UNC' + B.repeat(2) + 'localhost' + B + 'C$' + S('/Windows/notepad.exe'), '\\\\?\\UNC\\ share form', true],
  [S('C:/Windows/Temp/../notepad.exe'), 'dotdot escaping Windows\\Temp', true],
  [S('C:/Windows/./notepad.exe'), 'single-dot segment', true],
  [S('C:/PROGRA~1/evil.exe'), '8.3 short: Program Files', true],
  [S('C:/PROGRA~2/evil.exe'), '8.3 short: Program Files (x86)', true],
  [S('C:/PROGRA~1/SomeApp/a.dll'), '8.3 short: nested', true],
  [S('C:/Windows/Sysnative/x.exe'), 'Sysnative WOW64 alias', true],
  [S('c:/windows/notepad.exe'), 'lowercase', true],
  [S('C:/WINDOWS/NOTEPAD.EXE'), 'uppercase', true],
  ['//?/C:/Windows/notepad.exe', 'forward-slash device prefix', true],
  [S('C:/Windows') + B, 'root with trailing separator', true],
  ['C:' + S('/Users/kiuhg/Desktop/x.txt'), 'Desktop (user shell dir)', true],
  // Negatives: must NOT be protected (over-blocking = feature loss, PRD 6.2 safe).
  [S('C:/WindowsApps/evil.exe'), 'NEGATIVE lookalike WindowsApps', false],
  [S('C:/Windows.old/evil.exe'), 'NEGATIVE lookalike Windows.old', false],
  [S('C:/Windows-old/evil.exe'), 'NEGATIVE lookalike Windows-old', false],
  [B.repeat(2) + 'server' + B + 'share' + S('/Windows/a.exe'), 'NEGATIVE UNC path', false],
  [S('C:/ProgramData/app/cache.tmp'), 'NEGATIVE ProgramData cache', false],
];

console.log('=== A1: isProtectedPath spelling/alias variants ===');
const missed = [];
for (const [p, label, want] of CASES) {
  let got;
  try {
    got = isProtectedPath(p, CFG.protectRoots);
  } catch (e) {
    got = `THREW ${e.message}`;
  }
  let real = '(none)';
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch (e) {
    real = `(unresolvable: ${e.code})`;
  }
  const exists = fs.existsSync(p);
  const ok = got === want;
  if (!ok && want === true) missed.push({ p, label, real, exists });
  line(label, `isProtectedPath=${String(got).padEnd(5)} want=${String(want).padEnd(5)} ${ok ? 'OK  ' : 'MISS'} exists=${String(exists).padEnd(5)} realpath=${real}`);
}
console.log(`A1 summary: ${missed.length}/${CASES.filter((c) => c[2] === true).length} must-be-protected spellings were NOT recognised.`);
for (const m of missed) {
  // A miss only matters if the OS itself resolves the spelling to a protected file.
  let resolvesIntoProtected = false;
  try {
    const rp = fs.realpathSync.native ? fs.realpathSync.native(m.p) : fs.realpathSync(m.p);
    resolvesIntoProtected = isProtectedPath(rp, CFG.protectRoots);
  } catch {
    resolvesIntoProtected = false;
  }
  console.log(`   MISS ${JSON.stringify(m.p)} (${m.label}) exists=${m.exists} realpath=${m.real} -> realpath IS protected: ${resolvesIntoProtected}`);
}

/* ── A3: directory passed where a file is expected ───────────────────────── */
console.log('\n=== A3: directory passed to classify()/clean() ===');
const { clean } = await import(new URL('../lib/cleaner.js', import.meta.url));
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const probeRoot = path.join(os.tmpdir(), `dshcc_adv_${STAMP}`);
const dirCase = path.join(probeRoot, 'dir_case');
fs.mkdirSync(path.join(dirCase, 'nested'), { recursive: true });
fs.writeFileSync(path.join(dirCase, 'nested', 'payload.tmp'), 'x'.repeat(32));
try {
  const rec = classify({ path: dirCase, size: 0, mtimeMs: Date.now() }, { cfg: CFG });
  line('classify(dir)', JSON.stringify({ category: rec.category, isLocked: rec.isLocked, reason: rec.reason }));
  line('isLocked(dir)', JSON.stringify(isLocked(dirCase)));
  const report = clean([rec], { deep: false, force: false, cfg: CFG, log: { debug() {}, info() {}, warn() {}, error() {} } });
  line('clean([dirRecord])', JSON.stringify(report));
  line('dir still exists after clean', fs.existsSync(dirCase));
  line('payload still exists', fs.existsSync(path.join(dirCase, 'nested', 'payload.tmp')));
} catch (e) {
  line('A3 THREW', `${e.code || ''} ${e.message}`);
}

/* ── A6: junction escaping a protected root ──────────────────────────────── */
console.log('\n=== A6: junction pointing out of a protected root ===');
const junc = path.join(probeRoot, 'junc_link');
let madeJunction = false;
try {
  fs.symlinkSync(path.join(probeRoot, 'real_target'), junc, 'junction');
  madeJunction = true;
} catch (e) {
  try {
    fs.mkdirSync(path.join(probeRoot, 'real_target'), { recursive: true });
    fs.symlinkSync(path.join(probeRoot, 'real_target'), junc, 'junction');
    madeJunction = true;
  } catch (e2) {
    line('junction creation', `FAILED ${e2.code} ${e2.message}`);
  }
}
if (madeJunction) {
  line('isProtectedPath(junction)', String(isProtectedPath(junc, CFG.protectRoots)));
  line('lstat isSymbolicLink', String(fs.lstatSync(junc).isSymbolicLink()));
}

/* ── A7/A8: db + classify edges ──────────────────────────────────────────── */
console.log('\n=== A7/A8: edge inputs ===');
for (const [label, fn] of [
  ['isProtectedPath("")', () => isProtectedPath('', CFG.protectRoots)],
  ['isProtectedPath(undefined)', () => isProtectedPath(undefined, CFG.protectRoots)],
  ['isProtectedPath(null)', () => isProtectedPath(null, CFG.protectRoots)],
  ['isProtectedPath(123)', () => isProtectedPath(123, CFG.protectRoots)],
  ['isLocked(missing file)', () => JSON.stringify(isLocked(path.join(probeRoot, 'nope.txt')))],
  ['classify(missing file)', () => JSON.stringify(classify({ path: path.join(probeRoot, 'nope.txt'), size: 0, mtimeMs: 0 }, { cfg: CFG }).category)],
  ['classify({}) empty record', () => JSON.stringify(classify({}, { cfg: CFG }).category)],
]) {
  try {
    line(label, String(fn()));
  } catch (e) {
    line(label, `THREW ${e.code || ''} ${e.message}`);
  }
}

fs.rmSync(probeRoot, { recursive: true, force: true });
console.log('\nadversarial probe complete.');
