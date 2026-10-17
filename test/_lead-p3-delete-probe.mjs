// Why does one-click clean report EBUSY for every file?
// Compares the recycle-bin path against a plain unlink on the SAME files, and
// tests whether the recycle path works for a file we create ourselves.
import fs from 'node:fs';
import path from 'node:path';
import { toRecycleBin, hardDelete } from '../lib/cleaner.js';

const NOOP = { info(){}, debug(){}, warn(){}, error(){} };

const base = process.env.LOCALAPPDATA + '/Temp/dcc_delprobe_' + process.pid;
fs.mkdirSync(base, { recursive: true });

// 1. Fresh files WE own: does the recycle bin work at all?
const ours = [1, 2, 3].map((i) => {
  const p = path.join(base, `ours_${i}.log`);
  fs.writeFileSync(p, 'x'.repeat(1000));
  return p;
});
console.log('=== freshly created files, recycle bin ===');
const r1 = await toRecycleBin(ours.slice(), NOOP);
console.log('  recycle result:', JSON.stringify({ ok: r1 }));
for (const p of ours) console.log('   ', fs.existsSync(p) ? 'STILL THERE' : 'gone    ', path.basename(p));

// 2. Fresh files, hard delete (baseline)
const ours2 = [1, 2].map((i) => {
  const p = path.join(base, `hard_${i}.log`);
  fs.writeFileSync(p, 'x'.repeat(1000));
  return p;
});
console.log('=== freshly created files, hardDelete ===');
const r2 = hardDelete(ours2.slice(), NOOP);
console.log('  hardDelete result:', JSON.stringify(r2));
for (const p of ours2) console.log('   ', fs.existsSync(p) ? 'STILL THERE' : 'gone    ', path.basename(p));

// 3. The real question: a file that exists in %TEMP% from another program.
//    Take a safe row that is small and exists, then try recycle FIRST, then unlink.
const state = JSON.parse(fs.readFileSync('F:/work/state.json', 'utf8')).value;
const candidates = state.rows
  .filter((r) => r.category === 'SAFE_TO_DELETE' && r.file_size > 0 && r.file_size < 300000)
  .filter((r) => fs.existsSync(r.file_path))
  .slice(0, 4);
console.log('=== foreign %TEMP% files ===');
for (const row of candidates) {
  const p = row.file_path;
  let openable = 'no';
  try { const fd = fs.openSync(p, 'r+'); fs.closeSync(fd); openable = 'yes (r+)'; }
  catch (e) { openable = 'open failed ' + e.code; }
  console.log(' ', path.basename(p), '| exists | openable:', openable);
  // Try plain unlink on a COPY-free basis: unlink moves to nowhere, so only try on one file.
}

// 4. Test the recycle path on exactly one foreign file, then see the message.
const victim = candidates[0];
if (victim) {
  const p = victim.file_path;
  console.log('=== recycle ONE foreign file ===');
  console.log('  target:', p);
  const before = fs.existsSync(p);
  const r = await toRecycleBin([p], NOOP);
  const after = fs.existsSync(p);
  console.log('  before exists:', before, '-> after exists:', after);
  console.log('  recycle raw result:', JSON.stringify(r));

  // 5. Now plain unlink the same file (if it survived) to see if it is really locked.
  if (after) {
    console.log('=== same file, plain unlinkSync ===');
    try { fs.unlinkSync(p); console.log('  unlink OK -> the file was NOT locked; the recycle path was the problem'); }
    catch (e) { console.log('  unlink threw', e.code, '-> genuinely locked:', e.message); }
  }
}

// 6. A locked-file control: hold a handle ourselves and try both paths.
const held = path.join(base, 'held.log');
fs.writeFileSync(held, 'y'.repeat(500));
const fd = fs.openSync(held, 'r+');
console.log('=== our OWN held-open file ===');
const r3 = await toRecycleBin([held], NOOP);
console.log('  recycle on held file:', JSON.stringify(r3), '| still there:', fs.existsSync(held));
fs.closeSync(fd);
const r4 = hardDelete([held], NOOP);
console.log('  hardDelete after close:', JSON.stringify(r4), '| still there:', fs.existsSync(held));

try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
console.log('DONE');
