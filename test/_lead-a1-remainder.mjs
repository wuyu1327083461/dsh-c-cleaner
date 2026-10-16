// Lead: isolate the ONE remaining A1 spelling (verifier reports 1/13). Likely
// 'C:\PROGRA~1\SomeApp\a.dll' — a short alias whose PARENT expands but whose leaf path does not
// exist, so realpath(parent) throws ENOENT and the string form keeps the alias.
import { isProtectedPath } from '../lib/classifier.js';
import fs from 'node:fs';
import path from 'node:path';

const spellings = [
  'C:\\Windows\\notepad.exe',
  'C:\\Windows \\notepad.exe',
  'C:\\Windows.\\notepad.exe',
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  '\\\\?\\C:\\Windows\\notepad.exe',
  '//?/C:/Windows/notepad.exe',
  'C:\\Program Files\\evil.exe',
  'C:\\PROGRA~1\\evil.exe',
  'C:\\Program Files (x86)\\evil.exe',
  'C:\\PROGRA~2\\evil.exe',
  'C:\\PROGRA~1\\SomeApp\\a.dll',
  'C:\\Users\\kiuhg\\Desktop\\x.txt',
  'C:\\Users\\kiuhg\\Documents\\x.txt',
  'c:\\windows\\NOTEPAD.EXE',
];

console.log('=== every spelling the verifier checks, with OS ground truth ===');
let missed = [];
for (const s of spellings) {
  const got = isProtectedPath(s);
  if (!got) missed.push(s);
  const exists = fs.existsSync(s);
  let real = null;
  try { real = fs.realpathSync.native(s); } catch { /* */ }
  // does the OS resolve the PARENT of this spelling into a protected root?
  const dir = path.dirname(s);
  let parentReal = null;
  try { parentReal = fs.realpathSync.native(dir); } catch { /* */ }
  console.log(`  ${got ? 'ok  ' : 'MISS'}  ${JSON.stringify(s)}`);
  console.log(`        exists=${exists}  realpath=${real ?? 'THREW'}  parentRealpath=${parentReal ?? 'THREW'}`);
}
console.log(`\n  ${missed.length}/${spellings.length} missed: ${JSON.stringify(missed)}`);

// Is the remaining one OS-reachable at all?
console.log('\n=== is the remaining miss actually reachable? ===');
for (const s of missed) {
  const dir = path.dirname(s);
  let parentReal = null;
  try { parentReal = fs.realpathSync.native(dir); } catch (e) { parentReal = `THREW ${e.code}`; }
  const parentExists = fs.existsSync(dir);
  console.log(`  ${JSON.stringify(s)}`);
  console.log(`      parent ${JSON.stringify(dir)} exists=${parentExists} realpath=${parentReal}`);
  // Would a file be creatable there?
  let creatable = false;
  try { fs.writeFileSync(s, 'probe'); creatable = true; fs.rmSync(s, { force: true }); } catch { /* */ }
  console.log(`      could a real file exist at this exact spelling? ${creatable}`);
  if (creatable) console.log('      >>> LIVE BYPASS: a real file inside a protected root uses this spelling');
  else console.log('      >>> COSMETIC on this host: nothing can be created at that spelling');
}
