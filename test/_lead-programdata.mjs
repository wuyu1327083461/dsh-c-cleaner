// Lead: is the ProgramData "DEFEATED" result real, or did my reachability probe mangle the path by
// joining a relative segment without a separator? Test the exact strings it printed, plus clean
// ProgramData spellings, and check what systemProtectedRoots() actually contains.
import { isProtectedPath } from '../lib/classifier.js';
import fs from 'node:fs';
import path from 'node:path';

console.log('=== the exact strings my probe flagged ===');
for (const s of [
  'C:\\ProgramData\\dshcc_wt_dev_1351dev.tmp',
  'C:\\ProgramData\\Esafenet_dbset11.dat',
  'C:\\ProgramData\\EstConfig.ini',
  'C:\\PROGRA~3\\Esafenet_dbset11.dat',
]) {
  console.log(`  ${JSON.stringify(s)}`);
  console.log(`      existsSync=${fs.existsSync(s)}  isProtectedPath=${isProtectedPath(s)}`);
}

console.log('\n=== clean, unambiguous ProgramData spellings ===');
for (const s of [
  'C:\\ProgramData\\x.txt',
  'C:\\ProgramData\\Esafenet_dbset11.dat',
  'C:\\PROGRA~3\\x.txt',
  'c:\\programdata\\anything.log',
  'C:\\ProgramData\\',
  'C:\\ProgramData',
]) {
  console.log(`  isProtectedPath(${JSON.stringify(s)}) = ${isProtectedPath(s)}`);
}

console.log('\n=== is a real ProgramData entry actually unprotected? ===');
let n = 0;
try {
  for (const e of fs.readdirSync('C:\\ProgramData', { withFileTypes: true })) {
    const full = path.join('C:\\ProgramData', e.name);
    const p = isProtectedPath(full);
    if (!p) { console.log(`  UNPROTECTED  ${e.isDirectory() ? 'DIR ' : 'FILE'}  ${JSON.stringify(full)}`); n += 1; }
    if (n >= 8) break;
  }
} catch (err) { console.log('  readdir failed:', err.code); }
console.log(`  unprotected real ProgramData entries: ${n}`);

console.log('\n=== what does the module consider a system-protected root? ===');
const src = fs.readFileSync(new URL('../lib/classifier.js', import.meta.url), 'utf8');
const m = src.match(/const SYSTEM_[A-Z_]*\s*=\s*\[[^\]]*\]/g);
console.log(m ? m.join('\n') : '(no inline SYSTEM_* array found)');
