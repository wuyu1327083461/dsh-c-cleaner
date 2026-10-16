// Lead: INDEPENDENT reproduction of the verifier's junction finding. I do not take the report on
// trust. Claim: canonical() only runs its realpath stage when the string contains '~', so a
// junction/reparse-point path is never resolved; a REAL file inside C:\Windows\Temp addressed
// through a junction under %TEMP% is classified SAFE_TO_DELETE and clean() deletes it.
import { isProtectedPath, classify } from '../lib/classifier.js';
import { clean } from '../lib/cleaner.js';
import { resolveConfig } from '../lib/config.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const cfg = resolveConfig({}, process.env);
const log = { info() {}, warn() {}, debug() {}, error() {} };

const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcc-lead-junc-'));
const junction = path.join(holder, 'innocent-cache');
const victimName = `dshcc-lead-victim-${process.pid}.log`;
const realVictim = path.join('C:\\Windows\\Temp', victimName);

console.log('=== setup ===');
console.log('  holder        :', holder);
console.log('  holder under a protectRoot (lexical)?', isProtectedPath(holder, cfg.protectRoots));

// real victim physically inside C:\Windows\Temp
try {
  fs.writeFileSync(realVictim, 'P'.repeat(48));
} catch (e) {
  console.log('  CANNOT create the victim in C:\\Windows\\Temp:', e.code, '— cannot run this repro');
  process.exit(2);
}
fs.mkdirSync(holder, { recursive: true });

// create the junction: %TEMP%\...\innocent-cache -> C:\Windows\Temp
let mklinkOut = '';
try {
  mklinkOut = execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, 'C:\\Windows\\Temp'], { encoding: 'utf8', windowsHide: true });
} catch (e) {
  mklinkOut = `FAILED ${e.status} ${String(e.stderr || e.message)}`;
}
console.log('  mklink        :', String(mklinkOut).trim().split('\n')[0]);

const viaJunction = path.join(junction, victimName);
console.log('\n=== does the file exist through BOTH routes? ===');
console.log('  real victim path   :', realVictim, 'exists =', fs.existsSync(realVictim));
console.log('  via junction       :', viaJunction, 'exists =', fs.existsSync(viaJunction));
if (!fs.existsSync(viaJunction)) { console.log('  repro setup failed'); process.exit(2); }

console.log('\n=== isProtectedPath: the load-bearing check ===');
const pReal = isProtectedPath(realVictim, cfg.protectRoots);
const pVia = isProtectedPath(viaJunction, cfg.protectRoots);
console.log(`  isProtectedPath(real C:\\Windows\\Temp file)  = ${pReal}   <- must be true`);
console.log(`  isProtectedPath(same file via junction)      = ${pVia}   <- must be true`);
console.log(`  isProtectedPath(the junction dir itself)     = ${isProtectedPath(junction, cfg.protectRoots)}`);
console.log('  realpath(junction dir) =', (() => { try { return fs.realpathSync.native(junction); } catch (e) { return `THROWS ${e.code}`; } })());
console.log('  does the junction path contain "~"? ', viaJunction.includes('~'));

console.log('\n=== classify + clean (the production path) ===');
const rec = classify({ path: viaJunction, size: 48, mtimeMs: Date.now(), sourceProcess: null }, { cfg, tree: null });
console.log('  classify =', rec.category, '|', rec.reason);
const report = await clean([rec], { deep: false, force: true, cfg, log });
console.log('  clean() report =', JSON.stringify(report));
const survived = fs.existsSync(realVictim);
console.log('  REAL C:\\Windows\\Temp file survives =', survived);
console.log(`\n  >>> ${!survived ? 'REAL DEFECT (PRD 6.2): clean() DELETED a file physically inside C:\\Windows\\Temp' : 'protected — no defect'}`);

// cleanup
try { fs.rmSync(holder, { recursive: true, force: true }); } catch { /* junction needs rmdir not rm */ }
try { execFileSync('cmd.exe', ['/c', 'rmdir', junction], { windowsHide: true }); } catch { /* */ }
try { fs.rmSync(holder, { recursive: true, force: true }); } catch { /* */ }
try { fs.rmSync(realVictim, { force: true }); } catch { /* */ }
console.log('  (cleaned up junction + holder + victim)');
