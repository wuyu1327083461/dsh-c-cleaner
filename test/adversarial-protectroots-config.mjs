// verifier probe: PRD §6.2 says the hardcoded protected paths must ABSOLUTELY refuse deletion
// "even if the config is wrong" (即使配置错误). Does a config-supplied protectRoots value
// DISABLE the built-in blacklist? If protectRoots: [] removes all protection, the PRD's
// "absolute" guarantee is user-overridable.
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { isProtectedPath, classify, CATEGORY } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');
const LOG = { debug(){}, info(){}, warn(){}, error(){} };

console.log('=== the four config shapes ===');
const shapes = [
  ['default', {}],
  ['protectRoots: []  (empty array)', { protectRoots: [] }],
  ['protectRoots: null', { protectRoots: null }],
  ['protectRoots: ["E:\\\\nonexistent_only"]', { protectRoots: ['E:' + B + 'nonexistent_only_xyz'] }],
];
const resolved = {};
for (const [label, raw] of shapes) {
  const cfg = resolveConfig(raw);
  resolved[label] = cfg;
  console.log(`${label.padEnd(38)} -> protectRoots(${cfg.protectRoots.length}) =`, JSON.stringify(cfg.protectRoots.slice(0, 4)));
}
console.log('');

const winFile = path.join('C:' + B + 'Windows', 'System32', 'kernel32.dll');
console.log('=== isProtectedPath on a HARDCODED protected path per shape ===');
console.log('candidate =', JSON.stringify(winFile), 'exists=', fs.existsSync(winFile));
for (const [label, cfg] of Object.entries(resolved)) {
  console.log(`  ${label.padEnd(38)} -> isProtectedPath = ${isProtectedPath(winFile, cfg.protectRoots)}`);
}
console.log('');

// SAFETY: never aim a real deletion at a system file. Prove the deletion decision on a REAL
// but DISPOSABLE file we create inside a genuinely protected root, then clean() it.
console.log('=== decisive deletion test: a real file WE OWN inside a hardcoded protectRoot ===');
const probeFile = path.join('C:' + B + 'Windows', 'Temp', `dshcc_prd62_${process.pid}_${Date.now().toString(36)}.log`);
let created = false;
try { fs.writeFileSync(probeFile, 'x'.repeat(32)); created = true; } catch (e) { console.log('could not create:', e.code); }
console.log('probe file =', JSON.stringify(probeFile), 'created =', created);
console.log('');

if (created) {
  for (const [label, cfg] of Object.entries(resolved)) {
    // fresh copy each round so each shape gets a fair test
    fs.writeFileSync(probeFile, 'x'.repeat(32));
    const c = classify({ path: probeFile, size: 32 }, { cfg, tree: { ownerOf: () => null, nameOf: () => null } });
    const rep = await clean([{ path: probeFile, category: c.category, size: 32 }], { deep: true, force: true, cfg, log: LOG });
    const gone = !fs.existsSync(probeFile);
    console.log(`${label}`);
    console.log(`   classify=${c.category}  clean={removed:${rep.removed},skipped:${rep.skipped}}  DELETED=${gone}`);
    if (rep.skippedList && rep.skippedList.length) console.log(`   skip reason: ${rep.skippedList[0].reason}`);
    fs.writeFileSync(probeFile, 'x'.repeat(32)); // restore for the next shape
  }
  try { fs.rmSync(probeFile, { force: true }); } catch {}
  console.log('');
  console.log('=== verdict ===');
  const emptied = resolved['protectRoots: []  (empty array)'];
  const stillProtected = isProtectedPath(winFile, emptied.protectRoots);
  console.log(stillProtected
    ? '>>> SAFE: an emptied protectRoots config does NOT disable the built-in blacklist'
    : '>>> REAL DEFECT (PRD 6.2, HIGH): protectRoots:[] DISABLES the hardcoded blacklist. PRD 6.2 requires');
  if (!stillProtected) {
    console.log('    the hardcoded protected paths to refuse deletion EVEN WHEN CONFIG IS WRONG.');
    console.log('    A config value therefore overrides the "absolute" guarantee.');
  }
}
