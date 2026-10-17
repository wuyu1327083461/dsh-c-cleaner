// Is "openable r+" a valid proxy for "deletable"? And how many of the 17.5k SAFE rows
// are actually delete-locked right now?
//
// The classifier uses fs.openSync(p,'r+') to decide is_locked. If a holder opened the file
// without FILE_SHARE_DELETE, r+ still succeeds while unlink fails -> the file is offered as
// cleanable but can never be cleaned. This measures the gap on the live table.
import fs from 'node:fs';
import path from 'node:path';

const state = JSON.parse(fs.readFileSync('F:/work/state.json', 'utf8')).value;
const rows = state.rows.filter((r) => r.category === 'SAFE_TO_DELETE');
console.log('SAFE_TO_DELETE rows:', rows.length);

// Non-destructive delete-permission test: rename within the same directory requires DELETE
// access on the file, exactly like unlink does, but the rename-back restores the name.
function canDelete(p) {
  const probe = p + '.dccdelprobe';
  try {
    fs.renameSync(p, probe);
  } catch (err) {
    return { ok: false, code: err.code };
  }
  try {
    fs.renameSync(probe, p);
  } catch (err) {
    // Should not happen; report loudly so the name can be restored by hand.
    return { ok: true, restoreFailed: err.code, stranded: probe };
  }
  return { ok: true };
}

// Sample: every 500th row, so the sample spreads across the whole table.
const step = Math.max(1, Math.floor(rows.length / 60));
const sample = [];
for (let i = 0; i < rows.length && sample.length < 60; i += step) sample.push(rows[i]);

let openOk = 0, delOk = 0, missing = 0;
const disagreements = [];
const lockedNames = new Map();
for (const row of sample) {
  const p = row.file_path;
  if (!fs.existsSync(p)) { missing += 1; continue; }
  let canOpen = true;
  try { const fd = fs.openSync(p, 'r+'); fs.closeSync(fd); } catch { canOpen = false; }
  const del = canDelete(p);
  if (canOpen) openOk += 1;
  if (del.ok) delOk += 1;
  if (del.restoreFailed) console.log('  !! restore failed:', del.stranded);
  if (canOpen !== del.ok) {
    disagreements.push({ p, canOpen, del });
    const top = p.split('\\').slice(-2, -1)[0];
    lockedNames.set(top, (lockedNames.get(top) || 0) + 1);
  }
}
console.log(`sample size: ${sample.length - missing} present, ${missing} missing`);
console.log(`openable r+ : ${openOk}`);
console.log(`deletable   : ${delOk}`);
console.log(`DISAGREEMENTS (openable but NOT deletable): ${disagreements.length}`);
const pct = ((disagreements.length / (sample.length - missing)) * 100).toFixed(1);
console.log(`  = ${pct}% of live SAFE rows are offered as cleanable but cannot be deleted`);
console.log('  by containing folder:', [...lockedNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
console.log('  examples:');
for (const d of disagreements.slice(0, 8)) console.log('   ', d.del.code, d.p);
console.log('DONE');
