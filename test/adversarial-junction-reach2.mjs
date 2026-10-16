// verifier probe: is the junction bypass REACHABLE through the plugin's own watcher?
// Defect 2 is proven live at the clean() step (test/adversarial-junction2.mjs). The remaining
// question for severity: does CWatcher emit a candidate for a file written through a junction
// that sits INSIDE a real watched directory (%LOCALAPPDATA%\Temp, watched recursively)?
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { CWatcher } = await import('../lib/watcher.js');
const LOG = { debug(){}, info(){}, warn(){}, error(){} };

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const cfg = resolveConfig({ debounceMs: 400 });
console.log('watchDirs =', JSON.stringify(cfg.watchDirs));
const watchedTemp = cfg.watchDirs[0].path;
console.log('primary watched dir =', JSON.stringify(watchedTemp));
console.log('');

// Junction INSIDE the real watched directory -> path is lexically inside a watch root.
const holder = path.join(watchedTemp, `dshcc_junc3_${STAMP}`);
fs.mkdirSync(holder, { recursive: true });
const junction = path.join(holder, 'innocent-cache');
const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', junction, 'C:\\Windows\\Temp'], { encoding: 'utf8' });
console.log('junction =', JSON.stringify(junction), '-> C:\\Windows\\Temp  created =', fs.existsSync(junction));
if (!fs.existsSync(junction)) { console.log((r.stderr || r.stdout || '').trim()); process.exit(0); }
console.log('');

const hits = [];
const w = new CWatcher({
  cfg, tree: { ownerOf: () => null, nameOf: () => null }, log: LOG,
  onCandidate: (c) => hits.push(String(c.path)),
});
w.start();
await new Promise((res) => setTimeout(res, 900));

const victimReal = path.join('C:\\Windows\\Temp', `dshcc_junc3_victim_${STAMP}.log`);
fs.writeFileSync(victimReal, 'v'.repeat(64));
console.log('wrote REAL file:', JSON.stringify(victimReal));

// Control: write a plain file directly in the holder (no junction) to prove the watcher is alive.
const control = path.join(holder, `control_${STAMP}.tmp`);
fs.writeFileSync(control, 'c'.repeat(16));
console.log('wrote CONTROL file:', JSON.stringify(control));

await new Promise((res) => setTimeout(res, 2500));
w.stop();
console.log('');
console.log('hits (' + hits.length + '):');
for (const h of hits) console.log('   ', JSON.stringify(h));
console.log('stats =', JSON.stringify(w.stats()));
console.log('');

const junctionHits = hits.filter((h) => h.includes('innocent-cache'));
const controlHits = hits.filter((h) => h.includes('control_'));
console.log('junction-spelled hits =', junctionHits.length, JSON.stringify(junctionHits));
console.log('control hits          =', controlHits.length, JSON.stringify(controlHits));
console.log('');
if (junctionHits.length > 0) {
  console.log('>>> REACHABLE THROUGH THE WATCHER: a junction inside the watched Temp dir makes the');
  console.log('    watcher persist a junction-spelled path; combined with adversarial-junction2.mjs');
  console.log('    (clean() deletes it) this is an END-TO-END PRD 6.2 failure with NO config tricks.');
} else {
  console.log('>>> NOT auto-triggered: the watcher emits no candidate for a write through the junction');
  console.log('    (control hits=' + controlHits.length + ' proves the watcher itself is alive).');
  console.log('    Exploitation therefore requires another route into the DB (persisted row, c-clean now,');
  console.log('    user config). Severity stays HIGH but not automatically triggered.');
}

try { fs.rmSync(junction, { recursive: true, force: true }); } catch {}
try { fs.rmSync(holder, { recursive: true, force: true }); } catch {}
for (const f of fs.existsSync('C:\\Windows\\Temp') ? fs.readdirSync('C:\\Windows\\Temp') : []) {
  if (f.startsWith('dshcc_junc3_')) { try { fs.rmSync(path.join('C:\\Windows\\Temp', f), { force: true }); } catch {} }
}
