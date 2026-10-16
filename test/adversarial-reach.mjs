/**
 * dsh-c-cleaner — STEP 4 reachability/severity probe (verifier-owned).
 *
 *   node /f/work/dsh-c-cleaner/test/adversarial-reach.mjs
 *
 * Answers three questions the finding needs before it can be graded:
 *   1. Does a `\\?\` device prefix defeat protection for a WRITABLE protectRoot
 *      (E:\dsh_escape_cache — the plugin's own escape root, a default protectRoot)?
 *   2. Does force/deep change anything (hardDelete vs recycle)?
 *   3. Can any legitimate code path produce such a spelling?
 */
import fs from 'node:fs';
import path from 'node:path';

const B = '\\';
const EXT = `${B}${B}?${B}`;

const { isProtectedPath, classify } = await import(new URL('../lib/classifier.js', import.meta.url));
const { clean } = await import(new URL('../lib/cleaner.js', import.meta.url));
const { resolveConfig } = await import(new URL('../lib/config.js', import.meta.url));
const CFG = resolveConfig({});
const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const STAMP = `${process.pid}_${Date.now().toString(36)}`;

console.log(`escapeRoot     = ${CFG.escapeRoot}`);
console.log(`is escapeRoot in protectRoots? ${CFG.protectRoots.some((r) => r.toLowerCase() === CFG.escapeRoot.toLowerCase())}`);
console.log('');

/* ── R1: device prefix on the escape root (writable protectRoot) ─────────── */
const escDir = path.join(CFG.escapeRoot, `dshcc_reach_${STAMP}`);
fs.mkdirSync(escDir, { recursive: true });
const plainFile = path.join(escDir, 'victim-plain.tmp');
fs.writeFileSync(plainFile, 'PRD 6.2 protected payload');
const devFile = `${EXT}${plainFile}`;

console.log('=== R1: \\\\?\\ device prefix on the escape root ===');
console.log(`  plain   path = ${JSON.stringify(plainFile)}  isProtectedPath=${isProtectedPath(plainFile, CFG.protectRoots)}`);
console.log(`  device  path = ${JSON.stringify(devFile)}  isProtectedPath=${isProtectedPath(devFile, CFG.protectRoots)}`);
for (const [label, p] of [['plain', plainFile], ['device-prefixed', devFile]]) {
  const target = path.join(escDir, `victim-${label}.tmp`);
  fs.writeFileSync(target, 'payload');
  const spelling = label === 'plain' ? target : `${EXT}${target}`;
  const c = classify({ path: spelling, size: fs.statSync(target).size, mtimeMs: Date.now() }, { cfg: CFG });
  let report = null;
  let err = null;
  try {
    report = await clean([c], { deep: false, force: false, cfg: CFG, log: LOG });
  } catch (e) { err = `${e.code || ''} ${e.message}`; }
  const gone = !fs.existsSync(target);
  console.log(`  [${label}] classify=${c.category} DELETED=${gone} report=${JSON.stringify(report?.skippedList ?? report)}${err ? ` ERR=${err}` : ''}`);
}

/* ── R2: does force:true (hard delete) change the outcome? ──────────────── */
console.log('\n=== R2: force:true (hard delete) with a device-prefixed spelling ===');
const t2 = path.join(escDir, 'victim-force.tmp');
fs.writeFileSync(t2, 'payload');
{
  const spelling = `${EXT}${t2}`;
  const c = classify({ path: spelling, size: fs.statSync(t2).size, mtimeMs: Date.now() }, { cfg: CFG });
  let report = null;
  let err = null;
  try {
    report = await clean([c], { deep: false, force: true, cfg: CFG, log: LOG });
  } catch (e) { err = `${e.code || ''} ${e.message}`; }
  console.log(`  device+force: DELETED=${!fs.existsSync(t2)} report=${JSON.stringify(report?.skippedList ?? report)}${err ? ` ERR=${err}` : ''}`);
}

/* ── R3: who can produce a short/device spelling? ───────────────────────── */
console.log('\n=== R3: can the plugin itself produce such a spelling? ===');
console.log('  fs.watch event filename  -> always a plain name appended to the watched dir');
console.log('  cfg.watchDirs / envMap   -> user-configured strings, taken verbatim by resolveConfig');
const { resolveConfig: rc } = await import(new URL('../lib/config.js', import.meta.url));
const weird = rc({ watchDirs: ['C:' + B + 'PROGRA~3' + B + 'dshcc'], protectRoots: ['C:' + B + 'PROGRA~3'] });
console.log(`  resolveConfig({watchDirs:['C:\\PROGRA~3\\dshcc']}) -> ${JSON.stringify(weird.watchDirs)}`);
console.log(`  resolveConfig({protectRoots:['C:\\PROGRA~3']})    -> ${JSON.stringify(weird.protectRoots)}`);
console.log('  => a user-written config keeps the spelling verbatim; no canonicalisation is applied.');

/* ── R4: is the same true for the ORIGINAL PRD 6.2 hardcoded roots? ─────── */
console.log('\n=== R4: PRD 6.2 hardcoded roots via 8.3 alias (writability gate) ===');
for (const [alias, root] of [['C:' + B + 'PROGRA~1', 'C:' + B + 'Program Files'], ['C:' + B + 'PROGRA~3', 'C:' + B + 'ProgramData'], ['C:' + B + 'WINDOW~1', 'C:' + B + 'Windows']]) {
  let real = '(none)';
  try { real = fs.realpathSync.native(alias); } catch (e) { real = `(${e.code})`; }
  let writable = false;
  try {
    const t = path.join(alias, `dshcc_w_${STAMP}.tmp`);
    fs.writeFileSync(t, 'x');
    fs.rmSync(t, { force: true });
    writable = true;
  } catch { writable = false; }
  const protByRoot = CFG.protectRoots.some((r) => real.toLowerCase() === r.toLowerCase());
  console.log(`  ${alias.padEnd(14)} -> ${real.padEnd(22)} declaredProtectRoot=${String(protByRoot).padEnd(5)} recognised=${isProtectedPath(alias + B + 'evil.dll', CFG.protectRoots)} writableByThisUser=${writable}`);
}

fs.rmSync(escDir, { recursive: true, force: true });
console.log('\nreachability probe complete.');
