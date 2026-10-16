/**
 * dsh-c-cleaner — STEP 4 DECISIVE deletion tests (verifier-owned).
 *
 *   node /f/work/dsh-c-cleaner/test/adversarial-clean.mjs
 *
 * isProtectedPath() returning false for an exotic spelling is only a DEFECT if
 * (a) the OS itself resolves that spelling to a protected file, AND
 * (b) clean() actually deletes it. This file tests exactly that, using
 * C:\Windows\Temp — a real protectRoot child that a NON-ELEVATED user may write.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { classify } = await import(new URL('../lib/classifier.js', import.meta.url));
const { clean } = await import(new URL('../lib/cleaner.js', import.meta.url));
const { resolveConfig } = await import(new URL('../lib/config.js', import.meta.url));
const CFG = resolveConfig({});
const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const B = '\\';

const results = [];
const rec = (label, detail, verdict) => {
  results.push({ label, detail, verdict });
  console.log(`${verdict.padEnd(9)} ${label.padEnd(46)} ${detail}`);
};

/* ── D1: \\?\ extended-length spelling of a REAL protected file ──────────── */
const winTempDir = 'C:' + B + 'Windows' + B + 'Temp';
const realName = `dshcc_adv_${STAMP}.log`;
const realPath = path.join(winTempDir, realName);
let d1Written = false;
try {
  fs.writeFileSync(realPath, 'protected-root payload');
  d1Written = true;
} catch (e) {
  rec('D1 setup: write to C:\\Windows\\Temp', `FAILED ${e.code} — cannot run D1`, 'SKIP');
}

if (d1Written) {
  const spellings = [
    ['plain', realPath],
    ['\\\\?\\ extended', '?' + B.repeat(2) + realPath],
    ['//?/ slash-device', '//?/' + realPath.split(B).join('/')],
  ];
  for (const [label, spelling] of spellings) {
    const target = path.join(winTempDir, `dshcc_adv_${label.replace(/[^a-z0-9]/gi, '')}_${STAMP}.log`);
    fs.writeFileSync(target, 'protected-root payload');
    const viaSpelling = spelling === realPath ? target : (label.startsWith('\\\\?\\') ? '?' + B.repeat(2) + target : '//?/' + target.split(B).join('/'));

    let existsBefore = fs.existsSync(target);
    let classified, report, existsAfter, err = null;
    try {
      classified = classify({ path: viaSpelling, size: fs.statSync(target).size, mtimeMs: Date.now() }, { cfg: CFG });
      report = await clean([classified], { deep: false, force: false, cfg: CFG, log: LOG });
      existsAfter = fs.existsSync(target);
    } catch (e) {
      err = `${e.code || ''} ${e.message}`;
      existsAfter = fs.existsSync(target);
    }
    const deleted = existsBefore && !existsAfter;
    rec(
      `D1 clean() via ${label}`,
      `classify=${classified?.category} exists ${existsBefore}->${existsAfter} DELETED=${deleted} report=${JSON.stringify(report?.skippedList?.map((s) => s.reason) || report)}${err ? ' ERR=' + err : ''}`,
      deleted ? 'DEFECT' : 'SAFE',
    );
    try { fs.rmSync(target, { force: true }); } catch {}
  }
  try { fs.rmSync(realPath, { force: true }); } catch {}
}

/* ── D2: directory record passed to clean() ──────────────────────────────── */
const probeRoot = path.join(os.tmpdir(), `dshcc_advc_${STAMP}`);
const dirCase = path.join(probeRoot, 'dir_case');
const dirPayload = path.join(dirCase, 'nested', 'payload.tmp');
fs.mkdirSync(path.join(dirCase, 'nested'), { recursive: true });
fs.writeFileSync(dirPayload, 'x'.repeat(64));
try {
  const c = classify({ path: dirCase, size: 0, mtimeMs: Date.now() }, { cfg: CFG });
  const report = await clean([c], { deep: false, force: false, cfg: CFG, log: LOG });
  const dirStill = fs.existsSync(dirCase);
  const payloadStill = fs.existsSync(dirPayload);
  rec(
    'D2 clean() with a DIRECTORY record',
    `classify=${c.category} dirStillExists=${dirStill} payloadStillExists=${payloadStill} report=${JSON.stringify(report)}`,
    !dirStill || !payloadStill ? 'DEFECT' : 'SAFE',
  );
} catch (e) {
  rec('D2 clean() with a DIRECTORY record', `THREW ${e.code || ''} ${e.message}`, 'DEFECT?');
}

/* ── D3: recursive flag — does clean({deep:true}) widen to directories? ───── */
const dirCase2 = path.join(probeRoot, 'dir_case2');
fs.mkdirSync(path.join(dirCase2, 'nested'), { recursive: true });
fs.writeFileSync(path.join(dirCase2, 'nested', 'p.tmp'), 'y'.repeat(64));
try {
  const c = classify({ path: dirCase2, size: 0, mtimeMs: Date.now() }, { cfg: CFG });
  const report = await clean([c], { deep: true, force: false, cfg: CFG, log: LOG });
  rec(
    'D3 deep:true with a DIRECTORY record',
    `dirStillExists=${fs.existsSync(dirCase2)} nestedStillExists=${fs.existsSync(path.join(dirCase2, 'nested'))} report=${JSON.stringify(report)}`,
    !fs.existsSync(dirCase2) ? 'DEFECT' : 'SAFE',
  );
} catch (e) {
  rec('D3 deep:true with a DIRECTORY record', `THREW ${e.code || ''} ${e.message}`, 'DEFECT?');
}

/* ── D4: 8.3 short spelling, real filesystem resolution ──────────────────── */
// C:\Windows has no 8.3 alias need; test PROGRA~1 for existence of the alias
// itself and whether the OS resolves it into the protected root.
for (const short of ['C:' + B + 'PROGRA~1', 'C:' + B + 'PROGRA~2']) {
  let real = '(unresolvable)';
  try { real = fs.realpathSync.native(short); } catch (e) { real = `(${e.code})`; }
  const prot = CFG.protectRoots.some((r) => real.toLowerCase().replace(/[\\/]+$/, '').startsWith(r.toLowerCase()));
  let verdict = 'SAFE';
  let why = '';
  if (prot) {
    const { isProtectedPath } = await import(new URL('../lib/classifier.js', import.meta.url));
    const direct = isProtectedPath(real, CFG.protectRoots);
    const viaShort = isProtectedPath(short + B + 'evil.dll', CFG.protectRoots);
    verdict = direct && !viaShort ? 'DEFECT' : 'SAFE';
    why = `realpath IS a protectRoot=${direct}, but isProtectedPath(short-form)=${viaShort}`;
  }
  rec(`D4 8.3 alias ${short}`, `realpath=${real} isProtectRoot=${prot} ${why}`, verdict);
}

fs.rmSync(probeRoot, { recursive: true, force: true });

const defects = results.filter((r) => r.verdict.startsWith('DEFECT'));
console.log(`\nDECISIVE SUMMARY: ${defects.length} defect(s) of ${results.length} test(s).`);
for (const d of defects) console.log(`  DEFECT: ${d.label} -> ${d.detail}`);
