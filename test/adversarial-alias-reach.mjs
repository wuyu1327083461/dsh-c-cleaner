// verifier probe: is the 8.3-alias protection bypass reachable through normal use?
// Question: if a user (or a pasted path) configures a watchDir using the SHORT spelling,
// does CWatcher emit candidates carrying that short spelling (and thus bypass isProtectedPath)?
import fs from 'node:fs';
import path from 'node:path';
const B = path.sep; // '\' on Windows
const SHORT = 'C:' + B + 'PROGRA~3';            // live alias of C:\ProgramData
const LONG  = 'C:' + B + 'ProgramData';
const { resolveConfig } = await import('../lib/config.js');
const { CWatcher } = await import('../lib/watcher.js');
const { classify, isProtectedPath } = await import('../lib/classifier.js');

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const shortDir = path.join(SHORT, `dshcc_reach_${STAMP}`);
const realDir  = path.join(LONG,  `dshcc_reach_${STAMP}`);
fs.mkdirSync(shortDir, { recursive: true });
console.log('shortDir exists        =', fs.existsSync(shortDir));
console.log('realpath(shortDir)     =', fs.realpathSync.native(shortDir));
console.log('same as long form?     =', fs.realpathSync.native(shortDir).toLowerCase() === fs.realpathSync.native(realDir).toLowerCase());

const silent = { debug(){}, info(){}, warn(){}, error(){} };
const hits = [];
const cfg = resolveConfig({ watchDirs: [{ path: shortDir, recursive: true, maxDepth: 3 }], debounceMs: 400 });
console.log('cfg.watchDirs[0].path  =', JSON.stringify(cfg.watchDirs[0].path), '(verbatim retention check)');

const w = new CWatcher({ cfg, tree: { ownerOf: () => null, nameOf: () => null }, log: silent, onCandidate: (c) => hits.push(c) });
w.start();
await new Promise((r) => setTimeout(r, 600));
const victim = path.join(shortDir, `victim_${STAMP}.tmp`);
fs.writeFileSync(victim, 'x'.repeat(64));
await new Promise((r) => setTimeout(r, 2500));
w.stop();

console.log('--- watcher hits ---');
for (const h of hits) console.log('  hit:', JSON.stringify(h.path), '| short-spelled?', String(h.path).toLowerCase().includes('progra~3'));

const emitted = hits.map((h) => h.path);
const shortSpelled = emitted.filter((p) => String(p).toLowerCase().includes('progra~3'));
if (shortSpelled.length) {
  const p = shortSpelled[0];
  const prot = isProtectedPath(p, cfg.protectRoots);
  const c = classify({ path: p, size: 64, mtimeMs: Date.now() }, { cfg });
  console.log('>>> REACHABLE: watcher emitted short-spelled candidate', JSON.stringify(p));
  console.log('    isProtectedPath =', prot, '| classify =', c.category);
  console.log('    ==> a watcher-sourced DB record can carry the 8.3 spelling and bypass PRD 6.2');
} else {
  console.log('>>> NOT reachable this way: watcher did not emit a short-spelled candidate');
}
fs.rmSync(realDir, { recursive: true, force: true });
