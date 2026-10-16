// verifier probe: LONG PATHS and UNICODE. The plugin does string surgery on paths
// (device-prefix stripping, `includes('~')` gating, trailing dot/space trimming, segment
// splitting on separators) and the PRD is a Chinese-language product whose protectRoots
// include `桌面` / `文档`. Both are classic sources of Windows path bugs:
//   (a) a path longer than MAX_PATH (260) — does the guard still recognise a protected root?
//   (b) non-ASCII characters — does the guard mangle/miss them?
//   (c) a filename containing a character that looks like a separator or a tilde.
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { isProtectedPath, classify } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');
const LOG = { debug(){}, info(){}, warn(){}, error(){} };
const cfg = resolveConfig({});
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const base = path.join(process.env.LOCALAPPDATA || '', 'Temp');
let failures = 0;
const verdict = (ok, msg) => { console.log('  ->', ok ? 'OK' : 'DEFECT:', msg); if (!ok) failures++; };

console.log('=== (a) LONG PATH under a protectRoot (%TEMP% deep chain) ===');
// Build a deep chain under a REAL protectRoot, C:\Windows\Temp (it is writable here).
const longDir = path.join('C:' + B + 'Windows', 'Temp', ...Array.from({ length: 12 }, (_, i) => `dshcc_long_${i}_${'x'.repeat(18)}`));
try {
  fs.mkdirSync(longDir, { recursive: true });
  const longFile = path.join(longDir, `deep_${STAMP}.log`);
  fs.writeFileSync(longFile, 'L'.repeat(32));
  console.log('  created length =', longFile.length, 'chars');
  const prot = isProtectedPath(longFile, cfg.protectRoots);
  console.log('  isProtectedPath =', prot);
  const rep = await clean([{ path: longFile, category: 'SAFE_TO_DELETE', size: 32 }], { force: true, cfg, log: LOG });
  console.log('  clean() report =', JSON.stringify({ removed: rep.removed, skipped: rep.skipped, bytesFreed: rep.bytesFreed }));
  const survives = fs.existsSync(longFile);
  verdict(prot === true && survives, `long path protected=${prot}, survives=${survives}`);
  try { fs.rmSync(longDir.split(path.sep).slice(0, 4).join(path.sep) + path.sep + longDir.split(path.sep)[3], { recursive: true, force: true }); } catch {}
  for (let i = 12; i > 0; i--) { try { fs.rmdirSync(path.join('C:' + B + 'Windows', 'Temp', ...Array.from({ length: i }, (_, k) => `dshcc_long_${k}_${'x'.repeat(18)}`))); } catch {} }
} catch (e) { console.log('  could not create long path:', e.code, e.message.split('\n')[0]); }

console.log('');
console.log('=== (b) UNICODE: Chinese-named file under a protectRoot ===');
const uniName = `逃逸缓存_${STAMP}_文档.log`;
const uniPath = path.join('C:' + B + 'Windows', 'Temp', uniName);
try {
  fs.writeFileSync(uniPath, 'U'.repeat(24));
  console.log('  path =', JSON.stringify(uniPath));
  const prot = isProtectedPath(uniPath, cfg.protectRoots);
  console.log('  isProtectedPath =', prot);
  const rep = await clean([{ path: uniPath, category: 'SAFE_TO_DELETE', size: 24 }], { force: true, cfg, log: LOG });
  console.log('  clean() report =', JSON.stringify({ removed: rep.removed, skipped: rep.skipped }));
  const survives = fs.existsSync(uniPath);
  verdict(prot === true && survives, `unicode protected=${prot}, survives=${survives}`);
  try { fs.rmSync(uniPath, { force: true }); } catch {}
} catch (e) { console.log('  could not create unicode path:', e.code, e.message.split('\n')[0]); }

console.log('');
console.log('=== (c) protectRoots entries in Chinese (PRD 桌面/文档) ===');
// Does a Chinese protectRoot actually protect, and does it over-block?
const uniRoot = path.join(base, `dshcc_uni_root_${STAMP}`);
fs.mkdirSync(uniRoot, { recursive: true });
const child = path.join(uniRoot, 'inside.tmp');
fs.writeFileSync(child, 'x');
console.log('  custom protectRoot =', JSON.stringify(uniRoot));
console.log('  isProtectedPath(child, [root]) =', isProtectedPath(child, [uniRoot]));
const rep2 = await clean([{ path: child, category: 'SAFE_TO_DELETE', size: 1 }], { force: true, cfg: { ...cfg, protectRoots: [uniRoot] }, log: LOG });
console.log('  clean() with that root =', JSON.stringify({ removed: rep2.removed, skipped: rep2.skipped, skippedList: rep2.skippedList }));
verdict(fs.existsSync(child), `custom protectRoot honoured, survives=${fs.existsSync(child)}`);

console.log('');
console.log('=== (d) a filename that CONTAINS a tilde / looks like an alias ===');
const tildeFile = path.join(base, `dshcc_tilde_${STAMP}`, 'PROGRA~9_innocent.tmp');
fs.mkdirSync(path.dirname(tildeFile), { recursive: true });
fs.writeFileSync(tildeFile, 'T'.repeat(16));
console.log('  path =', JSON.stringify(tildeFile));
console.log('  isProtectedPath =', isProtectedPath(tildeFile, cfg.protectRoots), '(must be false: it is a real temp file)');
const rep3 = await clean([{ path: tildeFile, category: 'SAFE_TO_DELETE', size: 16 }], { force: true, cfg, log: LOG });
console.log('  clean() report =', JSON.stringify({ removed: rep3.removed, skipped: rep3.skipped, bytesFreed: rep3.bytesFreed }));
const gone = !fs.existsSync(tildeFile);
console.log('  deleted =', gone, '(the expandShortNames path must not infinite-loop or refuse a legitimately deletable file)');
verdict(gone, `tilde-looking filename still deletable (deleted=${gone})`);

console.log('');
console.log(`>>> ${failures === 0 ? 'ALL PATH-SHAPE CASES OK' : failures + ' FAILING CASE(S)'}`);
try { fs.rmSync(uniRoot, { recursive: true, force: true }); } catch {}
try { fs.rmSync(path.dirname(tildeFile), { recursive: true, force: true }); } catch {}
