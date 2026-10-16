// Lead: H1/H3 tested at the DIRECT API level. resolveConfig() is a documented public export
// (index.js re-exports it), and its own JSDoc says input is "treated as untrusted here because tests
// call this directly" — so a crash on a malformed entry is a real robustness gap in my own file,
// independent of the Cordis schema that guards the production path.
import { resolveConfig } from '../lib/config.js';

const cases = [
  ['watchDirs: ["C:\\\\plain-string"]   (the adversarial-reach.mjs shape)', { watchDirs: ['C:\\plain-string'] }],
  ['watchDirs: [null]', { watchDirs: [null] }],
  ['watchDirs: [42]', { watchDirs: [42] }],
  ['watchDirs: [{}]                  (no path)', { watchDirs: [{}] }],
  ['watchDirs: [""]', { watchDirs: [''] }],
  ['watchDirs: {path:"C:\\\\x"}       (not an array)', { watchDirs: { path: 'C:\\x' } }],
  ['protectRoots: [null]', { protectRoots: [null] }],
  ['protectRoots: "C:\\\\x"', { protectRoots: 'C:\\x' }],
  ['excludeNames: [null]', { excludeNames: [null] }],
  ['debounceMs: "abc"', { debounceMs: 'abc' }],
  ['debounceMs: -5', { debounceMs: -5 }],
  ['debounceMs: NaN', { debounceMs: NaN }],
  ['sessionWindowMs: -1', { sessionWindowMs: -1 }],
  ['pollIntervalMs: "x"', { pollIntervalMs: 'x' }],
  ['maxBatch: 0', { maxBatch: 0 }],
  ['envMap: "nope"', { envMap: 'nope' }],
  ['envMap: {TEMP: 7}', { envMap: { TEMP: 7 } }],
  ['envMap: {TEMP: ""}', { envMap: { TEMP: '' } }],
  ['escapeRoot: 42', { escapeRoot: 42 }],
  ['dshHome: null', { dshHome: null }],
  ['aiSignatureGlobs: [null]', { aiSignatureGlobs: [null] }],
];

let ok = 0, threw = 0;
const failures = [];
for (const [label, input] of cases) {
  try {
    const cfg = resolveConfig(input);
    ok += 1;
    // show the fields that matter for each interesting case
    const probe = {};
    if ('watchDirs' in input) probe.watchDirs = cfg.watchDirs;
    if ('debounceMs' in input) probe.debounceMs = cfg.debounceMs;
    if ('sessionWindowMs' in input) probe.sessionWindowMs = cfg.sessionWindowMs;
    if ('pollIntervalMs' in input) probe.pollIntervalMs = cfg.pollIntervalMs;
    if ('maxBatch' in input) probe.maxBatch = cfg.maxBatch;
    if ('envMap' in input) probe.envMap = cfg.envMap;
    if ('protectRoots' in input) probe.protectRoots = cfg.protectRoots.length;
    if ('excludeNames' in input) probe.excludeNames = cfg.excludeNames;
    if ('aiSignatureGlobs' in input) probe.aiSignatureGlobs = cfg.aiSignatureGlobs;
    if ('escapeRoot' in input) probe.escapeRoot = cfg.escapeRoot;
    console.log(`  ok    ${label}`);
    if (Object.keys(probe).length) console.log(`        ${JSON.stringify(probe)}`);
  } catch (e) {
    threw += 1;
    failures.push({ label, err: `${e.constructor.name}: ${e.message}` });
    console.log(`  THREW ${label}`);
    console.log(`        ${e.constructor.name}: ${e.message}`);
  }
}
console.log(`\n=== verdict ===`);
console.log(`  survived: ${ok}   threw: ${threw}`);
for (const f of failures) console.log(`  CRASH ${f.label}\n        ${f.err}`);
console.log(threw === 0
  ? '  => resolveConfig is robust to malformed input at the API level.'
  : `  => ${threw} malformed input(s) CRASH resolveConfig (H1/H3 real at the API level, blocked in production by the Cordis schema).`);
