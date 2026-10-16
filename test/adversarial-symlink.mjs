// verifier probe: the SYMLINK sibling of the junction case (distinct mechanism).
// A junction is a directory reparse point; a file SYMLINK inside temp pointing into a
// protected root is more realistic (installers create them). fs.statSync FOLLOWS symlinks,
// so the watcher's isFile() test passes and the symlink path IS lexically inside the watched
// temp dir. Question: does the plugin delete the TARGET (destructive) or just the LINK?
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { CWatcher } = await import('../lib/watcher.js');
const { isProtectedPath, classify, CATEGORY } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');
const LOG = { debug(){}, info(){}, warn(){}, error(){} };

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const cfg = resolveConfig({ debounceMs: 400 });
const watched = cfg.watchDirs[0].path;
const holder = path.join(watched, `dshcc_sym_${STAMP}`);
fs.mkdirSync(holder, { recursive: true });

// A REAL file physically inside a protectRoot, and a symlink to it inside the watched temp dir.
const target = path.join('C:\\Windows', 'Temp', `dshcc_sym_target_${STAMP}.log`);
fs.writeFileSync(target, 'T'.repeat(96));
const link = path.join(holder, `innocent-${STAMP}.log`);
const r = spawnSync('cmd.exe', ['/c', 'mklink', link, target], { encoding: 'utf8' });
console.log('target (physical, in C:\\Windows\\Temp) =', JSON.stringify(target), 'exists =', fs.existsSync(target));
console.log('symlink (in watched temp dir)          =', JSON.stringify(link), 'created =', fs.existsSync(link));
if (!fs.existsSync(link)) { console.log('mklink output:', (r.stderr || r.stdout || '').trim()); process.exit(0); }
console.log('  lstat isSymbolicLink =', fs.lstatSync(link).isSymbolicLink(), '| stat isFile (follows) =', fs.statSync(link).isFile());
console.log('  realpath(link)       =', JSON.stringify(fs.realpathSync.native(link)));
console.log('');
console.log('isProtectedPath(link)                  =', isProtectedPath(link, cfg.protectRoots), '  <- the question');
console.log('isProtectedPath(target)                =', isProtectedPath(target, cfg.protectRoots));
console.log('');

// Watcher emission
const hits = [];
const w = new CWatcher({ cfg, tree: { ownerOf: () => null, nameOf: () => null }, log: LOG, onCandidate: (c) => hits.push(String(c.path)) });
w.start();
await new Promise((res) => setTimeout(res, 900));
fs.writeFileSync(path.join(holder, `control_${STAMP}.tmp`), 'c'.repeat(16));
await new Promise((res) => setTimeout(res, 2500));
w.stop();
console.log('watcher hits (' + hits.length + '):');
for (const h of hits) console.log('   ', JSON.stringify(h));
console.log('  contains the symlink path?', hits.some((h) => h === link));
console.log('');

// Decisive: clean the symlink record
const c = classify({ path: link, size: 96 }, { cfg, tree: { ownerOf: () => null, nameOf: () => null } });
console.log('classify(link) =', c.category, '|', JSON.stringify(c.reason));
const rep = await clean([{ path: link, category: c.category, size: 96 }], { deep: true, force: true, cfg, log: LOG });
console.log('clean() report =', JSON.stringify({ removed: rep.removed, skipped: rep.skipped, bytesFreed: rep.bytesFreed, skippedList: rep.skippedList }));
console.log('');
console.log('AFTER clean():');
console.log('  link still exists   =', fs.existsSync(link), fs.existsSync(link) ? '(lstat: ' + (() => { try { return fs.lstatSync(link).isSymbolicLink() ? 'symlink' : 'regular'; } catch { return '?'; } })() + ')' : '');
console.log('  TARGET survives     =', fs.existsSync(target), '  <- the destructive question');
console.log('');
console.log(!fs.existsSync(target)
  ? '>>> REAL DEFECT (PRD 6.2, CRITICAL): clean() followed the symlink and DELETED the file physically inside C:\\Windows\\Temp'
  : fs.existsSync(link)
    ? '>>> non-issue: the protected file survived and the symlink was NOT removed'
    : '>>> hardening only: the symlink itself was removed but the protected TARGET survived (unlink semantics)');

try { fs.rmSync(link, { force: true }); } catch {}
try { fs.rmSync(holder, { recursive: true, force: true }); } catch {}
try { fs.rmSync(target, { force: true }); } catch {}
