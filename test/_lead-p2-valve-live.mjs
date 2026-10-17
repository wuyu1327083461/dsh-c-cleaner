/**
 * Live acceptance: the PRD 3.3 safety valve.
 *
 * PRD 3.2 says to record only dsh-attributable or AI-signature files.
 * PRD 3.3 says a credential-shaped file in Temp must surface as LOCKED_CRITICAL
 * with its holder. Those two rules conflict for `credentials.json`, which matches
 * no AI signature. The valve must win: the credential file must be TRACKED.
 *
 * Same directory, same second, foreign-software noise alongside it.
 */
import fs from 'node:fs';
import path from 'node:path';

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const REAL_TEMP =
  process.env.CC_REAL_TEMP ||
  path.join(process.env.USERPROFILE || 'C:\\Users\\kiuhg', 'AppData', 'Local', 'Temp');
const dir = path.join(REAL_TEMP, `dshcc_valve_${STAMP}`);
fs.mkdirSync(dir, { recursive: true });

const NOISE = path.join(dir, 'Win11SDK_WindowsPerformanceToolkit.msi'); // no signature, no critical name
const CRED = path.join(dir, 'credentials.json'); // critical name -> valve must admit
const SIG = path.join(dir, `dshcc-${STAMP}.log`); // ordinary signature match

fs.writeFileSync(NOISE, Buffer.alloc(32 * 1024, 0x42));
fs.writeFileSync(CRED, JSON.stringify({ token: 'redacted', note: 'not a real credential' }));
fs.writeFileSync(SIG, 'log\n');

console.log(`dir    ${dir}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(6000);

const res = await fetch('http://127.0.0.1:3080/c-cleaner/api/state');
const rows = (await res.json())?.value?.rows ?? [];
const lower = (p) => p.toLowerCase();
const find = (p) => rows.find((r) => lower(r.file_path) === lower(p));

const noiseRow = find(NOISE);
const credRow = find(CRED);
const sigRow = find(SIG);

console.log('--- RESULT ---');
console.log(`noise       tracked: ${noiseRow ? `YES (${noiseRow.category})` : 'NO (filtered)'}   <- must be NO`);
console.log(`credentials tracked: ${credRow ? `YES (${credRow.category})` : 'NO (filtered)'}   <- must be YES, category LOCKED_CRITICAL`);
console.log(`ordinary    tracked: ${sigRow ? `YES (${sigRow.category})` : 'NO (filtered)'}   <- must be YES`);

const checks = [
  ['noise is filtered by the gate', !noiseRow],
  ['credentials.json is admitted by the 3.3 valve', !!credRow],
  ['credentials.json is LOCKED_CRITICAL', credRow?.category === 'LOCKED_CRITICAL'],
  ['ordinary signature file still admitted', !!sigRow],
];
let pass = true;
for (const [name, ok] of checks) {
  console.log(`CHECK ${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) pass = false;
}

// The credential file is LOCKED_CRITICAL -> the panel must refuse to clean it.
const cleanRes = await fetch('http://127.0.0.1:3080/c-cleaner/api/clean', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ paths: [CRED, SIG], force: true }),
});
const cr = (await cleanRes.json())?.value;
console.log(`force-clean report: ${JSON.stringify(cr?.report ?? cr)}`);
const credStillThere = fs.existsSync(CRED);
console.log(`CHECK ${credStillThere ? 'PASS' : 'FAIL'} a LOCKED_CRITICAL file survives even --force`);
if (!credStillThere) pass = false;

await wait(200);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`fixture dir removed: ${!fs.existsSync(dir)}`);
process.exit(pass ? 0 : 1);
