/**
 * Build a large but harmless clean payload: every SAFE_TO_DELETE path from the live DB,
 * with the basename swapped for an untracked name. filterRequestedPaths rejects all of
 * them, so this exercises request-body reading and the early return at the panel's real
 * scale WITHOUT deleting anything.
 */
import fs from 'node:fs';

const v = JSON.parse(fs.readFileSync('.ccstate.json', 'utf8')).value;
const safe = v.rows.filter((r) => r.category === 'SAFE_TO_DELETE');
const fake = safe.map((r, i) => {
  const p = r.file_path;
  const cut = p.lastIndexOf('\\');
  return cut === -1 ? p : `${p.slice(0, cut + 1)}untracked-${i}.log`;
});
fs.writeFileSync('.ccfake.json', JSON.stringify({ paths: fake, deep: false, force: false }));
console.log('safe rows:', safe.length);
console.log('fake payload bytes:', fs.statSync('.ccfake.json').size);
console.log('sample fake path:', fake[0]);
