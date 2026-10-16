// verifier probe: does the libuv fs-event.c:72 abort need a GENUINE 8.3 alias, or does any
// directory whose literal name contains a tilde abort? This decides the production blast radius.
//   A: a real directory literally named "literal~dir" (tilde is part of the real name, no alias)
//   B: a GENUINE 8.3 alias prefix (C:\PROGRA~3 = C:\ProgramData) vs its long spelling
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const B = path.sep;
const here = path.dirname(fileURLToPath(import.meta.url));
const STAMP = `${process.pid}_${Date.now().toString(36)}`;

const CHILD = `
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.DCC_DIR;
try { fs.watch(dir, { recursive: true }, () => {}); }
catch (e) { console.log('watch THREW ' + (e.code || '') + ': ' + e.message); process.exit(0); }
await new Promise((r) => setTimeout(r, 700));
fs.writeFileSync(path.join(dir, 'scope_probe.tmp'), 'x');
await new Promise((r) => setTimeout(r, 1200));
console.log('RESULT: SURVIVED (no abort)');
`;

function trial(label, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    encoding: 'utf8', cwd: here, env: { ...process.env, DCC_DIR: dir }, timeout: 25000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const aborted = r.status === 3221226505 || r.status === -1073740791;
  const hung = r.error && r.error.code === 'ETIMEDOUT';
  console.log(`\n${label}`);
  console.log('  dir  =', JSON.stringify(dir));
  console.log('  exit =', r.status, aborted ? '  <<< ABORT 0xC0000409' : hung ? '  <<< HUNG (killed after 25s)' : '');
  for (const l of out.split('\n').filter(Boolean)) console.log(`  | ${l}`);
  return { aborted, hung, out };
}

// --- A: literal tilde inside a REAL directory name (not an 8.3 alias) ----------------
const aRoot = path.join(os.tmpdir(), `dshcc_scopeA_${STAMP}`);
const aDir = path.join(aRoot, 'literal~dir');
fs.mkdirSync(aDir, { recursive: true });
console.log('A) is the tilde a genuine alias here?');
console.log('  realpath =', JSON.stringify(fs.realpathSync.native(aDir)));
console.log('  same string as given =', fs.realpathSync.native(aDir).toLowerCase() === aDir.toLowerCase());
const A = trial('A) literal tilde in the real directory name (NOT an alias)', aDir);

// --- B: genuine 8.3 alias prefix vs long spelling -----------------------------------
const longRoot = path.join('C:' + B + 'ProgramData', `dshcc_scopeB_${STAMP}`);
fs.mkdirSync(longRoot, { recursive: true });
const shortRoot = 'C:' + B + 'PROGRA~3' + B + `dshcc_scopeB_${STAMP}`;
console.log('\nB) alias check');
console.log('  short spelling exists =', fs.existsSync(shortRoot));
console.log('  realpath(short) =', JSON.stringify(fs.realpathSync.native(shortRoot)));
console.log('  realpath(long)  =', JSON.stringify(fs.realpathSync.native(longRoot)));
const Bt = trial('B1) GENUINE 8.3 alias prefix (C:\\PROGRA~3\\...)', shortRoot);
const Bl = trial('B2) long spelling of the SAME directory', longRoot);

console.log('\n--- verdict ---');
console.log('literal tilde (not an alias) aborts =', A.aborted);
console.log('genuine 8.3 alias aborts            =', Bt.aborted);
console.log('long spelling aborts                =', Bl.aborted);
console.log(A.aborted
  ? '>>> BROAD: any tilde-containing path aborts'
  : '>>> NARROW: only a GENUINE 8.3 alias spelling aborts (needs a short-spelled path)');

fs.rmSync(aRoot, { recursive: true, force: true });
fs.rmSync(longRoot, { recursive: true, force: true });
