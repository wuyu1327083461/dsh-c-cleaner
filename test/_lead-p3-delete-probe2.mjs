/**
 * Probe: which Node-native call discriminates "file is deletable now" from
 * "another process holds it without FILE_SHARE_DELETE"?
 *
 * Motivated by the live defect: `fs.openSync(p,'r+')` succeeds on files that
 * `fs.unlinkSync` then rejects with EBUSY, so isLocked() under-reports locks.
 * Cut 1 (this probe): can `fs.renameSync(p, p)` (same-name rename) be used as a
 * NON-DESTRUCTIVE delete-permission test?
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
function record(label, value) {
  results.push({ label, value });
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

function tryCall(fn) {
  try {
    const r = fn();
    return { ok: true, value: r === undefined ? null : r };
  } catch (err) {
    return { ok: false, code: (err && err.code) || 'ERR', message: String((err && err.message) || err) };
  }
}

// --- part 1: a FREE file (nobody holds it) ---------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccprobe_'));
const free = path.join(dir, 'free.bin');
fs.writeFileSync(free, 'x'.repeat(1024));

record('free.openSync(r+)', tryCall(() => (fs.closeSync(fs.openSync(free, 'r+')), 'opened')));
record('free.renameSync(p,p)', tryCall(() => fs.renameSync(free, free)));
record('free still exists', fs.existsSync(free));

// --- part 2: a file held by ANOTHER process without delete sharing ----------
// A child process opens it exclusively ('wx' style full lock) so the parent sees
// the same class of refusal a real toolchain produces.
const held = path.join(dir, 'held.bin');
fs.writeFileSync(held, 'y'.repeat(1024));

const { spawn } = await import('node:child_process');
const holder = spawn(process.execPath, ['-e', `
const fs = require('fs');
// Windows: opening with no share flags is not expressible in Node, so hold a
// raw handle open and keep the process alive; the parent then probes it.
const fd = fs.openSync(process.argv[1], 'r');
process.stdout.write('HELD\\n');
setTimeout(() => process.exit(0), 4000);
`, held], { stdio: ['ignore', 'pipe', 'pipe'] });

await new Promise((resolve) => {
  holder.stdout.once('data', () => resolve());
  setTimeout(resolve, 2000);
});

record('held.openSync(r+)', tryCall(() => (fs.closeSync(fs.openSync(held, 'r+')), 'opened')));
record('held.renameSync(p,p)', tryCall(() => fs.renameSync(held, held)));
record('held.rename away', tryCall(() => fs.renameSync(held, held + '.away')));

// --- part 3: real Adobe logs (the live failure case) -----------------------
const adobeRoot = 'C:/Users/kiuhg/AppData/Local/Temp/Adobe/com.adobe.dunamis';
if (fs.existsSync(adobeRoot)) {
  const logs = fs.readdirSync(adobeRoot).filter((n) => n.endsWith('.log')).slice(0, 8);
  for (const name of logs) {
    const p = path.join(adobeRoot, name);
    const rPlus = tryCall(() => (fs.closeSync(fs.openSync(p, 'r+')), 'opened'));
    const selfRename = tryCall(() => fs.renameSync(p, p));
    const away = tryCall(() => {
      const tmp = p + '.__probe_away';
      fs.renameSync(p, tmp);
      fs.renameSync(tmp, p);
      return 'renamed-away-and-back';
    });
    record(
      `adobe/${name.slice(0, 42)}`,
      `open_r+=${rPlus.ok ? 'ok' : rPlus.code} | self_rename=${selfRename.ok ? 'ok' : selfRename.code} | away_back=${away.ok ? away.value : away.code}`,
    );
  }
} else {
  record('adobe root', 'absent');
}

holder.kill();
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* ignore */
}
console.log('\n--- summary ---');
console.log('self-rename discriminates?', JSON.stringify(results.filter((r) => r.label.includes('self_rename') || r.label.includes('renameSync')), null, 2));
