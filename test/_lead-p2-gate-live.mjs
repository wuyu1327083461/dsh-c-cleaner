/**
 * Live acceptance: prove the RUNNING harness applies the PRD 3.2 noise gate.
 *
 * Creates, inside the real %LOCALAPPDATA%\Temp, in the same second:
 *   - a foreign-software-shaped file that matches NO AI signature -> must be REJECTED
 *   - a pip-*.log that matches a signature                            -> must be ADMITTED
 * then reads the plugin's own API and the DB to see which one landed.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
// IMPORTANT: os.tmpdir() is HIJACKED to E:\dsh_escape_cache\temp, which is a protectRoot
// and therefore deliberately unwatched. The gate must be exercised against the REAL
// C: %LOCALAPPDATA%\Temp — the directory the PRD's Module 3.2 actually monitors.
const REAL_TEMP =
  process.env.CC_REAL_TEMP ||
  path.join(process.env.USERPROFILE || 'C:\\Users\\kiuhg', 'AppData', 'Local', 'Temp');
const dir = path.join(REAL_TEMP, `dshcc_gate_${STAMP}`);
fs.mkdirSync(dir, { recursive: true });

const NOISE = path.join(dir, 'Win11SDK_WindowsPerformanceToolkit.msi'); // foreign software, no signature
const SIGNED = path.join(dir, `pip-probe-${STAMP}.log`); // AI-toolchain signature

// Same second, same directory.
fs.writeFileSync(NOISE, Buffer.alloc(64 * 1024, 0x41));
fs.writeFileSync(SIGNED, 'hello\n');

console.log(`dir      ${dir}`);
console.log(`noise    ${NOISE}`);
console.log(`signed   ${SIGNED}`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('waiting for watcher debounce + classify (6s)...');
await wait(6000);

const res = await fetch('http://127.0.0.1:3080/c-cleaner/api/state');
const body = await res.json();
const rows = body?.value?.rows ?? [];
const lower = (p) => p.toLowerCase();

const noiseRow = rows.find((r) => lower(r.file_path) === lower(NOISE));
const signedRow = rows.find((r) => lower(r.file_path) === lower(SIGNED));

console.log('--- RESULT ---');
console.log(`noise  tracked: ${noiseRow ? `YES (${noiseRow.category})` : 'NO (filtered)'}`);
console.log(`signed tracked: ${signedRow ? `YES (${signedRow.category})` : 'NO (filtered)'}`);

const pass = !noiseRow && !!signedRow;
console.log(pass ? 'VERDICT: PASS — PRD 3.2 gate is ENFORCED in the live process' : 'VERDICT: FAIL — gate not enforced live');

// Clean up our own fixtures through the plugin's own API (never rm by hand).
const toClean = [SIGNED, ...(noiseRow ? [NOISE] : [])];
if (toClean.length > 0) {
  const cleanRes = await fetch('http://127.0.0.1:3080/c-cleaner/api/clean', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: toClean }),
  });
  const cr = await cleanRes.json();
  console.log('cleanup:', JSON.stringify(cr?.value?.report ?? cr).slice(0, 200));
}
await wait(300);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`fixture dir removed: ${!fs.existsSync(dir)}`);
process.exit(pass ? 0 : 1);
