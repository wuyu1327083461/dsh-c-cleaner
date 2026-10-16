// verifier probe: REACHABILITY of the device-prefix bypass through normal plugin use.
// Chain under test: user config watchDir uses the \\?\ device prefix
//   -> CWatcher emits candidate paths CARRYING that prefix
//   -> classify/isProtectedPath see an unrecognised spelling (guard false)
//   -> clean() deletes a real file that physically lives inside a protectRoot.
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { CWatcher } = await import('../lib/watcher.js');
const { resolveConfig } = await import('../lib/config.js');
const { classify, isProtectedPath } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');

// A real protected-root location that is WRITABLE on this host (C:\ProgramData is a default protectRoot).
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const realDir = path.join('C:' + B + 'ProgramData', `dshcc_devwatch_${STAMP}`);
fs.mkdirSync(realDir, { recursive: true });
const deviceDir = B + B + '?' + B + realDir;

const base = resolveConfig({});
const cfg = {
  ...base,
  debounceMs: 300,
  watchDirs: [{ path: deviceDir, recursive: false, maxDepth: 1 }],
};
const LOG = { debug() {}, info() {}, warn() {}, error() {} };
console.log('realDir           =', JSON.stringify(realDir));
console.log('configured watch  =', JSON.stringify(cfg.watchDirs[0].path));
console.log('deviceDir exists  =', fs.existsSync(deviceDir));
console.log('protectRoots has realDir?', cfg.protectRoots.some((r) => r.toLowerCase() === realDir.toLowerCase()));

const hits = [];
const w = new CWatcher({ cfg, tree: { ownerOf: () => null, nameOf: () => null }, log: LOG, onCandidate: (c) => hits.push(c) });
let startErr = null;
try { w.start(); } catch (e) { startErr = `${e.code || ''} ${e.message}`; }
console.log('start() threw     =', startErr);
await new Promise((r) => setTimeout(r, 700));

const victim = path.join(realDir, `victim_${STAMP}.tmp`);
fs.writeFileSync(victim, 'z'.repeat(64));
await new Promise((r) => setTimeout(r, 2000));
w.stop();

console.log('\n--- watcher emission ---');
for (const h of hits) console.log('  hit =', JSON.stringify(h.path));

const prefixed = hits.map((h) => h.path).filter((p) => String(p).startsWith(B + B + '?'));
if (!prefixed.length) {
  console.log('  no device-prefixed candidate emitted this run');
  console.log('  stats =', JSON.stringify(w.stats()));
}

if (prefixed.length) {
  const p = prefixed[0];
  console.log('\n--- decisive chain ---');
  console.log('emitted candidate   =', JSON.stringify(p));
  console.log('real target         =', JSON.stringify(fs.realpathSync.native(p)));
  console.log('isProtected(cand)   =', isProtectedPath(p, cfg.protectRoots));
  console.log('isProtected(real)   =', isProtectedPath(fs.realpathSync.native(p), cfg.protectRoots));
  const c = classify({ path: p, size: 64, mtimeMs: Date.now() }, { cfg });
  console.log('classify(cand)      =', c.category, '|', JSON.stringify(c.reason));
  const rep = await clean([{ ...c, sourceProcess: 'verifier' }], { deep: false, force: true, cfg, log: LOG });
  console.log('clean() report      =', JSON.stringify(rep));
  const gone = !fs.existsSync(victim);
  console.log('victim still exists =', !gone);
  console.log(gone
    ? '>>> REACHABLE REAL DEFECT: watcher-sourced record carrying \\\\?\\ was DELETED inside a protectRoot'
    : '>>> not deleted');
}

fs.rmSync(realDir, { recursive: true, force: true });
