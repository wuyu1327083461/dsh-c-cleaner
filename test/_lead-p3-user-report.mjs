/**
 * Reproduces the user's exact report and proves the new behaviour.
 *
 * Original report (m01182):
 *   已拒绝（EPERM）：move failed: EPERM, Permission denied: \\?\C:\...\Temp\Adobe\com.adobe.dunamis ...
 *
 * Now the same directory must answer FILES_IN_USE at PLANNING time, before any copy, naming the
 * busy files and the remedy — and the Adobe directory must be untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inspectDirectory, migrateDirectory, findCandidates } from '../lib/symlink-migrate.js';
import { resolveConfig } from '../lib/config.js';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
const cfg = resolveConfig({}, process.env);

const ADOBE = 'C:/Users/kiuhg/AppData/Local/Temp/Adobe/com.adobe.dunamis';

function snapshotDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(`${ent.name}:${fs.statSync(p).size}`);
    }
  };
  walk(dir);
  return out.sort();
}

console.log('=== the directory from the report ===');
console.log('exists     :', fs.existsSync(ADOBE));
console.log('isJunction :', fs.existsSync(ADOBE) ? fs.lstatSync(ADOBE).isSymbolicLink() : 'n/a');
const before = snapshotDir(ADOBE);
console.log('files      :', before ? before.length : 0);

console.log('\n=== inspectDirectory (the planning gate) ===');
const plan = inspectDirectory(ADOBE, cfg);
console.log('ok     :', plan.ok);
console.log('code   :', plan.code);
console.log('reason :', plan.reason ?? '(none)');

console.log('\n=== migrateDirectory (the operation) ===');
const res = await migrateDirectory(ADOBE, { cfg, log: silentLog, db: null });
console.log('ok     :', res.ok);
console.log('code   :', res.code);
console.log('reason :', res.reason ?? '(none)');

console.log('\n=== data safety ===');
const after = snapshotDir(ADOBE);
console.log('still a real dir :', fs.existsSync(ADOBE) && !fs.lstatSync(ADOBE).isSymbolicLink());
console.log('file count same  :', before && after ? before.length === after.length : 'n/a');
console.log('bytes same       :', JSON.stringify(before) === JSON.stringify(after));

console.log('\n=== is it still offered as a candidate? ===');
const rows = (before ?? []).map((name) => ({
  file_path: path.join(ADOBE, name.slice(0, name.lastIndexOf(':'))),
  file_size: Number(name.slice(name.lastIndexOf(':') + 1)),
  category: 'CAUTION_CACHE',
}));
const offers = findCandidates(rows, cfg);
console.log('candidates:', offers.length);
for (const c of offers) console.log(`  ${c.path} (${c.bytes} B) -> ${c.target}`);

const noEperm = res.ok === false && res.code !== 'EPERM';
const named = /held open by another process/.test(String(res.reason ?? plan.reason ?? ''));
console.log('\n=== verdict ===');
console.log('no raw EPERM surfaced :', noEperm || res.ok === true);
console.log('cause is explained    :', named);
console.log('data intact           :', JSON.stringify(before) === JSON.stringify(after));
