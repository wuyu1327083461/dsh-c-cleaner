// verifier probe: is the ONE remaining A1 miss (C:\PROGRA~1\SomeApp\a.dll) a LIVE bypass
// or a cosmetic string that never reaches a real file? Also test 8.3 spellings of REAL
// existing files under C:\Program Files, which is the case that actually matters.
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { isProtectedPath } = await import('../lib/classifier.js');

const cfg = resolveConfig({});
console.log('protectRoots =', JSON.stringify(cfg.protectRoots));
console.log('');

// 1) the synthetic miss from the A1 probe
const synthetic = 'C:' + B + 'PROGRA~1' + B + 'SomeApp' + B + 'a.dll';
console.log('--- 1) the A1 probe spelling ---');
console.log('spelling   =', JSON.stringify(synthetic));
for (const fn of ['existsSync', 'realpathSync.native']) {
  try {
    const v = fn === 'existsSync' ? fs.existsSync(synthetic) : fs.realpathSync.native(synthetic);
    console.log(`${fn.padEnd(19)}= ${JSON.stringify(v)}`);
  } catch (e) { console.log(`${fn.padEnd(19)}= THREW ${e.code || e.message}`); }
}
console.log('isProtected=', isProtectedPath(synthetic, cfg.protectRoots));
console.log('=> if it does not exist, the spelling is UNREACHABLE (cosmetic), not a live bypass.');
console.log('');

// 2) REAL existing files, addressed via a genuine 8.3 alias of C:\Program Files
console.log('--- 2) REAL files via the 8.3 alias of C:\\Program Files ---');
const realCandidates = [
  'C:' + B + 'Program Files' + B + 'Common Files' + B + 'microsoft shared',
  'C:' + B + 'Program Files' + B + 'Windows Defender',
  'C:' + B + 'Program Files' + B + 'Internet Explorer',
  'C:' + B + 'Program Files (x86)',
];
let missed = 0, tested = 0, live = 0;
for (const real of realCandidates) {
  let exists = false;
  try { exists = fs.existsSync(real); } catch {}
  if (!exists) continue;
  // Build the short spelling by replacing the "Program Files" segment with its 8.3 alias.
  const alias = real.includes('(x86)') ? 'PROGRA~2' : 'PROGRA~1';
  const short = real.replace('Program Files (x86)', alias).replace('Program Files', alias);
  tested++;
  let same = false, shortExists = false;
  try { shortExists = fs.existsSync(short); } catch {}
  try { same = fs.realpathSync.native(short).toLowerCase() === fs.realpathSync.native(real).toLowerCase(); } catch {}
  const prot = isProtectedPath(short, cfg.protectRoots);
  const protReal = isProtectedPath(real, cfg.protectRoots);
  if (same && prot === false) { missed++; live++; }
  console.log(`real=${JSON.stringify(real)}`);
  console.log(`  short=${JSON.stringify(short)}`);
  console.log(`  shortExists=${shortExists} resolvesToReal=${same} isProtected(short)=${prot} isProtected(real)=${protReal}`);
  // prove it is WRITABLE/READABLE at the alias (i.e. a real, addressable path)
  if (shortExists) {
    try {
      const dir = fs.statSync(short).isDirectory() ? short : path.dirname(short);
      const probeFile = path.join(dir, `dshcc_aliaswrite_${process.pid}.tmp`);
      fs.writeFileSync(probeFile, 'x');
      const gone = fs.existsSync(probeFile);
      fs.rmSync(probeFile, { force: true });
      console.log(`  WRITABLE at the alias spelling = ${gone} -> a deletion through this spelling would really hit the protected file`);
    } catch (e) { console.log(`  write at alias: ${e.code || e.message}`); }
  }
  console.log('');
}
console.log(`tested=${tested} liveUnprotectedMisses=${missed}`);
console.log(missed === 0
  ? '>>> NO live bypass remains via 8.3 alias of C:\\Program Files'
  : `>>> REAL DEFECT: ${missed} real protected paths are addressable-but-unprotected via 8.3 alias`);
