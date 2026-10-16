// verifier probe: is the JUNCTION bypass reachable via USER CONFIG (a watchDir that is a
// junction to a protected root)? This is the same route that made the device-prefix defect
// (Defect 4) end-to-end exploitable. Watcher canonicalises watchDirs in start(); does that
// close the junction route too?
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
const tmpBase = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp');
const holder = path.join(tmpBase, `dshcc_junc4_${STAMP}`);
fs.mkdirSync(holder, { recursive: true });
const junction = path.join(holder, 'cache-view');

const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', junction, 'C:\\Windows\\Temp'], { encoding: 'utf8' });
if (!fs.existsSync(junction)) {
  console.log('junction not created:', (r.stderr || r.stdout || '').trim());
  process.exit(0);
}
console.log('junction (configured as watchDir) =', JSON.stringify(junction), '-> C:\\Windows\\Temp');
console.log('  isProtectedPath(junction) = ', (await import('../lib/classifier.js')).isProtectedPath(junction, resolveConfig({}).protectRoots));
console.log('');

const cfg = resolveConfig({ watchDirs: [{ path: junction, recursive: false, maxDepth: 1 }], debounceMs: 400 });
console.log('cfg.watchDirs[0].path =', JSON.stringify(cfg.watchDirs[0].path));

const hits = [];
const dbRows = [];
const w = new CWatcher({ cfg, tree: { ownerOf: () => null, nameOf: () => null }, log: LOG,
  onCandidate: (c) => { hits.push(String(c.path)); dbRows.push(classify(c, { cfg })); } });
let startErr = null;
try { w.start(); } catch (e) { startErr = (e.code || '') + ' ' + e.message; }
console.log('startErr     =', startErr);
console.log('stats.watching =', JSON.stringify(w.stats().watching), '  <- if canonicalised it becomes C:\\Windows\\Temp');
await new Promise((res) => setTimeout(res, 800));

const victimReal = path.join('C:\\Windows\\Temp', `dshcc_junc4_victim_${STAMP}.log`);
fs.writeFileSync(victimReal, 'v'.repeat(64));
console.log('wrote REAL file:', JSON.stringify(victimReal));
console.log('  same file via the junction =', JSON.stringify(path.join(junction, path.basename(victimReal))), 'exists=', fs.existsSync(path.join(junction, path.basename(victimReal))));

await new Promise((res) => setTimeout(res, 2500));
w.stop();
console.log('');
console.log('hits (' + hits.length + '):');
for (const h of hits) console.log('   ', JSON.stringify(h));
console.log('stats =', JSON.stringify(w.stats()));
console.log('');

if (dbRows.length) {
  const rep = await clean(dbRows, { deep: true, force: true, cfg, log: LOG });
  console.log('clean() report =', JSON.stringify({ removed: rep.removed, skipped: rep.skipped, bytesFreed: rep.bytesFreed, skippedList: rep.skippedList }));
  console.log('REAL C:\\Windows\\Temp file survives =', fs.existsSync(victimReal));
} else {
  console.log('no candidate emitted -> nothing reached clean() via this route');
  console.log('REAL C:\\Windows\\Temp file survives =', fs.existsSync(victimReal));
}
console.log('');
console.log(!fs.existsSync(victimReal)
  ? '>>> REAL DEFECT END-TO-END: configuring a junction-to-protected-root watchDir caused clean() to delete a file physically inside C:\\Windows\\Temp'
  : '>>> NOT reachable via the watchDir config route either (watchDir canonicalisation closes it)');

try { fs.rmSync(junction, { recursive: true, force: true }); } catch {}
try { fs.rmSync(holder, { recursive: true, force: true }); } catch {}
try { fs.rmSync(victimReal, { force: true }); } catch {}
