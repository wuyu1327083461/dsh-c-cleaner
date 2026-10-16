// verifier probe: decisive device-prefix bypass, end-to-end through clean().
// The device prefix \\?\ reaches the REAL file (proven in adversarial-spelling-reach.mjs)
// while isProtectedPath() returns false. Prove clean() deletes through it on a WRITABLE
// protected root (C:\ProgramData), i.e. where classify does not incidentally fail LOCKED.
import fs from 'node:fs';
import path from 'node:path';

const B = path.sep;
const { isProtectedPath, classify } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');
const { resolveConfig } = await import('../lib/config.js');
const cfg = resolveConfig({});
const LOG = { debug() {}, info() {}, warn() {}, error() {} };

const ROOT = path.join('C:' + B + 'ProgramData', `dshcc_dev_victim_${process.pid}`);
fs.mkdirSync(ROOT, { recursive: true });
const victim = path.join(ROOT, 'victim.tmp');
fs.writeFileSync(victim, 'y'.repeat(48));

const deviceSpelling = B + B + '?' + B + victim;
const roots = [ROOT];

console.log('protectRoots        =', JSON.stringify(roots));
console.log('victim real path    =', JSON.stringify(victim));
console.log('device spelling     =', JSON.stringify(deviceSpelling));
console.log('device reaches real =', fs.realpathSync.native(deviceSpelling).toLowerCase() === fs.realpathSync.native(victim).toLowerCase());
console.log('isProtected(real)   =', isProtectedPath(victim, roots));
console.log('isProtected(device) =', isProtectedPath(deviceSpelling, roots));
const c = classify({ path: deviceSpelling, size: 48, mtimeMs: Date.now() }, { cfg: { ...cfg, protectRoots: roots } });
console.log('classify(device)    =', c.category, '|', JSON.stringify(c.reason));

const rec = {
  path: deviceSpelling, size: 48, category: c.category, isLocked: false,
  lockedByPid: null, lockedByProcess: null, reason: 'probe',
  sourceProcess: 'verifier', mtimeMs: Date.now(),
};
const rep = await clean([rec], { deep: false, force: true, cfg: { ...cfg, protectRoots: roots }, log: LOG });
console.log('clean() report      =', JSON.stringify(rep));
const gone = !fs.existsSync(victim);
console.log('victim still exists =', !gone);
console.log(gone
  ? '>>> REAL DEFECT: clean() DELETED a file inside a protectRoot via the \\\\?\\ device prefix'
  : '>>> refused / kept (device prefix did not defeat the guard here)');

fs.rmSync(ROOT, { recursive: true, force: true });
