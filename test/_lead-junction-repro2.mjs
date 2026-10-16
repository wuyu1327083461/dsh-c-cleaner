// Lead: CORRECTED independent repro of the junction claim.
//
// My first attempt was INVALID and I must not repeat its mistake: I used os.tmpdir(), which now
// returns E:\dsh_escape_cache\temp because the plugin has hijacked TEMP — and E:\dsh_escape_cache is
// ITSELF a default protectRoot. So isProtectedPath() returned true LEXICALLY via the parent path and
// proved nothing about junction resolution.
//
// This run builds the junction in %LOCALAPPDATA%\Temp (not a protectRoot) so that only real
// filesystem resolution can protect the file.
import { isProtectedPath, classify } from '../lib/classifier.js';
import { clean } from '../lib/cleaner.js';
import { resolveConfig } from '../lib/config.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const cfg = resolveConfig({}, process.env);
const log = { info() {}, warn() {}, debug() {}, error() {} };

// Explicitly the REAL local temp, NOT os.tmpdir() (which is hijacked to the escape root).
const REAL_LOCAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';
const isUnderRoot = (p) => cfg.protectRoots.some((r) => p.toLowerCase().replace(/\\+$/, '').startsWith(r.toLowerCase().replace(/\\+$/, '') + '\\'));

const holder = fs.mkdtempSync(path.join(REAL_LOCAL_TEMP, 'dshcc-lead-junc2-'));
const junction = path.join(holder, 'innocent-cache');
const victimName = `dshcc-lead-junc2-victim-${process.pid}.log`;
const realVictim = path.join('C:\\Windows\\Temp', victimName);

console.log('=== setup (deliberately in the REAL local temp, not the hijacked one) ===');
console.log('  os.tmpdir()          :', os_tmpdir());
function os_tmpdir() { return require_TMPDIR(); }
function require_TMPDIR() { return process.env.TEMP; }
console.log('  REAL_LOCAL_TEMP      :', REAL_LOCAL_TEMP);
console.log('  holder               :', holder);
console.log('  holder under a protectRoot (lexical)?', isUnderRoot(holder), ' <- MUST be false for this repro to mean anything');

fs.writeFileSync(realVictim, 'P'.repeat(48));
let mklinkOut = '';
try {
  mklinkOut = execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, 'C:\\Windows\\Temp'], { encoding: 'utf8', windowsHide: true });
} catch (e) {
  mklinkOut = `FAILED ${e.status} ${String(e.stderr || e.message)}`;
}
console.log('  mklink created       :', fs.existsSync(junction));

const viaJunction = path.join(junction, victimName);
console.log('\n=== both routes reach the same physical file ===');
console.log('  real victim   :', realVictim, 'exists =', fs.existsSync(realVictim));
console.log('  via junction  :', viaJunction, 'exists =', fs.existsSync(viaJunction));
if (!fs.existsSync(viaJunction)) { console.log('  setup failed'); process.exit(2); }

console.log('\n=== isProtectedPath: the load-bearing check ===');
console.log(`  isProtectedPath(real C:\\Windows\\Temp file)  = ${isProtectedPath(realVictim, cfg.protectRoots)}   <- must be true`);
console.log(`  isProtectedPath(same file via junction)      = ${isProtectedPath(viaJunction, cfg.protectRoots)}   <- must be true (the claim)`);
console.log(`  isProtectedPath(junction dir itself)         = ${isProtectedPath(junction, cfg.protectRoots)}`);
console.log('  junction path contains "~"?', viaJunction.includes('~'));
console.log('  realpath(junction dir) =', (() => { try { return fs.realpathSync.native(junction); } catch (e) { return `THROWS ${e.code}`; } })());

console.log('\n=== production path: classify + clean ===');
const rec = classify({ path: viaJunction, size: 48, mtimeMs: Date.now(), sourceProcess: null }, { cfg, tree: null });
console.log('  classify =', rec.category, '|', rec.reason);
const report = await clean([rec], { deep: false, force: true, cfg, log });
console.log('  clean() report =', JSON.stringify(report));
const survived = fs.existsSync(realVictim);
console.log('  REAL C:\\Windows\\Temp file survives =', survived);
console.log(`\n  >>> ${!survived ? 'REAL DEFECT (PRD 6.2 HIGH): clean() DELETED a file physically inside C:\\Windows\\Temp' : 'PROTECTED — the verifier claim does NOT reproduce with the current files'}`);

try { execFileSync('cmd.exe', ['/c', 'rmdir', junction], { windowsHide: true }); } catch { /* */ }
try { fs.rmSync(holder, { recursive: true, force: true }); } catch { /* */ }
try { fs.rmSync(realVictim, { force: true }); } catch { /* */ }
console.log('  cleaned up');
