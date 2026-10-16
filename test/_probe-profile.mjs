// Lead probe: inspect the profile state after the failed install.
// Written to disk because backslash paths inside `node -e` get mangled by bash.
import fs from 'node:fs';

const PROFILE = 'E:/dsh/.dsh/profiles/tauri';
const pkg = JSON.parse(fs.readFileSync(`${PROFILE}/package.json`, 'utf8'));

console.log('=== profile package.json ===');
console.log('dependencies      :', JSON.stringify(pkg.dependencies, null, 2));
console.log('dsh.profile.bundles:', JSON.stringify(pkg.dsh?.profile?.bundles, null, 2));

console.log('\n=== node_modules link ===');
const link = `${PROFILE}/node_modules/dsh-c-cleaner`;
try {
  const st = fs.lstatSync(link);
  console.log('lstat isSymbolicLink:', st.isSymbolicLink());
  const real = fs.realpathSync(link); // throws if dangling
  console.log('realpath           :', real);
} catch (e) {
  console.log('link problem       :', e.code, e.message.split('\n')[0]);
}

console.log('\n=== does the real dir exist? ===');
for (const p of ['F:/work/dsh-c-cleaner', 'E:/f/work/dsh-c-cleaner']) {
  console.log(`  ${p} :`, fs.existsSync(p));
}

console.log('\n=== patch file: is dsh-c-cleaner mentioned? ===');
const patch = fs.readFileSync(`${PROFILE}/cordis.patch.yml`, 'utf8');
console.log('  mentions dsh-c-cleaner:', patch.includes('dsh-c-cleaner'));
