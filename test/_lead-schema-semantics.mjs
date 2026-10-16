// Confirm the two semantics my config-schema doc comments describe, before correcting them.
import { Config } from '../lib/config-schema.js';
import { resolveConfig } from '../lib/config.js';

const X = 'C:' + String.fromCharCode(92) + 'x';

const cases = [
  ['unknown key (kept?)', { totallyMadeUp: 42 }],
  ['watchDirs:[null]', { watchDirs: [null] }],
  ['watchDirs:[{}]', { watchDirs: [{}] }],
  ['watchDirs:[5]', { watchDirs: [5] }],
  ['watchDirs:[bare string]', { watchDirs: [X] }],
  ['watchDirs:[good+bad]', { watchDirs: [{ path: X }, 5, { path: X + '2' }] }],
];

console.log('=== schema semantics vs what the comments claim ===');
for (const [label, raw] of cases) {
  const v = Config['~standard'].validate(raw);
  const rejected = Array.isArray(v?.issues) && v.issues.length > 0;
  let eff;
  if (rejected) {
    eff = `REJECTED: ${v.issues.map((i) => `${i.path ? i.path.join('.') + ': ' : ''}${i.message}`).join('; ')}`;
  } else {
    const keys = Object.keys(v.value);
    const dirs = resolveConfig(v.value).watchDirs.map((d) => d.path);
    eff = `value keys=[${keys.join(',')}] watchDirs=${JSON.stringify(dirs)}`;
  }
  console.log(`  ${label.padEnd(26)} ${eff}`);
}

console.log('');
console.log('CLAIM 1 "Unknown key: keep it" holds =', 'totallyMadeUp' in Config['~standard'].validate({ totallyMadeUp: 42 }).value);
const mixed = Config['~standard'].validate({ watchDirs: [{ path: X }, 5] });
console.log('CLAIM 2 "a malformed element is dropped rather than aborting the whole config"');
console.log('  watchDirs:[good, 5] -> issues =', JSON.stringify(mixed.issues ?? null));
console.log('  i.e. the comment is', Array.isArray(mixed.issues) && mixed.issues.length > 0 ? 'WRONG: the whole config IS rejected' : 'right: element dropped');
