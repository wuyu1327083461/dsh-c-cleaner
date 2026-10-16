// verifier probe: which configured watchDir SPELLINGS abort the Node process (libuv
// fs-event.c:72 assertion -> 0xC0000409 fail-fast) on the first filesystem event?
// Reachability question: a user-pasted config path might use any of these forms.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = path.sep;
const here = path.dirname(fileURLToPath(import.meta.url));
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const realDir = path.join('C:' + B + 'ProgramData', `dshcc_spell_${STAMP}`);
fs.mkdirSync(realDir, { recursive: true });
fs.mkdirSync(path.join(realDir, 'sub'), { recursive: true });

const L = realDir; // C:\ProgramData\dshcc_spell_<stamp>
const spellings = [
  ['long baseline', L],
  ['lower drive', L.replace(/^C:/, 'c:')],
  ['all upper', L.toUpperCase()],
  ['8.3 short', L.replace(/^C:\\ProgramData/, 'C:' + B + 'PROGRA~3')],
  ['trailing separator', L + B],
  ['forward slashes', L.replace(/\\/g, '/')],
  ['device prefix', '\\\\?' + B + L],
  ['device + fwd slash', '//?/' + L.replace(/\\/g, '/')],
  ['trailing dot component', L + B + '.'],
  ['dotdot round trip', path.join(L, 'sub') + B + '..'],
  ['UNC localhost', '\\\\localhost\\C$' + L.slice(2)],
];

const CHILD = `
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.DCC_DIR;
let w;
try {
  w = fs.watch(dir, { recursive: true }, () => {});
} catch (e) {
  console.log('  watch() THREW ' + (e.code || '') + ': ' + e.message);
  process.exit(0);
}
await new Promise((r) => setTimeout(r, 600));
fs.writeFileSync(path.join(process.env.DCC_TARGET, 'spell_probe.tmp'), 'x');
await new Promise((r) => setTimeout(r, 1000));
try { w.close(); } catch {}
console.log('  RESULT: SURVIVED (no abort)');
`;

let aborts = 0;
const aborted = [];
for (const [label, dir] of spellings) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    encoding: 'utf8',
    cwd: here,
    env: { ...process.env, DCC_DIR: dir, DCC_TARGET: realDir },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const isAbort = r.status === 3221226505 || r.status === -1073740791;
  if (isAbort) {
    aborts++;
    aborted.push(label);
  }
  const verdict = isAbort ? 'ABORT 0xC0000409' : r.status === 0 ? 'ok' : `exit=${r.status}`;
  console.log(`${label.padEnd(24)} ${verdict}`);
  console.log(`  dir=${JSON.stringify(dir)}`);
  for (const line of out.split('\n')) console.log(`  | ${line}`);
}
console.log(`\n>>> ${aborts}/${spellings.length} spellings ABORT the process: ${JSON.stringify(aborted)}`);
fs.rmSync(realDir, { recursive: true, force: true });
