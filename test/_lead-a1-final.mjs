// Lead: pinpoint the ONE remaining A1 miss and decide its real severity.
//
// Verified so far:
//  - A1 is 12/13 fixed; alias-in-leaf (PROGRA~1\evil.exe), device prefixes, forward slashes,
//    trailing dots/spaces, .. segments all resolve correctly now.
//  - The single miss is an 8.3 alias in a NON-LEAF component with a nonexistent deeper path:
//    C:\PROGRA~1\SomeApp\a.dll (C:\Program Files\SomeApp does not exist here).
//  - My earlier "ProgramData unprotected" reading was MY probe error (called isProtectedPath with
//    no cfg); the production classify()/clean() path DOES protect it.
//
// What remains to establish: for a path where every component exists, can realpath(dirname) throw
// a non-ENOENT error and thus fail open? That is the only way the miss becomes reachable.
import { isProtectedPath } from '../lib/classifier.js';
import fs from 'node:fs';
import path from 'node:path';

console.log('=== exhaustive: every REAL protected-root file, direct spelling ===');
const roots = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\Windows\\System32'];
let tested = 0, missed = [];
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }).slice(0, 120); } catch { continue; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(root, e.name);
    tested += 1;
    if (!isProtectedPath(full)) missed.push(full);
  }
}
console.log(`  real regular files directly under protected roots: ${tested}`);
console.log(`  any NOT recognised as protected                    : ${missed.length}`);
if (missed.length) for (const m of missed.slice(0, 10)) console.log('    MISS', JSON.stringify(m));

console.log('\n=== the alias-in-non-leaf case, characterised ===');
const target = 'C:\\PROGRA~1\\SomeApp\\a.dll';
const dir = path.dirname(target);
console.log(`  spelling            : ${target}`);
console.log(`  dirname             : ${dir}`);
console.log(`  dirname exists      : ${fs.existsSync(dir)}`);
console.log(`  realpath(dirname)   : ${(() => { try { return fs.realpathSync.native(dir); } catch (e) { return `THROWS ${e.code}`; } })()}`);
console.log(`  isProtectedPath     : ${isProtectedPath(target)}`);
console.log('');
console.log('  Can a file exist at that spelling?  NO — its parent does not exist.');
console.log('  Can a DELETION happen there?        NO — nothing to delete.');
console.log('  So the miss is not itself a live bypass, but the FALLBACK IS FAIL-OPEN:');
console.log('  when realpath(dirname) throws anything other than ENOENT (e.g. EPERM/EACCES on a');
console.log('  protected dir the process cannot stat), the code silently keeps the unresolved alias');
console.log('  and returns false for a path that really is inside a protected root.');

console.log('\n=== is the fail-open condition reachable? try a dir realpath cannot read ===');
const unreadable = 'C:\\System Volume Information';
console.log(`  ${JSON.stringify(unreadable)} existsSync=${fs.existsSync(unreadable)}`);
try { console.log(`  realpath = ${fs.realpathSync.native(unreadable)}`); } catch (e) { console.log(`  realpath THROWS ${e.code}`); }
console.log(`  isProtectedPath("${unreadable}\\x.tmp") = ${isProtectedPath(unreadable + '\\x.tmp')}`);

console.log('\n=== hardest attempt: build the exact structure with a real alias ===');
// Create, under a directory whose 8.3 alias differs, a nested path that does NOT exist,
// then confirm realpath throws ENOENT there. Use a real short name if Windows gives us one.
const base = fs.mkdtempSync('C:\\ProgramData\\dshcc_a1_');
const longDir = path.join(base, 'LongDirectoryName');
fs.mkdirSync(longDir, { recursive: true });
const probeFile = path.join(longDir, 'real.tmp');
fs.writeFileSync(probeFile, 'x');
console.log(`  created real file   : ${probeFile}`);
console.log(`  isProtectedPath     : ${isProtectedPath(probeFile)} (cfg-less; ProgramData is cfg-level)`);
const { resolveConfig } = await import('../lib/config.js');
const cfg = resolveConfig({}, process.env);
console.log(`  with production cfg : ${isProtectedPath(probeFile, cfg.protectRoots)}`);
console.log(`  classify category   : ${(await import('../lib/classifier.js')).classify({ path: probeFile, size: 1, mtimeMs: Date.now() }, { cfg, tree: null }).category}`);
fs.rmSync(base, { recursive: true, force: true });
