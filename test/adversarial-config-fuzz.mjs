// verifier probe (task-4 re-verify rev2) — item 2: fuzz resolveConfig with malformed input.
//
// Contract under test (lead message item 3 / H1+H3): `resolveConfig` is a documented public export
// whose JSDoc declares its input untrusted. It must NEVER throw for any input, and every clamped
// numeric must keep its documented floor:
//   debounceMs     floor 0    default 3000
//   pollIntervalMs floor 250  default 5000
//   sessionWindowMs floor 0   default 30*60*1000
//   maxBatch       floor 1    default 50
// Plus: a VALID config must still be honoured (no over-coercion) — that is the positive control
// that stops "coerce everything to defaults" from passing this probe.
import path from 'node:path';
import { resolveConfig } from '../lib/config.js';

let failures = 0;
const verdict = (ok, msg) => { console.log('  ->', ok ? 'OK' : 'DEFECT:', msg); if (!ok) failures++; };

const FLOORS = {
  debounceMs: { floor: 0, def: 3000 },
  pollIntervalMs: { floor: 250, def: 5000 },
  sessionWindowMs: { floor: 0, def: 30 * 60 * 1000 },
  maxBatch: { floor: 1, def: 50 },
};

// Every call must be total: no throw, and the four numerics must always respect their floor.
const calls = [];
const push = (label, raw, env) => calls.push({ label, raw, env });

const JUNK = [
  undefined, null, 0, 1, -1, NaN, Infinity, -Infinity, 1e309, '', '   ', 'x', '3000', [], {}, true, false,
  [null], [undefined], [''], [0], [1], [NaN], [{}], [[]], ['x'], ['C:\\Windows'], [null, 1, 'a', {}],
  { path: null }, { path: 42 }, { path: '' }, { path: 'C:\\ok' }, { path: 'C:\\ok', recursive: 'yes', maxDepth: 'x' },
  [{ path: 'C:\\a' }, { path: 'c:\\A' }, { path: 'C:\\b' }, null],
  Symbol.iterator, () => {}, new Date(0), /re/, new Map(), new Set(),
];

for (const junk of JUNK) {
  push(`watchDirs=${String(junk).slice(0, 30)}`, { watchDirs: junk });
  push(`protectRoots=${String(junk).slice(0, 30)}`, { protectRoots: junk });
  push(`excludeNames=${String(junk).slice(0, 30)}`, { excludeNames: junk });
  push(`aiSignatureGlobs=${String(junk).slice(0, 30)}`, { aiSignatureGlobs: junk });
  push(`envMap=${String(junk).slice(0, 30)}`, { envMap: junk });
  push(`escapeRoot=${String(junk).slice(0, 30)}`, { escapeRoot: junk });
  push(`dshHome=${String(junk).slice(0, 30)}`, { dshHome: junk });
  push(`stateDir=${String(junk).slice(0, 30)}`, { stateDir: junk });
  push(`dbPath=${String(junk).slice(0, 30)}`, { dbPath: junk });
  for (const k of Object.keys(FLOORS)) push(`${k}=${String(junk).slice(0, 24)}`, { [k]: junk });
}

// Non-object top-level configs and malformed env objects.
for (const raw of [undefined, null, 0, 1, NaN, '', 'cfg', [], [1, 2], true, false, Symbol.iterator, () => {}, new Date(0)]) {
  push(`raw=${String(raw).slice(0, 24)}`, raw);
}
for (const env of [undefined, null, 0, 'x', [], true, () => {}, new Date(0)]) {
  push(`env=${String(env).slice(0, 24)}`, {}, env);
}
// Combos.
push('all-junk-at-once', {
  watchDirs: [null, 1, '', 'C:\\ok'], protectRoots: [null, NaN, {}], excludeNames: [1, null], aiSignatureGlobs: 'x',
  envMap: 'nope', escapeRoot: 42, dshHome: null, stateDir: [], dbPath: {}, debounceMs: NaN, pollIntervalMs: -99,
  sessionWindowMs: 'x', maxBatch: 0, enabled: 'yes', useRecycleBin: 'no', autoClean: 'true', resolveLockOwner: 'false',
});

console.log(`=== fuzzing resolveConfig with ${calls.length} malformed calls ===`);
const thrown = [];
for (const { label, raw, env } of calls) {
  let cfg = null;
  try {
    cfg = env === undefined ? resolveConfig(raw) : resolveConfig(raw, env);
  } catch (err) {
    thrown.push(`${label} -> ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
    continue;
  }
  if (!cfg || typeof cfg !== 'object') { thrown.push(`${label} -> returned ${typeof cfg}`); continue; }
  for (const [k, { floor }] of Object.entries(FLOORS)) {
    const v = cfg[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < floor) {
      thrown.push(`${label} -> ${k}=${JSON.stringify(v)} violates floor ${floor}`);
    }
  }
  if (!Array.isArray(cfg.watchDirs)) thrown.push(`${label} -> watchDirs is not an array`);
  if (!Array.isArray(cfg.protectRoots)) thrown.push(`${label} -> protectRoots is not an array`);
  if (cfg.envMap === null || typeof cfg.envMap !== 'object' || Array.isArray(cfg.envMap)) thrown.push(`${label} -> envMap is not a plain object`);
  if (typeof cfg.escapeRoot !== 'string' || cfg.escapeRoot.length === 0) thrown.push(`${label} -> escapeRoot not a usable string`);
  if (typeof cfg.dbPath !== 'string' || cfg.dbPath.length === 0) thrown.push(`${label} -> dbPath not a usable string`);
  for (const [name, entry] of cfg.watchDirs.entries()) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) thrown.push(`${label} -> watchDirs[${name}] has no usable path`);
    if (typeof entry.recursive !== 'boolean') thrown.push(`${label} -> watchDirs[${name}].recursive is not boolean`);
    if (typeof entry.maxDepth !== 'number' || !Number.isFinite(entry.maxDepth)) thrown.push(`${label} -> watchDirs[${name}].maxDepth is not a finite number`);
  }
}
verdict(thrown.length === 0, `${calls.length} malformed calls: 0 throws and all invariants held (violations=${thrown.length})`);
for (const t of thrown.slice(0, 12)) console.log('       ', t);
if (thrown.length > 12) console.log(`        ... and ${thrown.length - 12} more`);

// --- positive control: valid input must NOT be coerced away --------------------------------
console.log('');
console.log('=== positive control (valid config must be honoured, not defaulted away) ===');
const good = resolveConfig({
  escapeRoot: 'E:\\my_escape', dshHome: 'E:\\my_dsh', stateDir: 'E:\\my_state', dbPath: 'E:\\my_state\\s.db',
  watchDirs: [{ path: 'C:\\Users\\kiuhg\\AppData\\Local\\Temp', recursive: true, maxDepth: 4 }],
  protectRoots: ['C:\\Windows', 'E:\\my_escape'],
  excludeNames: ['.dsh', 'node_modules'],
  debounceMs: 500, pollIntervalMs: 1000, sessionWindowMs: 60000, maxBatch: 7,
  resolveLockOwner: false, useRecycleBin: false, autoClean: true,
});
verdict(good.escapeRoot === path.resolve('E:\\my_escape'), `escapeRoot honoured (${good.escapeRoot})`);
verdict(good.dshHome === path.resolve('E:\\my_dsh'), `dshHome honoured (${good.dshHome})`);
verdict(good.dbPath === path.resolve('E:\\my_state\\s.db'), `dbPath honoured (${good.dbPath})`);
verdict(good.watchDirs.length === 1 && good.watchDirs[0].recursive === true && good.watchDirs[0].maxDepth === 4,
  `watchDirs entry honoured verbatim (${JSON.stringify(good.watchDirs)})`);
verdict(good.protectRoots.length === 2, `protectRoots honoured (${JSON.stringify(good.protectRoots)})`);
verdict(good.excludeNames.join(',') === '.dsh,node_modules', `excludeNames honoured (${JSON.stringify(good.excludeNames)})`);
verdict(good.debounceMs === 500 && good.pollIntervalMs === 1000 && good.sessionWindowMs === 60000 && good.maxBatch === 7,
  `numerics honoured (${good.debounceMs}/${good.pollIntervalMs}/${good.sessionWindowMs}/${good.maxBatch})`);
verdict(good.resolveLockOwner === false, 'resolveLockOwner:false honoured');
verdict(good.useRecycleBin === false, 'useRecycleBin:false honoured');
verdict(good.autoClean === true, 'autoClean:true honoured');
verdict(good.enabled === true, 'enabled defaults true');

// --- defaults control -----------------------------------------------------------------------
console.log('');
console.log('=== defaults control ===');
const d = resolveConfig();
verdict(d.debounceMs === 3000 && d.pollIntervalMs === 5000 && d.sessionWindowMs === 1800000 && d.maxBatch === 50,
  `defaults intact (${d.debounceMs}/${d.pollIntervalMs}/${d.sessionWindowMs}/${d.maxBatch})`);
verdict(d.watchDirs.length === 3, `default watchDirs = 3 (${d.watchDirs.length})`);
verdict(d.resolveLockOwner === true, 'resolveLockOwner defaults true');

// --- boundary: exactly at the floor must be KEPT, one below must fall back -------------------
console.log('');
console.log('=== floor boundaries ===');
const b = resolveConfig({ pollIntervalMs: 250, maxBatch: 1, debounceMs: 0, sessionWindowMs: 0 });
verdict(b.pollIntervalMs === 250 && b.maxBatch === 1 && b.debounceMs === 0 && b.sessionWindowMs === 0,
  `floor values kept verbatim (${b.pollIntervalMs}/${b.maxBatch}/${b.debounceMs}/${b.sessionWindowMs})`);
const b2 = resolveConfig({ pollIntervalMs: 249, maxBatch: 0, debounceMs: -1, sessionWindowMs: -1 });
verdict(b2.pollIntervalMs === 5000 && b2.maxBatch === 50 && b2.debounceMs === 3000 && b2.sessionWindowMs === 1800000,
  `one-below-floor falls back to defaults (${b2.pollIntervalMs}/${b2.maxBatch}/${b2.debounceMs}/${b2.sessionWindowMs})`);

console.log('');
console.log(`>>> CONFIG FUZZ: ${failures === 0 ? 'NEVER THROWS; FLOORS HELD; VALID INPUT HONOURED' : failures + ' DEFECT(S)'}`);
process.exit(failures === 0 ? 0 : 1);
