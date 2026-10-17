// test/adversarial-p2-stalecount.mjs — verifier: reconcile the lead's stale-row claim
// against the live DB (measured on a COPY, never the live file).
//
// The lead reported "2721 rows, of which 1111 do NOT pass the §3.2 name test".
// My findStaleRows-based count was 1079. This probe decomposes the difference so the
// number in the report is exact rather than approximate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateDB } from '../lib/state-db.js';
import { resolveConfig } from '../lib/config.js';
import { compileSignatureGlobs, signatureListFrom, classifyName } from '../lib/watcher.js';
import { findStaleRows } from '../lib/web-api.js';

const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const ROOT = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp', `dshcc_stale_${STAMP}`);
fs.mkdirSync(ROOT, { recursive: true });

const live = 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';
const copy = path.join(ROOT, 'state.db');
fs.copyFileSync(live, copy);
for (const s of ['-wal', '-shm']) if (fs.existsSync(live + s)) fs.copyFileSync(live + s, copy + s);

const cfg = resolveConfig({});
const globs = compileSignatureGlobs(signatureListFrom(cfg));
const db = new StateDB(copy);
const rows = db.list({ limit: 100000 });
db.close();

const byCat = {};
for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + 1;

// Name-test verdict per row, computed directly with the gate's own exported predicate.
let failAll = 0;
let failAllNoValve = 0;
let failCriticalShaped = 0;
const failByCat = {};
const failSafe = [];
for (const r of rows) {
  const p = r.file_path;
  const v = classifyName(p, globs, true);
  const vNoValve = classifyName(p, globs, false);
  if (!v.pass) {
    failAll += 1;
    failByCat[r.category] = (failByCat[r.category] || 0) + 1;
    if (r.category === 'SAFE_TO_DELETE') failSafe.push(r);
  }
  if (!vNoValve.pass) failAllNoValve += 1;
  if (v.criticalName) failCriticalShaped += 1;
}

const purgeable = findStaleRows(
  rows.map((r) => ({ file_path: r.file_path, file_size: r.file_size, category: r.category })),
  globs,
  true,
);

const bytes = (list) => list.reduce((s, r) => s + (Number.isFinite(r.file_size) ? r.file_size : 0), 0);
const mb = (n) => (n / 1024 / 1024).toFixed(1);
const ts = (v) => {
  if (v === null || v === undefined) return NaN;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const d = Date.parse(String(v).replace(' ', 'T') + (String(v).includes('T') || String(v).includes('Z') ? '' : 'Z'));
  return Number.isFinite(d) ? d : NaN;
};
const stamps = rows.map((r) => ts(r.last_checked_at)).filter((n) => Number.isFinite(n));
const newest = stamps.length ? Math.max(...stamps) : NaN;
const oldest = stamps.length ? Math.min(...stamps) : NaN;
console.log(`last_checked_at type: ${typeof rows[0]?.last_checked_at} sample=${JSON.stringify(rows[0]?.last_checked_at)} (parsed ${stamps.length}/${rows.length} rows)`);

console.log(`live DB copy        : ${live}`);
console.log(`total rows          : ${rows.length}`);
console.log(`by category         : ${JSON.stringify(byCat)}`);
console.log('');
console.log(`A. rows failing classifyName(admit=true)  [ALL categories]: ${failAll}`);
console.log(`   ... of which by category                              : ${JSON.stringify(failByCat)}`);
console.log(`B. rows failing classifyName(admit=false) [valve OFF]    : ${failAllNoValve}`);
console.log(`C. rows whose BASENAME hits LOCKED_BASENAME_RE (valve)   : ${failCriticalShaped}`);
console.log(`D. PURGEABLE (SAFE_TO_DELETE AND gate-rejected, admit=true): ${purgeable.stale.length}`);
console.log(`   purgeable bytes                                       : ${mb(purgeable.bytes)} MB`);
console.log(`   kept rows                                             : ${purgeable.kept}`);
console.log(`   SAFE+rejected, of which credential-shaped survivors    : ${failSafe.length - purgeable.stale.length}`);
console.log('');
console.log(`last_checked_at range: ${Number.isFinite(oldest) ? new Date(oldest).toISOString() : 'n/a'} .. ${Number.isFinite(newest) ? new Date(newest).toISOString() : 'n/a'}`);
const preGate = rows.filter((r) => Number.isFinite(ts(r.last_checked_at)) && ts(r.last_checked_at) < Date.parse('2026-10-17T00:00:00Z')).length;
console.log(`rows with last_checked_at before 2026-10-17 (pre-gate)  : ${preGate}`);

console.log('');
console.log('LEAD CLAIM: 2721 rows, 1111 fail the §3.2 name test');
const leadRows = 2721;
const leadStale = 1111;
console.log(`row-count drift        : ${rows.length - leadRows} (${leadRows} -> ${rows.length})`);
console.log(`stale-count drift (D)  : ${purgeable.stale.length - leadStale} (${leadStale} -> ${purgeable.stale.length})`);
console.log(`A - leadStale          : ${failAll - leadStale}`);
console.log(`A - D (non-SAFE rejects): ${failAll - purgeable.stale.length}`);

try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* best effort */
}
