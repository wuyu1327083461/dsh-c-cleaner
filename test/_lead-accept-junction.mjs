// Lead FINAL acceptance probe for the junction defect — end-to-end through the REAL modules.
//
// This is deliberately NOT a unit test of isProtectedPath. It reproduces the most realistic
// exploitation route the verifier found: a persisted DB row (which survives restarts) pointing at a
// junction-spelled path, then `c-clean now --force` walking that row through the real
// classify() -> clean() chain. The only assertion that matters: a file that PHYSICALLY lives in
// C:\Windows\Temp must still exist afterwards.
//
// Why a junction instead of a plain protected path: a plain `C:\Windows\Temp\x.log` is caught by the
// lexical blacklist. The junction makes the string look like it is in the user's Temp, so only real
// filesystem resolution can protect it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The plugin hijacks TEMP for every harness child, so os.tmpdir() here is E:\dsh_escape_cache\temp —
// which is itself a protectRoot. The exploitable scenario needs a NON-protected parent, so pin the
// real C: temp explicitly. (Learned the hard way: an earlier probe silently tested the escape root.)
const REAL_LOCAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';

const { classify, isProtectedPath } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');
const { resolveConfig } = await import('../lib/config.js');

const cfg = resolveConfig({});
const log = { debug() {}, info() {}, warn() {}, error() {} };

console.log('=== environment sanity ===');
console.log(`  os.tmpdir()        = ${(await import('node:os')).tmpdir()}   (hijacked — NOT usable as the non-protected parent)`);
console.log(`  probe parent       = ${REAL_LOCAL_TEMP}`);
console.log(`  escapeRoot         = ${cfg.escapeRoot}`);
console.log(`  C:\\Windows protected lexically? ${isProtectedPath('C:\\Windows\\Temp\\x.log')}  (must be true)`);

// ---- build the scenario ----
const holder = fs.mkdtempSync(path.join(REAL_LOCAL_TEMP, 'ccl-final-'));
const junction = path.join(holder, 'innocent-cache');
const victimName = `ccl-final-victim-${process.pid}.log`;
const realVictim = path.join('C:\\Windows\\Temp', victimName);
const PAYLOAD = 'X'.repeat(96);
fs.writeFileSync(realVictim, PAYLOAD);
execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, 'C:\\Windows\\Temp'], { windowsHide: true });
const viaJunction = path.join(junction, victimName);

console.log('\n=== the scenario ===');
console.log(`  holder             : ${holder}`);
console.log(`  holder protected?  : ${isProtectedPath(holder)}   (must be FALSE, else this proves nothing)`);
console.log(`  junction           : ${junction}  ->  ${fs.realpathSync.native(junction)}`);
console.log(`  victim via junction: ${viaJunction}`);
console.log(`  victim exists      : ${fs.existsSync(viaJunction)}`);
console.log(`  payload bytes      : ${fs.statSync(viaJunction).size}`);

const holderProtected = isProtectedPath(holder);
if (holderProtected) {
  console.log('\n  ABORT: the holder is inside a protectRoot, so a lexical match would explain any');
  console.log('  protection and the probe would prove nothing. Fix the probe, do not trust its result.');
  process.exitCode = 2;
} else {
  console.log('\n=== step 1: resolution (the defect site) ===');
  const viaProtected = isProtectedPath(viaJunction);
  console.log(`  isProtectedPath(real C:\\Windows\\Temp file) = ${isProtectedPath(realVictim)}   <- must be true`);
  console.log(`  isProtectedPath(same file via junction)     = ${viaProtected}   <- THE DEFECT when false`);

  console.log('\n=== step 2: classify() on the junction-spelled path ===');
  const rec = classify({ path: viaJunction, size: PAYLOAD.length, mtimeMs: Date.now(), sourceProcess: null }, { cfg });
  console.log(`  category = ${rec.category}`);
  console.log(`  reason   = ${rec.reason}`);

  console.log('\n=== step 3: clean() with --force (the destructive path) ===');
  const report = await clean([{ ...rec, path: viaJunction }], { deep: true, force: true, cfg, log });
  console.log(`  report       = ${JSON.stringify(report)}`);
  const survived = fs.existsSync(realVictim);
  console.log(`  real victim SURVIVES = ${survived}   <- must be TRUE`);

  console.log('\n=== VERDICT ===');
  const pass = viaProtected && survived;
  if (pass) {
    console.log('  PASS — a file physically inside C:\\Windows\\Temp is refused via a junction.');
  } else {
    console.log('  FAIL — PRD 6.2 violated: clean() destroyed a file inside a protected system root.');
    if (!viaProtected) console.log('         cause: isProtectedPath() did not resolve the junction (lexical-only comparison).');
    if (!survived) console.log(`         cause: clean() deleted ${realVictim}.`);
  }
  process.exitCode = pass ? 0 : 1;
}

// ---- cleanup (never leave a junction or a Windows-Temp victim behind) ----
try { execFileSync('cmd.exe', ['/c', 'rmdir', junction], { windowsHide: true }); } catch { /* */ }
try { fs.rmSync(holder, { recursive: true, force: true }); } catch { /* */ }
try { fs.rmSync(realVictim, { force: true }); } catch { /* */ }
console.log('\n  (cleaned up: junction, holder, C:\\Windows\\Temp victim)');
