/**
 * Lead-owned live probe: does POST /c-cleaner/api/clean actually clean?
 *
 * Writes three 200 KB `pip-*` logs into ONE new directory in the REAL Windows Temp,
 * waits for the watcher to track them, then drives the LIVE clean verb exactly the way
 * the panel does and reports what happened on disk.
 *
 * Rooted at %LOCALAPPDATA%\Temp on purpose: os.tmpdir() is redirected by the plugin's
 * own env hijack into the escape root, which is a protectRoot, so a probe rooted there
 * would test the protectRoot veto rather than the clean path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'http://127.0.0.1:3080/c-cleaner/api';
const tmpRoot = path.join(process.env.LOCALAPPDATA, 'Temp');
const dir = fs.mkdtempSync(path.join(tmpRoot, 'dshcc_cleanlive_'));

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  -- ${detail}`}`);
}

const files = [];
for (const n of [1, 2, 3]) {
  const p = path.join(dir, `pip-cleanlive-${n}.log`);
  fs.writeFileSync(p, Buffer.alloc(200 * 1024, 0x61));
  files.push(p);
}

async function getJson(verb, init) {
  const res = await fetch(`${API}/${verb}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init?.body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}

// Wait for the watcher to track all three.
const deadline = Date.now() + 45_000;
let rows = [];
while (Date.now() < deadline) {
  const st = await getJson('state');
  rows = (st.json?.value?.rows ?? []).filter((r) => String(r.file_path ?? '').startsWith(dir));
  if (rows.length >= 3) break;
  await new Promise((r) => setTimeout(r, 1500));
}
check('the watcher tracked all three probe files', rows.length === 3, `tracked=${rows.length}`);
check('all three are SAFE_TO_DELETE', rows.every((r) => r.category === 'SAFE_TO_DELETE'),
  rows.map((r) => r.category).join(','));

// Drive the clean verb exactly like the panel: paths + deep + force.
const before = files.filter((p) => fs.existsSync(p)).length;
const res = await getJson('clean', {
  method: 'POST',
  body: JSON.stringify({ paths: files, deep: false, force: false }),
});
const after = files.filter((p) => fs.existsSync(p)).length;

console.log(`\nclean response status=${res.status}`);
console.log(`clean response body=${res.text}`);

check('POST /clean answered 200', res.status === 200, `status=${res.status}`);
check('the response carries ok:true', res.json?.ok === true, JSON.stringify(res.json?.error ?? null));
check('all three probe files are GONE from disk', after === 0, `before=${before} after=${after}`);
check('the report says it removed three', res.json?.value?.report?.removed === 3,
  `removed=${res.json?.value?.report?.removed}`);

// A replay must delete nothing (rows are gone from the DB).
const replay = await getJson('clean', {
  method: 'POST',
  body: JSON.stringify({ paths: files, deep: false, force: false }),
});
check('a replay removes nothing (rows already forgotten)', replay.json?.value?.report?.removed === 0,
  `removed=${replay.json?.value?.report?.removed} rejected=${(replay.json?.value?.rejected ?? []).length}`);

// Clean up the now-empty probe directory.
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`);
console.log(`verdict=${failed.length === 0 ? 'LIVE-CLEAN-OK' : 'LIVE-CLEAN-BROKEN'}`);
process.exitCode = failed.length === 0 ? 0 : 1;
