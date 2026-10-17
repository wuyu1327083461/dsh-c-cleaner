// How stale is the tracked table? "Clean" can only delete files that exist, so a
// table dominated by rows whose file is already gone makes one-click clean a no-op
// that still reports skipped=N.
import fs from 'node:fs';

const state = JSON.parse(fs.readFileSync('F:/work/state.json', 'utf8')).value;
const rows = state.rows;
const byTier = {};
for (const r of rows) {
  byTier[r.category] ??= { total: 0, present: 0, missing: 0, bytesPresent: 0, bytesMissing: 0 };
  const t = byTier[r.category];
  t.total += 1;
  let present = false;
  try { present = fs.statSync(r.file_path).isFile(); } catch { present = false; }
  if (present) { t.present += 1; t.bytesPresent += r.file_size; } else { t.missing += 1; t.bytesMissing += r.file_size; }
}
for (const [tier, t] of Object.entries(byTier)) {
  const pct = ((t.missing / t.total) * 100).toFixed(1);
  console.log(
    `${tier.padEnd(16)} total=${String(t.total).padStart(6)} present=${String(t.present).padStart(6)} missing=${String(t.missing).padStart(6)} (${pct}% stale)  bytesMissing=${(t.bytesMissing / 1e9).toFixed(2)} GB`,
  );
}

// Of the rows that ARE present, how many are delete-locked?
const presentSafe = rows.filter((r) => {
  if (r.category !== 'SAFE_TO_DELETE') return false;
  try { return fs.statSync(r.file_path).isFile(); } catch { return false; }
});
console.log('\nSAFE rows whose file still exists:', presentSafe.length);
let locked = 0, openableNotDeletable = 0, deletable = 0;
for (const r of presentSafe) {
  const p = r.file_path;
  const probe = p + '.dccprobe';
  let canRename = true;
  try { fs.renameSync(p, probe); fs.renameSync(probe, p); } catch (e) {
    canRename = false;
    try { fs.renameSync(probe, p); } catch {}
  }
  if (canRename) deletable += 1;
  else {
    locked += 1;
    let canOpen = true;
    try { const fd = fs.openSync(p, 'r+'); fs.closeSync(fd); } catch { canOpen = false; }
    if (canOpen) openableNotDeletable += 1;
  }
}
console.log(`  deletable right now        : ${deletable}`);
console.log(`  NOT deletable              : ${locked}`);
console.log(`  of which "openable r+"     : ${openableNotDeletable}  <- misclassified as unlocked`);
console.log('DONE');
