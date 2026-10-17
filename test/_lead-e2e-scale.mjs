/**
 * END-TO-END proof of the transport fix at the user's REAL payload size.
 *
 * The user's failure: 一键清理已选 with ~1693 paths selected -> a ~150 KB request body. The old
 * server cap was 64 KiB (`MAX_BODY_BYTES` in lib/web-api.js), and a body that large was destroyed
 * at the socket level, which the browser surfaces as `Failed to fetch` rather than a 413. The cap
 * is now 4 MiB.
 *
 * This probe reproduces that exact shape with files it owns: it creates enough real `pip-*` files
 * under the REAL Windows Temp to exceed 64 KiB of JSON, waits for the watcher to track them ALL,
 * then sends ONE clean request carrying every path and proves they are really gone.
 *
 * Creation is PACED, not a tight loop. Measured on this host (`test/_lead-watch-burst.mjs`): a
 * burst of 200+ files overflows the Windows directory-change buffer so that even a bare `fs.watch`
 * sees only ~107/200, and the plugin tracked 205/800. That is an OS boundary BELOW the plugin, but
 * it would make this probe measure burst loss instead of the transport, so files are created in
 * small batches with a gap.
 *
 * Rooted at %LOCALAPPDATA%\Temp on purpose: os.tmpdir() is redirected by the plugin's own env
 * hijack into the escape root (a protectRoot), where this would test the protection veto instead
 * of the clean path.
 */
import fs from 'node:fs';
import path from 'node:path';

const API = 'http://127.0.0.1:3080/c-cleaner/api';
const tmpRoot = path.join(process.env.LOCALAPPDATA, 'Temp');
const dir = fs.mkdtempSync(path.join(tmpRoot, 'dshcc_e2e_'));

const BATCH = 40;
const GAP_MS = 700;
const TARGET_BYTES = 96 * 1024; // comfortably past the old 64 KiB cap

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`);
}

async function get(verb) {
  const res = await fetch(`${API}/${verb}`);
  return { status: res.status, json: await res.json() };
}

async function trackedCount() {
  const st = await get('state');
  const rows = st.json?.value?.rows ?? [];
  return rows.filter((r) => String(r.file_path).startsWith(dir)).length;
}

// Create in paced batches until the JSON payload for the tracked set would exceed the old cap.
const files = [];
for (let batch = 0; batch < 60; batch += 1) {
  for (let i = 0; i < BATCH; i += 1) {
    const p = path.join(dir, `pip-e2e-${batch * BATCH + i}.log`);
    fs.writeFileSync(p, Buffer.alloc(2000, 0x63));
    files.push(p);
  }
  const estimate = Buffer.byteLength(JSON.stringify({ paths: files }));
  if (estimate > TARGET_BYTES) break;
  await new Promise((r) => setTimeout(r, GAP_MS));
}

const payloadBytes = Buffer.byteLength(JSON.stringify({ paths: files }));
check('the payload EXCEEDS the old 64 KiB cap (the shape that failed)', payloadBytes > 65536,
  `${files.length} paths / ${payloadBytes} B (old cap 65536, new cap 4 MiB)`);

// Wait for the watcher to catch up on the paced set.
const deadline = Date.now() + 120_000;
let tracked = 0;
while (Date.now() < deadline) {
  tracked = await trackedCount();
  if (tracked >= files.length) break;
  await new Promise((r) => setTimeout(r, 2000));
}
check('the watcher tracked every paced file', tracked === files.length, `tracked=${tracked}/${files.length}`);

const payload = JSON.stringify({ paths: files, deep: false, force: false });
const t0 = Date.now();
const res = await fetch(`${API}/clean`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: payload,
});
const ms = Date.now() - t0;
const body = await res.json();
const report = body?.value?.report ?? {};
const left = files.filter((p) => fs.existsSync(p)).length;

check('POST /clean answers 200 (no "Failed to fetch", no 413)', res.status === 200, `status=${res.status} wall=${ms} ms`);
check('every selected file was really removed from disk', left === 0, `left=${left} of ${files.length}`);
check('the report accounts for every file', report.removed === files.length, `removed=${report.removed} of ${files.length}`);
check('no errors were reported', (report.errors ?? []).length === 0, `errors=${(report.errors ?? []).length}`);

console.log(`\nwall = ${ms} ms for ${files.length} files / ${payloadBytes} B`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`);
console.log(`verdict=${failed.length === 0 ? 'E2E-TRANSPORT-OK' : 'E2E-TRANSPORT-BROKEN'}`);
process.exitCode = failed.length === 0 ? 0 : 1;
