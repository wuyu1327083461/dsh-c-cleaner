/** Lead probe: the Phase 3 command grammar must accept paths with spaces and keep the old strictness. */
import { parseArgs, USAGE } from '../lib/commands.js';

let pass = 0;
let fail = 0;
const ok = (cond, what, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS ${what}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL ${what}${extra ? ' :: ' + extra : ''}`);
  }
};
const eq = (actual, expected, what) =>
  ok(JSON.stringify(actual) === JSON.stringify(expected), what, `got ${JSON.stringify(actual)}`);

// unchanged Phase 1/2 grammar
eq(parseArgs(''), { ok: false, code: 'EMPTY' }, 'empty input stays EMPTY');
eq(parseArgs('status'), { ok: true, verb: 'status', deep: false, force: false }, 'status');
eq(parseArgs('status now'), { ok: false, code: 'STATUS_EXTRA_ARGS' }, 'status now still rejected');
eq(parseArgs('ui'), { ok: true, verb: 'ui', deep: false, force: false }, 'ui');
eq(parseArgs('ui x'), { ok: false, code: 'UI_EXTRA_ARGS' }, 'ui x still rejected');
eq(parseArgs('now --deep --force'), { ok: true, verb: 'now', deep: true, force: true }, 'now flags');
eq(parseArgs('now --nope'), { ok: false, code: 'UNKNOWN_FLAG' }, 'unknown flag still rejected');
eq(parseArgs('now --deep --deep'), { ok: false, code: 'DUPLICATE_FLAG' }, 'duplicate flag still rejected');
eq(parseArgs('bogus'), { ok: false, code: 'UNKNOWN_VERB' }, 'unknown verb still rejected');

// Phase 3 verbs
eq(parseArgs('migrate'), { ok: true, verb: 'migrate', path: '' }, 'migrate alone = list form');
eq(parseArgs('MIGRATE'), { ok: true, verb: 'migrate', path: '' }, 'verb is case-insensitive');
const spaced = 'migrate C:\\Users\\kiuhg\\AppData\\Local\\Temp\\My Cache';
eq(
  parseArgs(spaced),
  { ok: true, verb: 'migrate', path: 'C:\\Users\\kiuhg\\AppData\\Local\\Temp\\My Cache' },
  'a path containing a SPACE is rejoined, not split into tokens',
);
const quoted = 'migrate "C:\\Users\\kiuhg\\AppData\\Local\\Temp\\My Cache"';
eq(parseArgs(quoted).path, '"C:\\Users\\kiuhg\\AppData\\Local\\Temp\\My Cache"', 'quotes are preserved verbatim (the fs layer resolves)');
eq(parseArgs('unmigrate'), { ok: false, code: 'UNMIGRATE_PATH_REQUIRED' }, 'unmigrate without a path is rejected');
eq(parseArgs('unmigrate C:\\x\\y z'), { ok: true, verb: 'unmigrate', path: 'C:\\x\\y z' }, 'unmigrate takes a spaced path');
eq(parseArgs('  migrate   C:\\x  ').path, 'C:\\x', 'outer padding is trimmed');

// usage must document the new verbs
ok(USAGE.includes('migrate') && USAGE.includes('unmigrate'), 'USAGE documents migrate/unmigrate');

console.log(`\nSUMMARY pass=${pass} fail=${fail} verdict=${fail === 0 ? 'GREEN' : 'RED'}`);
process.exit(fail === 0 ? 0 : 1);
