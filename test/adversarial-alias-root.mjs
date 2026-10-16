// verifier probe: the BARE 8.3 alias ROOT. isProtectedPath('C:\PROGRA~2') === false while
// the long form 'C:\Program Files (x86)' === true. clean() with force:true on a directory
// record DELETES RECURSIVELY. So: does a bare alias root of a protectRoot get deleted?
//
// *** SAFETY *** We must NEVER aim this at C:\PROGRA~2 / C:\Program Files (x86). Instead we
// build the identical SHAPE with a directory we own: a top-level directory whose long form is
// a protectRoot and whose bare 8.3 alias root is not recognised. E:\ root is used for the probe.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { isProtectedPath, CATEGORY } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');
const LOG = { debug(){}, info(){}, warn(){}, error(){} };

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const longRoot = 'E:' + B + `dshcc_aliasroot_probe_${STAMP}`;
fs.mkdirSync(longRoot, { recursive: true });
fs.writeFileSync(path.join(longRoot, 'payload.txt'), 'x'.repeat(64));

// Ask Windows for the real 8.3 short name of our directory.
const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${longRoot}').ShortPath`],
  { encoding: 'utf8' });
const shortRoot = (ps.stdout || '').trim();

console.log('long root  =', JSON.stringify(longRoot));
console.log('short root =', JSON.stringify(shortRoot));
if (!shortRoot) {
  console.log('could not obtain an 8.3 short name; stderr =', JSON.stringify((ps.stderr || '').trim()));
  console.log('>>> INCONCLUSIVE (no alias available for a directory we own)');
  process.exit(0);
}
const aliasLive = (() => { try { return fs.realpathSync.native(shortRoot).toLowerCase() === fs.realpathSync.native(longRoot).toLowerCase(); } catch { return false; } })();
console.log('shortRoot is a live alias of longRoot =', aliasLive);
if (!aliasLive) {
  console.log('>>> INCONCLUSIVE (short name does not resolve back)');
  process.exit(0);
}

// Identical shape to C:\PROGRA~2 vs C:\Program Files (x86): a bare alias root of a protectRoot.
const cfg = resolveConfig({ protectRoots: [longRoot] });
console.log('');
console.log('cfg.protectRoots =', JSON.stringify(cfg.protectRoots));
console.log('isProtectedPath(long root)  =', isProtectedPath(longRoot, cfg.protectRoots), '  <- must be true');
console.log('isProtectedPath(short root) =', isProtectedPath(shortRoot, cfg.protectRoots), '  <- the C:\\PROGRA~2 shape');
console.log('');

// A file INSIDE the alias root is protected (dirname expands) — confirm, then test the root itself.
const inner = path.join(shortRoot, 'payload.txt');
console.log('isProtectedPath(alias + file) =', isProtectedPath(inner, cfg.protectRoots), '  <- expected true');

console.log('');
console.log('--- decisive: clean() the BARE ALIAS ROOT record (our own directory, force+deep) ---');
const rec = [{ path: shortRoot, category: CATEGORY.SAFE, size: 64 }];
const rep = await clean(rec, { deep: true, force: true, cfg, log: LOG });
console.log('clean() report     =', JSON.stringify(rep));
console.log('longRoot exists    =', fs.existsSync(longRoot), '  <- if false, the directory AND its payload were destroyed');
console.log('payload exists     =', fs.existsSync(path.join(longRoot, 'payload.txt')));
console.log('');
if (!fs.existsSync(longRoot)) {
  console.log('>>> REAL DEFECT (PRD 6.2, HIGH): a bare 8.3 alias root of a protectRoot is NOT');
  console.log('    protected, and clean() DELETED the whole directory recursively. The identical');
  console.log('    shape is C:\\PROGRA~2 -> C:\\Program Files (x86), a DECLARED default protectRoot.');
  console.log('    Extrapolation: a record spelled "C:\\PROGRA~2" is deleted recursively.');
} else {
  console.log('>>> SAFE: clean() refused the bare alias root (directory survived).');
}

try { fs.rmSync(longRoot, { recursive: true, force: true }); } catch {}
