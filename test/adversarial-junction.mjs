/**
 * dsh-c-cleaner — STEP 4 DECISIVE junction test (verifier-owned).
 *
 *   node /f/work/dsh-c-cleaner/test/adversarial-junction.mjs
 *
 * Question: can a junction inside a WATCHED temp dir point into a PRD §6.2
 * literal root (C:\Windows), such that
 *   (a) the watcher emits a candidate whose path is the junction path,
 *   (b) isProtectedPath() misses it (no realpath canonicalisation), and
 *   (c) clean() actually deletes a file that physically lives under C:\Windows?
 *
 * C:\Windows\Temp is a literal `C:\Windows` child that a non-elevated user can
 * write on this host (verified separately), so this is a live escalation path.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { isProtectedPath, classify } = await import(new URL('../lib/classifier.js', import.meta.url));
const { clean } = await import(new URL('../lib/cleaner.js', import.meta.url));
const { CWatcher } = await import(new URL('../lib/watcher.js', import.meta.url));
const { resolveConfig } = await import(new URL('../lib/config.js', import.meta.url));
const CFG = resolveConfig({});
const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const B = '\\';

const watched = path.join(os.tmpdir(), `dshcc_junc_${STAMP}`);
const junc = path.join(watched, 'innocent-cache');
const winTemp = `C:${B}Windows${B}Temp`;
const realVictim = path.join(winTemp, `dshcc_junc_victim_${STAMP}.log`);
const viaJunc = path.join(junc, path.basename(realVictim));

let junctionMade = false;
fs.mkdirSync(watched, { recursive: true });
try {
  fs.symlinkSync(winTemp, junc, 'junction');
  junctionMade = true;
} catch (e) {
  console.log(`SETUP FAILED: could not create a junction ${junc} -> ${winTemp}: ${e.code} ${e.message}`);
}

if (junctionMade) {
  console.log('=== J1: path-level behaviour through the junction ===');
  console.log(`  watched dir       = ${watched}`);
  console.log(`  junction          = ${junc}  ->  ${winTemp}`);
  console.log(`  isProtectedPath(junction)                 = ${isProtectedPath(junc, CFG.protectRoots)}`);
  console.log(`  isProtectedPath(<real C:\\Windows\\Temp file>) = ${isProtectedPath(realVictim, CFG.protectRoots)}`);
  console.log(`  isProtectedPath(junction + filename)      = ${isProtectedPath(viaJunc, CFG.protectRoots)}`);

  console.log('\n=== J2: does the WATCHER emit a candidate for a file written through the junction? ===');
  const hits = [];
  const wcfg = { ...CFG, debounceMs: 500, watchDirs: [{ path: watched, recursive: true, maxDepth: 3 }] };
  const w = new CWatcher({ cfg: wcfg, tree: { ownerOf: () => null, nameOf: () => null }, log: silent, onCandidate: (c) => hits.push(c) });
  w.start();
  await new Promise((r) => setTimeout(r, 500));
  try {
    fs.writeFileSync(viaJunc, 'PRD 6.2 protected payload written through a junction');
    console.log(`  wrote ${viaJunc} (physically ${realVictim})`);
  } catch (e) {
    console.log(`  write through junction FAILED: ${e.code} ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
  w.stop();
  console.log(`  watcher hits (${hits.length}): ${JSON.stringify(hits.map((h) => h.path))}`);
  console.log(`  watcher stats: ${JSON.stringify(w.stats())}`);

  console.log('\n=== J3: DECISIVE — clean() a record whose path goes through the junction ===');
  if (fs.existsSync(realVictim)) {
    const c = classify({ path: viaJunc, size: fs.statSync(viaJunc).size, mtimeMs: Date.now() }, { cfg: CFG });
    console.log(`  classify(${viaJunc}) = ${c.category} (${c.reason})`);
    let report = null;
    let err = null;
    try {
      report = await clean([c], { deep: false, force: false, cfg: CFG, log: LOG });
    } catch (e) {
      err = `${e.code || ''} ${e.message}`;
    }
    const realGone = !fs.existsSync(realVictim);
    const viaGone = !fs.existsSync(viaJunc);
    console.log(`  clean() report = ${JSON.stringify(report?.skippedList ?? report)}${err ? ` ERR=${err}` : ''}`);
    console.log(`  REAL file ${realVictim} deleted = ${realGone}`);
    console.log(`  junction-path file deleted        = ${viaGone}`);
    if (realGone) {
      console.log('  >>> REAL DEFECT: a file physically under C:\\Windows\\Temp (a PRD 6.2 literal root) was DELETED');
      console.log('      because the cleaner validates the junction spelling, never the real target.');
    } else {
      console.log('  >>> NOT exploitable at the clean() step: the physical file survived.');
    }
  } else {
    console.log('  victim does not exist (write failed) — J3 not runnable');
  }

  try { fs.rmSync(junc, { force: true }); } catch { /* junction removal is best-effort */ }
  try { fs.rmSync(realVictim, { force: true }); } catch { /* ignore */ }
}
fs.rmSync(watched, { recursive: true, force: true });
console.log('\njunction probe complete.');
