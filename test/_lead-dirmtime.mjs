/**
 * Does NTFS update an ANCESTOR directory's mtime when a file is created several levels
 * below it? This decides whether an overflow rescan can prune by directory mtime.
 *
 * Run: node test/_lead-dirmtime.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dirmtime-'));
const a = path.join(root, 'a');
const b = path.join(a, 'b');
const c = path.join(b, 'c');
fs.mkdirSync(c, { recursive: true });
// Put an old file in so the directories are not brand new.
fs.writeFileSync(path.join(c, 'old.txt'), 'old');

const before = {};
for (const [name, p] of [['root', root], ['a', a], ['b', b], ['c', c]]) {
  before[name] = fs.statSync(p).mtimeMs;
}

// Sleep so any mtime change is unambiguous, then create a file DEEP.
const t0 = Date.now();
while (Date.now() - t0 < 1100) { /* spin */ }
fs.writeFileSync(path.join(c, 'new.txt'), 'new');

const after = {};
for (const [name, p] of [['root', root], ['a', a], ['b', b], ['c', c]]) {
  after[name] = fs.statSync(p).mtimeMs;
}

console.log('dir            beforeDelta  changed?');
for (const name of ['root', 'a', 'b', 'c']) {
  const changed = after[name] > before[name];
  console.log(
    `${name.padEnd(14)} ${(after[name] - before[name]).toString().padStart(11)}  ${changed ? 'YES' : 'no'}`,
  );
}
console.log(`\nverdict=${after.root > before.root ? 'ANCESTOR-MTIME-PROPAGATES' : 'ANCESTOR-MTIME-STATIC'}`);
fs.rmSync(root, { recursive: true, force: true });
