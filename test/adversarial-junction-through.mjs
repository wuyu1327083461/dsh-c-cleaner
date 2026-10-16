// verifier probe: THE decisive reachability question for the live junction defect.
// Earlier reach tests wrote to the REAL path (C:\Windows\Temp\file), which the watcher of
// %LOCALAPPDATA%\Temp could never see — so they proved nothing. This probe writes THROUGH
// the junction, i.e. to the junction-spelled path, which IS lexically inside the watched dir.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { CWatcher } = await import('../lib/watcher.js');
const { classify } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');
const LOG = { debug(){}, info(){}, warn(){}, error(){} };

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const cfg = resolveConfig({ debounceMs: 400 });
const watched = cfg.watchDirs[0].path;
console.log('watched dir =', JSON.stringify(watched), 'recursive =', cfg.watchDirs[0].recursive, 'maxDepth =', cfg.watchDirs[0].maxDepth);

const holder = path.join(watched, `dshcc_junc6_${STAMP}`);
fs.mkdirSync(holder, { recursive: true });
const junction = path.join(holder, 'cache-view');
spawnSync('cmd.exe', ['/c', 'mklink', '/J', junction, 'C:\\Windows\\Temp'], { encoding: 'utf8' });
console.log('junction    =', JSON.stringify(junction), '-> C:\\Windows\\Temp  created =', fs.existsSync(junction));
if (!fs.existsSync(junction)) process.exit(0);
console.log('');

const hits = [];
const w = new CWatcher({ cfg, tree: { ownerOf: () => null, nameOf: () => null }, log: LOG,
  onCandidate: (c) => hits.push(String(c.path)) });
w.start();
await new Promise((r) => setTimeout(r, 1000));

// (A) write THROUGH the junction (lexically inside the watched tree)
const viaJunction = path.join(junction, `junc6_through_${STAMP}.log`);
fs.writeFileSync(viaJunction, 'v'.repeat(64));
console.log('A) wrote THROUGH the junction:', JSON.stringify(viaJunction));
console.log('   physically at:', JSON.stringify(path.join('C:\\Windows\\Temp', path.basename(viaJunction))));

// (B) control: a plain file directly in the holder
const control = path.join(holder, `control_${STAMP}.tmp`);
fs.writeFileSync(control, 'c'.repeat(24));
console.log('B) wrote CONTROL:', JSON.stringify(control));

// (C) write through the junction into a SUBDIR of it
const sub = path.join(junction, `sub_${STAMP}`);
try { fs.mkdirSync(sub, { recursive: true }); fs.writeFileSync(path.join(sub, `deep_${STAMP}.log`), 'd'.repeat(32)); console.log('C) wrote through junction into subdir'); } catch (e) { console.log('C) subdir write:', e.code); }

await new Promise((r) => setTimeout(r, 3000));
w.stop();
console.log('');
console.log('hits (' + hits.length + '):');
for (const h of hits) console.log('   ', JSON.stringify(h));
console.log('stats =', JSON.stringify(w.stats()));
console.log('');

const jHits = hits.filter((h) => h.includes('cache-view'));
const cHits = hits.filter((h) => h.includes('control_'));
console.log('junction-spelled hits =', jHits.length, JSON.stringify(jHits));
console.log('control hits          =', cHits.length, JSON.stringify(cHits));

if (jHits.length) {
  const recs = jHits.map((p) => ({ path: p, category: classify({ path: p, size: 64 }, { cfg, tree: { ownerOf: () => null, nameOf: () => null } }).category, size: 64 }));
  const rep = await clean(recs, { deep: true, force: true, cfg, log: LOG });
  console.log('clean() report =', JSON.stringify({ removed: rep.removed, skipped: rep.skipped, bytesFreed: rep.bytesFreed, skippedList: rep.skippedList }));
}
const phys = path.join('C:\\Windows\\Temp', `junc6_through_${STAMP}.log`);
console.log('');
console.log('physical file survives =', fs.existsSync(phys));
console.log('');
if (jHits.length && !fs.existsSync(phys)) {
  console.log('>>> FULLY REACHABLE END-TO-END: the plugin\'s OWN watcher emitted the junction-spelled');
  console.log('    path, and the normal pipeline deleted a file physically inside C:\\Windows\\Temp.');
  console.log('    Severity CRITICAL: no config tricks, no manual DB edits, no user action.');
} else if (jHits.length) {
  console.log('>>> watcher emits junction-spelled candidates (see hits) but this run did not delete.');
} else {
  console.log('>>> NOT reachable from the watcher: writing THROUGH the junction produced 0 candidates');
  console.log('    while the control produced ' + cHits.length + '. Exploitation needs the DB route.');
}

try { fs.rmSync(junction, { recursive: true, force: true }); } catch {}
try { fs.rmSync(holder, { recursive: true, force: true }); } catch {}
try { fs.rmSync(phys, { force: true }); } catch {}
