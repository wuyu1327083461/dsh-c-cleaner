// Lead reproduction of verifier's two adversarial findings (A1, A3).
// Independent of test/run.js — written from the reported symptoms, not from its code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isProtectedPath, classify } from '../lib/classifier.js';
import { clean } from '../lib/cleaner.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const cfg = { useRecycleBin: false, maxBatch: 50 };

console.log('=== A1: protected-path spelling variants (PRD 6.2 blacklist) ===');
const shouldBeProtected = [
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
  'C:\\Users\\kiuhg\\Desktop\\x.txt',
  'C:\\Users\\kiuhg\\Documents\\x.txt',
  'c:\\windows\\NOTEPAD.EXE',
];
let missed = 0;
for (const p of shouldBeProtected) {
  const got = isProtectedPath(p);
  if (!got) missed += 1;
  console.log(`  ${got ? 'ok  ' : 'MISS'}  isProtectedPath(${JSON.stringify(p)}) = ${got}`);
}
console.log(`  => ${missed}/${shouldBeProtected.length} protected spellings NOT recognised`);

console.log('\n=== A3: directory passed to classify + clean ===');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-a3-'));
const target = path.join(dir, 'victim-dir');
fs.mkdirSync(target);
fs.writeFileSync(path.join(target, 'inner1.txt'), 'a'.repeat(100));
fs.mkdirSync(path.join(target, 'nested'));
fs.writeFileSync(path.join(target, 'nested', 'inner2.txt'), 'b'.repeat(100));
console.log('  before: victim-dir contains', fs.readdirSync(target).join(', '));

const c = classify({ path: target, size: 0, sourceProcess: 'lead-repro', mtimeMs: Date.now() }, { cfg, tree: null });
console.log('  classify(dir) ->', JSON.stringify({ category: c.category, reason: c.reason }));

const report = await clean([c], { deep: false, force: true, cfg, log });
console.log('  clean(...) ->', JSON.stringify(report));
console.log('  after : victim-dir exists =', fs.existsSync(target));
console.log('  NOTE  : bytesFreed =', report.bytesFreed, 'while', 200, 'bytes of content were destroyed');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n=== verdict ===');
// A3 is a defect only if the directory was DESTROYED. Note clean() runs before this check, so the
// earlier "exists" read is the post-clean state.
const dirSurvived = fs.existsSync(target);
console.log(`  A1 real defect: ${missed > 0} (blacklist is bypassable via path spelling)`);
console.log(`  A3 real defect: ${!dirSurvived} (directory silently recursively deleted); dir survived = ${dirSurvived}`);
console.log(`  A3 bytesFreed = ${report.bytesFreed}, removed = ${report.removed}, skipped = ${report.skipped}`);
