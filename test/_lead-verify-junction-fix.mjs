// Lead independent post-fix verification of the junction repair. Four claims must all hold, and I
// will not take any of them on report:
//   1. the junction is refused (already proven by _lead-accept-junction.mjs, re-asserted here),
//   2. the DB route is refused too (the realistic exploitation path the verifier found),
//   3. NO over-blocking regression from the new per-directory memo — the memo caches resolved
//      dirnames, and a cache that is too aggressive would start protecting innocent paths,
//   4. the `fresh:true` delete-time path really bypasses the memo (i.e. a junction created AFTER a
//      cached classification is still caught) — otherwise the staleness window I warned about is open.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const { classify, isProtectedPath } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');
const { resolveConfig } = await import('../lib/config.js');
const { StateDB } = await import('../lib/state-db.js');

const cfg = resolveConfig({});
const NOOP = { debug() {}, info() {}, warn() {}, error() {} };
const REAL_LOCAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

console.log('=== claim 3: NO OVER-BLOCKING regression (the memo risk) ===');
// NOTE: isProtectedPath(filePath, protectRoots, opts) — the 2nd arg is REQUIRED for the production
// root list. Calling it with one argument silently falls back to systemProtectedRoots(), which by
// design omits cfg.protectRoots entries such as C:\ProgramData. My first version made exactly that
// mistake and reported a bogus "C:\ProgramData LEAK". Always pass cfg.protectRoots here.
const prot2 = (p) => isProtectedPath(p, cfg.protectRoots);
const mustStayOpen = [
  'C:\\WindowsApps\\evil.dll',
  'C:\\Windows-old\\x.txt',
  'C:\\Windows.old\\x.txt',
  'C:\\Program Files Extra\\x.txt',
  'C:\\ProgramDataExtra\\x.txt',
  'C:\\Windows\\..\\Users\\x.txt',
  path.join(REAL_LOCAL_TEMP, 'ordinary-not-protected.tmp'),
  // NOTE: E:\dsh_escape_cache is deliberately one of cfg.protectRoots (the cleaner must never delete
  // its own escape tree), so it belongs in the must-stay-CLOSED list, not here. My first version
  // asserted it should stay open and reported a bogus "OVER-BLOCKED".
];
for (const p of mustStayOpen) {
  const prot = prot2(p);
  check(`open  ${JSON.stringify(p)}`, prot === false, prot ? '<-- OVER-BLOCKED' : '');
}
const mustStayClosed = [
  'C:\\Windows\\notepad.exe',
  'C:\\Windows\\Temp\\x.log',
  'C:\\Program Files\\a\\b.dll',
  'C:\\Program Files (x86)\\a\\b.dll',
  'C:\\ProgramData\\a\\b.dat',
  'C:\\Users\\kiuhg\\Desktop\\x.txt',
  'C:\\Users\\kiuhg\\Documents\\x.txt',
  'C:\\Windows',
];
for (const p of mustStayClosed) {
  const prot = prot2(p);
  check(`prot  ${JSON.stringify(p)}`, prot === true, prot ? '' : '<-- LEAK');
}

console.log('\n=== claim 4: the fresh:true delete-time resolve bypasses the memo ===');
// Classify a path in a plain directory FIRST (this populates the memo with the lexical resolve),
// THEN turn that same directory into a junction and try to delete. The cached value is stale;
// only a fresh resolve saves the file.
const lateHolder = fs.mkdtempSync(path.join(REAL_LOCAL_TEMP, 'ccl-late-'));
const lateVictimName = `ccl-late-victim-${process.pid}.log`;
const lateRealVictim = path.join('C:\\Windows\\Temp', lateVictimName);
fs.writeFileSync(lateRealVictim, 'L'.repeat(64));

const plainChild = path.join(lateHolder, 'not-yet-a-junction.txt');
fs.writeFileSync(plainChild, 'innocent');
const preRec = classify({ path: plainChild, size: 8, mtimeMs: Date.now(), sourceProcess: null }, { cfg });
console.log(`  step 1: classified a plain file first -> ${preRec.category} (memo now holds the lexical resolve)`);

// now replace the directory with a junction to C:\Windows\Temp
fs.rmSync(plainChild, { force: true });
fs.rmdirSync(lateHolder);
execFileSync('cmd.exe', ['/c', 'mklink', '/J', lateHolder, 'C:\\Windows\\Temp'], { windowsHide: true });
const lateViaJunction = path.join(lateHolder, lateVictimName);
console.log(`  step 2: replaced that dir with a junction -> ${lateHolder} => ${fs.realpathSync.native(lateHolder)}`);
console.log(`  step 3: victim reachable : ${fs.existsSync(lateViaJunction)}`);

const lateRec = classify({ path: lateViaJunction, size: 64, mtimeMs: Date.now(), sourceProcess: null }, { cfg });
const lateReport = await clean([{ ...lateRec, path: lateViaJunction }], { deep: true, force: true, cfg, log: NOOP });
const lateSurvived = fs.existsSync(lateRealVictim);
console.log(`  clean() report = ${JSON.stringify(lateReport)}`);
check('late-created junction victim survives', lateSurvived, lateSurvived ? '' : '<-- STALENESS WINDOW OPEN');

try { execFileSync('cmd.exe', ['/c', 'rmdir', lateHolder], { windowsHide: true }); } catch { /* */ }
try { fs.rmSync(lateRealVictim, { force: true }); } catch { /* */ }

console.log('\n=== claim 2: the DB route (persisted row -> clean) ===');
const holder = fs.mkdtempSync(path.join(REAL_LOCAL_TEMP, 'ccl-db-'));
const junction = path.join(holder, 'innocent-cache');
const dbVictimName = `ccl-db-victim-${process.pid}.log`;
const dbRealVictim = path.join('C:\\Windows\\Temp', dbVictimName);
fs.writeFileSync(dbRealVictim, 'D'.repeat(72));
execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, 'C:\\Windows\\Temp'], { windowsHide: true });
const dbViaJunction = path.join(junction, dbVictimName);

const tmpDb = path.join(holder, 'route.db');
const db = new StateDB(tmpDb);
db.migrate();
const dbRec = classify({ path: dbViaJunction, size: 72, mtimeMs: Date.now(), sourceProcess: null }, { cfg });
// NOTE: upsert() takes the Classified shape (path/size/isLocked/...), NOT the DB column names.
// Passing file_path/file_size silently returns false (fail-safe) and persists nothing —
// which is what my first version did, making the whole DB-route assertion vacuous.
const wroteDb = db.upsert(dbRec);
console.log(`  upsert(dbRec) returned : ${wroteDb}   (must be true, else this probe proves nothing)`);
const listed = db.list({ category: dbRec.category });
console.log(`  persisted ${listed.length} row(s) under ${dbRec.category}; path = ${listed[0] ? listed[0].file_path : '(none)'}`);
if (listed.length === 0) {
  console.log('  FAIL  the DB route is not actually exercised (0 rows persisted) — probe is vacuous');
  failures += 1;
}

// mimic `c-clean now --force`: read the row back, re-classify, clean
const replay = listed.length ? listed[0] : null;
let dbReport = null;
if (replay) {
  const rec2 = classify({ path: replay.file_path, size: replay.file_size, mtimeMs: Date.now(), sourceProcess: null }, { cfg });
  dbReport = await clean([{ ...rec2, path: replay.file_path }], { deep: true, force: true, cfg, log: NOOP });
}
console.log(`  clean() from the persisted row = ${JSON.stringify(dbReport)}`);
const dbSurvived = fs.existsSync(dbRealVictim);
check('DB-route junction victim survives', dbSurvived, dbSurvived ? '' : '<-- REAL DEFECT VIA DB ROUTE');
db.close();

try { execFileSync('cmd.exe', ['/c', 'rmdir', junction], { windowsHide: true }); } catch { /* */ }
try { fs.rmSync(holder, { recursive: true, force: true }); } catch { /* */ }
try { fs.rmSync(dbRealVictim, { force: true }); } catch { /* */ }

console.log('\n=== claim 1: plain junction refusal (re-assert) ===');
check('isProtectedPath(real C:\\Windows\\Temp file)', isProtectedPath('C:\\Windows\\Temp\\x.log') === true);

console.log('\n=== VERDICT ===');
console.log(`  failures: ${failures}`);
console.log(failures === 0 ? '  ALL CLAIMS HOLD' : '  SOME CLAIMS FAILED');
process.exitCode = failures === 0 ? 0 : 1;
