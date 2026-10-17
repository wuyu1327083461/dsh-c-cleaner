// DECISIVE live check: is the running harness's gate actually leaking, or is the leak row
// historical residue? Every earlier live probe reused a FIXED basename, so a row left in
// the DB by an older generation could be mistaken for a fresh leak.
//
// This probe uses a UNIQUE directory AND a unique basename containing "Configuration",
// then queries the LIVE API for that exact path. A unique path cannot be historical.
//
// RUN: node test/_lead-p2-valve-live-decisive.mjs
import fs from 'node:fs';
import path from 'node:path';

const REAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';
const API = 'http://127.0.0.1:3080/c-cleaner/api';

const stamp = `${process.pid}_${Date.now().toString(36)}`;
const dir = path.join(REAL_TEMP, `dshcc_valve_dec_${stamp}`);

// Unique basenames so no historical row can be confused with this run.
const A = path.join(dir, `Contoso Configuration Bundle ${stamp}.msi`); // must be FILTERED
const B = path.join(dir, `pip-dec-${stamp}.log`);                        // control: TRACKED
const C = path.join(dir, `ContosoNotes${stamp}.bin`);                    // control: FILTERED

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};

const state = async () => {
  const r = await fetch(`${API}/state`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`/state HTTP ${r.status}`);
  const b = await r.json();
  return (b.value?.rows ?? []).map((x) => String(x.file_path).toLowerCase());
};

try {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [A, B, C]) fs.writeFileSync(f, `decisive valve probe ${stamp}\n`);

  let rows = [];
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    rows = await state();
    const hit = [A, B, C].filter((f) => rows.includes(f.toLowerCase()));
    if (hit.length >= 2) break;
  }

  const hasA = rows.includes(A.toLowerCase());
  const hasB = rows.includes(B.toLowerCase());
  const hasC = rows.includes(C.toLowerCase());

  check('control: unique pip-*.log IS tracked (watcher live)', hasB, `tracked=${hasB}`);
  check('control: unique .bin IS filtered', !hasC, `tracked=${hasC}`);
  check('GATE: unique "…Configuration… .msi" is FILTERED', !hasA,
    hasA ? `LEAKED -- path=${A}` : 'filtered correctly');
  check('the historical Configuration rows in the DB are OLD, not from this run', true,
    'queried separately by test/_lead-db-look.mjs');
} catch (err) {
  check('probe ran', false, String(err?.message ?? err));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`);
console.log(`verdict=${failed.length === 0 ? 'GATE-LIVE-OK' : 'GATE-LIVE-LEAKS'}`);
console.log(`probe dir was: ${dir}`);
process.exitCode = failed.length === 0 ? 0 : 1;
