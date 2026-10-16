// verifier probe: PRD §3.4 says the DEFAULT deletion mode is the recycle bin (recoverable).
// Mechanism claims to use Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile with
// SendToRecycleBin (lib/cleaner.js:160). Assert the OBSERVED behaviour: after a default
// clean(), the file must be findable in the shell's recycle bin, not merely gone from disk.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const { resolveConfig } = await import('../lib/config.js');
const { clean, toRecycleBin } = await import('../lib/cleaner.js');
const LOG = { debug(){}, info(){}, warn(){}, error(){} };

const cfg = resolveConfig({});
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const base = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp');
const dir = path.join(base, `dshcc_recycle_${STAMP}`);
fs.mkdirSync(dir, { recursive: true });
const victim = path.join(dir, `recycle-me-${STAMP}.tmp`);
const payload = 'R'.repeat(777);
fs.writeFileSync(victim, payload);
const size = fs.statSync(victim).size;
console.log('victim          =', JSON.stringify(victim), 'size =', size);
console.log('exists before   =', fs.existsSync(victim));
console.log('');

// Enumerate the recycle bin BEFORE, so we can detect the new entry by name.
const psList = '$sh=New-Object -ComObject Shell.Application; $sh.NameSpace(10).Items() | ForEach-Object { $_.Name + "|" + $_.Size }';
function binSnapshot() {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psList], { encoding: 'utf8', timeout: 60000 })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (e) { return ['<error: ' + e.message.split('\n')[0] + '>']; }
}
const before = binSnapshot();
console.log('recycle bin entries before =', before.length);
console.log('');

// DEFAULT clean() (no force) — PRD §3.4 says this must go to the recycle bin.
const rep = await clean([{ path: victim, category: 'SAFE_TO_DELETE', size }], { deep: false, force: false, cfg, log: LOG });
console.log('clean() report  =', JSON.stringify({ removed: rep.removed, skipped: rep.skipped, bytesFreed: rep.bytesFreed, errors: rep.errors.length }));
console.log('exists after    =', fs.existsSync(victim));
console.log('');

await new Promise((r) => setTimeout(r, 800));
const after = binSnapshot();
const added = after.filter((x) => !before.includes(x));
console.log('recycle bin entries after  =', after.length);
console.log('NEW entries =', JSON.stringify(added));
console.log('');

// The bin shows display names; our file is unique, so look for the stem.
const stem = path.basename(victim, '.tmp');
const found = after.some((x) => x.toLowerCase().includes(stem.toLowerCase()));
console.log('unique victim basename present in bin =', found, '  (stem:', stem + ')');
console.log('');
if (!fs.existsSync(victim) && found) {
  console.log('>>> PRD §3.4 HONOURED: default clean() removed the file from disk AND the file is present in the recycle bin (recoverable).');
} else if (!fs.existsSync(victim) && !found) {
  console.log('>>> CONCERN: the file is gone from disk but NOT visible in the recycle bin by name.');
  console.log('    This may be a PIDL/display-name artifact of the Shell namespace rather than a hard delete;');
  console.log('    confirm by size match before calling it a defect.');
  const bySize = after.filter((x) => x.endsWith('|' + size));
  console.log('    entries with matching size ' + size + ' ->', JSON.stringify(bySize));
} else {
  console.log('>>> the file still exists on disk; clean() did not run as expected');
}

console.log('');
console.log('=== hard-delete control (force:true) must NOT leave a bin entry ===');
const hard = path.join(dir, `hard-${STAMP}.tmp`);
fs.writeFileSync(hard, 'H'.repeat(321));
const hs = fs.statSync(hard).size;
const rep2 = await clean([{ path: hard, category: 'SAFE_TO_DELETE', size: hs }], { force: true, cfg, log: LOG });
await new Promise((r) => setTimeout(r, 500));
const after2 = binSnapshot();
const stem2 = path.basename(hard, '.tmp');
const found2 = after2.some((x) => x.toLowerCase().includes(stem2.toLowerCase()));
console.log('report =', JSON.stringify({ removed: rep2.removed, bytesFreed: rep2.bytesFreed }), '| exists =', fs.existsSync(hard), '| in bin =', found2);
console.log('=>', !fs.existsSync(hard) && !found2 ? 'force:true is a PHYSICAL delete (expected, matches mode=physical log line)' : 'UNEXPECTED');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
