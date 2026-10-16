// verifier probe: NFR 6.1 — "绝对不递归 C:\Users 或 %LOCALAPPDATA% 根目录".
// The default config is safe, but the PRD states this as a HARD rule. Test whether the code
// DEFENDS against a config that asks for it (user config, plugin override, misconfiguration),
// or merely relies on the default being correct.
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { CWatcher } = await import('../lib/watcher.js');

const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const lp = process.env.LOCALAPPDATA;
const up = process.env.USERPROFILE;

console.log('LOCALAPPDATA =', JSON.stringify(lp));
console.log('USERPROFILE  =', JSON.stringify(up));
console.log('');

const cases = [
  ['%LOCALAPPDATA% root, recursive:true', [{ path: lp, recursive: true, maxDepth: 3 }]],
  ['C:\\Users root, recursive:true', [{ path: 'C:' + B + 'Users', recursive: true, maxDepth: 3 }]],
  ['C:\\Users\\<u> (profile root), recursive:true', [{ path: up, recursive: true, maxDepth: 3 }]],
  ['C:\\ root, recursive:true', [{ path: 'C:' + B, recursive: true, maxDepth: 3 }]],
  ['%LOCALAPPDATA% root, recursive:FALSE', [{ path: lp, recursive: false, maxDepth: 1 }]],
];

for (const [label, watchDirs] of cases) {
  let cfg, err = null;
  try { cfg = resolveConfig({ watchDirs }); } catch (e) { err = `${e.code || ''} ${e.message}`; }
  if (err) { console.log(`${label}\n  resolveConfig THREW: ${err}\n`); continue; }
  const got = cfg.watchDirs.map((w) => ({ path: w.path, recursive: w.recursive, maxDepth: w.maxDepth }));
  console.log(label);
  console.log('  requested :', JSON.stringify(watchDirs));
  console.log('  resolved  :', JSON.stringify(got));

  // Did resolveConfig defend (force recursive off)?
  const stillRecursive = got.some((w) => w.recursive === true);
  console.log('  still recursive:', stillRecursive, stillRecursive ? '(config-level defence ABSENT)' : '(forced off by resolveConfig)');

  // And what does the WATCHER do with it? Does it force recursive off at runtime?
  const w = new CWatcher({ cfg, tree: { ownerOf: () => null, nameOf: () => null }, log: LOG, onCandidate: () => {} });
  let startErr = null;
  try { w.start(); } catch (e) { startErr = `${e.code || ''} ${e.message}`; }
  const stats = w.stats();
  w.stop();
  console.log('  watcher   : startErr=' + (startErr || 'none') + ' recursiveForcedOff=' + stats.recursiveForcedOff + ' watching=' + JSON.stringify(stats.watching));
  if (!startErr && stillRecursive && stats.recursiveForcedOff === 0) {
    console.log('  >>> NFR 6.1 NOT DEFENDED: a recursive watch on a broad root was actually installed');
  }
  console.log('');
}

// Sanity: the DEFAULT config must remain safe.
const d = resolveConfig({});
console.log('DEFAULT config watchDirs:');
for (const w of d.watchDirs) console.log('  ', JSON.stringify({ path: w.path, recursive: w.recursive, maxDepth: w.maxDepth }));
const broadRecursive = d.watchDirs.filter((w) => {
  const p = String(w.path).toLowerCase().replace(/[\\/]+$/, '');
  const isBroad = p === 'c:' || p === 'c:' + B + 'users' || p === String(up).toLowerCase() || p === String(lp).toLowerCase();
  return isBroad && w.recursive === true;
});
console.log(broadRecursive.length
  ? '  >>> DEFAULT CONFIG VIOLATES NFR 6.1: ' + JSON.stringify(broadRecursive)
  : '  OK: no broad root watched recursively in the default config');
