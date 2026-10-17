// Lead-owned probe (read-only w.r.t. the plugin): does the PRD 3.3 SAFETY VALVE leak
// other-software noise through the PRD 3.2 gate?
//
// The valve admits a file whose basename matches LOCKED_BASENAME_RE
// (/\.lock$|\.sqlite3?$|\.db$|auth|config|token|credential/i) -- a bare SUBSTRING test.
// So "Kits Configuration Installer-x86_en-us.msi" is admitted because "Config" appears
// inside "Configuration", even though nothing about it is a credential.
//
// This probe writes, in ONE directory and the SAME second:
//   A. "<vendor> Configuration Bundle.msi"  -> should be NOISE (it is an installer)
//   B. "pip-valve-leak-<stamp>.log"         -> control: MUST be tracked
//   C. "<vendor>Notes<stamp>.bin"           -> control: MUST be noise
// then it asks the LIVE API which of the three it tracked.
//
// Pass condition: A and C absent, B present.
//
// RUN:  node test/_lead-p2-valve-leak.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// os.tmpdir() is redirected by the plugin's own env hijack to the escape root, which is a
// protectRoot -> a probe rooted there tests the protectRoot veto, not the gate.
// Use the REAL Windows Temp, exactly like the production watch target.
const REAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';
const API = 'http://127.0.0.1:3080/c-cleaner/api';

const stamp = `${process.pid}_${Date.now().toString(36)}`;
const dir = path.join(REAL_TEMP, `dshcc_valve_leak_${stamp}`);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

async function state() {
  const r = await fetch(`${API}/state`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`/state HTTP ${r.status}`);
  const body = await r.json();
  return (body.value?.rows ?? []).map((row) => String(row.file_path).toLowerCase());
}

const A = path.join(dir, 'Contoso Configuration Bundle.msi');
const B = path.join(dir, `pip-valve-leak-${stamp}.log`);
const C = path.join(dir, `ContosoNotes${stamp}.bin`);

let rows = [];
try {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [A, B, C]) fs.writeFileSync(f, `valve leak probe ${stamp}\n`);

  // The gate runs after the debounce (default 3000 ms) settles each path.
  const deadline = Date.now() + 45000;
  let have = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    rows = await state();
    have = [A, B, C].filter((f) => rows.includes(f.toLowerCase()));
    if (have.length >= 2) break;
  }

  const hasA = rows.includes(A.toLowerCase());
  const hasB = rows.includes(B.toLowerCase());
  const hasC = rows.includes(C.toLowerCase());

  check('control: pip-* log IS tracked', hasB, `tracked=${hasB} (proves the watcher is live)`);
  check('control: plain .bin IS filtered', !hasC, `tracked=${hasC}`);
  check('VALVE LEAK: "Configuration ... .msi" filtered as noise', !hasA,
    hasA ? 'LEAKED -- admitted by the "config" substring in "Configuration"' : 'filtered correctly');

  // Classify the leak precisely, so the fix targets the right token.
  const RE = /\.lock$|\.sqlite3?$|\.db$|auth|config|token|credential/i;
  const m = RE.exec(path.basename(A));
  check('leak mechanism identified', !hasA || m !== null,
    `regex hit on "${path.basename(A)}" = ${m ? JSON.stringify(m[0]) : 'none'}`);
} catch (err) {
  check('probe ran', false, String(err?.message ?? err));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`);
console.log(`verdict=${failed.length === 0 ? 'VALVE-TIGHT' : 'VALVE-LEAKS'}`);
process.exitCode = failed.length === 0 ? 0 : 1;
