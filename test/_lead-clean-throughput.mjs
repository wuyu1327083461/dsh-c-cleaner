/**
 * Throughput measurement: how long does a REAL recycle-bin clean take, per chunk of 50?
 *
 * The panel's clean verb is synchronous from the browser's point of view: the request stays open
 * until every PowerShell chunk has run. Node's default server `requestTimeout` is 300 s, so a
 * full selection (measured live: 1762 SAFE_TO_DELETE rows = ~36 chunks) must finish well inside
 * that or the panel would fail with a transport error again for a different reason.
 *
 * This probe cleans real probe files it created itself under %LOCALAPPDATA%\Temp and reports the
 * wall time per chunk, so the total is a measured extrapolation rather than a guess.
 */
import fs from 'node:fs';
import path from 'node:path';

const API = 'http://127.0.0.1:3080/c-cleaner/api';
const tmpRoot = path.join(process.env.LOCALAPPDATA, 'Temp');
const dir = fs.mkdtempSync(path.join(tmpRoot, 'dshcc_thru_'));

const COUNT = 120; // ~2.4 chunks of 50
const files = [];
for (let i = 0; i < COUNT; i += 1) {
  const p = path.join(dir, `pip-thru-${i}.log`);
  fs.writeFileSync(p, Buffer.alloc(4096, 0x62));
  files.push(p);
}

async function post(verb, body) {
  const res = await fetch(`${API}/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function get(verb) {
  const res = await fetch(`${API}/${verb}`);
  return { status: res.status, json: await res.json() };
}

// Wait for the watcher to track them.
const deadline = Date.now() + 60_000;
let tracked = 0;
while (Date.now() < deadline) {
  const st = await get('state');
  tracked = (st.json?.value?.rows ?? []).filter((r) => String(r.file_path).startsWith(dir)).length;
  if (tracked >= COUNT) break;
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(`tracked ${tracked}/${COUNT} probe files`);

const t0 = Date.now();
const r = await post('clean', { paths: files, deep: false, force: false });
const ms = Date.now() - t0;
const report = r.json?.value?.report ?? {};
const left = files.filter((p) => fs.existsSync(p)).length;

console.log(`clean status=${r.status}`);
console.log(`removed=${report.removed} skipped=${report.skipped} bytesFreed=${report.bytesFreed} errors=${(report.errors ?? []).length}`);
console.log(`files left on disk=${left}`);
console.log(`WALL MS for ${COUNT} files = ${ms}`);
console.log(`MS PER CHUNK OF 50 = ${Math.round((ms / COUNT) * 50)}`);

// Extrapolate to the live full selection.
const st = await get('state');
const safeCount = (st.json?.value?.rows ?? []).filter((r2) => r2.category === 'SAFE_TO_DELETE').length;
const perChunk = (ms / COUNT) * 50;
const chunks = Math.ceil(safeCount / 50);
const estMs = perChunk * chunks;
console.log(`\nlive SAFE_TO_DELETE rows = ${safeCount} -> ${chunks} chunks`);
console.log(`ESTIMATED full-clean wall = ${Math.round(estMs)} ms = ${(estMs / 1000).toFixed(1)} s`);
console.log(`Node default requestTimeout = 300000 ms -> ${estMs < 300_000 ? 'INSIDE the budget' : 'OVER the budget -- the panel would time out'}`);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = 0;
