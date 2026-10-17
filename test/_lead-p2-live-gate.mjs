/**
 * LIVE end-to-end check of the PRD 3.2 noise gate against the running harness.
 *
 * Writes five files into the real %TEMP% (through the escape-dir hijack, so they land
 * where the watcher is actually looking), waits for the debounce + classification, then
 * asks the panel API which of them were RECORDED.
 *
 * Expected: the two other-software shapes are dropped by the gate; the two AI-toolchain
 * signatures are recorded (rule #2); the credential-shaped file is recorded via the
 * PRD 3.3 valve even though it matches no signature.
 */
import fs from 'node:fs';
import path from 'node:path';

const stamp = String(Date.now()).slice(-6);
// MUST be the REAL C: temp, not os.tmpdir(): the env hijack redirects TEMP to the escape
// root on E:, and that root is deliberately a protectRoot (never watched). Probing there
// measures nothing — a mistake this suite has made before.
const realTemp = process.env.CC_REAL_TEMP || 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';
const dir = path.join(realTemp, `dshcc_lead_gate_${stamp}`);
if (!dir.toLowerCase().startsWith(realTemp.toLowerCase())) {
  throw new Error(`refusing to probe outside the real temp dir: ${dir}`);
}
fs.mkdirSync(dir, { recursive: true });

const probes = [
  ['noise', 'Win11SDK_WindowsPerformanceToolkit_' + stamp + '.msi'],
  ['noise', 'Microsoft.VisualStudio.Setup.Common_' + stamp + '.dll'],
  ['rule2', 'pip-install-' + stamp + '.log'],
  ['rule2', 'torch-weights-' + stamp + '.tmp'],
  ['valve', 'credentials-' + stamp + '.json'],
];

for (const [, name] of probes) {
  fs.writeFileSync(path.join(dir, name), 'x'.repeat(32));
}
console.log(`dir   : ${dir}`);
console.log(`stamp : ${stamp}`);
console.log(`wrote : ${probes.length} files; waiting for debounce + classification...`);

const waitMs = Number(process.argv[2] || 12000);
await new Promise((r) => setTimeout(r, waitMs));

const res = await fetch('http://127.0.0.1:3080/c-cleaner/api/state', { cache: 'no-store' });
const body = await res.json();
const rows = body?.value?.rows ?? [];
const recorded = new Map();
for (const row of rows) {
  const base = String(row.file_path).split(/[\\/]/).pop();
  if (base && base.includes(stamp)) recorded.set(base, row.category);
}

let bad = 0;
const want = { noise: false, rule2: true, valve: true };
for (const [kind, name] of probes) {
  const hit = recorded.has(name);
  const category = recorded.get(name) ?? '-';
  const expected = want[kind];
  const ok = hit === expected;
  if (!ok) bad += 1;
  console.log(
    `${ok ? 'OK  ' : 'BAD '} ${kind.padEnd(6)} ${hit ? 'RECORDED' : 'REJECTED'} (${category}) :: ${name}`,
  );
}

// The verdict must be independent of any file left behind.
console.log(`cleanup: ${dir}`);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`SUMMARY probes=${probes.length} mismatches=${bad} verdict=${bad === 0 ? 'GATE-OK' : 'GATE-BROKEN'}`);
// Do NOT call process.exit() here: on this Windows/Node build, exiting with the undici
// socket still winding down trips `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
// file src\win\async.c, line 94` — a native fail-fast that reports exit 127 even though the
// verdict printed GATE-OK. Setting exitCode lets the loop drain and the real code survive.
process.exitCode = bad === 0 ? 0 : 1;
