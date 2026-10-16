// verifier probe (task-5 item 3, part 2) — CAUSAL diagnosis of the Lead's ONE `row count = 0` run.
//
// Hypothesis (mine, from the probe history): the watcher does NOT scan at start(); it only reacts
// to fs.watch events. An earlier revision of test/adversarial-h2-e2e.mjs created the victim file
// BEFORE apply() armed the watch handle, so no event ever fired, nothing was persisted, and the
// read-back printed "row count = 0" with 4 DEFECTs — which looks like a catastrophic plugin
// failure but is purely a probe-ordering artifact.
//
// This probe proves the cause by running BOTH orders ON PURPOSE and showing the outcome flips.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const base = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp', `dshcc_order_${STAMP}`);
fs.mkdirSync(base, { recursive: true });

const runOrder = async (label, victimFirst) => {
  const dir = path.join(base, label);
  fs.mkdirSync(path.join(dir, 'watched'), { recursive: true });
  const escapeRoot = path.join(dir, 'escape');
  const stateDir = path.join(dir, 'state');
  const dbPath = path.join(stateDir, 'state.db');
  const victim = path.join(dir, 'watched', `order-victim-${label}.tmp`);
  const log = [];

  const { apply } = await import('../index.js');
  const { StateDB } = await import('../lib/state-db.js');
  const cleanups = [];
  const ctx = {
    logger: { debug: (...a) => log.push('debug: ' + a.join(' ')), info: (...a) => log.push('info: ' + a.join(' ')), warn: (...a) => log.push('warn: ' + a.join(' ')), error: (...a) => log.push('error: ' + a.join(' ')) },
    commands: { register: () => () => {} },
    effect: (fn) => { cleanups.push(fn); return () => {}; },
  };

  const cfg = {
    watchDirs: [{ path: path.join(dir, 'watched'), recursive: true, maxDepth: 2 }],
    escapeRoot, stateDir, dbPath, debounceMs: 1200, resolveLockOwner: true,
  };

  if (victimFirst) {
    // THE OLD (BUGGY PROBE) ORDER: file exists before any watch handle is armed.
    fs.writeFileSync(victim, 'O'.repeat(64));
    apply(ctx, cfg);
  } else {
    // THE CURRENT (CORRECT) ORDER: arm the handle first, then create the file.
    apply(ctx, cfg);
    await new Promise((r) => setTimeout(r, 1500));
    fs.writeFileSync(victim, 'O'.repeat(64));
  }

  // Give the debounce (1200ms) plus classify time to run.
  const db = new StateDB(dbPath);
  let rows = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) {
    try { rows = db.list({ limit: 20 }); } catch { rows = []; }
    if (rows.length > 0) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  db.close();
  for (const fn of cleanups.reverse()) { try { await fn(); } catch {} }
  await new Promise((r) => setTimeout(r, 400));
  return { rows: rows.length, paths: rows.map((r) => path.basename(r.file_path)), logLen: log.length };
};

try {
  console.log('=== ORDER A: victim created BEFORE apply() (the original probe order) ===');
  const a = await runOrder('victim-first', true);
  console.log(`  row count = ${a.rows} | rows = ${JSON.stringify(a.paths)} | plugin log lines = ${a.logLen}`);
  console.log('=== ORDER B: victim created AFTER apply() + 1.5s arming delay (current probe order) ===');
  const b = await runOrder('armed-first', false);
  console.log(`  row count = ${b.rows} | rows = ${JSON.stringify(b.paths)} | plugin log lines = ${b.logLen}`);

  console.log('');
  const reproduced = a.rows === 0 && b.rows > 0;
  console.log(`>>> CAUSAL DIAGNOSIS: ${reproduced
    ? 'REPRODUCED — creating the victim before apply() yields row count = 0; arming first yields a row. The Lead\'s row count = 0 was a PROBE-ORDERING FLAKE, not a db.list() throw and not a plugin defect.'
    : `NOT reproduced with this ordering (A=${a.rows}, B=${b.rows}) — the cause is elsewhere; do not claim a flake.`}`);
} finally {
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
}
process.exit(0);
