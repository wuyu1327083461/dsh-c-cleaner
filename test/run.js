#!/usr/bin/env node
/**
 * dsh-c-cleaner acceptance harness — verifier-owned, dependency-free.
 *
 * Node v24 ESM. Imports every lib module and asserts OBSERVED BEHAVIOUR
 * (CONTRACTS.md §12: "Acceptance is observed behaviour, not 'the file exists'").
 *
 * Contract: exit 0 only if every check passes.
 * Output: `PASS <name>` / `FAIL <name>: <detail>` per check, final SUMMARY line.
 *
 * Owner: verifier. Write scope: test/** only. This file is never a source of
 * truth for the implementation — it asserts the frozen contracts §3-§10.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IS_WIN = process.platform === 'win32';
const STAMP = `${process.pid}_${Date.now().toString(36)}`;

// ─────────────────────────────────────────────────────────── result plumbing
const results = [];
let probeFailures = 0;
const notes = [];

function detail(msg) {
  console.log(`      | ${msg}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function check(name, fn) {
  const t0 = Date.now();
  try {
    const d = await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name} (${Date.now() - t0}ms)`);
    if (d) detail(d);
  } catch (e) {
    results.push({ name, ok: false, detail: e && e.message ? e.message : String(e) });
    console.log(`FAIL ${name}: ${e && e.message ? e.message : e}`);
    if (e && e.stack && process.env.DCC_TRACE) detail(e.stack.split('\n').slice(0, 6).join(' / '));
  }
}

/** Adversarial probe: records a finding. Only `prdViolation:true` fails the run. */
async function probe(name, fn) {
  let res;
  try {
    res = await fn();
    if (!res || typeof res !== 'object' || typeof res.verdict !== 'string') {
      res = { verdict: 'PROBE RETURNED NO VERDICT', data: String(res), prdViolation: false };
    }
  } catch (e) {
    res = { verdict: 'THREW', data: e && e.message ? e.message : String(e), prdViolation: false };
  }
  if (res.prdViolation === undefined) res.prdViolation = false;
  const tag = res.prdViolation ? 'PROBE-FAIL' : 'PROBE';
  if (res.prdViolation) probeFailures++;
  console.log(`${tag} ${name}: ${res.verdict}`);
  if (res.data !== undefined) detail(typeof res.data === 'string' ? res.data : JSON.stringify(res.data));
  return res;
}

// ───────────────────────────────────────────────────────────── path helpers
function norm(p) {
  let s = String(p).trim();
  // strip \\?\ and \\.\ prefixes so comparisons see the canonical target
  s = s.replace(/^\\\\[?.]\\/, '');
  return path.resolve(s).replace(/[\\/]+$/, '').toLowerCase();
}
function under(p, root) {
  const a = norm(p);
  const b = norm(root);
  return a === b || a.startsWith(b + '\\');
}
function isUnderAny(p, roots) {
  return (roots || []).some((r) => under(p, r));
}
function mkdirp(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  } catch { /* best effort */ }
}
function json(x) {
  return JSON.stringify(x);
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

// ─────────────────────────────────────────────────────────── module loading
const moduleCache = new Map();
async function load(rel) {
  if (moduleCache.has(rel)) return moduleCache.get(rel);
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error(`MISSING MODULE ${rel} (not written yet)`);
  const m = await import(pathToFileURL(file).href);
  moduleCache.set(rel, m);
  return m;
}

// ─────────────────────────────────────────────────── live fixture management
const cleanupFns = [];
const probeRoot = mkdirp(path.join(os.tmpdir(), `dshcc_harness_${STAMP}`));
cleanupFns.push(() => rmrf(probeRoot));

function spawnLocker(file) {
  const ready = `${file}.dcc-ready`;
  rmrf(ready);
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const ps = [
    `$ErrorActionPreference='Stop'`,
    `$f=[System.IO.File]::Open(${q(file)},'Open','ReadWrite','None')`,
    `[System.IO.File]::WriteAllText(${q(ready)},'ok')`,
    `Start-Sleep -Seconds 90`,
    `$f.Close()`,
  ].join('\n');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  let err = '';
  child.stderr.on('data', (b) => { err += b.toString(); });
  cleanupFns.push(() => { try { child.kill(); } catch {} });
  return { child, ready, errText: () => err };
}

async function waitFor(pred, timeoutMs, stepMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

// ══════════════════════════════════════════════════════════════════════════
// 1. STATIC — node --check every .js under the plugin root
// ══════════════════════════════════════════════════════════════════════════
function walkJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

await check('static.nodecheck', async () => {
  const files = walkJs(ROOT).sort();
  assert(files.length > 0, `no .js files found under ${ROOT}`);
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${path.relative(ROOT, f)}: ${(r.stderr || '').trim().split('\n')[0]}`);
  }
  assert(bad.length === 0, `node --check failed for: ${bad.join(' ; ')}`);
  return `${files.length} files OK: ${files.map((f) => path.relative(ROOT, f)).join(', ')}`;
});

// ══════════════════════════════════════════════════════════════════════════
// 2/3/4. CONFIG (CONTRACTS §3)
// ══════════════════════════════════════════════════════════════════════════
let cfg = null;
let CATEGORY = null;

await check('config.defaults', async () => {
  const m = await load('lib/config.js');
  assert(typeof m.resolveConfig === 'function', 'resolveConfig is not a function');
  CATEGORY = m.CATEGORY;
  cfg = m.resolveConfig({}, process.env);
  assert(cfg && typeof cfg === 'object', 'resolveConfig returned non-object');

  // escapeRoot must be on E: (derived from $DSH_HOME=E:\dsh\.dsh)
  assertEq(typeof cfg.escapeRoot, 'string', 'escapeRoot type');
  assert(/^e:\\/i.test(cfg.escapeRoot), `escapeRoot not on E: -> ${json(cfg.escapeRoot)}`);

  // stateDir / dbPath
  assertEq(typeof cfg.stateDir, 'string', 'stateDir type');
  assertEq(typeof cfg.dbPath, 'string', 'dbPath type');
  assert(under(cfg.dbPath, cfg.stateDir), `dbPath ${json(cfg.dbPath)} is not under stateDir ${json(cfg.stateDir)}`);

  // watchDirs must include %LOCALAPPDATA%\Temp
  const wantTemp = path.join(process.env.LOCALAPPDATA, 'Temp');
  assert(Array.isArray(cfg.watchDirs), 'watchDirs is not an array');
  const hasTemp = cfg.watchDirs.some((w) => w && typeof w.path === 'string' && norm(w.path) === norm(wantTemp));
  assert(hasTemp, `watchDirs lacks ${json(wantTemp)}; got ${json(cfg.watchDirs.map((w) => w && w.path))}`);

  // protectRoots must include C:\Windows
  assert(Array.isArray(cfg.protectRoots), 'protectRoots is not an array');
  const hasWin = cfg.protectRoots.some((r) => norm(r) === 'c:\\windows');
  assert(hasWin, `protectRoots lacks C:\\Windows; got ${json(cfg.protectRoots)}`);
  const isAbs = cfg.protectRoots.every((r) => path.isAbsolute(r));
  assert(isAbs, `protectRoots must be absolute: ${json(cfg.protectRoots)}`);

  // documented defaults (§3)
  const defaults = { debounceMs: 3000, pollIntervalMs: 5000, sessionWindowMs: 30 * 60 * 1000 };
  for (const [k, v] of Object.entries(defaults)) {
    assertEq(cfg[k], v, `default ${k}`);
  }
  assert(Array.isArray(cfg.excludeNames) && cfg.excludeNames.includes('.dsh'),
    `excludeNames must contain '.dsh'; got ${json(cfg.excludeNames)}`);
  assert(Array.isArray(cfg.excludeGlobs), 'excludeGlobs is not an array');
  assert(typeof cfg.envMap === 'object' && cfg.envMap !== null, 'envMap is not an object');
  assertEq(cfg.envMap.TEMP, 'temp', 'envMap.TEMP');
  assertEq(cfg.envMap.PIP_CACHE_DIR, 'pip', 'envMap.PIP_CACHE_DIR');
  assertEq(cfg.envMap.PLAYWRIGHT_BROWSERS_PATH, 'playwright', 'envMap.PLAYWRIGHT_BROWSERS_PATH');
  assertEq(cfg.isWindows, IS_WIN, 'isWindows');
  assertEq(cfg.enabled, true, 'enabled default');

  // CATEGORY enum values (§3)
  assertEq(CATEGORY.SAFE, 'SAFE_TO_DELETE', 'CATEGORY.SAFE');
  assertEq(CATEGORY.CAUTION, 'CAUTION_CACHE', 'CATEGORY.CAUTION');
  assertEq(CATEGORY.LOCKED, 'LOCKED_CRITICAL', 'CATEGORY.LOCKED');

  return `escapeRoot=${cfg.escapeRoot} dbPath=${cfg.dbPath} watchDirs=${cfg.watchDirs.length} protectRoots=${json(cfg.protectRoots)}`;
});

await check('config.overrides', async () => {
  const m = await load('lib/config.js');
  const c = m.resolveConfig({ escapeRoot: 'E:\\dsh_cc_probe_root', debounceMs: 1234, enabled: false }, process.env);
  assertEq(c.escapeRoot, 'E:\\dsh_cc_probe_root', 'escapeRoot override ignored');
  assertEq(c.debounceMs, 1234, 'debounceMs override ignored');
  assertEq(c.enabled, false, 'enabled override ignored');
  return 'explicit overrides honoured';
});

await check('config.malformed-input-hardening', async () => {
  // H1/H3 hardening (rev3): `resolveConfig` is a documented public re-export from index.js, so a
  // malformed config must be REPAIRED, never thrown on. The Lead measured `survived: 12 threw: 9`
  // before the rewrite; this is the permanent guard that the throws stay gone.
  const m = await load('lib/config.js');
  const resolveConfig = m.resolveConfig ?? m.default;
  assert(typeof resolveConfig === 'function', 'resolveConfig is not exported as a function');

  const junk = [undefined, null, 42, 'nope', [], [1, 2], true, () => {}, Symbol.iterator ? {} : {}, NaN, Infinity, -1, 0, '', '   '];
  let threw = [];
  for (const raw of junk) {
    for (const env of [process.env, undefined, null, 'env', 42, []]) {
      try {
        const c = resolveConfig(raw, env);
        assert(c && typeof c === 'object', `resolveConfig(${json(String(raw))}) returned a non-object`);
      } catch (e) {
        threw.push(`resolveConfig(${json(String(raw))}, env=${json(String(env))}) THREW: ${e.code || ''} ${e.message}`);
      }
    }
  }
  assert(threw.length === 0, `${threw.length} malformed resolveConfig call(s) threw (must fail soft); first: ${threw[0]}`);

  // The specific regression: `envMap: "nope"` used to spread a STRING into vars literally named
  // 0,1,2,3. A string must never produce per-character numeric variable names.
  const c1 = resolveConfig({ envMap: 'nope' });
  assert(c1.envMap && typeof c1.envMap === 'object' && !Array.isArray(c1.envMap), `envMap must stay a plain object, got ${json(c1.envMap)}`);
  const numeric = Object.keys(c1.envMap).filter((k) => /^\d+$/.test(k));
  assert(numeric.length === 0, `envMap: "nope" spread into numeric variable names ${json(numeric)} (the {0:'n',1:'o',...} bug) — envMap = ${json(c1.envMap)}`);
  assertEq(c1.envMap.TEMP, 'temp', 'a malformed envMap must fall back to the DEFAULTS, not to {}');
  const c2 = resolveConfig({ envMap: { TEMP: 'x', BAD: 42, ALSO_BAD: null, GOOD: 'y' } });
  assertEq(c2.envMap.TEMP, 'x', 'a valid envMap string entry must survive');
  assertEq(c2.envMap.GOOD, 'y', 'a valid envMap string entry must survive');
  assert(!('BAD' in c2.envMap) && !('ALSO_BAD' in c2.envMap), `non-string envMap values must be dropped, got ${json(c2.envMap)}`);

  // H1: a watchDirs entry without `path` used to throw ERR_INVALID_ARG_TYPE from path.resolve.
  const c3 = resolveConfig({ watchDirs: [{}, { path: '' }, null, 42, { path: 'C:\\Users\\kiuhg\\AppData\\Local\\Temp', recursive: true, maxDepth: 2 }] });
  assert(Array.isArray(c3.watchDirs), `watchDirs must stay an array, got ${json(c3.watchDirs)}`);
  assert(c3.watchDirs.length >= 1, `a watchDirs list with unusable entries must fall back to defaults, got ${json(c3.watchDirs)}`);
  assert(c3.watchDirs.every((w) => typeof w.path === 'string' && w.path.length > 0), `every watchDir must carry a path, got ${json(c3.watchDirs)}`);
  // CONTRACTS.md:68 fixes the shape as an ARRAY of {path,...}; a bare string is only tolerated
  // as an ELEMENT (normaliseWatchDir), not as the whole value. A top-level non-array is therefore
  // out of contract, and the requirement is merely "must not throw".
  const c4 = resolveConfig({ watchDirs: ['C:\\Users\\kiuhg\\AppData\\Local\\Temp'] });
  assert(Array.isArray(c4.watchDirs) && c4.watchDirs.length === 1 && c4.watchDirs[0].path.toLowerCase().endsWith('temp'),
    `an array containing a bare-string entry must be accepted, got ${json(c4.watchDirs)}`);
  let c4b = null;
  try { c4b = resolveConfig({ watchDirs: 'C:\\Users\\kiuhg\\AppData\\Local\\Temp' }); } catch (e) { throw new Error(`a top-level non-array watchDirs THREW (must fail soft): ${e.message}`); }
  assert(Array.isArray(c4b.watchDirs), `a top-level non-array watchDirs must still yield an array, got ${json(c4b.watchDirs)}`);
  // Recorded as a hardening note, not an assertion: a top-level non-array yields [] (watches
  // NOTHING) rather than falling back to the defaults. Out of contract (the Cordis schema rejects
  // it first) and it cannot widen deletion, but it is a silent no-op.
  const silentDisable = c4b.watchDirs.length === 0;

  // H3: numeric bounds must be clamped/ignored, never accepted as garbage.
  const c5 = resolveConfig({ debounceMs: 'x', pollIntervalMs: -99, sessionWindowMs: NaN, maxBatch: -5 });
  for (const k of ['debounceMs', 'pollIntervalMs', 'sessionWindowMs', 'maxBatch']) {
    assert(Number.isFinite(c5[k]) && c5[k] >= 0, `${k} must stay a finite non-negative number, got ${json(c5[k])}`);
  }
  assert(c5.debounceMs === 3000, `a non-numeric debounceMs must fall back to 3000, got ${c5.debounceMs}`);
  assert(c5.maxBatch >= 1, `maxBatch must be >= 1, got ${c5.maxBatch}`);

  // PRD §6.2 FAIL-CLOSED: repairing malformed input must never WIDEN what may be deleted.
  // The classifier keeps an INDEPENDENT hardcoded blacklist, so even an emptied protectRoots
  // config must not make a Windows file deletable.
  const cl = await load('lib/classifier.js');
  const emptyCfg = resolveConfig({ protectRoots: [], excludeNames: null, excludeGlobs: 'nope' });
  assert(Array.isArray(emptyCfg.protectRoots), `protectRoots must stay an array, got ${json(emptyCfg.protectRoots)}`);
  for (const p of ['C:\\Windows\\notepad.exe', 'C:\\Windows\\System32\\kernel32.dll']) {
    assert(cl.isProtectedPath(p, emptyCfg.protectRoots) === true,
      `FAIL-OPEN: with a malformed/emptied protectRoots config, ${p} is no longer protected`);
  }
  assert(cl.isProtectedPath('C:\\Windows\\notepad.exe', null) === true, 'FAIL-OPEN: protectRoots=null must still protect C:\\Windows');
  assert(cl.isProtectedPath('C:\\Windows\\notepad.exe', undefined) === true, 'FAIL-OPEN: protectRoots=undefined must still protect C:\\Windows');

  return `malformed config repaired without throwing (${junk.length} x 6 shapes, 0 throws); envMap:"nope" -> defaults with 0 numeric keys; watchDirs [{},null,42] -> defaults; numerics clamped (debounceMs=${c5.debounceMs}, maxBatch=${c5.maxBatch}); PRD §6.2 stays fail-CLOSED with emptied/null protectRoots${silentDisable ? '; NOTE: a top-level non-array watchDirs yields [] (watches nothing) instead of the defaults — out of contract (CONTRACTS.md:68 wants an array), cannot widen deletion, hardening only' : ''}`;
});

await check('config.nfr1-no-broad-recursive', async () => {
  // PRD §6.1: never recursive on C:\Users\<u> or %LOCALAPPDATA% root.
  const banned = [
    'c:\\',
    'c:\\users',
    norm(path.join(process.env.USERPROFILE || 'C:\\Users\\x')),
    norm(process.env.LOCALAPPDATA),
  ];
  const bad = (cfg.watchDirs || []).filter((w) => w && w.recursive === true && banned.includes(norm(w.path)));
  assert(bad.length === 0, `recursive watch on a forbidden root: ${json(bad)}`);
  for (const w of cfg.watchDirs) {
    assert(path.isAbsolute(w.path), `watchDirs entry not absolute: ${json(w.path)}`);
    assert(typeof w.recursive === 'boolean', `watchDirs.recursive not boolean: ${json(w)}`);
  }
  return json(cfg.watchDirs);
});

// ══════════════════════════════════════════════════════════════════════════
// 5/6/7/8. ENV HIJACK (CONTRACTS §4)
// ══════════════════════════════════════════════════════════════════════════
// The plugin is installed AND LIVE in this profile, so ambient TEMP may ALREADY be the escape
// root (E:\dsh_escape_cache\temp). Asserting `install() changed TEMP` against ambient state is
// therefore not hermetic. We install a non-escape SENTINEL as the prior value, so the real
// property (prior captured -> redirected under escapeRoot -> restored exactly) is testable
// regardless of ambient state. The true ambient values are restored in teardown.
const ambientPrior = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
// NOTE: os.tmpdir() itself reads TEMP, so it may return the LIVE escape root. The sentinel must
// be provably OUTSIDE escapeRoot or the check degenerates; prefer the real Windows temp dir.
const sentinelBase = under(os.tmpdir(), cfg.escapeRoot)
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp')
  : os.tmpdir();
const SENTINEL = path.join(sentinelBase, `cc-sentinel-not-escape-${STAMP}`);
assert(!under(SENTINEL, cfg.escapeRoot), `sentinel ${json(SENTINEL)} must not be under escapeRoot ${json(cfg.escapeRoot)}`);
const capturedPrior = { TEMP: SENTINEL, TMP: SENTINEL, TMPDIR: SENTINEL };
for (const k of Object.keys(capturedPrior)) process.env[k] = SENTINEL;
cleanupFns.push(() => {
  for (const [k, v] of Object.entries(ambientPrior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let hijacker = null;
let installRes = null;

await check('envhijack.install', async () => {
  const m = await load('lib/env-hijack.js');
  assert(typeof m.EnvHijacker === 'function', 'EnvHijacker is not a class/constructor');
  hijacker = new m.EnvHijacker(cfg, silentLog);
  installRes = hijacker.install();
  assertEq(installRes.ok, true, `install().ok (errors=${json(installRes.errors)})`);
  assert(Array.isArray(installRes.applied) && installRes.applied.length > 0, 'install().applied empty');
  assert(Array.isArray(installRes.createdDirs), 'install().createdDirs not an array');

  const applied = installRes.applied.find((a) => a.name === 'TEMP');
  assert(applied, 'TEMP not in install().applied');
  assertEq(applied.previous, capturedPrior.TEMP, 'applied[TEMP].previous must be the captured prior value');

  const now = process.env.TEMP;
  assert(now !== capturedPrior.TEMP, `install() did NOT change process.env.TEMP (still ${json(now)})`);
  assert(under(now, cfg.escapeRoot), `process.env.TEMP ${json(now)} not under escapeRoot ${json(cfg.escapeRoot)}`);
  for (const [name, sub] of Object.entries(cfg.envMap)) {
    const v = process.env[name];
    if (v === undefined) continue;
    assert(under(v, cfg.escapeRoot), `process.env.${name}=${json(v)} not under escapeRoot`);
    assert(norm(v) === norm(path.join(cfg.escapeRoot, sub)), `process.env.${name} is ${json(v)}, expected ${json(path.join(cfg.escapeRoot, sub))}`);
  }
  for (const d of installRes.createdDirs) assert(fs.existsSync(d), `createdDirs entry does not exist: ${d}`);
  assert(fs.existsSync(cfg.escapeRoot), `escapeRoot was not created: ${cfg.escapeRoot}`);

  return `TEMP ${json(capturedPrior.TEMP)} -> ${json(now)}; applied=${installRes.applied.length} createdDirs=${installRes.createdDirs.length}`;
});

await check('envhijack.status', async () => {
  assert(hijacker, 'hijacker not installed');
  const st = hijacker.status();
  assertEq(st.installed, true, 'status().installed');
  assertEq(st.escapeRoot, cfg.escapeRoot, 'status().escapeRoot');
  assert(Array.isArray(st.entries) && st.entries.length > 0, 'status().entries empty');
  const bad = st.entries.filter((e) => e.ok !== true);
  assert(bad.length === 0, `status() entries not all ok: ${json(bad)}`);
  return `${st.entries.length} entries all ok:true`;
});

await check('envhijack.scrub-skip', async () => {
  // §0 HARD RULE + §4(c): a name matching /KEY|PASSWORD|SECRET|TOKEN/i must be skipped.
  const m = await load('lib/env-hijack.js');
  const cfg2 = { ...cfg, envMap: { ...cfg.envMap, DCC_FAKE_TOKEN: 'tok' } };
  const h2 = new m.EnvHijacker(cfg2, silentLog);
  try {
    const r = h2.install();
    const skippedNames = (r.skipped || []).map((s) => s.name);
    assert(skippedNames.includes('DCC_FAKE_TOKEN'),
      `credential-shaped name not reported in skipped: ${json(r.skipped)}`);
    assert(process.env.DCC_FAKE_TOKEN === undefined,
      `HARD-RULE violation: DCC_FAKE_TOKEN was written into process.env (${json(process.env.DCC_FAKE_TOKEN)})`);
    return `skipped=${json(r.skipped)}`;
  } finally {
    try { h2.restore(); } catch (e) { throw new Error(`restore() after scrub-skip threw: ${e.message}`); }
  }
});

await check('envhijack.child-inherit', async () => {
  // CONTRACTS §12.3: a real child must observe the hijacked TEMP.
  // The harness spawner re-reads process.env on every spawn
  // (dsh-subprocess/lib/index.js:50-53 scrubbedParentEnv), so we replicate that
  // scrub exactly and prove TEMP survives it.
  const scrub = (src) => Object.fromEntries(Object.entries(src).filter(([k, v]) =>
    v !== undefined && !/KEY|PASSWORD|SECRET|TOKEN/i.test(k) && !k.toUpperCase().startsWith('DSH_')));
  const childEnv = scrub(process.env);
  assert(childEnv.TEMP !== undefined, 'TEMP vanished through the credential scrub (pattern drift?)');
  const r = spawnSync(process.execPath, ['-e', 'console.log(process.env.TEMP)'], { env: childEnv, encoding: 'utf8' });
  assertEq(r.status, 0, 'child node -e exited non-zero');
  const printed = (r.stdout || '').trim();
  assert(under(printed, cfg.escapeRoot),
    `child printed TEMP=${json(printed)}, expected a path under ${json(cfg.escapeRoot)}`);
  notes.push(`child-inherit printed: ${printed}`);

  // corroborate that the real scrubber still has the same shape
  const scrubSrc = '/c/Users/kiuhg/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js';
  const winSrc = 'C:\\Users\\kiuhg\\AppData\\Roaming\\dsh-tauri\\dependencies\\dsh\\node_modules\\@deepseek-ai\\dsh-subprocess\\lib\\index.js';
  let pat = 'unreadable';
  try {
    const txt = fs.readFileSync(winSrc, 'utf8');
    pat = (txt.match(/SENSITIVE_ENV_PATTERN\s*=\s*(\/.*\/i)/) || [])[1] || 'pattern-not-found';
  } catch { pat = `could not read ${scrubSrc}`; }
  return `child printed ${printed}; live scrub pattern in dsh-subprocess = ${pat}`;
});

await check('envhijack.restore', async () => {
  assert(hijacker, 'hijacker not installed');
  hijacker.restore();
  for (const [k, v] of Object.entries(capturedPrior)) {
    assert(process.env[k] === v,
      `restore() left ${k}=${json(process.env[k])}, expected the captured prior value ${json(v)}`);
  }
  hijacker = null;
  return `TEMP/TMP/TMPDIR restored exactly to pre-install values (TEMP=${json(capturedPrior.TEMP)})`;
});

// ══════════════════════════════════════════════════════════════════════════
// 9/10. CLASSIFIER (CONTRACTS §7, PRD §3.3)
// ══════════════════════════════════════════════════════════════════════════
const tempDir = path.join(process.env.LOCALAPPDATA, 'Temp');
const fixtureDir = mkdirp(path.join(tempDir, `dshcc_probe_${STAMP}`));
const localDir = mkdirp(path.join(process.env.LOCALAPPDATA, `dshcc_probe_${STAMP}`));
cleanupFns.push(() => rmrf(localDir));
cleanupFns.push(() => rmrf(fixtureDir));

function mkCandidate(p, size = 1234) {
  let mtimeMs = Date.now();
  try { mtimeMs = fs.statSync(p).mtimeMs; } catch {}
  return { path: p, size, mtimeMs, sourceProcess: 'verifier-probe' };
}
function mkClassified(p, size, category, over = {}) {
  return {
    path: p, size, category, isLocked: false, lockedByPid: null, lockedByProcess: null,
    reason: 'verifier fixture', sourceProcess: 'verifier-probe', mtimeMs: Date.now(), ...over,
  };
}
const treeStub = {
  pids: () => new Set([process.pid]), isTreeMember: () => false, nameOf: () => null,
  snapshot: () => [], ownerOf: async () => null, refresh: async () => ({ count: 0, total: 0 }),
};

let classifier = null;

await check('classifier.three-categories', async () => {
  classifier = await load('lib/classifier.js');
  assert(typeof classifier.classify === 'function', 'classify is not a function');
  assert(typeof classifier.isLocked === 'function', 'isLocked is not a function');
  assert(typeof classifier.isProtectedPath === 'function', 'isProtectedPath is not a function');

  // SAFE: under a Temp dir (name carries no critical marker)
  const safePath = path.join(fixtureDir, 'pip-build-cache-0001.bin');
  fs.writeFileSync(safePath, 'x'.repeat(2048));
  // CAUTION: under LocalAppData, not Temp, no one-shot extension
  const cautionPath = path.join(localDir, 'torch-weights-shard-0001.bin');
  fs.writeFileSync(cautionPath, 'y'.repeat(4096));
  // LOCKED by rule: persistent-state name
  const lockedPath = path.join(fixtureDir, 'session-state.sqlite3');
  fs.writeFileSync(lockedPath, 'z'.repeat(100));

  const cSafe = classifier.classify(mkCandidate(safePath, 2048), { cfg, tree: treeStub });
  const cCau = classifier.classify(mkCandidate(cautionPath, 4096), { cfg, tree: treeStub });
  const cLock = classifier.classify(mkCandidate(lockedPath, 100), { cfg, tree: treeStub });

  for (const [label, c] of [['safe', cSafe], ['caution', cCau], ['locked', cLock]]) {
    assert(c && typeof c === 'object', `${label}: classify returned non-object`);
    for (const k of ['path', 'size', 'category', 'isLocked', 'reason', 'mtimeMs']) {
      assert(k in c, `${label}: Classified is missing field ${k} -> ${json(Object.keys(c))}`);
    }
  }
  assertEq(cSafe.category, CATEGORY.SAFE, `SAFE fixture category (reason=${json(cSafe.reason)})`);
  assertEq(cCau.category, CATEGORY.CAUTION, `CAUTION fixture category (reason=${json(cCau.reason)})`);
  assertEq(cLock.category, CATEGORY.LOCKED, `LOCKED fixture category (reason=${json(cLock.reason)})`);
  assertEq(cSafe.isLocked, false, `SAFE fixture isLocked`);
  assertEq(cSafe.path, safePath, 'classify must preserve path');

  // .lock suffix and auth/config/token names are LOCKED too
  for (const name of ['worker.pid.lock', 'auth.json', 'credentials.json']) {
    const p = path.join(fixtureDir, name);
    fs.writeFileSync(p, 'q');
    const c = classifier.classify(mkCandidate(p, 1), { cfg, tree: treeStub });
    assertEq(c.category, CATEGORY.LOCKED, `rule LOCKED for ${name} (reason=${json(c.reason)})`);
  }
  return `safe=${cSafe.category} caution=${cCau.category} locked=${cLock.category}`;
});

await check('classifier.isProtectedPath', async () => {
  assertEq(classifier.isProtectedPath('C:\\Windows\\notepad.exe', cfg.protectRoots), true, "isProtectedPath('C:\\Windows\\notepad.exe')");
  const positives = [
    'C:\\Windows\\System32\\kernel32.dll',
    'C:\\Windows\\Temp\\x.txt',
    'C:\\Program Files\\Some App\\a.exe',
    'C:\\Program Files (x86)\\Some App\\a.exe',
    path.join(process.env.USERPROFILE, 'Desktop', 'a.txt'),
    path.join(process.env.USERPROFILE, 'Documents', 'a.txt'),
  ];
  for (const p of positives) {
    assertEq(classifier.isProtectedPath(p, cfg.protectRoots), true, `isProtectedPath(${json(p)})`);
  }
  const negatives = [path.join(fixtureDir, 'a.txt'), path.join(process.env.LOCALAPPDATA, 'x', 'a.txt')];
  for (const p of negatives) {
    assertEq(classifier.isProtectedPath(p, cfg.protectRoots), false, `isProtectedPath(${json(p)}) [false positive]`);
  }
  // isLocked on a missing path must be locked:false (CONTRACTS §7)
  const m = classifier.isLocked(path.join(fixtureDir, 'no-such-file-' + STAMP));
  assertEq(m.locked, false, `isLocked(missing).locked`);
  return 'all positives true, negatives false, ENOENT -> locked:false';
});

// REGRESSION GUARD (lead directive): the fix for the spelling-bypass defects must NOT
// over-block. A sibling directory that merely PREFIXES a protectRoot is NOT protected.
await check('classifier.no-over-blocking', async () => {
  const siblings = [
    'C:\\WindowsApps\\evil.dll',
    'C:\\Windows-old\\x.txt',
    'C:\\Windows.old\\x.txt',
    'C:\\Program Files (x86)Extra\\a.txt',
    'C:\\Program Files Extra\\x.txt',
    'C:\\ProgramData-backup\\a.txt',
  ];
  for (const p of siblings) {
    assertEq(classifier.isProtectedPath(p, cfg.protectRoots), false, `isProtectedPath(${json(p)}) [must NOT be protected: sibling-prefix over-blocking]`);
  }
  // and the real roots must still be protected (no under-blocking regression)
  for (const p of ['C:\\WindowsApps\\..\\Windows\\notepad.exe', 'C:\\Windows\\System32\\cmd.exe']) {
    assertEq(classifier.isProtectedPath(p, cfg.protectRoots), true, `isProtectedPath(${json(p)}) [must stay protected]`);
  }
  // A memoized/reparse canonicalisation stage could over-block near-miss siblings; assert the
  // property on REAL existing directories too, not just on synthetic strings (lead item 3).
  for (const real of ['C:\\WindowsApps', 'C:\\Windows.old', 'C:\\Windows-old']) {
    if (!fs.existsSync(real)) continue;
    assertEq(classifier.isProtectedPath(path.join(real, 'probe.tmp'), cfg.protectRoots), false, `isProtectedPath(${json(real + '\\probe.tmp')}) [existing non-protected dir must stay unprotected]`);
  }
  return `sibling-prefix paths NOT protected (${siblings.length}); real roots still protected`;
});

// ══════════════════════════════════════════════════════════════════════════
// 11/12. STATE DB (CONTRACTS §9, PRD §5)
// ══════════════════════════════════════════════════════════════════════════
const PRD_COLUMNS = ['id', 'file_path', 'file_size', 'category', 'is_locked', 'locked_by_pid', 'source_process', 'created_at', 'last_checked_at'];
let db = null;
let dbPath = null;

await check('statedb.migrate-idempotent', async () => {
  const m = await load('lib/state-db.js');
  assert(typeof m.StateDB === 'function', 'StateDB is not a class/constructor');
  dbPath = path.join(probeRoot, 'state.db');
  db = new m.StateDB(dbPath);
  db.migrate();
  db.migrate(); // must not throw
  const r = spawnSync(process.execPath, ['-e', `
    const {DatabaseSync}=require('node:sqlite');
    const d=new DatabaseSync(${JSON.stringify(dbPath)});
    console.log(JSON.stringify(d.prepare("select name from sqlite_master where type='table'").all().map(r=>r.name)));
    console.log(JSON.stringify(d.prepare("select sql from sqlite_master where name='tracked_files'").get()));
  `], { encoding: 'utf8' });
  assertEq(r.status, 0, `sqlite probe failed: ${(r.stderr || '').trim()}`);
  const [tablesLine, sqlLine] = r.stdout.trim().split('\n');
  const tables = JSON.parse(tablesLine);
  assert(tables.includes('tracked_files'), `table tracked_files missing; tables=${tablesLine}`);
  const sql = String(JSON.parse(sqlLine)?.sql || '').toLowerCase();
  for (const col of PRD_COLUMNS) assert(sql.includes(col), `PRD §5 CREATE TABLE lacks column ${col}`);
  return `tables=${tablesLine} (migrate() x2 idempotent)`;
});

await check('statedb.upsert-summary-list', async () => {
  assert(db, 'db not open');
  const rows = [
    mkClassified('C:\\Users\\x\\AppData\\Local\\Temp\\a.tmp', 100, CATEGORY.SAFE),
    mkClassified('C:\\Users\\x\\AppData\\Local\\npm\\b.bin', 2048, CATEGORY.CAUTION),
    mkClassified('C:\\Users\\x\\AppData\\Local\\Temp\\c.sqlite', 4096, CATEGORY.LOCKED, { isLocked: true, lockedByPid: 4242, lockedByProcess: 'python.exe' }),
  ];
  rows.forEach((r) => db.upsert(r));
  db.upsertMany([mkClassified('C:\\Users\\x\\AppData\\Local\\Temp\\d.log', 8192, CATEGORY.SAFE)]);
  db.upsertMany([mkClassified('C:\\Users\\x\\AppData\\Local\\Temp\\a.tmp', 150, CATEGORY.SAFE)]); // idempotent re-upsert by file_path

  const s = db.summary();
  assertEq(s.SAFE.count, 2, 'summary().SAFE.count');
  assertEq(s.SAFE.bytes, 150 + 8192, 'summary().SAFE.bytes');
  assertEq(s.CAUTION.count, 1, 'summary().CAUTION.count');
  assertEq(s.CAUTION.bytes, 2048, 'summary().CAUTION.bytes');
  assertEq(s.LOCKED.count, 1, 'summary().LOCKED.count');
  assertEq(s.LOCKED.bytes, 4096, 'summary().LOCKED.bytes');
  assertEq(s.total.count, 4, 'summary().total.count (upsert must key on file_path)');
  assertEq(s.total.bytes, 150 + 8192 + 2048 + 4096, 'summary().total.bytes');

  const all = db.list();
  assertEq(all.length, 4, 'list().length');
  for (const col of PRD_COLUMNS) assert(col in all[0], `TrackedRow lacks PRD §5 column ${col} -> ${json(Object.keys(all[0]))}`);
  const extra = Object.keys(all[0]).filter((k) => !PRD_COLUMNS.includes(k));
  if (extra.length) notes.push(`TrackedRow has extra columns beyond PRD §5: ${json(extra)}`);

  const safeOnly = db.list({ category: CATEGORY.SAFE });
  assertEq(safeOnly.length, 2, 'list({category:SAFE}).length');
  assert(safeOnly.every((r) => r.category === CATEGORY.SAFE), `list({category}) leaked other categories: ${json(safeOnly.map((r) => r.category))}`);
  const lockedOnly = db.list({ category: CATEGORY.LOCKED });
  assertEq(lockedOnly.length, 1, 'list({category:LOCKED}).length');
  assertEq(lockedOnly[0].locked_by_pid, 4242, 'locked_by_pid round-trip');
  assertEq(lockedOnly[0].source_process, 'verifier-probe', 'source_process round-trip');
  assertEq(db.list({ limit: 2 }).length, 2, 'list({limit:2}).length');

  const row = db.list().find((r) => r.file_path.endsWith('a.tmp'));
  assertEq(row.file_size, 150, 're-upsert must update file_size');
  assertEq(db.removeByPath([row.file_path]), 1, 'removeByPath return value');
  assertEq(db.list().length, 3, 'list() after removeByPath');
  return `summary=${json(s)} rows=4 list-filters ok`;
});

db?.close();

// ══════════════════════════════════════════════════════════════════════════
// 13-16. CLEANER (CONTRACTS §8, PRD §3.4 / §6.3)
// ══════════════════════════════════════════════════════════════════════════
let cleaner = null;
const cleanLog = { lines: [], debug(m) { this.lines.push('debug ' + m); }, info(m) { this.lines.push('info ' + m); }, warn(m) { this.lines.push('warn ' + m); }, error(m) { this.lines.push('error ' + m); } };

await check('cleaner.locked-file-skip', async () => {
  // ★ LOAD-BEARING (PRD §6.3): a live exclusive handle must never abort the sweep.
  cleaner = await load('lib/cleaner.js');
  assert(typeof cleaner.clean === 'function', 'clean is not a function');

  const dir = mkdirp(path.join(fixtureDir, 'locked_case'));
  const fileA = path.join(dir, 'A-locked.tmp');
  const fileB = path.join(dir, 'B-free.tmp');
  fs.writeFileSync(fileA, 'A'.repeat(1024));
  fs.writeFileSync(fileB, 'B'.repeat(2048));

  const locker = spawnLocker(fileA);
  const ready = await waitFor(() => fs.existsSync(locker.ready), 15000, 100);
  if (!ready) {
    locker.child.kill();
    throw new Error(`FIXTURE ERROR: locker never signalled ready (${json(locker.ready)}); stderr=${json(locker.errText().slice(0, 300))}`);
  }
  let probeOpen = 'opened (NOT locked)';
  try { const fd = fs.openSync(fileA, 'r+'); fs.closeSync(fd); } catch (e) { probeOpen = `threw ${e.code}`; }
  assert(probeOpen.startsWith('threw'), `FIXTURE ERROR: exclusive handle did not take effect (openSync r+ ${probeOpen})`);

  const cA = classifier.classify(mkCandidate(fileA, 1024), { cfg, tree: treeStub });
  const cB = classifier.classify(mkCandidate(fileB, 2048), { cfg, tree: treeStub });
  assertEq(cA.isLocked, true, `classify(A).isLocked must be true while A is held (category=${cA.category})`);

  let report = null;
  try {
    report = await cleaner.clean([cA, cB], { deep: false, force: true, cfg, log: cleanLog });
  } catch (e) {
    locker.child.kill();
    throw new Error(`clean() THREW on a locked file (PRD §6.3 violation): ${e.code || ''} ${e.message}`);
  }

  try {
    assert(report && typeof report === 'object', 'clean() returned non-object');
    for (const k of ['removed', 'skipped', 'bytesFreed', 'errors', 'skippedList']) {
      assert(k in report, `CleanupReport lacks field ${k} -> ${json(Object.keys(report))}`);
    }
    assertEq(fs.existsSync(fileB), false, 'unlocked file B must be deleted');
    assertEq(fs.existsSync(fileA), true, 'locked file A must survive');
    assert(report.skipped >= 1, `report.skipped must be >=1, got ${report.skipped}`);
    const inSkipped = (report.skippedList || []).some((s) => norm(s.path) === norm(fileA));
    assert(inSkipped, `A not in skippedList: ${json(report.skippedList)}`);
    assert(report.removed >= 1, `report.removed must be >=1, got ${report.removed}`);
    assertEq(report.bytesFreed, 2048, 'bytesFreed must count only the removed file');
    return `A held by pid ${locker.child.pid} (openSync r+ ${probeOpen}) -> kept+skipped; B removed; report=${json(report)}`;
  } finally {
    locker.child.kill();
    await waitFor(() => { try { fs.rmSync(fileA); return true; } catch { return false; } }, 10000, 200);
  }
});

await check('cleaner.recyclebin-default', async () => {
  // PRD §3.4 default path: no --force => recycle bin (PowerShell VB FileSystem).
  const p = path.join(fixtureDir, 'recycle-me.log');
  fs.writeFileSync(p, 'R'.repeat(512));
  const rec = mkClassified(p, 512, CATEGORY.SAFE);
  let report;
  try {
    report = await cleaner.clean([rec], { deep: false, force: false, cfg, log: cleanLog });
  } catch (e) {
    throw new Error(`clean({force:false}) THREW: ${e.code || ''} ${e.message}`);
  }
  assertEq(fs.existsSync(p), false, `file still present after recycle-bin clean; report=${json(report)}`);
  assertEq(report.bytesFreed, 512, 'bytesFreed');
  return `recycle-bin delete ok; report=${json(report)}`;
});

await check('cleaner.never-deletes-locked-critical', async () => {
  // PRD §3.3 🔴 严禁删除 — even with deep+force.
  const p = path.join(fixtureDir, 'keep-me.sqlite3');
  fs.writeFileSync(p, 'K'.repeat(64));
  const rec = classifier.classify(mkCandidate(p, 64), { cfg, tree: treeStub });
  assertEq(rec.category, CATEGORY.LOCKED, 'fixture must classify LOCKED');
  const report = await cleaner.clean([rec], { deep: true, force: true, cfg, log: cleanLog });
  assertEq(fs.existsSync(p), true, `LOCKED_CRITICAL file was DELETED (PRD §3.3 violation); report=${json(report)}`);
  assertEq(report.removed, 0, 'report.removed for a locked record');
  return `kept; report=${json(report)}`;
});

await check('cleaner.instant-revalidation', async () => {
  // PRD §3.4: 瞬时二次校验 — a file locked AFTER classify must be skipped, not crashed on.
  const p = path.join(fixtureDir, 'sneaky-lock.tmp');
  fs.writeFileSync(p, 'S'.repeat(256));
  const rec = classifier.classify(mkCandidate(p, 256), { cfg, tree: treeStub });
  assertEq(rec.category, CATEGORY.SAFE, 'fixture must classify SAFE');
  assertEq(rec.isLocked, false, 'fixture must start unlocked');

  const locker = spawnLocker(p);
  const ready = await waitFor(() => fs.existsSync(locker.ready), 15000, 100);
  if (!ready) { locker.child.kill(); throw new Error('FIXTURE ERROR: second locker never signalled ready'); }
  try {
    let report;
    try {
      report = await cleaner.clean([rec], { deep: false, force: true, cfg, log: cleanLog });
    } catch (e) {
      throw new Error(`clean() THREW on a file locked between classify and delete: ${e.code || ''} ${e.message}`);
    }
    assertEq(fs.existsSync(p), true, `file locked after classify was still deleted; report=${json(report)}`);
    assert(report.skipped >= 1, `re-validation did not skip: report=${json(report)}`);
    return `re-locked between classify and clean -> skipped; report=${json(report)}`;
  } finally {
    locker.child.kill();
    await waitFor(() => { try { fs.rmSync(p); return true; } catch { return false; } }, 10000, 200);
  }
});

await check('cleaner.recyclebin-recoverable', async () => {
  // PRD §3.4 says the DEFAULT is 移入回收站 — i.e. RECOVERABLE, not merely "gone from disk".
  // The weaker assertion (existsSync === false) cannot tell a recycle-bin delete from a
  // physical unlink, so this check enumerates the shell recycle bin before/after.
  const B = path.sep;
  const psList = '$sh=New-Object -ComObject Shell.Application; $sh.NameSpace(10).Items() | ForEach-Object { $_.Name + "|" + $_.Size }';
  const binList = () => {
    try {
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psList], { encoding: 'utf8', timeout: 90000 })
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch { return null; }
  };

  const p = path.join(fixtureDir, `recoverable-${STAMP}.tmp`);
  const payload = 'Q'.repeat(777);
  fs.writeFileSync(p, payload);
  const size = fs.statSync(p).size;

  const before = binList();
  if (before === null) return `SKIPPED: could not enumerate the shell recycle bin; ${json(binList())}`;

  const rec = mkClassified(p, size, CATEGORY.SAFE);
  const report = await cleaner.clean([rec], { deep: false, force: false, cfg, log: cleanLog });
  assertEq(fs.existsSync(p), false, `file still present after recycle-bin clean; report=${json(report)}`);
  await new Promise((r) => setTimeout(r, 900));

  const after = binList() || [];
  const added = after.filter((x) => !before.includes(x));
  const stem = path.basename(p, '.tmp').toLowerCase();
  const inBin = after.some((x) => x.toLowerCase().includes(stem));
  assert(inBin, `file was removed from disk but NOT found in the recycle bin (PRD §3.4 default must be recoverable); new bin entries=${json(added)}`);
  return `recoverable: bin entries ${before.length} -> ${after.length}; added=${json(added)}`;
});

await check('cleaner.category-gate', async () => {
  // PRD §3.3/§4: SAFE deleted by default, CAUTION only with --deep, LOCKED NEVER ("锁定置灰"),
  // and a malformed/forged category must FAIL CLOSED (refuse), not delete.
  const trials = [
    ['SAFE default', CATEGORY.SAFE, {}, true],
    ['SAFE deep', CATEGORY.SAFE, { deep: true }, true],
    ['CAUTION default', CATEGORY.CAUTION, {}, false],
    ['CAUTION deep', CATEGORY.CAUTION, { deep: true }, true],
    ['LOCKED default', CATEGORY.LOCKED, {}, false],
    ['LOCKED deep', CATEGORY.LOCKED, { deep: true }, false],
    ['LOCKED force', CATEGORY.LOCKED, { force: true }, false],
    ['LOCKED deep+force', CATEGORY.LOCKED, { deep: true, force: true }, false],
    ['undefined category', undefined, { deep: true, force: true }, false],
    ['null category', null, { deep: true, force: true }, false],
    ['empty-string category', '', { deep: true, force: true }, false],
    ['garbage category', 'GARBAGE', { deep: true, force: true }, false],
    ['wrong-case category', 'safe_to_delete', { deep: true, force: true }, false],
  ];
  const wrong = [];
  const seen = [];
  for (const [label, category, opts, expectDeleted] of trials) {
    const p = path.join(fixtureDir, `gate-${label.replace(/[^a-z0-9]+/gi, '_')}-${STAMP}.tmp`);
    fs.writeFileSync(p, 'G'.repeat(32));
    const report = await cleaner.clean([{ path: p, category, size: 32 }], { ...opts, cfg, log: cleanLog });
    const deleted = !fs.existsSync(p);
    seen.push(`${label}: deleted=${deleted}`);
    if (deleted !== expectDeleted) {
      wrong.push(`${label}: deleted=${deleted}, expected ${expectDeleted} (report=${json(report)})`);
    }
    try { fs.rmSync(p, { force: true }); } catch {}
  }
  assert(wrong.length === 0, `category gate wrong for: ${wrong.join(' | ')}`);
  return `SAFE always deleted; CAUTION only with --deep; LOCKED never at any flag; malformed fails closed (13 trials)`;
});

await check('classifier.junction-guard', async () => {
  // PRD §6.2 (绝对拒绝): a directory that IS a junction into a protectRoot must not let a
  // file physically inside that protectRoot be deleted. This is the defect found in review
  // (classifier.js canonical() used to realpath only when the string contained '~').
  // Skips cleanly if junctions cannot be created or C:\Windows\Temp is not writable.
  const B = path.sep;
  const holder = path.join(fixtureDir, `juncguard-${STAMP}`);
  const link = path.join(holder, 'innocent-cache');
  const realDir = 'C:' + B + 'Windows' + B + 'Temp';
  try { fs.mkdirSync(holder, { recursive: true }); }
  catch { return 'SKIPPED: could not create the holder directory'; }

  const victimReal = path.join(realDir, `dshcc_jg_victim_${STAMP}.log`);
  try { fs.writeFileSync(victimReal, 'J'.repeat(48)); }
  catch (e) { return `SKIPPED: C:\\Windows\\Temp not writable (${e.code})`; }
  cleanupFns.push(() => { try { fs.rmSync(victimReal, { force: true }); } catch {} });

  const made = spawnSync('cmd.exe', ['/c', 'mklink', '/J', link, realDir], { encoding: 'utf8' });
  let isJunction = false;
  try { isJunction = fs.realpathSync.native(link).toLowerCase() === fs.realpathSync.native(realDir).toLowerCase(); } catch {}
  if (!isJunction) {
    return `SKIPPED: mklink /J unavailable (${(made.stderr || made.stdout || '').trim().split('\n')[0]})`;
  }
  cleanupFns.push(() => { try { fs.rmSync(holder, { recursive: true, force: true }); } catch {} });

  const viaJunction = path.join(link, path.basename(victimReal));
  assertEq(fs.existsSync(viaJunction), true, 'the junction-spelled path should resolve to the victim');
  assertEq(classifier.isProtectedPath(viaJunction, cfg.protectRoots), true,
    'isProtectedPath must resolve the junction and recognise the protectRoot');

  const report = await cleaner.clean([{ path: viaJunction, category: CATEGORY.SAFE, size: 48 }], { deep: true, force: true, cfg, log: cleanLog });
  assertEq(fs.existsSync(victimReal), true, `PRD §6.2 VIOLATION: a file physically inside C:\\Windows\\Temp was deleted via a junction; report=${json(report)}`);
  assertEq(report.removed, 0, 'report.removed for a junction-spelled protected file');
  return `junction resolved and refused; victim survives; report=${json({ removed: report.removed, skipped: report.skipped, skippedList: report.skippedList })}`;
});

// adversarial: a vanished file must not throw and must not be counted as removed
await probe('cleaner.file-vanished-before-clean', () => {
  const p = path.join(fixtureDir, `ghost-${STAMP}.tmp`);
  const rec = mkClassified(p, 999, CATEGORY.SAFE);
  return cleaner.clean([rec], { deep: false, force: true, cfg, log: cleanLog }).then(
    (r) => ({ verdict: r.removed === 0 ? 'no-throw, removed=0 (correct)' : `no-throw but removed=${r.removed} for a nonexistent file`, data: json(r), prdViolation: false }),
    (e) => ({ verdict: 'THREW', data: `${e.code || ''} ${e.message}`, prdViolation: true }),
  );
});

// adversarial: empty record set
await probe('cleaner.empty-record-set', () => cleaner.clean([], { deep: true, force: true, cfg, log: cleanLog }).then(
  (r) => ({
    verdict: (r.removed === 0 && r.skipped === 0 && r.bytesFreed === 0 && Array.isArray(r.errors)) ? 'clean zeros (correct)' : 'non-zero report for empty input',
    data: json(r), prdViolation: false,
  }),
  (e) => ({ verdict: 'THREW on empty input', data: `${e.code || ''} ${e.message}`, prdViolation: true }),
));

// ══════════════════════════════════════════════════════════════════════════
// 17/18. PROCESS TREE (CONTRACTS §5)
// ══════════════════════════════════════════════════════════════════════════
let tree = null;

await check('proctree.refresh-pids', async () => {
  const m = await load('lib/process-tree.js');
  assert(typeof m.ProcessTree === 'function', 'ProcessTree is not a class/constructor');
  tree = new m.ProcessTree({ rootPid: process.pid, pollIntervalMs: 1000, log: silentLog });
  const r = await tree.refresh();
  assert(r && typeof r.count === 'number', `refresh() must resolve {count,total}; got ${json(r)}`);
  const pids = tree.pids();
  assert(pids instanceof Set, `pids() must return a Set; got ${json(pids)}`);
  assertEq(pids.has(process.pid), true, `pids() must contain process.pid ${process.pid}`);
  assertEq(tree.isTreeMember(process.pid), true, 'isTreeMember(process.pid)');
  const name = tree.nameOf(process.pid);
  assert(typeof name === 'string' && name.length > 0, `nameOf(process.pid) must be non-empty; got ${json(name)}`);
  const snap = tree.snapshot();
  assert(Array.isArray(snap) && snap.length > 0, `snapshot() must be a non-empty array; got ${json(snap && snap.length)}`);
  assert('pid' in snap[0] && 'ppid' in snap[0] && 'name' in snap[0], `snapshot row shape: ${json(snap[0])}`);
  tree.start();
  await new Promise((r2) => setTimeout(r2, 250));
  tree.stop();
  return `count=${r.count} total=${r.total} name=${json(name)} snapshot=${snap.length}`;
});

await check('proctree.ownerOf-best-effort', async () => {
  assert(tree, 'tree not built');
  const p = path.join(fixtureDir, 'owner-probe.txt');
  fs.writeFileSync(p, 'o');
  let res;
  try {
    res = await tree.ownerOf(p);
  } catch (e) {
    throw new Error(`ownerOf() threw (CONTRACTS §5: never throw): ${e.code || ''} ${e.message}`);
  }
  assert(res === null || (typeof res === 'object' && typeof res.pid === 'number' && typeof res.name === 'string'),
    `ownerOf() must return null or {pid,name}; got ${json(res)}`);
  const missing = await tree.ownerOf(path.join(fixtureDir, 'definitely-missing-' + STAMP));
  assertEq(missing, null, 'ownerOf(missing file)');
  return `ownerOf(file)=${json(res)} ownerOf(missing)=null`;
});

// ══════════════════════════════════════════════════════════════════════════
// 19-21. WATCHER (CONTRACTS §6, PRD §3.2)
// ══════════════════════════════════════════════════════════════════════════
await check('watcher.fires-candidate', async () => {
  const m = await load('lib/watcher.js');
  assert(typeof m.CWatcher === 'function', 'CWatcher is not a class/constructor');
  const watchDir = mkdirp(path.join(tempDir, `dshcc_probe_${STAMP}`, 'watch'));
  const hits = [];
  const wcfg = { ...cfg, debounceMs: 300, watchDirs: [{ path: watchDir, recursive: true, maxDepth: 8 }], protectRoots: cfg.protectRoots };
  const w = new m.CWatcher({ cfg: wcfg, tree: treeStub, log: silentLog, onCandidate: (c) => hits.push(c) });
  try {
    const started = w.start();
    assert(started && Array.isArray(started.watching), `start() must return {watching:string[]}; got ${json(started)}`);
    await new Promise((r) => setTimeout(r, 400)); // let fs.watch attach
    const f = path.join(watchDir, `pip-probe-${STAMP}.log`);
    fs.writeFileSync(f, 'candidate');
    const fired = await waitFor(() => hits.length > 0, 8000, 100);
    assert(fired, `onCandidate never fired for ${f} within 8s (stat=${json(w.stats())})`);
    const h = hits.find((c) => norm(c.path) === norm(f));
    assert(h, `onCandidate fired for a different path: ${json(hits.map((c) => c.path))}`);
    for (const k of ['path', 'size', 'mtimeMs', 'sourceProcess']) assert(k in h, `Candidate lacks ${k}: ${json(h)}`);
    const st = w.stats();
    assert(st.candidates > 0, `stats().candidates must be >0; got ${json(st)}`);
    assert(st.events > 0, `stats().events must be >0; got ${json(st)}`);
    assert(st.watching.some((p) => norm(p) === norm(watchDir)), `stats().watching lacks ${watchDir}: ${json(st.watching)}`);
    return `hit ${json(h)}; stats=${json(st)}`;
  } finally {
    w.stop();
  }
});

await check('watcher.protectroot-silent', async () => {
  // PRD §6.2 belt-and-braces: a file under a protectRoot must never be emitted,
  // even when that directory is explicitly watched with the REAL protectRoots.
  // NOTE: C:\Windows\Temp cannot be watched by a non-elevated process
  // (fs.watch -> EPERM), so we use cfg.escapeRoot — a genuine entry of the
  // production protectRoots as resolved by resolveConfig (see config.defaults).
  const m = await load('lib/watcher.js');
  const rootsHittingEscapeRoot = cfg.protectRoots.filter((r) => norm(r) === norm(cfg.escapeRoot));
  assertEq(rootsHittingEscapeRoot.length, 1, `escapeRoot must itself be a protectRoot for this check to be meaningful; protectRoots=${json(cfg.protectRoots)}`);
  const watchDir = mkdirp(path.join(cfg.escapeRoot, `dshcc_probe_${STAMP}`));
  assert(isUnderAny(watchDir, cfg.protectRoots), `${watchDir} is not under any protectRoot — check would be void`);
  const hits = [];
  const wcfg = { ...cfg, debounceMs: 300, watchDirs: [{ path: watchDir, recursive: false, maxDepth: 1 }] };
  const w = new m.CWatcher({ cfg: wcfg, tree: treeStub, log: silentLog, onCandidate: (c) => hits.push(c) });
  const f = path.join(watchDir, `dshcc_probe_${STAMP}.log`);
  try {
    w.start();
    await new Promise((r) => setTimeout(r, 400));
    fs.writeFileSync(f, 'must not be reported');
    await new Promise((r) => setTimeout(r, 2500));
    assertEq(hits.length, 0, `watcher emitted ${json(hits.map((c) => c.path))} under protectRoot ${cfg.escapeRoot}`);
    const st = w.stats();
    assert(st.filtered >= 1, `stats().filtered must count the dropped protected file; got ${json(st)}`);
    assertEq(st.candidates, 0, `stats().candidates must stay 0; got ${json(st)}`);
    return `watched ${watchDir} (a real protectRoot); no emission; stats=${json(st)}`;
  } finally {
    w.stop();
    rmrf(watchDir);
  }
});

// PRD §6.3 graceful degradation: an unwatchable watchDir must not throw.
await check('watcher.unwatchable-dir-degrades', async () => {
  const m = await load('lib/watcher.js');
  const wcfg = { ...cfg, debounceMs: 300, watchDirs: [{ path: 'C:\\Windows\\Temp', recursive: false, maxDepth: 1 }] };
  const w = new m.CWatcher({ cfg: wcfg, tree: treeStub, log: silentLog, onCandidate: () => { throw new Error('emitted from a protectRoot'); } });
  try {
    let started;
    try {
      started = w.start();
    } catch (e) {
      throw new Error(`start() THREW on an unwatchable dir; PRD §6.3 wants graceful degradation: ${e.code || ''} ${e.message}`);
    }
    assert(started && Array.isArray(started.watching), `start() return shape: ${json(started)}`);
    const st = w.stats();
    assert(Array.isArray(st.failedList), `stats().failedList missing: ${json(st)}`);
    return `C:\\Windows\\Temp unwatchable here -> start() did not throw; failedList=${json(st.failedList)}`;
  } finally {
    w.stop();
  }
});

// PRD §3/§4: the plugin's only user-facing surface — the `c-clean` command.
// Asserts registration shape, that every documented verb returns a well-formed result,
// that unknown input is rejected WITHOUT throwing (PRD §6.3), and that a failing
// deps.collect() surfaces as an error result rather than an exception.
await check('commands.register-and-handlers', async () => {
  const m = await load('lib/commands.js');
  const register = m.registerCommands ?? m.default;
  assert(typeof register === 'function', 'registerCommands is not exported as a function');

  let registered = null;
  let disposed = 0;
  const fakeCtx = {
    commands: {
      register(spec) {
        registered = spec;
        return () => { disposed++; };
      },
    },
  };

  const collectRows = [];
  const fakeDb = {
    summary: () => ({ SAFE: { count: 0, bytes: 0 }, CAUTION: { count: 0, bytes: 0 }, LOCKED: { count: 0, bytes: 0 }, total: { count: 0, bytes: 0 } }),
  };
  const disposer = register(fakeCtx, {
    cfg,
    log: silentLog,
    refresh: async () => {},
    collect: async () => collectRows,
    db: fakeDb,
    // commands.js:173 calls `deps.hijacker.status()` — it must be a FUNCTION, not a plain object.
    hijacker: { status: () => ({ installed: true, escapeRoot: cfg.escapeRoot, entries: [{ ok: true }, { ok: true }] }) },
  });
  assert(typeof disposer === 'function', 'registerCommands must return a disposer');
  assert(registered && registered.name === 'c-clean', `registered command name: ${json(registered?.name)}`);
  assert(typeof registered.handler === 'function', 'registered spec has no handler');
  assert(typeof registered.description === 'string' && registered.description.length > 0, 'registered spec has no description');
  assert(registered.input && typeof registered.input.hint === 'string', `registered spec has no input.hint: ${json(registered?.input)}`);

  // status: must report the hijack state without throwing.
  const st = await registered.handler({ rawInput: 'status' });
  assert(st && typeof st.kind === 'string' && typeof st.text === 'string', `status result shape: ${json(st)}`);
  assert(st.kind === 'success', `status kind should be success, got ${json(st.kind)}: ${st.text}`);
  assert(st.text.includes(cfg.escapeRoot), `status text should name the escape root: ${st.text}`);

  // now: with an empty record set -> success, zeros, never throws (PRD §6.3).
  const n0 = await registered.handler({ rawInput: 'now' });
  assert(n0 && n0.kind === 'success', `'now' with no records: ${json(n0)}`);
  assert(/已删除: 0/.test(n0.text), `'now' with no records should report 0 deleted: ${n0.text}`);

  // now --force --deep: must be accepted and reach clean().
  const nf = await registered.handler({ rawInput: 'now --force --deep' });
  assert(nf && nf.kind === 'success', `'now --force --deep': ${json(nf)}`);

  // unknown args: rejected as an error RESULT, not an exception.
  let threw = null;
  let bad = null;
  try { bad = await registered.handler({ rawInput: 'now --nonsense' }); } catch (e) { threw = `${e.code || ''} ${e.message}`; }
  assert(!threw, `unknown args THREW instead of returning an error result (PRD §6.3): ${threw}`);
  assert(bad && bad.kind === 'error', `unknown args should be kind=error: ${json(bad)}`);

  // a failing collect(): must degrade to an error result, not throw.
  const failing = register({ commands: { register: (s) => { registered = s; return () => {}; } } }, {
    cfg, log: silentLog, refresh: async () => {}, collect: async () => { throw new Error('collect boom'); }, db: fakeDb,
  });
  let threw2 = null;
  let res2 = null;
  try { res2 = await registered.handler({ rawInput: 'now' }); } catch (e) { threw2 = `${e.code || ''} ${e.message}`; }
  assert(!threw2, `a failing collect() THREW out of the handler (PRD §6.3): ${threw2}`);
  assert(res2 && res2.kind === 'error', `a failing collect() should yield kind=error: ${json(res2)}`);
  void failing;

  disposer();
  assert(disposed === 1, `disposer should have been called once, got ${disposed}`);

  return 'c-clean registers (name/description/hint/handler); status+now+--force+--deep ok; unknown args and a throwing collect() degrade to error results without throwing';
});

// PRD §5 / CONTRACTS §5: `locked_by_pid` must be filled from a REAL holder, and a multi-path
// batch must be answered PATH BY PATH.
//
// This is the permanent regression guard for a defect found in rev3: the PowerShell launcher
// parsed the JSON path array with `@($env:CC_RM_PATHS | ConvertFrom-Json)`, which on PowerShell
// 5.1 collapses an array into ONE space-joined string. Restart Manager was then asked about a
// nonexistent combined filename and returned `ERR|RmGetList|6` for EVERY path, so a batch produced
// no owner for anything. The signature of that bug is a MISSING MAP KEY ("we could not ask"), as
// distinct from a `null` value ("we asked, nobody holds it"), so key PRESENCE is the assertion.
//
// Production reaches the batch path: index.js calls `resolve([record.path])` one path at a time,
// but resolve() queues and flushes after batchWindowMs, so locked rows found in one window share a
// single PowerShell spawn (asserted below via stats().spawns).
await check('lockowner.batch-every-path-answered', async () => {
  const m = await load('lib/lock-owner.js');
  const Resolver = m.LockOwnerResolver ?? m.default;
  assert(typeof Resolver === 'function', `LockOwnerResolver is not exported as a function: ${json(Object.keys(m))}`);

  const dir = mkdirp(path.join(probeRoot, 'batch'));
  const files = ['a', 'b', 'c'].map((n) => path.join(dir, `held-${n}.tmp`));
  const lockers = [];
  for (const f of files) {
    fs.writeFileSync(f, 'B'.repeat(48));
    lockers.push({ f, locker: spawnLocker(f) });
  }
  const readyMs = 25000;
  for (const { f, locker } of lockers) {
    const ok = await waitFor(() => fs.existsSync(locker.ready), readyMs, 200);
    assert(ok, `could not take an exclusive handle on ${f} (stderr=${JSON.stringify(locker.errText().slice(0, 200))})`);
    // Confirm the handle really is exclusive before trusting any "held" claim.
    let code = null;
    try { const fd = fs.openSync(f, 'r+'); fs.closeSync(fd); } catch (e) { code = e.code; }
    assert(code, `${f} was NOT actually locked (openSync r+ succeeded), so the probe would be vacuous`);
  }
  const wantPid = new Map(lockers.map(({ f, locker }) => [f.toLowerCase(), locker.child.pid]));

  // --- (1) a 2-path batch: every path present AND each answered with its OWN holder -------------
  const r1 = new Resolver({ batchWindowMs: 60, timeoutMs: 20000 });
  let m1;
  try {
    m1 = await r1.resolve([files[0], files[1]]);
  } finally {
    r1.close();
  }
  assert(m1 instanceof Map, `resolve() must return a Map, got ${typeof m1}`);
  assert(m1.size === 2, `a 2-path batch must answer BOTH paths; got map size ${m1.size} (a missing key means "we could not ask" — the non-enumerating-parse bug)`);
  for (const f of files.slice(0, 2)) {
    assert(m1.has(f), `a 2-path batch dropped the key for ${f} — this is the missing-key signature of the JSON-array parse bug`);
    const o = m1.get(f);
    assert(o && Number(o.pid) === Number(wantPid.get(f.toLowerCase())),
      `${f} must report its OWN holder pid: got ${json(o)} want ${wantPid.get(f.toLowerCase())}`);
  }

  // --- (2) the production batching behaviour: queued calls inside one window share ONE spawn ---
  const r2 = new Resolver({ batchWindowMs: 250, timeoutMs: 20000 });
  let m2a;
  let m2b;
  let r2spawns = 0;
  try {
    [m2a, m2b] = await Promise.all([r2.resolve([files[0]]), r2.resolve([files[1]])]);
    r2spawns = r2.stats().spawns;
  } finally {
    r2.close();
  }
  assert(r2spawns === 1, `two resolve() calls inside one batch window must coalesce into ONE spawn (got ${r2spawns}) — this is the production path that made the bug reachable`);
  assert(m2a.has(files[0]) && m2b.has(files[1]), 'a coalesced flush must still answer every caller\'s path');

  // --- (3) >maxBatch paths: chunking must not drop keys ----------------------------------------
  const many = [files[0], files[1], files[2]];
  for (let i = 0; i < 27; i += 1) many.push(path.join(dir, `absent-${i}.tmp`));
  assert(many.length > 25, `the batch must exceed maxBatch=25 to exercise chunking (got ${many.length})`);
  const r3 = new Resolver({ batchWindowMs: 40, timeoutMs: 60000 });
  let m3;
  let spawns3;
  try {
    m3 = await r3.resolve(many);
    spawns3 = r3.stats().spawns;
  } finally {
    r3.close();
  }
  const missing = many.filter((p) => !m3.has(p));
  assert(spawns3 >= 2, `a ${many.length}-path batch must be split into more than one spawn (got ${spawns3})`);
  assert(missing.length === 0, `${missing.length}/${many.length} requested paths have NO key — the resolver could not answer them (first missing: ${missing[0]})`);
  for (const f of files) {
    const o = m3.get(f);
    assert(o && Number(o.pid) === Number(wantPid.get(f.toLowerCase())),
      `in a ${many.length}-path batch, ${f} must still report its OWN holder pid: got ${json(o)} want ${wantPid.get(f.toLowerCase())}`);
  }
  const absent = many.slice(3).map((p) => m3.get(p));
  assert(absent.every((v) => v === null), `a nonexistent path must answer null (a REAL answer), not be dropped; got ${json(absent.slice(0, 5))}`);

  return `2-path batch answered both with their own pids; 2 queued calls coalesced into ${r2spawns} spawn; ${many.length}-path batch -> ${spawns3} spawns, 0 missing keys, 3 held paths correct, absent paths null`;
});

// ══════════════════════════════════════════════════════════════════════════
// PHASE 3 — PRD §7 (a) `mklink /J` junction migration, (b) `post_session_close`
// ══════════════════════════════════════════════════════════════════════════
// The Phase 3 acceptance surface is exactly two features (PRD §7). Both are asserted against
// the PRODUCTION entry points (`inspectDirectory` / `migrateDirectory` / `undoMigration` /
// `findCandidates` / `installSessionHook`), never a reimplementation of them.
//
// Volume reality on this host: C: and E: are separate volumes and `fs.renameSync` between them
// throws EXDEV (probed). The module therefore has a copy+verify+delete path that ONLY runs
// cross-volume — a same-volume fixture would exercise the `rename` shortcut and prove nothing
// about the PRD's actual scenario. So the live fixture is created on the real C: volume,
// migrates to the escape root on E:, and is undone afterwards.

const MIG_SRC_ROOT = path.join(process.env.LOCALAPPDATA, 'Temp');
const MIG_TARGET_ROOT = path.join(cfg.escapeRoot, `mig_probe_${STAMP}`);
const migScratch = path.join(MIG_SRC_ROOT, `dshcc_mig_${STAMP}`);
const resolveConfig = (await load('lib/config.js')).resolveConfig;

function migCfg(over = {}) {
  return resolveConfig({ migrateTargetRoot: MIG_TARGET_ROOT, ...over }, process.env);
}

await check('migrate.inspect-gate-refusals', async () => {
  const m = await load('lib/symlink-migrate.js');
  assert(typeof m.inspectDirectory === 'function', 'inspectDirectory is not exported');
  assert(typeof m.targetRootOf === 'function', 'targetRootOf is not exported');
  assertEq(m.MIGRATION_STATE.LINKED, 'LINKED', 'MIGRATION_STATE.LINKED');

  const c = migCfg();
  assertEq(m.targetRootOf(c), MIG_TARGET_ROOT, 'targetRootOf honours an explicit migrateTargetRoot');

  mkdirp(migScratch);
  cleanupFns.push(() => rmrf(migScratch));

  // A real, eligible stubborn directory: files, nesting, enough components below the root.
  const good = path.join(migScratch, 'stubborn');
  mkdirp(path.join(good, 'nested'));
  fs.writeFileSync(path.join(good, 'a.bin'), 'a'.repeat(1024));
  fs.writeFileSync(path.join(good, 'nested', 'b.bin'), 'b'.repeat(2048));
  const goodPlan = m.inspectDirectory(good, c);
  assert(goodPlan.ok, `an ordinary C: directory must be migratable, got ${goodPlan.code}: ${goodPlan.reason}`);
  assertEq(goodPlan.bytes, 3072, 'inspectDirectory measured byte total');
  assertEq(goodPlan.files, 2, 'inspectDirectory measured file count');
  assert(under(goodPlan.target, MIG_TARGET_ROOT), `target ${json(goodPlan.target)} not under the target root`);

  // Every refusal the PRD depends on. Each answer must be a CODE, never a throw (PRD §6.3).
  const refusal = (p, want, useCfg = c) => {
    const v = m.inspectDirectory(p, useCfg);
    assert(v && v.ok === false, `inspectDirectory(${json(p)}) should refuse with ${want}, got ok=${v?.ok}`);
    assertEq(v.code, want, `inspectDirectory(${json(p)}) code`);
    return v;
  };

  refusal('', 'BAD_PATH');
  refusal(path.join(migScratch, 'does-not-exist'), 'MISSING');
  const plainFile = path.join(migScratch, 'plain.bin');
  fs.writeFileSync(plainFile, 'x');
  refusal(plainFile, 'NOT_A_DIRECTORY');                    // files are clean()'s business

  // PRD §6.2 hardcoded blacklist — migration relocates a whole tree, a stronger act than
  // deleting one file, so the same blacklist must bind it.
  refusal('C:\\Windows', 'PROTECTED');
  refusal('C:\\Program Files', 'PROTECTED');
  refusal('C:\\Windows\\Temp\\anything', 'PROTECTED');
  refusal(MIG_SRC_ROOT, 'PROTECTED');                       // a watch root itself
  refusal(cfg.escapeRoot, 'PROTECTED');                     // our own escape root
  refusal(MIG_TARGET_ROOT, 'PROTECTED');                    // the migration destination

  refusal('C:\\Temp', 'TOO_SHALLOW');                       // a typo may not relocate a system dir
  // An ancestor of a watch root: migrating it would hide every tracked file beneath it.
  refusal(process.env.LOCALAPPDATA, 'ANCESTOR_OF_WATCH_ROOT');
  // An ancestor of a protected path (USERPROFILE contains Desktop/Documents).
  refusal(process.env.USERPROFILE, 'ANCESTOR_OF_PROTECTED');

  // A junction is not a directory: lstat is the only call that sees the link.
  const link = path.join(migScratch, 'already-linked');
  fs.symlinkSync(good, link, 'junction');
  refusal(link, 'ALREADY_LOGGED');

  // A tree CONTAINING a junction cannot be copied: the copy would duplicate the target's bytes.
  const host = path.join(migScratch, 'has-reparse');
  mkdirp(host);
  fs.writeFileSync(path.join(host, 'real.bin'), 'r');
  fs.symlinkSync(good, path.join(host, 'inner-link'), 'junction');
  refusal(host, 'CONTAINS_REPARSE_POINTS');

  const emptyDir = path.join(migScratch, 'empty-dir');
  mkdirp(emptyDir);
  refusal(emptyDir, 'EMPTY');

  // Same volume: a "migration" on C: frees nothing and only adds indirection.
  refusal(good, 'SAME_VOLUME', migCfg({ migrateTargetRoot: path.join(MIG_SRC_ROOT, `same_${STAMP}`) }));

  // No derivable target root: refuse rather than guess.
  const noRoot = m.inspectDirectory(good, { ...c, escapeRoot: '', migrateTargetRoot: null });
  assert(noRoot.ok === false, 'a config with no target root must refuse');
  assertEq(noRoot.code, 'NO_TARGET_ROOT', 'no-target-root refusal code');

  return `12 refusal codes answered as codes, never throws; eligible dir measured ${goodPlan.files} files / ${goodPlan.bytes} B, target ${goodPlan.target}`;
});

await check('migrate.cross-volume-move-and-junction', async () => {
  const m = await load('lib/symlink-migrate.js');
  const dbm = await load('lib/state-db.js');
  const c = migCfg();

  const src = path.join(MIG_SRC_ROOT, `dshcc_mv_${STAMP}`);
  rmrf(src);
  mkdirp(path.join(src, 'deep', 'deeper'));
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(src, 'deep', 'deeper', `f${i}.bin`), Buffer.alloc(4096, i));
  fs.writeFileSync(path.join(src, 'top.txt'), 'top-level');
  cleanupFns.push(() => rmrf(src));

  const db = new dbm.StateDB(path.join(mkdirp(path.join(probeRoot, `migdb_${STAMP}`)), 'state.db'));
  cleanupFns.push(() => { try { db.close(); } catch {} });

  const before = m.walkTree(src);
  assertEq(before.reparsePoints.length, 0, 'the fixture contains no reparse points');

  // Assert the FACT the module is built around, so this check fails loudly if a future host or
  // Node version ever made the copy path unreachable.
  let renameCode = null;
  try { fs.renameSync(src, path.join(MIG_TARGET_ROOT, 'never')); } catch (e) { renameCode = e.code; }
  assertEq(renameCode, 'EXDEV', 'C: -> E: rename must fail with EXDEV (this is why copy+verify exists)');

  const result = await m.migrateDirectory(src, { cfg: c, log: silentLog, db });
  assert(result.ok, `migrateDirectory failed: ${result.code}: ${result.reason}`);
  assertEq(result.method, 'copy', 'the cross-volume move used copy+verify, not rename');
  assertEq(result.files, before.files, 'reported file count matches the pre-move measurement');
  assertEq(result.bytes, before.bytes, 'reported byte count matches the pre-move measurement');

  // 1. The junction is at the source path and is a reparse point.
  const st = fs.lstatSync(src);
  assert(st.isSymbolicLink(), 'the source path is now a junction (lstat.isSymbolicLink)');
  assert(fs.statSync(src).isDirectory(), 'the junction still stats as a directory (transparent to callers)');
  assertEq(norm(fs.readlinkSync(src)), norm(result.target), 'the junction points at the new location');

  // 2. The bytes physically LEFT C: — the whole point of PRD §3.4.
  assert(under(result.target, MIG_TARGET_ROOT), `target ${json(result.target)} is under the target root`);
  assert(
    path.parse(result.target).root.toUpperCase() !== path.parse(src).root.toUpperCase(),
    'the destination volume differs from the source volume',
  );
  const after = m.walkTree(result.target);
  assertEq(after.files, before.files, 'every file arrived at the target');
  assertEq(after.bytes, before.bytes, 'every byte arrived at the target');

  // 3. PRD §3.4 step (3): a write through the OLD C: path lands on the destination volume.
  fs.writeFileSync(path.join(src, 'through-junction.txt'), 'lands off C:');
  assert(
    fs.existsSync(path.join(result.target, 'through-junction.txt')),
    'a write through the old C: path must physically land in the target directory',
  );

  // 4. The journal reached LINKED, so the crash window is closed.
  const rec = db.getMigrationBySource(path.resolve(src));
  assert(rec !== null, 'a migration record exists for the source path');
  assertEq(rec.state, 'LINKED', 'journal state after a successful migration');
  assertEq(norm(rec.target_path), norm(result.target), 'journal target matches the real target');
  assertEq(db.listInterruptedMigrations().length, 0, 'a completed migration is not reported as interrupted');

  // 5. Undo: drop the junction, move the data back, prove the target is gone.
  const undo = await m.undoMigration(src, { cfg: c, log: silentLog, db });
  assert(undo.ok, `undoMigration failed: ${undo.code}: ${undo.reason}`);
  assert(!fs.lstatSync(src).isSymbolicLink(), 'after an undo the source is a real directory again');
  assert(!fs.existsSync(result.target), 'after an undo the target directory is gone');
  const restored = m.walkTree(src);
  assertEq(restored.files, after.files + 1, 'every file came back, including the one written through the junction');
  assertEq(db.getMigrationBySource(path.resolve(src)).state, 'RESTORED', 'journal state after an undo');

  return `copy moved ${result.files} files / ${result.bytes} B C:->E:, junction redirects writes to E:, undo restored the tree and removed the target`;
});

await check('migrate.undo-refuses-to-eat-data', async () => {
  const m = await load('lib/symlink-migrate.js');
  const dbm = await load('lib/state-db.js');
  const c = migCfg();
  const db = new dbm.StateDB(path.join(mkdirp(path.join(probeRoot, `migdb2_${STAMP}`)), 'state.db'));
  cleanupFns.push(() => { try { db.close(); } catch {} });

  // A path with NO journal record: undo must refuse, not guess what used to be there.
  const stranger = path.join(MIG_SRC_ROOT, `dshcc_stranger_${STAMP}`);
  mkdirp(stranger);
  fs.writeFileSync(path.join(stranger, 'keep.txt'), 'must survive');
  cleanupFns.push(() => rmrf(stranger));
  const noRecord = await m.undoMigration(stranger, { cfg: c, log: silentLog, db });
  assert(noRecord.ok === false, 'undo of an unrecorded path must refuse');
  assertEq(noRecord.code, 'NO_RECORD', 'unrecorded undo refusal code');
  assert(fs.existsSync(path.join(stranger, 'keep.txt')), 'the unrecorded directory was not touched');

  // A recorded path whose junction was REPLACED by a real directory full of data. Undoing it
  // would delete real content, so it must refuse — this is the probe that matters.
  const swapped = path.join(MIG_SRC_ROOT, `dshcc_swapped_${STAMP}`);
  rmrf(swapped);
  mkdirp(swapped);
  fs.writeFileSync(path.join(swapped, 'a.bin'), 'a');
  cleanupFns.push(() => rmrf(swapped));
  const mig = await m.migrateDirectory(swapped, { cfg: c, log: silentLog, db });
  assert(mig.ok, `setup migration failed: ${mig.code}: ${mig.reason}`);
  fs.rmdirSync(swapped);                                     // drop the junction
  mkdirp(swapped);                                           // ...and put a REAL directory back
  fs.writeFileSync(path.join(swapped, 'precious.txt'), 'do not delete');
  const refuse = await m.undoMigration(swapped, { cfg: c, log: silentLog, db });
  assert(refuse.ok === false, 'undo of a path that is no longer a junction must refuse');
  assertEq(refuse.code, 'NOT_A_JUNCTION', 'replaced-junction refusal code');
  assert(fs.existsSync(path.join(swapped, 'precious.txt')), 'the real directory survived the refused undo');

  return `undo refused NO_RECORD for an unrecorded path and NOT_A_JUNCTION for a re-materialised directory; neither fixture lost data`;
});

await check('migrate.candidates-come-from-tracked-rows', async () => {
  const m = await load('lib/symlink-migrate.js');
  const c = migCfg({ migrateMinBytes: 1024 });

  const dir = path.join(MIG_SRC_ROOT, `dshcc_cand_${STAMP}`);
  rmrf(dir);
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(2048, 1));
  cleanupFns.push(() => rmrf(dir));

  const row = (p, size) => ({
    file_path: p, file_size: size, category: 'SAFE_TO_DELETE', is_locked: 0,
    locked_by_pid: null, source_process: null,
  });

  const hit = m.findCandidates([row(path.join(dir, 'big.bin'), 2048)], c);
  assertEq(hit.length, 1, 'one tracked directory above the byte threshold is offered');
  assertEq(norm(hit[0].path), norm(dir), 'the candidate is the CONTAINING directory');
  assertEq(hit[0].bytes, 2048, 'candidate bytes are the tracked row total');

  assertEq(m.findCandidates([row(path.join(dir, 'big.bin'), 64)], c).length, 0,
    'below migrateMinBytes -> not offered');

  // A protected directory is never offered, even with plenty of bytes: the panel must never
  // show an action the POST would refuse (that reads as a broken button).
  assertEq(m.findCandidates([row(path.join('C:\\Windows', 'Temp', 'huge.bin'), 99 * 1024 * 1024)], c).length, 0,
    'a protected directory is never a candidate');

  // Malformed rows degrade to "no candidate" instead of throwing — the watcher writes these.
  assertEq(m.findCandidates([null, undefined, {}, { file_path: '' }, { file_path: 'relative.bin', file_size: 5 }], c).length, 0,
    'malformed rows produce no candidates and do not throw');
  assertEq(m.findCandidates(null, c).length, 0, 'a null row list produces no candidates');

  return `candidates derive from tracked rows through the same gate the operation runs; malformed rows answer []`;
});

// A migrated directory's CHILDREN still spell `C:` while their bytes live on `E:`. Offering
// them again would migrate already-moved data a second time, nesting target inside target.
// The gate must therefore compare PHYSICAL volumes, not path literals.
await check('migrate.no-second-migration-through-a-junction', async () => {
  const m = await load('lib/symlink-migrate.js');
  const c = migCfg({ migrateMinBytes: 1024 });

  const dir = path.join(MIG_SRC_ROOT, `dshcc_nest_${STAMP}`);
  rmrf(dir);
  mkdirp(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'big.bin'), Buffer.alloc(2048, 1));
  cleanupFns.push(() => rmrf(dir));

  const first = m.inspectDirectory(dir, c);
  assertEq(first.ok, true, `the directory starts out migratable (${first.code})`);

  // The journal is not optional: migrateDirectory refuses to move bytes it cannot record.
  const dbm = await load('lib/state-db.js');
  assertEq((await m.migrateDirectory(dir, { cfg: c, log: silentLog, db: null })).code, 'STATE_UNAVAILABLE',
    'a migration without a journal is refused before anything moves');
  assert(!fs.lstatSync(dir).isSymbolicLink(), 'and nothing was touched');

  const db = new dbm.StateDB(path.join(mkdirp(path.join(probeRoot, `nestdb_${STAMP}`)), 'state.db'));
  cleanupFns.push(() => { try { db.close(); } catch {} });
  const moved = await m.migrateDirectory(dir, { cfg: c, log: silentLog, db });
  assertEq(moved.ok, true, `migration executed (${moved.code}: ${moved.reason})`);
  cleanupFns.push(() => { try { m.removeJunction(dir); } catch {} });

  assert(fs.lstatSync(dir).isSymbolicLink(), 'the source is now a junction');

  // `sub` is reachable only THROUGH that junction: same bytes, spelled `C:`, living on `E:`.
  const nested = path.join(dir, 'sub');
  const verdict = m.inspectDirectory(nested, c);
  assertEq(verdict.ok, false, 'a directory reached through our own junction is refused');
  assertEq(verdict.code, 'SAME_VOLUME', 'refused because it already lives on the target volume');

  const row = (p, size) => ({
    file_path: p, file_size: size, category: 'SAFE_TO_DELETE', is_locked: 0,
    locked_by_pid: null, source_process: null,
  });
  assertEq(m.findCandidates([row(path.join(nested, 'big.bin'), 2048)], c).length, 0,
    'and it is never offered as a candidate again');

  return `physical volume decides SAME_VOLUME: ${norm(nested)} -> ${verdict.code}`;
});

await check('sessionhook.arms-and-sweeps-on-dispose', async () => {
  const sh = await load('lib/session-hook.js');
  assert(typeof sh.installSessionHook === 'function', 'installSessionHook is not exported');

  // A fake Cordis context that records subscriptions and fires them exactly like `ctx.on`.
  const handlers = new Map();
  const ctx = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event)?.delete(fn);
    },
    fire(event, ...args) { for (const fn of [...(handlers.get(event) ?? [])]) fn(...args); },
    count(event) { return handlers.get(event)?.size ?? 0; },
  };

  let cleaned = [];
  const rows = [
    { file_path: 'C:\\x\\a.tmp', category: 'SAFE_TO_DELETE' },
    { file_path: 'C:\\x\\b.tmp', category: 'CAUTION_CACHE' },
  ];
  const baseDeps = {
    cfg: { sessionCloseClean: true, sessionCloseMinAgeMs: 0, enabled: true },
    log: silentLog,
    trackedRows: async () => rows,
    // Assert the CONTRACT of clean(), not the DB shape: `clean()` reads `rec.path`, so a sweep
    // that forwards raw `TrackedRow`s (which carry `file_path`) hands it `undefined` and silently
    // cleans nothing. Reading `file_path` here is what let that defect pass this check once already.
    clean: async (recs) => {
      for (const r of recs) assert(typeof r.path === 'string' && r.path.length > 0, `clean() got a record without a path: ${json(r)}`);
      cleaned.push(recs.map((r) => r.path));
      return { removed: recs.length, bytesFreed: 10, skipped: 0 };
    },
  };

  const hook = sh.installSessionHook(ctx, baseDeps);
  assertEq(ctx.count('session/disposed'), 1, 'the hook subscribed to session/disposed');
  assertEq(ctx.count('session/created'), 1, 'the hook subscribed to session/created (for the min-age rule)');
  assertEq(hook.isEnabled(), true, 'hook reports enabled when sessionCloseClean is on');

  ctx.fire('session/disposed', { id: 'session-1' });
  await waitFor(() => cleaned.length > 0, 3000, 40);
  assertEq(cleaned.length, 1, 'disposing a session ran exactly one sweep');
  assertEq(cleaned[0].length, 1, 'the sweep cleaned ONLY SAFE_TO_DELETE rows (PRD §3.3 tiering)');
  assert(cleaned[0][0].endsWith('a.tmp'), `the swept row was the SAFE one, got ${json(cleaned[0])}`);

  // A throwing cleaner must not become an unhandled rejection in the host.
  const throwing = sh.installSessionHook(
    { on: () => () => {} },
    { ...baseDeps, clean: async () => { throw new Error('cleaner exploded'); } },
  );
  const rejected = await throwing.sweep('probe').then(() => false, () => true);
  assert(rejected === false, 'sweep() must swallow a cleaner exception rather than reject');
  throwing.dispose();

  hook.dispose();
  assertEq(ctx.count('session/disposed'), 0, 'dispose() unsubscribed from session/disposed');
  assertEq(ctx.count('session/created'), 0, 'dispose() unsubscribed from session/created');
  hook.dispose(); // idempotent
  return `dispose -> 1 sweep of SAFE rows only, errors contained, dispose() idempotent`;
});

await check('sessionhook.off-by-default-and-min-age', async () => {
  const sh = await load('lib/session-hook.js');
  const off = sh.installSessionHook(
    { on: () => () => {} },
    { cfg: { sessionCloseClean: false }, log: silentLog, trackedRows: async () => [], clean: async () => ({}) },
  );
  assertEq(off.isEnabled(), false, 'the hook is OFF unless sessionCloseClean is explicitly true');
  assertEq(await off.sweep('probe'), null, 'a disabled hook does nothing when swept');
  off.dispose();

  // A session that lived less than sessionCloseMinAgeMs must not trigger a sweep: the host
  // creates and disposes throwaway sessions routinely and every sweep is expensive.
  const handlers = new Map();
  const ctx = {
    on(e, fn) { if (!handlers.has(e)) handlers.set(e, new Set()); handlers.get(e).add(fn); return () => handlers.get(e)?.delete(fn); },
    fire(e, ...a) { for (const fn of [...(handlers.get(e) ?? [])]) fn(...a); },
  };
  let sweeps = 0;
  const hook = sh.installSessionHook(ctx, {
    cfg: { sessionCloseClean: true, sessionCloseMinAgeMs: 60_000, enabled: true },
    log: silentLog,
    trackedRows: async () => [{ file_path: 'C:\\x\\a.tmp', category: 'SAFE_TO_DELETE' }],
    clean: async () => { sweeps += 1; return { removed: 1, bytesFreed: 1, skipped: 0 }; },
  });
  ctx.fire('session/created', { id: 'short-lived' });
  ctx.fire('session/disposed', { id: 'short-lived' });
  await new Promise((r) => setTimeout(r, 250));
  assertEq(sweeps, 0, 'a session shorter than sessionCloseMinAgeMs must not trigger a silent clean');

  // A session with no observed start has no measurable age, so it is NOT skipped.
  ctx.fire('session/disposed', { id: 'never-seen' });
  await waitFor(() => sweeps > 0, 3000, 40);
  assertEq(sweeps, 1, 'a session with no observed start is swept');
  hook.dispose();
  return `default OFF; sub-threshold sessions skipped; unmeasurable sessions swept`;
});

await check('sessionhook.concurrency-and-disposal', async () => {
  const sh = await load('lib/session-hook.js');
  const handlers = new Map();
  const ctx = {
    on(e, fn) { if (!handlers.has(e)) handlers.set(e, new Set()); handlers.get(e).add(fn); return () => handlers.get(e)?.delete(fn); },
    fire(e, ...a) { for (const fn of [...(handlers.get(e) ?? [])]) fn(...a); },
    count(e) { return handlers.get(e)?.size ?? 0; },
  };

  let concurrent = 0;
  let maxConcurrent = 0;
  let runs = 0;
  const hook = sh.installSessionHook(ctx, {
    cfg: { sessionCloseClean: true, sessionCloseMinAgeMs: 0, enabled: true },
    log: silentLog,
    trackedRows: async () => [{ file_path: 'C:\\x\\a.tmp', category: 'SAFE_TO_DELETE' }],
    clean: async () => {
      runs += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 60));
      concurrent -= 1;
      return { removed: 1, bytesFreed: 1, skipped: 0 };
    },
  });

  ctx.fire('session/disposed', { id: 's1' });
  ctx.fire('session/disposed', { id: 's2' });
  ctx.fire('session/disposed', { id: 's3' });
  await waitFor(() => runs >= 1, 3000, 40);
  await new Promise((r) => setTimeout(r, 350));
  assertEq(maxConcurrent, 1, 'concurrent disposals must never run two sweeps at once');
  assert(runs >= 1 && runs <= 3, `three disposals produced ${runs} sweep(s) — the latch must not multiply work`);
  hook.dispose();
  assertEq(ctx.count('session/disposed'), 0, 'dispose() after firing still unsubscribes');
  return `3 simultaneous disposals -> ${runs} sweep(s), max concurrency ${maxConcurrent}`;
});

await check('config.phase3-keys', async () => {
  const m = await load('lib/config.js');
  const schema = await load('lib/config-schema.js');
  const d = m.resolveConfig({}, process.env);
  assertEq(d.migrateTargetRoot, null, 'migrateTargetRoot default (derived from escapeRoot)');
  assertEq(d.migrateVerify, true, 'migrateVerify default on — it is the evidence for deleting the source');
  assertEq(d.migrateMinBytes, 10 * 1024 * 1024, 'migrateMinBytes default 10 MB');
  assertEq(d.sessionCloseClean, false, 'sessionCloseClean default OFF (silent clean is opt-in)');
  assertEq(d.sessionCloseMinAgeMs, 60000, 'sessionCloseMinAgeMs default 60 s');

  // The same fail-soft style as every other key: garbage falls back, it never throws.
  const bad = m.resolveConfig(
    { migrateTargetRoot: 42, migrateVerify: 'yes', migrateMinBytes: -5, sessionCloseClean: 'true', sessionCloseMinAgeMs: NaN },
    process.env,
  );
  assertEq(bad.migrateTargetRoot, null, 'a non-string migrateTargetRoot falls back to null');
  assertEq(bad.migrateVerify, true, 'a non-false migrateVerify stays true (fail safe)');
  assertEq(bad.migrateMinBytes, 10 * 1024 * 1024, 'a negative migrateMinBytes falls back to the default');
  assertEq(bad.sessionCloseClean, false, "the string 'true' is NOT true — the hook stays off");

  // Every new key must be declared in the schema AND carry a Chinese description, or the
  // settings UI silently omits it.
  const meta = schema.Config?.meta ?? schema.default?.meta ?? {};
  const fields = schema.FIELDS ?? schema.default?.FIELDS ?? {};
  for (const k of ['migrateTargetRoot', 'migrateVerify', 'migrateMinBytes', 'sessionCloseClean', 'sessionCloseMinAgeMs']) {
    assert(k in meta, `config key ${k} has no Config.meta description`);
    assert(k in fields, `config key ${k} is not declared in FIELDS`);
    assert(/[\u4e00-\u9fa5]/.test(String(meta[k]?.description ?? '')), `config key ${k} description is not Chinese`);
  }
  return `5 Phase 3 keys present in config.js + config-schema.js FIELDS + meta, defaults 10 MB / 60 s / opt-in, malformed input fails soft`;
});

// ── REGRESSION: the three defects behind the live "nothing happened" report ──
// Each of these was a real production failure observed through the panel, not a hypothetical.

// (1) isLocked() used `open('r+')`, which SUCCEEDS on a file another process holds open
//     WITHOUT delete sharing — yet such a file cannot be deleted. The probe must match the
//     operation: deletion needs delete sharing, so the test is a rename-away-and-back.
await check('cleaner.isLocked-matches-delete-permission', async () => {
  const { isLocked } = await load('lib/classifier.js');
  const dir = mkdirp(path.join(probeRoot, `lockprobe_${STAMP}`));
  const free = path.join(dir, 'free.log');
  fs.writeFileSync(free, 'x');

  const unlocked = isLocked(free);
  assertEq(unlocked.locked, false, 'a plain file must not read as locked');

  // Hold the file the way a Windows program that does not share delete does: open it for
  // read/write but NOT delete. `open('r+')` succeeds here — which is exactly why the old
  // probe was wrong.
  const holder = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import fs from 'node:fs';
     const fd = fs.openSync(process.env.DCC_LOCK_PATH, 'r+');
     process.stdout.write('HOLDING\\n');
     const end = Date.now() + 6000;
     while (Date.now() < end) { try { fs.fstatSync(fd); } catch {} }
     try { fs.closeSync(fd); } catch {}`,
  ], { env: { ...process.env, DCC_LOCK_PATH: free }, stdio: ['ignore', 'pipe', 'ignore'] });
  cleanupFns.push(() => {
    try {
      holder.kill();
    } catch {}
  });

  await new Promise((resolve) => setTimeout(resolve, 900));

  // Cross-check the ground truth independently: can the file be renamed right now?
  const probe2 = `${free}.mv`;
  let renamable = true;
  try {
    fs.renameSync(free, probe2);
    fs.renameSync(probe2, free);
  } catch {
    renamable = false;
  }

  const held = isLocked(free);
  try {
    holder.kill();
  } catch {}
  if (renamable) {
    // Some processes DO share delete; then there is no lock to detect and the probe proves
    // nothing. Report that honestly rather than pretending a lock was observed.
    detail('holder allowed delete sharing on this host — lock detection not exercised');
    return 'skipped: host allowed delete sharing (isLocked reported locked=' + held.locked + ')';
  }
  assertEq(held.locked, true, 'a file that cannot be renamed must read as locked');
  return 'rename-based probe agrees with the real delete permission (old r+ probe did not)';
});

// (2) A source-directory delete cannot succeed while a file inside is held, and `rmSync`
//     deletes what it CAN reach before failing. Migration must therefore refuse at PLANNING
//     time — before copying — so the panel never offers a move that must fail.
await check('migrate.busy-directory-refused-before-any-copy', async () => {
  const m = await load('lib/symlink-migrate.js');
  /* Must live on the REAL C: volume and outside every protected root: `probeRoot` sits in
   * `os.tmpdir()`, which the env hijack has already redirected to `E:\dsh_escape_cache\temp`,
   * so a directory there is refused as PROTECTED long before the busy check is reached. */
  const dir = mkdirp(path.join(MIG_SRC_ROOT, `dshcc_busy_${STAMP}`));
  cleanupFns.push(() => rmrf(dir));
  const targetRoot = path.join(cfg.escapeRoot, `busy_target_${STAMP}`);
  cleanupFns.push(() => rmrf(targetRoot));
  const c = migCfg({ migrateTargetRoot: targetRoot });

  const held = path.join(dir, 'held.log');
  fs.writeFileSync(held, 'x'.repeat(4096));
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(dir, `free-${i}.log`), 'y'.repeat(1024));

  const holder = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import fs from 'node:fs';
     const fd = fs.openSync(process.env.DCC_LOCK_PATH, 'r+');
     process.stdout.write('HOLDING\\n');
     const end = Date.now() + 8000;
     while (Date.now() < end) { try { fs.fstatSync(fd); } catch {} }
     try { fs.closeSync(fd); } catch {}`,
  ], { env: { ...process.env, DCC_LOCK_PATH: held }, stdio: ['ignore', 'pipe', 'ignore'] });
  cleanupFns.push(() => {
    try {
      holder.kill();
    } catch {}
  });
  await new Promise((resolve) => setTimeout(resolve, 900));

  const inspected = m.inspectDirectory(dir, c);

  // Ground truth for "is there actually a lock here", measured independently of the module:
  // a locked file cannot be renamed. If the host granted delete sharing, there is no lock to
  // detect and this check must say so instead of asserting a behaviour it never exercised.
  let reallyLocked = false;
  try {
    const probePath = `${held}.mv`;
    fs.renameSync(held, probePath);
    fs.renameSync(probePath, held);
  } catch {
    reallyLocked = true;
  }
  try {
    holder.kill();
  } catch {}

  if (inspected.ok && !reallyLocked) {
    detail('host allowed delete sharing — busy refusal not exercised');
    return 'skipped: no lock could be established on this host';
  }
  assertEq(inspected.ok, false, 'a directory holding an undeletable file must not be offered as a candidate');
  assertEq(inspected.code, 'FILES_IN_USE', 'the refusal must name the cause');
  assert(/held open by another process/.test(inspected.reason), `reason should explain: ${inspected.reason}`);
  assert(!fs.existsSync(targetRoot), 'a refusal must not have copied anything to the target volume');
  for (let i = 0; i < 3; i += 1) {
    assert(fs.existsSync(path.join(dir, `free-${i}.log`)), 'the refusal must not have deleted any file');
  }
  return `refused with FILES_IN_USE before any copy; 4 files intact; nothing written to the target`;
});

// (3) A clean run must let its caller drop the rows it just acted on, or the table fills with
//     dead rows and every later click re-validates thousands of files that no longer exist.
await check('cleaner.reports-removed-and-gone-paths', async () => {
  const { clean } = await load('lib/cleaner.js');
  /* Real C: volume and outside the protected roots — see the comment on the check above. */
  const dir = mkdirp(path.join(MIG_SRC_ROOT, `dshcc_removed_${STAMP}`));
  cleanupFns.push(() => rmrf(dir));
  const live = path.join(dir, 'live.log');
  const ghost = path.join(dir, 'ghost.log');
  fs.writeFileSync(live, 'x'.repeat(2048));
  const c = await load('lib/config.js');
  const ccfg = c.resolveConfig({}, process.env);

  const report = await clean(
    [
      { path: live, size: 2048, category: 'SAFE_TO_DELETE' },
      { path: ghost, size: 512, category: 'SAFE_TO_DELETE' },
    ],
    { deep: false, force: true, cfg: ccfg, log: silentLog },
  );

  assert(!fs.existsSync(live), 'the live file should be gone');
  assertEq(report.removed, 1, 'one file removed');
  assertEq(report.skipped, 1, 'the ghost is skipped, not counted as removed');
  assert(Array.isArray(report.removedPaths), 'report.removedPaths must exist so rows can be dropped');
  assert(Array.isArray(report.gonePaths), 'report.gonePaths must exist so dead rows can be dropped');
  assertEq(report.removedPaths.length, 1, 'exactly one removed path');
  assertEq(norm(report.removedPaths[0]), norm(live), 'removedPaths must name the deleted file');
  assertEq(report.gonePaths.length, 1, 'exactly one already-gone path');
  assertEq(norm(report.gonePaths[0]), norm(ghost), 'gonePaths must name the missing file');
  // The two lists must stay distinct: a file that was never there must not inflate "freed".
  assertEq(report.bytesFreed, 2048, 'only the deleted file contributes bytes');
  return 'removed=1 removedPaths=1 gonePaths=1 bytesFreed=2048 (both lists distinct)';
});

// (4) Dead rows must be findable so /purge can drop them — and a missing path must never
//     count as "alive", while an unreadable one must (forgetting it would hide a real file).
await check('webapi.findDeadRows-separates-missing-from-unreadable', async () => {
  const m = await load('lib/web-api.js');
  assert(typeof m.findDeadRows === 'function', 'findDeadRows is not exported');

  const dir = mkdirp(path.join(probeRoot, `dead_${STAMP}`));
  const present = path.join(dir, 'present.log');
  fs.writeFileSync(present, 'x');

  const rows = [
    { file_path: present },
    { file_path: path.join(dir, 'absent-1.log') },
    { file_path: path.join(dir, 'absent-2.log') },
    { file_path: '' },
    null,
  ];
  const found = m.findDeadRows(rows);
  assertEq(found.scanned, 5, 'scanned counts every row');
  // alive = present.log + the empty-string row + the null row: a row this plugin cannot
  // address is not proof that a file died, so it is never forgotten.
  assertEq(found.alive, 3, 'present and unaddressable rows all count as alive');
  assertEq(found.dead.length, 2, 'exactly the two absent paths are dead');
  assert(found.dead.every((p) => /absent-\d/.test(p)), `dead list must name the missing files: ${found.dead}`);

  // A probe that throws must NOT condemn the row — an unreadable path may still hold data.
  const guarded = m.findDeadRows([{ file_path: 'C:/whatever/x.bin' }], () => {
    throw new Error('EACCES');
  });
  assertEq(guarded.dead.length, 0, 'a throwing existence probe must not forget the row');
  assertEq(guarded.alive, 1, 'a throwing probe leaves the row alive');
  assertEq(m.findDeadRows(null).scanned, 0, 'null input is tolerated');
  return '2 dead / 2 alive / unreadable-guarded; null tolerated';
});

// ── PROBE P1: the migration gate must refuse a blacklisted path even when it exists ──
// PRD §6.2: 对黑名单路径绝对拒绝. Migration relocates a whole tree — a stronger act than deleting
// one file — so the same blacklist must bind it, and it must bind by PATH, not by existence.
await probe('P1.migration-blacklist-veto', async () => {
  const m = await load('lib/symlink-migrate.js');
  const c = migCfg();
  const real = path.join('C:\\Windows', 'Temp', `dshcc_p1_${STAMP}`);
  let created = false;
  try { mkdirp(real); fs.writeFileSync(path.join(real, 'x.bin'), 'x'); created = true; } catch { /* sandbox may deny */ }
  cleanupFns.push(() => { if (created) rmrf(real); });

  const verdicts = {};
  for (const [label, p] of [
    ['C:\\Windows (exists)', 'C:\\Windows'],
    ['C:\\Windows\\Temp\\<real dir>', real],
    ['C:\\Program Files', 'C:\\Program Files'],
    ['Desktop', path.join(process.env.USERPROFILE || 'C:\\Users\\x', 'Desktop')],
    ['Documents', path.join(process.env.USERPROFILE || 'C:\\Users\\x', 'Documents')],
    ['%LOCALAPPDATA%\\Temp\\<stubborn>', path.join(MIG_SRC_ROOT, `dshcc_p1b_${STAMP}`)],
  ]) {
    const v = m.inspectDirectory(p, c);
    verdicts[label] = v.ok ? 'ALLOWED' : v.code;
  }
  const leaks = Object.entries(verdicts).filter(([, v]) => v !== 'PROTECTED');
  // The last row is a LEGITIMATE stubborn directory (it is exactly what the feature is for), so
  // its expected answer is MISSING (absent) or OK — not PROTECTED. Grade it separately.
  const blacklist = leaks.filter(([k]) => !k.startsWith('%LOCALAPPDATA%'));
  return {
    verdict: blacklist.length === 0
      ? `all 5 blacklisted paths refused with PROTECTED (a real directory under C:\\Windows\\Temp is refused by path, not by existence)`
      : `${blacklist.length} blacklisted path(s) NOT refused: ${blacklist.map(([k, v]) => `${k}=${v}`).join(' | ')}`,
    data: json(verdicts),
    prdViolation: blacklist.length > 0,
  };
});

// ── PROBE P2: the crash window must be recoverable, never lossy ──
// PENDING = nothing moved; MOVED = data at target, no junction. Neither may lose bytes, and
// `undoMigration` must be able to finish the job from MOVED alone (PRD §6.3 graceful degrade).
await probe('P2.migration-crash-window-is-recoverable', async () => {
  const m = await load('lib/symlink-migrate.js');
  const dbm = await load('lib/state-db.js');
  const c = migCfg();
  const db = new dbm.StateDB(path.join(mkdirp(path.join(probeRoot, `migdb3_${STAMP}`)), 'state.db'));
  cleanupFns.push(() => { try { db.close(); } catch {} });

  const src = path.join(MIG_SRC_ROOT, `dshcc_crash_${STAMP}`);
  rmrf(src);
  mkdirp(src);
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(src, `f${i}.bin`), Buffer.alloc(1024, i));
  cleanupFns.push(() => rmrf(src));
  const beforeFiles = m.walkTree(src).files;

  const mig = await m.migrateDirectory(src, { cfg: c, log: silentLog, db });
  if (!mig.ok) return { verdict: `setup failed: ${mig.code}`, prdViolation: false };
  cleanupFns.push(() => { try { if (fs.existsSync(mig.target)) rmrf(mig.target); } catch {} });

  // Simulate the crash: the junction vanished after the move, exactly as a power loss at that
  // instant would leave it. The journal is then still in the MOVED window.
  fs.rmdirSync(src);
  const row = db.getMigrationBySource(path.resolve(src));
  db.updateMigration(row.id, { state: 'MOVED' });
  const interrupted = db.listInterruptedMigrations();

  const undo = await m.undoMigration(src, { cfg: c, log: silentLog, db });
  const recoveredFiles = fs.existsSync(src) ? m.walkTree(src).files : -1;
  const targetGone = !fs.existsSync(mig.target);

  return {
    verdict: undo.ok && recoveredFiles === beforeFiles && targetGone
      ? `MOVED window (data at target, no junction) undone: ${recoveredFiles} file(s) back, target removed`
      : `crash window NOT recoverable: undo=${undo.ok}/${undo.code} files=${recoveredFiles}/${beforeFiles} targetGone=${targetGone}`,
    data: `interrupted=${interrupted.length} undo=${undo.code} state=${db.getMigrationBySource(path.resolve(src))?.state}`,
    prdViolation: !(undo.ok && recoveredFiles === beforeFiles),
  };
});

// ── PROBE P3: junction capability without a shell (PRD §3.4's `mklink /J`) ──
// The PRD names `mklink /J`; invoking it means spawning cmd.exe with a quoted user path, the
// classic injection surface. `fs.symlinkSync(..., 'junction')` produces the SAME NTFS junction
// with no shell, so this probe pins the equivalence and the unlink-must-not-touch-target rule.
await probe('P3.junction-without-shell-equivalence', () => {
  const root = mkdirp(path.join(probeRoot, `p3_${STAMP}`));
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  mkdirp(target);
  fs.writeFileSync(path.join(target, 'in.txt'), 'payload');

  fs.symlinkSync(target, link, 'junction');
  const st = fs.lstatSync(link);
  const readsThrough = fs.readFileSync(path.join(link, 'in.txt'), 'utf8') === 'payload';
  fs.writeFileSync(path.join(link, 'out.txt'), 'written');
  const writesThrough = fs.existsSync(path.join(target, 'out.txt'));
  const realpaths = norm(fs.realpathSync.native(link)) === norm(fs.realpathSync.native(target));

  // Removing the link must never touch the target: this is what makes an undo safe.
  fs.rmdirSync(link);
  const linkGone = !fs.existsSync(link);
  const targetSurvived = fs.existsSync(path.join(target, 'in.txt')) && fs.existsSync(path.join(target, 'out.txt'));

  const ok = st.isSymbolicLink() && readsThrough && writesThrough && realpaths && linkGone && targetSurvived;
  return {
    verdict: ok
      ? 'junction created / read / written / unlinked with no shell; target intact (same artifact as mklink /J)'
      : `junction behaviour unexpected: symlink=${st.isSymbolicLink()} read=${readsThrough} write=${writesThrough} realpath=${realpaths} linkGone=${linkGone} targetSurvived=${targetSurvived}`,
    data: `admin-free; unlink removed only the reparse point`,
    prdViolation: !ok,
  };
});

// ══════════════════════════════════════════════════════════════════════════
// ADVERSARIAL PASS (PRD §6 non-functional requirements)
// ══════════════════════════════════════════════════════════════════════════
console.log('--- adversarial probes ---');

function protectedVariant(p) {
  try {
    return { value: classifier.isProtectedPath(p, cfg.protectRoots) };
  } catch (e) {
    return { err: `${e.code || ''} ${e.message}` };
  }
}

await probe('A1.protected-path-spelling-variants', () => {
  const variants = {
    'C:\\Windows\\notepad.exe': true,          // baseline
    'c:\\windows\\notepad.exe': true,          // case
    'C:\\WINDOWS\\NOTEPAD.EXE': true,          // upper case
    'C:/Windows/notepad.exe': true,            // forward slashes
    'C:\\Windows\\notepad.exe ': true,         // trailing space
    'C:\\Windows \\notepad.exe': true,         // trailing space in component
    'C:\\Windows.\\notepad.exe': true,         // trailing dot component
    'C:\\Windows\\Temp\\..\\notepad.exe': true, // .. segment
    'C:\\Users\\x\\..\\..\\Windows\\notepad.exe': true,
    '\\\\?\\C:\\Windows\\notepad.exe': true,   // extended-length prefix
    'C:\\PROGRA~1\\evil.exe': true,            // 8.3 short name
    'C:\\PROGRA~2\\evil.exe': true,            // 8.3 short name (x86)
    'C:\\PROGRA~1\\SomeApp\\a.dll': true,
  };
  const misses = [];
  for (const [p, want] of Object.entries(variants)) {
    const r = protectedVariant(p);
    const got = r.err ? `THREW ${r.err}` : r.value;
    if (got !== want) misses.push(`${json(p)} -> ${json(got)}`);
  }
  return {
    verdict: misses.length ? `${misses.length}/${Object.keys(variants).length} protected-path spellings NOT recognised` : 'all 13 spellings recognised',
    data: misses.length ? misses.join(' | ') : undefined,
    prdViolation: misses.length > 0, // PRD §6.2: 绝对拒绝删除 protected paths
  };
});

await probe('A2.over-blocking-C-WindowsApps', () => {
  const cases = ['C:\\WindowsApps\\evil.dll', 'C:\\Windows-old\\x.txt', 'C:\\Windows.old\\x.txt'];
  const got = {};
  for (const p of cases) got[p] = protectedVariant(p).value;
  const wronglyProtected = cases.filter((p) => got[p] === true);
  return {
    verdict: wronglyProtected.length ? `over-blocked (errs safe): ${json(got)}` : `not over-blocked: ${json(got)}`,
    data: 'over-blocking is a false positive, not a PRD violation (fails safe) — reported as hardening only',
    prdViolation: false,
  };
});

await probe('A3.directory-passed-to-classify', async () => {
  const d = mkdirp(path.join(fixtureDir, 'iam-a-directory'));
  let c;
  try {
    c = classifier.classify(mkCandidate(d, 0), { cfg, tree: treeStub });
  } catch (e) {
    return { verdict: 'classify(dir) THREW', data: `${e.code || ''} ${e.message}`, prdViolation: false };
  }
  let report = null;
  try {
    report = await cleaner.clean([c], { deep: true, force: true, cfg, log: cleanLog });
  } catch (e) {
    return { verdict: `classify(dir)=${c.category}, clean(dir) THREW`, data: `${e.code || ''} ${e.message}`, prdViolation: false };
  }
  const gone = !fs.existsSync(d);
  return {
    verdict: gone ? `directory classified ${c.category} and RECURSIVELY DELETED` : `directory classified ${c.category}, kept (removed=${report.removed})`,
    data: `classify(dir)={category:${c.category},reason:${json(c.reason)}} clean=${json(report)}`,
    prdViolation: gone, // deleting a whole tree from a Classified record is destructive
  };
});

await probe('A4.directory-passed-to-isLocked', () => {
  const d = mkdirp(path.join(fixtureDir, 'dir-for-isLocked'));
  let r;
  try { r = classifier.isLocked(d); } catch (e) { return { verdict: 'isLocked(dir) THREW', data: `${e.code || ''} ${e.message}`, prdViolation: true }; }
  return { verdict: `isLocked(dir)=${json(r)}`, data: 'a directory is not a deletable candidate; watcher drops non-files', prdViolation: false };
});

await probe('A5.protected-veto-on-clean', async () => {
  // The nastiest realistic case: C:\Windows\Temp\*.log classifies SAFE by the
  // Temp rule (§7), so clean() must veto it via isProtectedPath (PRD §6.2, §8).
  const p = path.join('C:\\Windows\\Temp', `dshcc_probe_${STAMP}.log`);
  fs.writeFileSync(p, 'protected but temp-shaped');
  cleanupFns.push(() => rmrf(p));
  const rec = classifier.classify(mkCandidate(p, 24), { cfg, tree: treeStub });
  const report = await cleaner.clean([rec], { deep: true, force: true, cfg, log: cleanLog });
  const survived = fs.existsSync(p);
  return {
    verdict: survived ? `vetoed correctly (classify said ${rec.category}, clean kept it)` : `DELETED a protectRoot file (classify said ${rec.category})`,
    data: `record=${json(rec)} report=${json(report)}`,
    prdViolation: !survived,
  };
});

await probe('A6.junction-out-of-protected-root', () => {
  const link = path.join(fixtureDir, 'link-to-windows');
  const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', link, 'C:\\Windows\\Temp'], { encoding: 'utf8' });
  if (!fs.existsSync(link)) {
    return { verdict: `junction not created (${(r.stderr || r.stdout || '').trim().slice(0, 120)})`, data: 'inconclusive on this host', prdViolation: false };
  }
  const through = path.join(link, 'x.log');
  let prot, det;
  try {
    prot = classifier.isProtectedPath(through, cfg.protectRoots);
    det = null;
  } catch (e) { det = `${e.code || ''} ${e.message}`; }
  return {
    verdict: det ? `isProtectedPath(junction path) THREW ${det}` : `isProtectedPath(junction path)=${prot}`,
    data: `path=${json(through)} (resolves into C:\\Windows\\Temp); watcher only ever sees real watched paths`,
    prdViolation: false,
  };
});

await probe('A7.db-edge-cases', async () => {
  const m = await load('lib/state-db.js');
  const empty = path.join(probeRoot, 'empty.db');
  const d2 = new m.StateDB(empty);
  d2.migrate();
  const s = d2.summary();
  const l = d2.list();
  const removed = d2.removeByPath([]);
  d2.close();
  const zeros = ['SAFE', 'CAUTION', 'LOCKED', 'total'].every((k) => s[k].count === 0 && s[k].bytes === 0);
  return {
    verdict: zeros && l.length === 0 && removed === 0 ? 'empty DB -> zero summary/list, removeByPath([])=0' : 'unexpected values on an empty DB',
    data: `summary=${json(s)} list=${l.length} removeByPath([])=${removed}`,
    prdViolation: !(zeros && l.length === 0),
  };
});

await probe('A8.classify-after-delete', () => {
  const p = path.join(fixtureDir, `vanishing-${STAMP}.tmp`);
  fs.writeFileSync(p, 'v');
  fs.rmSync(p);
  try {
    const c = classifier.classify(mkCandidate(p, 1), { cfg, tree: treeStub });
    return { verdict: `classify(deleted file)=${c.category} isLocked=${c.isLocked}`, data: json(c), prdViolation: false };
  } catch (e) {
    return { verdict: 'classify() THREW on a since-deleted file', data: `${e.code || ''} ${e.message}`, prdViolation: false };
  }
});

// ── Defect 4 (reachable PRD 6.2 bypass): non-lexical path spellings defeat isProtectedPath ──
// normalizePath() is LEXICAL only (classifier.js:79-87), so spellings that the OS resolves to a
// protected location are unrecognised. proven REACHABLE: the watcher emits such a spelling
// verbatim (watcher.js:102-110 canonicalKey is lexical), the row is persisted, and clean()
// (cleaner.js:411) then deletes the real file. Repro: test/adversarial-e2e-protectroot.mjs
await probe('A9.protectroot-bypass-non-lexical-spellings', async () => {
  const B = path.sep;
  const root = path.join('C:' + B + 'ProgramData', `dshcc_a9_${STAMP}`);
  mkdirp(root);
  cleanupFns.push(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const victim = path.join(root, `victim_${STAMP}.tmp`);
  fs.writeFileSync(victim, 'x'.repeat(48));
  const realLower = fs.realpathSync.native(victim).toLowerCase();

  // spellings that RESOLVE to the victim (verified below) but normalise lexically to something else
  const spellings = [
    ['8.3 short alias of C:\\ProgramData', 'C:' + B + 'PROGRA~3' + B + path.basename(root) + B + path.basename(victim)],
    ['device prefix (\\\\?\\)', B + B + '?' + B + victim],
  ];

  const bypasses = [];
  for (const [label, sp] of spellings) {
    let resolves = false;
    try { resolves = fs.realpathSync.native(sp).toLowerCase() === realLower; } catch {}
    const prot = classifier.isProtectedPath(sp, cfg.protectRoots);
    if (resolves && prot === false) bypasses.push(`${label} -> isProtectedPath=false but the OS resolves it to the protected victim`);
  }

  // Prove the consequence: clean() actually deletes through the first viable bypass.
  let deleted = null;
  const viable = spellings.find(([, sp]) => {
    try { return fs.realpathSync.native(sp).toLowerCase() === realLower && classifier.isProtectedPath(sp, cfg.protectRoots) === false; } catch { return false; }
  });
  if (viable) {
    const c = classifier.classify(mkCandidate(viable[1], 48), { cfg, tree: treeStub });
    const rep = await cleaner.clean([{ ...c, sourceProcess: 'verifier-a9' }], { deep: false, force: true, cfg, log: cleanLog });
    deleted = !fs.existsSync(viable[1]);
    detail(`A9 clean() via "${viable[0]}": report=${json(rep)} deleted=${deleted}`);
  }

  return {
    verdict: bypasses.length
      ? `${bypasses.length}/${spellings.length} protected-path spellings NOT recognised${deleted ? ' and clean() DELETED through one' : ''}`
      : `0/${spellings.length} non-lexical spellings defeat isProtectedPath`,
    data: bypasses.join(' | ') || undefined,
    prdViolation: bypasses.length > 0, // PRD §6.2 绝对拒绝
  };
});

// ── Defect 3: a genuine 8.3 alias spelling of a watchDir hard-aborts the HOST ──
// fs.watch(dir) at watcher.js:265 with dir verbatim; native fail-fast in libuv on the first event.
// try/catch at watcher.js:264/278 cannot intercept it. Repro: test/adversarial-abort-scope.mjs
await probe('A10.watchdir-8.3-alias-hard-abort', () => {
  const B = path.sep;
  const longRoot = path.join('C:' + B + 'ProgramData', `dshcc_a10_${STAMP}`);
  mkdirp(longRoot);
  cleanupFns.push(() => { try { fs.rmSync(longRoot, { recursive: true, force: true }); } catch {} });
  const shortRoot = 'C:' + B + 'PROGRA~3' + B + path.basename(longRoot);

  let aliasIsLive = false;
  try { aliasIsLive = fs.realpathSync.native(shortRoot).toLowerCase() === fs.realpathSync.native(longRoot).toLowerCase(); } catch {}
  if (!aliasIsLive) {
    return { verdict: 'inconclusive: no live 8.3 alias for this directory on this host', data: `short=${json(shortRoot)}`, prdViolation: false };
  }

  // Must run in a CHILD: if the plugin failed to canonicalise, the abort kills the process
  // (exit 3221226505) and cannot be caught. The child drives the PRODUCTION path (CWatcher);
  // raw fs.watch aborting on an 8.3 alias is a libuv fact, not a plugin defect, so it must
  // NOT be used as the assertion.
  const childSrc = `
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { resolveConfig } = await import('./lib/config.js');
    const { CWatcher } = await import('./lib/watcher.js');
    const dir = process.env.DCC_A10_DIR;
    const LOG = { debug(){}, info(){}, warn(){}, error(){} };
    const cfg = resolveConfig({ watchDirs: [{ path: dir, recursive: false, maxDepth: 1 }], debounceMs: 300 });
    const w = new CWatcher({ cfg, tree: { ownerOf: () => null, nameOf: () => null }, log: LOG, onCandidate: () => {} });
    let startErr = null;
    try { w.start(); } catch (e) { startErr = (e.code || '') + ' ' + e.message; }
    console.log('START_ERR=' + startErr);
    console.log('WATCHING=' + JSON.stringify(w.stats().watching));
    await new Promise((r) => setTimeout(r, 700));
    // Write via the LONG spelling so the event definitely lands under a live path.
    fs.writeFileSync(path.join(process.env.DCC_A10_LONG, 'a10_trigger.tmp'), 'x');
    await new Promise((r) => setTimeout(r, 1500));
    w.stop();
    console.log('SURVIVED');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', childSrc], {
    encoding: 'utf8', cwd: ROOT, timeout: 30000,
    env: { ...process.env, DCC_A10_DIR: shortRoot, DCC_A10_LONG: longRoot },
  });
  try { fs.rmSync(path.join(longRoot, 'a10_trigger.tmp'), { force: true }); } catch {}
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const aborted = r.status === 3221226505 || r.status === -1073740791;
  const watching = /WATCHING=(\[.*\])/.exec(out)?.[1] ?? '(none)';
  const canonicalised = !watching.includes('~');
  return {
    verdict: aborted
      ? 'HOST ABORT (0xC0000409): CWatcher did not canonicalise an 8.3-alias watchDir'
      : canonicalised
        ? `no abort; watchDir canonicalised (stats().watching=${watching})`
        : `no abort BUT watchDir not canonicalised: stats().watching=${watching}`,
    data: aborted ? out.split('\n')[0] : `short=${json(shortRoot)} exit=${r.status} watching=${watching}`,
    prdViolation: aborted, // native fail-fast: uncatchable, kills the host
  };
});

// ══════════════════════════════════════════════════════════════════════════
// cleanup + summary
// ══════════════════════════════════════════════════════════════════════════
for (const fn of cleanupFns.reverse()) {
  try { await fn(); } catch {}
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
if (notes.length) {
  console.log('--- notes ---');
  for (const n of notes) detail(n);
}
console.log(`SUMMARY pass=${pass} fail=${fail} total=${results.length} probes_failed=${probeFailures} verdict=${fail === 0 && probeFailures === 0 ? 'GREEN' : 'RED'}`);
if (fail) {
  console.log('FAILED CHECKS:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
}
process.exit(fail === 0 && probeFailures === 0 ? 0 : 1);
