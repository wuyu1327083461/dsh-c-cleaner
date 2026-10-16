// verifier probe: isolate the libuv fs-event.c assertion abort.
// Q1: does RAW fs.watch(sync) abort on a short-spelled dir, or is it CWatcher-specific?
// Q2: do other spelling mismatches (lowercase drive, trailing dot/space) also abort?
// Run each case in a SEPARATE child process so one abort cannot mask the others.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = path.sep;
const here = path.dirname(fileURLToPath(import.meta.url));
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const realDir = path.join('C:' + B + 'ProgramData', `dshcc_iso_${STAMP}`);
fs.mkdirSync(realDir, { recursive: true });

// Each case: how to spell the dir handed to fs.watch.
const cases = [
  ['long  (C:\\ProgramData\\x)', realDir],
  ['lower drive (c:\\programdata\\x)', realDir.replace(/^C:/, 'c:')],
  ['short  (C:\\PROGRA~3\\x)', realDir.replace(/^C:\\ProgramData/, 'C:' + B + 'PROGRA~3')],
  ['uppercase (C:\\PROGRAMDATA\\x)', realDir.replace(/^C:\\ProgramData/, 'C:' + B + 'PROGRAMDATA')],
];

const CHILD = `
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[1] ?? process.argv[2];
console.log('  watching:', JSON.stringify(dir), 'exists=', fs.existsSync(dir));
const w = fs.watch(dir, { recursive: true }, () => {});
await new Promise((r) => setTimeout(r, 700));
fs.writeFileSync(path.join(dir, 'probe.tmp'), 'x');
await new Promise((r) => setTimeout(r, 1200));
w.close();
console.log('  RESULT: survived, no abort');
`;

for (const [label, dir] of cases) {
  process.stdout.write(`case ${label}\n`);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD, dir], {
    encoding: 'utf8',
    cwd: here,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  console.log(out.split('\n').map((l) => `  | ${l}`).join('\n'));
  console.log(`  exit=${r.status}${r.signal ? ` signal=${r.signal}` : ''}\n`);
}

fs.rmSync(realDir, { recursive: true, force: true });
