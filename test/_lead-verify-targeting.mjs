/**
 * Verify the overflow-rescan TARGETING half-implementation is complete and safe.
 *
 * CRASH REPRO (the bug that took dsh down on 2026-10-17): `_onEvent` called
 * `this._noteActiveDir(...)`, which did not exist -> fatal uncaught TypeError inside an
 * fs event callback -> the whole Harness process died at boot, repeatedly. Named events
 * must now be handled without throwing, and the guard on the fs.watch callback must
 * contain ANY future throw so a plugin bug can never kill the host again.
 *
 * TARGETING UNIT: `_noteActiveDir` / `_takeEpisodeTargets` must implement exactly what
 * the constructor comments describe (see `_activeDirs`): most-recently-active-first
 * targets from the episode window, scoped to the overflowed watch root, LRU-bounded,
 * root-walk fallback when the episode recorded nothing.
 *
 * TARGETING E2E: a real 600-file child-process burst into a NESTED directory must
 * overflow the recursive watch and be recovered by a rescan that walks the NESTED
 * directory, not the watched root (the pre-targeting failure mode: the root walk burns
 * its file cap on unrelated content).
 *
 * Rooted at %LOCALAPPDATA%\Temp for the same reason as `_lead-p2-overflow-recovery.mjs`:
 * os.tmpdir() is redirected by the plugin's own env hijack, and recursive:true is only
 * honoured at/under %LOCALAPPDATA%\Temp (PRD 6.1), which the E2E part needs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { CWatcher } = await import(new URL('../lib/watcher.js', import.meta.url).href);
const { resolveConfig } = await import(new URL('../lib/config.js', import.meta.url).href);

const tmpRoot = path.join(process.env.LOCALAPPDATA, 'Temp');
const root = fs.mkdtempSync(path.join(tmpRoot, 'dshcc_target_'));
const silent = { debug() {}, info() {}, warn() {}, error() {} };

let pass = 0;
let fail = 0;
let skip = 0;
function check(name, ok, detail) {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  -- ${detail}`);
}
function skipCheck(name, detail) {
  skip += 1;
  console.log(`SKIP  ${name}  -- ${detail}`);
}

// ---------------------------------------------------------------------------
// 0. Static sweep: every `this._x(...)` call must have a definition. The 2026-10-17
//    boot crash was EXACTLY such a gap (`_noteActiveDir` called, never defined); this
//    sweep would have caught it before the code ever reached a boot.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(new URL('../lib/watcher.js', import.meta.url), 'utf8');
  const calls = new Set([...src.matchAll(/this\.(_[A-Za-z0-9]+)\s*\(/g)].map((m) => m[1]));
  const defined = new Set([
    ...[...src.matchAll(/^\s{2}(?:async\s+)?(_[A-Za-z0-9]+)\s*\(/gm)].map((m) => m[1]), // class methods
    ...[...src.matchAll(/this\.(_[A-Za-z0-9]+)\s*=/g)].map((m) => m[1]), // instance fields
  ]);
  const missing = [...calls].filter((c) => !defined.has(c));
  check(
    'static sweep: every this._method() call has a definition',
    missing.length === 0,
    missing.length === 0 ? `all ${calls.size} call sites resolve` : `MISSING: ${missing.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// 1. The exact crash: a NAMED event on a recursive watch + the fs.watch guard.
// ---------------------------------------------------------------------------
{
  const sub = path.join(root, 'live');
  fs.mkdirSync(sub, { recursive: true });
  const delivered = [];
  const warns = [];
  const w = new CWatcher({
    cfg: {
      ...resolveConfig({}),
      watchDirs: [{ path: root, recursive: true, maxDepth: 2 }],
      debounceMs: 80,
    },
    tree: null,
    log: { debug() {}, info() {}, warn: (m) => warns.push(m), error() {} },
    onCandidate: (c) => delivered.push(path.basename(c.path)),
  });
  w.start();

  // 1a. a named event on the nested directory: this is the line that killed every boot
  fs.writeFileSync(path.join(sub, 'pip-rec-a.log'), Buffer.alloc(64, 0x61));
  await new Promise((r) => setTimeout(r, 500));
  check(
    'named event on recursive watch is handled and delivered (the 2026-10-17 boot crash)',
    delivered.includes('pip-rec-a.log'),
    `delivered=${JSON.stringify(delivered)}`,
  );
  check(
    '_noteActiveDir recorded the directory that actually received the event',
    [...w._activeDirs.values()].some((e) => e.path.toLowerCase() === sub.toLowerCase()),
    `activeDirs=${w._activeDirs.size}`,
  );

  // 1b. the guard: a throwing handler must be contained, not fatal
  const statsBefore = w.stats();
  w._noteActiveDir = () => {
    throw new Error('synthetic handler bug');
  };
  fs.writeFileSync(path.join(sub, 'pip-rec-b.log'), Buffer.alloc(64, 0x62));
  await new Promise((r) => setTimeout(r, 500));
  const statsAfter = w.stats();
  check(
    'fs.watch guard contains a throwing handler (process still alive, warn logged)',
    warns.some((m) => String(m).includes('dropped event')),
    `warns=${warns.length}`,
  );
  check(
    'guarded event was dropped, not delivered, and counted as filtered',
    !delivered.includes('pip-rec-b.log') && statsAfter.filtered > statsBefore.filtered,
    `filtered ${statsBefore.filtered} -> ${statsAfter.filtered}`,
  );
  w.stop();
}

// ---------------------------------------------------------------------------
// 2. TARGETING unit, fully deterministic via the injected `now`.
// ---------------------------------------------------------------------------
{
  let clock = 1000;
  const w = new CWatcher({
    cfg: {
      ...resolveConfig({}),
      watchDirs: [{ path: root, recursive: true, maxDepth: 2 }],
      rescanOnOverflow: true,
      rescanCooldownMs: 0,
      rescanSettleMs: 50,
    },
    tree: null,
    log: silent,
    onCandidate: () => {},
    now: () => clock,
  });

  const subA = path.join(root, 'ep-a');
  const subB = path.join(root, 'ep-b');
  const outside = path.join(tmpRoot, 'dshcc_target_outside'); // another watch root's tree

  // stale activity (delivered fine, predates the episode)
  w._noteActiveDir(subA); // at=1000
  clock += 10; // 1010: the FIRST null event of the burst opens the episode
  w._overflowEpisodeStart = clock;
  clock += 5; // 1015
  w._noteActiveDir(subB);
  clock += 5; // 1020: subA refreshed INSIDE the episode window
  w._noteActiveDir(subA);
  clock += 5; // 1025: in-episode activity under ANOTHER root -> must be excluded
  w._noteActiveDir(outside);

  const targets = w._takeEpisodeTargets(root);
  check(
    'episode targets: in-window dirs under the overflowed root, most recently active first',
    targets.length === 2 && targets[0] === subA && targets[1] === subB,
    `targets=${JSON.stringify(targets)}`,
  );
  check('the episode is closed by the take', w._overflowEpisodeStart === 0, `start=${w._overflowEpisodeStart}`);
  check(
    'a take with no open episode yields no targets (root-walk fallback path)',
    w._takeEpisodeTargets(root).length === 0,
    'second take returned []',
  );

  // episode open but NO in-window activity -> caller falls back to the root walk
  clock += 100;
  w._overflowEpisodeStart = clock;
  const none = w._takeEpisodeTargets(root);
  check(
    'episode with only pre-episode activity yields no targets -> root fallback',
    none.length === 0 && w._overflowEpisodeStart === 0,
    `targets=${none.length}, start=${w._overflowEpisodeStart}`,
  );

  // ANCESTOR NOISE: dir-change events note the PARENT of the changed directory, so the
  // watched root shows up in every real burst; it must be dropped when a real target lies
  // beneath it (this is what keeps the 30k-file Temp-root walk out of production bursts)
  clock += 50;
  w._overflowEpisodeStart = clock;
  clock += 1;
  w._noteActiveDir(subA); // file activity inside ep-a (the real target)
  clock += 1;
  w._noteActiveDir(root); // spurious note: dir-change event for ep-a itself
  const trimmed = w._takeEpisodeTargets(root);
  check(
    'spurious ancestor (watched root, noted via dir-change events) is dropped when a descendant is targeted',
    trimmed.length === 1 && trimmed[0] === subA,
    `targets=${JSON.stringify(trimmed)}`,
  );

  // LRU bound: refresh keeps recency order, eviction drops the least recently active.
  // (Clear first: earlier cases left entries, and a max LOWERED below the current size is
  // a test-only situation -- production never changes `_activeDirMax` after construction.)
  w._activeDirs.clear();
  w._activeDirMax = 3;
  for (let i = 0; i < 10; i += 1) {
    clock += 1;
    w._noteActiveDir(path.join(root, `lru-${i}`));
  }
  const keys = [...w._activeDirs.keys()];
  check(
    'activeDirs is LRU-bounded at _activeDirMax and keeps the most recent entries',
    w._activeDirs.size === 3 &&
      keys.length === 3 &&
      ['lru-7', 'lru-8', 'lru-9'].every((n) => keys.some((k) => k.endsWith(n))),
    `size=${w._activeDirs.size} keys=${JSON.stringify(keys)}`,
  );
}

// ---------------------------------------------------------------------------
// 3. TARGETING E2E: a real overflow, recovered by a walk of the NESTED dir only.
//    Child-process writer is mandatory (same-process sync writes starve the event loop
//    and measure Node rather than the watcher -- see _lead-p2-overflow-recovery.mjs).
// ---------------------------------------------------------------------------
{
  const sub = path.join(root, 'burst');
  fs.mkdirSync(sub, { recursive: true });

  const WRITER = `
import fs from 'node:fs';
import path from 'node:path';
const [dir, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i += 1) {
  fs.writeFileSync(path.join(dir, 'pip-rec-' + i + '.log'), Buffer.alloc(2048, 0x64));
}
`;
  const writerPath = path.join(root, 'writer.mjs');
  fs.writeFileSync(writerPath, WRITER);

  const delivered = new Set();
  const walked = [];
  const w = new CWatcher({
    cfg: {
      ...resolveConfig({}),
      watchDirs: [{ path: root, recursive: true, maxDepth: 2 }],
      debounceMs: 50,
      rescanSettleMs: 300,
      rescanCooldownMs: 60000,
    },
    tree: null,
    log: silent,
    onCandidate: (c) => {
      const b = path.basename(c.path);
      if (b.startsWith('pip-rec-')) delivered.add(b);
    },
  });
  const origRescan = w._rescanDir.bind(w);
  w._rescanDir = (p) => {
    walked.push(p);
    return origRescan(p);
  };
  w.start();

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writerPath, sub, '600'], { stdio: 'ignore' });
    child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`writer exit ${c}`))));
    child.on('error', reject);
  });
  await new Promise((r) => setTimeout(r, 12000));
  const stats = w.stats();
  w.stop();

  const created = fs.readdirSync(sub).filter((f) => f.startsWith('pip-rec-')).length;
  if (stats.rescans === 0) {
    skipCheck(
      'E2E burst overflow (rescan ran)',
      `rescans=0: this run's burst did not overflow the buffer (events=${stats.events})`,
    );
    skipCheck('E2E every burst file recovered', `delivered=${delivered.size}/${created} without any rescan`);
    skipCheck('E2E rescan walked the NESTED dir', 'no scan fired');
  } else {
    check('E2E burst overflowed and a rescan ran', stats.rescans >= 1, `rescans=${stats.rescans} events=${stats.events}`);
    check(
      'E2E every burst file recovered despite the overflow',
      delivered.size === created,
      `delivered=${delivered.size}/${created} rescanned=${stats.rescanned}`,
    );
    const subLc = sub.toLowerCase();
    const rootLc = root.toLowerCase();
    check(
      'E2E rescan walked the NESTED burst directory, not the watched root',
      walked.length >= 1 &&
        walked.every((p) => p.toLowerCase() === subLc || p.toLowerCase().startsWith(subLc + path.sep)),
      `walked=${JSON.stringify(walked)}`,
    );
    check(
      'E2E the watched root itself was NOT walked (targeting saved the file budget)',
      !walked.some((p) => p.toLowerCase() === rootLc),
      `walked=${walked.length} root`,
    );
  }
}

console.log(`\n${pass} pass, ${fail} fail, ${skip} skip`);
process.exitCode = fail === 0 ? 0 : 1;
