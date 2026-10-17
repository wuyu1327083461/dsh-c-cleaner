// Lead-owned discriminator probe (read-only w.r.t. the plugin).
//
// QUESTION: is the residual live `.msi` leak caused by the CURRENT shipped gate, or by a
// PHANTOM watcher left over from a module generation that predates the process-global
// live-watcher registry?
//
// DISCRIMINATOR: `Contoso Configuration Bundle.bin` contains the SUBSTRING "Config" but the
// token is not word-bounded, and `.bin` matches none of DEFAULT_AI_SIGNATURES
// (tmp*/pip-*/uv-*/playwright*/node-*/npm-*/hf-*/torch*/*-cache/*.pyc/*.log/*.tmp/*.bak).
//   * shipped gate  -> CREDENTIAL_NAME_RE requires a word boundary -> NO admit -> dropped
//   * pre-fix gate  -> LOCKED_BASENAME_RE is a bare substring  -> ADMIT     -> delivered
// So a `.bin` whose basename merely CONTAINS "Configuration" can only be delivered by code
// that still holds the old loose regex. That isolates "phantom old generation" from
// "current generation is wrong".
//
// RUN: node test/_lead-p2-phantom-discriminator.mjs
import fs from 'node:fs';
import path from 'node:path';

const REAL_TEMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp';
const API = 'http://127.0.0.1:3080/c-cleaner/api';

const stamp = `${process.pid}_${Date.now().toString(36)}`;
const dir = path.join(REAL_TEMP, `dshcc_phantom_${stamp}`);

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

const A = path.join(dir, 'Contoso Configuration Bundle.bin');
const B = path.join(dir, `pip-phantom-${stamp}.log`);
const C = path.join(dir, `ContosoNotes${stamp}.bin`);

let rows = [];
try {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [A, B, C]) fs.writeFileSync(f, `phantom discriminator ${stamp}\n`);

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

  check('control: pip-* log IS tracked', hasB, `tracked=${hasB} (watcher is live)`);
  check('control: plain .bin IS filtered', !hasC, `tracked=${hasC}`);
  check(
    'PHANTOM: loose-substring "Configuration*.bin" filtered',
    !hasA,
    hasA
      ? 'LEAKED -- only a generation holding the OLD loose LOCKED_BASENAME_RE can admit this'
      : 'filtered correctly -- shipped tight CREDENTIAL_NAME_RE is the live gate',
  );
} catch (err) {
  check('probe ran', false, String(err?.message ?? err));
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`);
console.log(`verdict=${failed.length === 0 ? 'CURRENT-GATE-ONLY' : 'PHANTOM-OLD-GENERATION'}`);
process.exitCode = 0;
