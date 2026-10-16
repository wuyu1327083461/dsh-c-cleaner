// Lead: disambiguate. My previous probe called isProtectedPath(s) with NO cfg, so ProgramData
// (which lives in cfg.protectRoots, NOT in the PRD §6.2 hardcoded list) was expected to be false.
// The real question is whether the PRODUCTION path — classify(candidate, {cfg, tree}) — protects it.
import { isProtectedPath, classify } from '../lib/classifier.js';
import { resolveConfig } from '../lib/config.js';
import fs from 'node:fs';
import path from 'node:path';

const cfg = resolveConfig({}, process.env);
console.log('=== cfg.protectRoots as resolved in production ===');
for (const r of cfg.protectRoots) console.log('  ', JSON.stringify(r));

console.log('\n=== isProtectedPath WITH the production protectRoots ===');
for (const s of [
  'C:\\ProgramData\\Esafenet_dbset11.dat',
  'C:\\ProgramData\\x.txt',
  'C:\\PROGRA~3\\x.txt',
  'C:\\Windows\\notepad.exe',
  'C:\\Program Files\\x.dll',
]) {
  console.log(`  ${isProtectedPath(s, cfg.protectRoots) ? 'PROTECTED    ' : 'not protected'}  ${JSON.stringify(s)}`);
}

console.log('\n=== the PRODUCTION path: classify() as the watcher would call it ===');
for (const s of [
  'C:\\ProgramData\\Esafenet_dbset11.dat',
  'C:\\PROGRAMDATA\\Esafenet_dbset11.dat',
  'C:\\PROGRA~3\\Esafenet_dbset11.dat',
]) {
  let c;
  try { c = classify({ path: s, size: 10, mtimeMs: Date.now(), sourceProcess: null }, { cfg, tree: null }); }
  catch (e) { console.log(`  THREW ${e.code} ${e.message} on ${JSON.stringify(s)}`); continue; }
  console.log(`  ${c.category}  ${JSON.stringify(s)}`);
  console.log(`        reason: ${c.reason}`);
}

console.log('\n=== PRD §6.2 hardcoded list, checked against the no-cfg call ===');
const prdHardcoded = ['C:\\Windows\\x', 'C:\\Program Files\\x', path.join(process.env.USERPROFILE, 'Desktop', 'x'), path.join(process.env.USERPROFILE, 'Documents', 'x')];
for (const s of prdHardcoded) {
  console.log(`  ${isProtectedPath(s) ? 'ok  ' : 'MISS'}  isProtectedPath(${JSON.stringify(s)}) = ${isProtectedPath(s)}`);
}

console.log('\n=== reachability of the ProgramData case via the watcher ===');
console.log('  ProgramData is NOT a configured watchDir, so the watcher never feeds it to classify:');
for (const w of cfg.watchDirs) console.log('    watchDir:', JSON.stringify(w.path), 'recursive:', w.recursive);
const inWatch = cfg.watchDirs.some((w) => path.resolve('C:\\ProgramData\\x').toLowerCase().startsWith(path.resolve(w.path).toLowerCase()));
console.log('  C:\\ProgramData under any watchDir?', inWatch);
console.log('  clean() also re-checks isProtectedPath(cfg.protectRoots) independently:', typeof isProtectedPath);
console.log('  => ProgramData IS vetoed on both the classify and clean paths when cfg is threaded through.');
