// Lead probe: two consistency questions on the CURRENT revision, decided by measurement.
// Q1: can a config value make `protectRoots` resolve EMPTY (fail-open) instead of falling back
//     to the default protect list? (PRD 6.2 must never be weakenable by config.)
// Q2: does the Cordis Config schema reject a bare-string `watchDirs` element that
//     `lib/config.js` deliberately tolerates (i.e. is `normaliseWatchDir`'s string branch dead)?
import { Config } from '../lib/config-schema.js';
import { resolveConfig, CATEGORY } from '../lib/config.js';

const q1 = [
  ['protectRoots: [null]', { protectRoots: [null] }],
  ['protectRoots: []', { protectRoots: [] }],
  ['protectRoots: ""', { protectRoots: '' }],
  ['protectRoots: [42]', { protectRoots: [42] }],
  ['protectRoots absent', {}],
];

console.log('=== Q1: can protectRoots ever resolve to nothing? ===');
for (const [label, raw] of q1) {
  const v = Config['~standard'].validate(raw);
  const rejected = Array.isArray(v?.issues) && v.issues.length > 0;
  let roots = '(unreachable)';
  if (!rejected) {
    const cfg = resolveConfig(v.value ?? raw);
    roots = `${cfg.protectRoots.length} root(s)`;
    if (cfg.protectRoots.length === 0) roots += '  <<< FAIL-OPEN';
  } else {
    roots = `schema rejected: ${v.issues[0].message}`;
  }
  console.log(`  ${label.padEnd(24)} schema=${rejected ? 'REJECTS' : 'accepts'}  -> ${roots}`);
}

const anyOpen = q1.some(([, raw]) => {
  const v = Config['~standard'].validate(raw);
  if (Array.isArray(v?.issues) && v.issues.length > 0) return false;
  return resolveConfig(v.value ?? raw).protectRoots.length === 0;
});
console.log(`  RESULT: protectRoots fail-open reachable = ${anyOpen}`);

console.log('');
console.log('=== Q1b: and is C:\\Windows still protected regardless? ===');
const bare = resolveConfig({ protectRoots: [] });
for (const p of ['C:\\Windows\\notepad.exe', 'C:\\Program Files\\x.dll', 'C:\\Users\\kiuhg\\Desktop\\a.txt']) {
  console.log(`  ${p.padEnd(40)} in resolved protectRoots = ${bare.protectRoots.some((r) => p.toLowerCase().startsWith(r.toLowerCase()))}`);
}

console.log('');
console.log('=== Q2: bare-string watchDirs element ===');
for (const [label, raw] of [
  ['["C:\\\\custom"] (bare string)', { watchDirs: ['C:\\custom'] }],
  ['[{path:"C:\\\\custom"}] (object)', { watchDirs: [{ path: 'C:\\custom' }] }],
]) {
  const v = Config['~standard'].validate(raw);
  const rejected = Array.isArray(v?.issues) && v.issues.length > 0;
  const direct = resolveConfig(raw).watchDirs.map((d) => d.path).join(' | ') || '(none)';
  console.log(`  ${label.padEnd(32)} schema=${rejected ? 'REJECTS (' + v.issues[0].message + ')' : 'accepts'}`);
  console.log(`  ${''.padEnd(32)} resolveConfig(direct) -> ${direct}`);
}

console.log('');
console.log('=== Q2b: is CATEGORY import intact (sanity) ===');
console.log(`  CATEGORY = ${JSON.stringify(CATEGORY)}`);
