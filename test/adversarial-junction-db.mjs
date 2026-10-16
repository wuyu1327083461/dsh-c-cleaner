// verifier probe: does the DB persistence route carry a junction-spelled path into clean()?
// This is the last plausible real-world route for the live junction defect. A row written while
// the junction existed survives in tracked_files and is later cleaned by `c-clean now`.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { StateDB } = await import('../lib/state-db.js');
const { classify } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');
const LOG = { debug(){}, info(){}, warn(){}, error(){} };

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const tmpBase = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp');
const holder = path.join(tmpBase, `dshcc_junc5_${STAMP}`);
fs.mkdirSync(holder, { recursive: true });
const junction = path.join(holder, 'cache-view');
const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', junction, 'C:\\Windows\\Temp'], { encoding: 'utf8' });
console.log('junction =', JSON.stringify(junction), 'created =', fs.existsSync(junction));
if (!fs.existsSync(junction)) { console.log((r.stderr || r.stdout || '').trim()); process.exit(0); }

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc_j5_state_'));
const cfg = resolveConfig({ stateDir });
const db = new StateDB(path.join(stateDir, 'state.db'));
db.migrate();
console.log('');

// A real file physically in C:\Windows\Temp, addressed via the junction.
const victimVia = path.join(junction, `dshcc_junc5_victim_${STAMP}.log`);
fs.writeFileSync(victimVia, 'v'.repeat(72));
const victimReal = path.join('C:\\Windows\\Temp', path.basename(victimVia));
console.log('victimReal =', JSON.stringify(victimReal), 'exists =', fs.existsSync(victimReal));
console.log('victimVia  =', JSON.stringify(victimVia), 'exists =', fs.existsSync(victimVia));
console.log('');

// Persist it exactly as index.js's onCandidate does.
const c = classify({ path: victimVia, size: 72 }, { cfg, tree: { ownerOf: () => null, nameOf: () => null } });
db.upsert(c);
const rows = db.list({ limit: 100 });
console.log('DB rows =', rows.length);
for (const row of rows) console.log('  row:', JSON.stringify({ path: row.file_path, category: row.category }));
console.log('');

// Now simulate `c-clean now`: collect() -> clean(), on a FRESH connection (as a restart would).
db.close();
const db2 = new StateDB(path.join(stateDir, 'state.db'));
db2.migrate();
const rows2 = db2.list({ limit: 100 });
db2.close();
const records = rows2.map((x) => ({ ...x, path: x.file_path }));
const rep = await clean(records, { deep: true, force: true, cfg, log: LOG });
console.log('clean() report =', JSON.stringify({ removed: rep.removed, skipped: rep.skipped, bytesFreed: rep.bytesFreed, skippedList: rep.skippedList }));
console.log('REAL C:\\Windows\\Temp file survives =', fs.existsSync(victimReal));
console.log('');
console.log(!fs.existsSync(victimReal)
  ? '>>> REAL DEFECT VIA THE DB ROUTE: a persisted tracked_files row (survives restart) caused clean() to delete a file physically inside C:\\Windows\\Temp'
  : '>>> NOT reachable via the DB route either');

try { fs.rmSync(junction, { recursive: true, force: true }); } catch {}
try { fs.rmSync(holder, { recursive: true, force: true }); } catch {}
try { fs.rmSync(victimReal, { force: true }); } catch {}
try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
