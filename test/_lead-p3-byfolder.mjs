import fs from 'node:fs';
const v = JSON.parse(fs.readFileSync('F:/work/state.json', 'utf8')).value;
const present = v.rows.filter((r) => { try { return fs.statSync(r.file_path).isFile(); } catch { return false; } });
const byDir = {};
for (const r of present) {
  const d = r.file_path.slice(0, r.file_path.lastIndexOf('\\'));
  byDir[d] = (byDir[d] || 0) + 1;
}
console.log('present rows by folder:');
for (const [d, n] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) console.log('  ', n, d);
console.log('\nrows with is_locked=1:', v.rows.filter((r) => r.is_locked).length);
console.log('present rows with is_locked=1:', present.filter((r) => r.is_locked).length);
