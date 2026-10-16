// Lead: DECISIVE reachability test for the last A1 miss.
//
// The residual miss is: an 8.3 alias in a NON-LEAF component whose deeper path does not exist
// (C:\PROGRA~1\SomeApp\a.dll). The current recipe realpaths only the IMMEDIATE parent, which throws
// ENOENT when C:\Program Files\SomeApp is absent, so the alias survives into the comparison.
//
// Reachability question that decides severity: can a file that REALLY EXISTS be fed to
// isProtectedPath() under a spelling it fails to recognise? For a file to exist, every component
// except the leaf must exist, so dirname() exists and realpath(dirname) normally succeeds. The
// remaining fail-open is realpath throwing something OTHER than ENOENT (e.g. EPERM on a protected
// dir) — then the code silently falls back to the unresolved alias string.
//
// This script brute-forces REAL protected-root files for any spelling that defeats the check.
import { isProtectedPath } from '../lib/classifier.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Ask Windows for the real 8.3 short path of an existing path. */
function shortPath(p) {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$fso = New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder('${p.replace(/'/g, "''")}').ShortPath`,
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return out.trim() || null;
  } catch {
    return null;
  }
}

console.log('=== does realpath(dir) ever fail on a REAL file? (the fail-open condition) ===');
console.log('checking: realpath(dirname) throws non-ENOENT while the file itself exists\n');

const protectedRoots = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];
const realFiles = [];
for (const root of protectedRoots) {
  if (!fs.existsSync(root)) { console.log(`  (absent) ${root}`); continue; }
  // shallow walk, few entries, just to find REAL existing files
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }).slice(0, 40); } catch (e) { console.log(`  (unreadable ${e.code}) ${root}`); continue; }
  let found = 0;
  for (const e of entries) {
    const full = path.join(root, e.name);
    try { if (e.isFile()) { realFiles.push(full); found += 1; } } catch { /* */ }
    if (found >= 4) break;
  }
  console.log(`  ${root}: collected ${found} real files`);
}

console.log('\n=== for each REAL file: try alias-bearing spellings, look for a defeated check ===');
let reachable = 0;
let nonEnoent = 0;
for (const f of realFiles) {
  const dir = path.dirname(f);
  const base = path.basename(f);
  // 1) the direct spelling
  const direct = isProtectedPath(f);
  // 2) a spelling where an ANCESTOR is replaced by its 8.3 alias
  const shortDir = shortPath(dir);
  const spellings = [f];
  if (shortDir && shortDir.toLowerCase() !== dir.toLowerCase()) spellings.push(path.win32.join(shortDir, base));
  // 3) alias of the ROOT segment only
  const rootShort = shortPath(path.parse(f).root);
  if (rootShort) spellings.push(path.win32.join(rootShort, path.relative(path.parse(f).root, f)));

  let dirRealErr = null;
  try { fs.realpathSync.native(dir); } catch (e) { dirRealErr = e.code; }

  for (const s of spellings) {
    const exists = fs.existsSync(s);
    const ok = isProtectedPath(s);
    const defeated = exists && !ok;
    if (defeated) reachable += 1;
    const interesting = exists && (!ok || s !== f);
    if (interesting) {
      console.log(`  ${defeated ? '*** DEFEATED' : 'ok        '} exists=${exists} protected=${ok}`);
      console.log(`        spelling = ${JSON.stringify(s)}`);
    }
  }
  if (dirRealErr && dirRealErr !== 'ENOENT') { nonEnoent += 1; console.log(`  NOTE dirname realpath error = ${dirRealErr} on ${JSON.stringify(dir)}`); }
  if (!direct) console.log(`  *** REAL FILE NOT PROTECTED: ${JSON.stringify(f)} -> ${direct}`);
}

console.log(`\n  real files tested                     : ${realFiles.length}`);
console.log(`  REAL files whose spelling defeated it : ${reachable}`);
console.log(`  dirname realpath non-ENOENT failures  : ${nonEnoent}`);
console.log(`  => residual miss is ${reachable > 0 ? 'REACHABLE — live bypass' : 'NOT reachable for an existing file on this host'}`);

console.log('\n=== the residual miss, restated precisely ===');
for (const c of ['C:\\PROGRA~1\\SomeApp\\a.dll']) {
  const dir = path.dirname(c);
  let err = null;
  try { fs.realpathSync.native(dir); } catch (e) { err = e.code; }
  console.log(`  ${c}`);
  console.log(`      dirname ${dir}`);
  console.log(`      fs.existsSync(dirname) = ${fs.existsSync(dir)}   realpath(dirname) throws ${err}`);
  console.log(`      => a file here CANNOT exist (its parent does not), so nothing can be deleted there`);
  console.log(`      => but if realpath(dirname) failed for a NON-ENOENT reason (EPERM on a protected`);
  console.log(`         dir), the code falls back to the alias string and returns false = FAIL-OPEN.`);
}
