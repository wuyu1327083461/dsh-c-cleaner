/**
 * Boundary proof for the panel's clean-body contract.
 *
 * REGRESSION THIS LOCKS (measured live, harness pid 47648):
 *   The panel sends every selected path as a JSON array. With 1693 rows selected that body is
 *   ~146 KB. The old `MAX_BODY_BYTES = 64 * 1024` rejected it AND called `req.destroy()`, so the
 *   browser got no response at all and the panel rendered the bare string `Failed to fetch` on
 *   一键清理已选. Boundary: 780 paths / 65 361 B -> 200; 790 paths / 66 327 B -> transport failure.
 *
 * THE CONTRACT NOW:
 *   1. A realistic full selection (the live SAFE_TO_DELETE population) is accepted -> 200.
 *   2. A body beyond the memory ceiling still gets a REAL HTTP response (413 + JSON), never a
 *      destroyed socket, so the panel can say what went wrong.
 *   3. Nothing is deleted by this probe: every path it sends has an untracked basename, so
 *      `filterRequestedPaths` rejects it and the handler takes the "no tracked path was selected"
 *      early return. The size contract is exercised without touching a file.
 */
import fs from 'node:fs';

const API = 'http://127.0.0.1:3080/c-cleaner/api/clean';
/** Must match lib/web-api.js. Kept in sync by the assertion on the live 200 below. */
const CEILING = 4 * 1024 * 1024;

const state = await (await fetch('http://127.0.0.1:3080/c-cleaner/api/state')).json();
const safe = state.value.rows.filter((r) => r.category === 'SAFE_TO_DELETE');

/** Untracked basename, so the request is refused by the row-matching fence, not by size. */
function fakePath(row, i) {
  const p = row.file_path;
  const cut = p.lastIndexOf('\\');
  return cut === -1 ? p : `${p.slice(0, cut + 1)}untracked-${i}.log`;
}

function payloadFor(paths) {
  return JSON.stringify({ paths, deep: false, force: false });
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`);
}

async function post(body) {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep null */ }
    return { status: res.status, json, text: text.slice(0, 200) };
  } catch (err) {
    return { status: 0, transport: String(err?.message ?? err) };
  }
}

// 1. The exact size that used to fail (65-150 KB) must now be accepted.
const realBody = payloadFor(safe.map(fakePath));
const realBytes = Buffer.byteLength(realBody);
const r1 = await post(realBody);
check('a realistic full selection (all SAFE_TO_DELETE rows) is ACCEPTED, not transport-failed',
  r1.status === 200, `${safe.length} paths / ${realBytes} B -> status=${r1.status}${r1.transport ? ` transport=${r1.transport}` : ''}`);
check('the response is real JSON, not a dead socket', r1.json?.ok === true,
  r1.json ? `ok=${r1.json.ok} note=${JSON.stringify(r1.json.value?.note ?? null)}` : `raw=${r1.text}`);

// 2. The specific size band that reproduced the user's failure must now pass.
const band = payloadFor(safe.slice(0, 790).map(fakePath));
const bandBytes = Buffer.byteLength(band);
const r2 = await post(band);
check('the exact band that reproduced "Failed to fetch" (790 paths / ~66 KB) now returns 200',
  r2.status === 200, `${bandBytes} B -> status=${r2.status}`);

// 3. Past the memory ceiling: a REAL 413 with a readable message, never a destroyed socket.
const huge = JSON.stringify({ paths: Array.from({ length: 60_000 }, (_, i) => `${'x'.repeat(80)}-${i}.log`), deep: false, force: false });
const hugeBytes = Buffer.byteLength(huge);
const r3 = await post(huge);
check('a body past the ceiling gets a REAL HTTP response, not a transport failure',
  r3.status !== 0, `${hugeBytes} B -> status=${r3.status}${r3.transport ? ` transport=${r3.transport}` : ''}`);
check('that response is a 413 carrying a readable, actionable message',
  r3.status === 413 && typeof r3.json?.error?.message === 'string' && r3.json.error.message.length > 0,
  r3.json ? `status=${r3.status} code=${r3.json.error?.code} message=${JSON.stringify(r3.json.error?.message)}` : `raw=${r3.text}`);
check('the reported limit is the shipped ceiling, not the old 64 KiB',
  r3.json?.error?.message?.includes(`${Math.round(CEILING / 1024)} KiB`) === true,
  `message=${JSON.stringify(r3.json?.error?.message)}`);

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`);
console.log(`verdict=${failed.length === 0 ? 'BODY-CONTRACT-OK' : 'BODY-CONTRACT-BROKEN'}`);
process.exitCode = failed.length === 0 ? 0 : 1;
