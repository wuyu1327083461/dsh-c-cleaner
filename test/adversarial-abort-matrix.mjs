// verifier probe: pin the EXACT trigger for the libuv fs-event.c:72 abort.
// Matrix: dir spelling (long vs 8.3 short) x recursive (true vs false) x raw fs.watch vs CWatcher.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = path.sep;
const here = path.dirname(fileURLToPath(import.meta.url));
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const realDir = path.join('C:' + B + 'ProgramData', `dshcc_matrix_${STAMP}`);
fs.mkdirSync(realDir, { recursive: true });
const shortDir = realDir.replace(/^C:\\ProgramData/, 'C:' + B + 'PROGRA~3');

const CHILD = `
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.DCC_DIR;
const recursive = process.env.DCC_REC === '1';
const useCWatcher = process.env.DCC_CW === '1';
console.log('  dir=' + JSON.stringify(dir) + ' recursive=' + recursive + ' via=' + (useCWatcher ? 'CWatcher' : 'raw fs.watch'));
if (useCWatcher) {
  const { CWatcher } = await import('../lib/watcher.js');
  const { resolveConfig } = await import('../lib/config.js');
  const cfg = resolveConfig({ watchDirs: [{ path: dir, recursive, maxDepth: 3 }], debounceMs: 300 });
  const silent = { debug(){}, info(){}, warn(){}, error(){} };
  const w = new CWatcher({ cfg, tree: { ownerOf: () => null, nameOf: () => null }, log: silent, onCandidate: () => {} });
  w.start();
  await new Promise((r) => setTimeout(r, 700));
  fs.writeFileSync(path.join(dir, 'probe.tmp'), 'x');
  await new Promise((r) => setTimeout(r, 900));
  w.stop();
  console.log('  stats=' + JSON.stringify(w.stats().watching));
} else {
  const w = fs.watch(dir, { recursive }, () => {});
  await new Promise((r) => setTimeout(r, 700));
  fs.writeFileSync(path.join(dir, 'probe.tmp'), 'x');
  await new Promise((r) => setTimeout(r, 900));
  w.close();
}
console.log('  RESULT: SURVIVED');
`;

const combos = [
  ['long   rec=true  raw', realDir, '1', '0'],
  ['long   rec=false raw', realDir, '0', '0'],
  ['short  rec=true  raw', shortDir, '1', '0'],
  ['short  rec=false raw', shortDir, '0', '0'],
  ['short  rec=true  CWatcher', shortDir, '1', '1'],
  ['short  rec=false CWatcher', shortDir, '0', '1'],
  ['long   rec=true  CWatcher', realDir, '1', '1'],
];

let aborts = 0;
for (const [label, dir, rec, cw] of combos) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    encoding: 'utf8',
    cwd: here,
    env: { ...process.env, DCC_DIR: dir, DCC_REC: rec, DCC_CW: cw },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const aborted = r.status === 3221226505 || r.status === -1073740791;
  if (aborted) aborts++;
  console.log(`case ${label}: exit=${r.status}${aborted ? '  <<< ABORT (0xC0000409 fail-fast)' : ''}`);
  for (const line of out.split('\n')) console.log(`  | ${line}`);
  console.log('');
}

console.log(`>>> ${aborts}/${combos.length} configurations abort the process.`);
fs.rmSync(realDir, { recursive: true, force: true });
