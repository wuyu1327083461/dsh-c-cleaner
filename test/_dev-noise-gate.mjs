// test/_dev-noise-gate.mjs — watch-tracker probe for the Phase 2 PRD §3.2 include-gate.
//
// Proves, against the REAL CWatcher on a REAL Windows temp directory:
//   * an OTHER-SOFTWARE Temp artifact (`ScopedDir_*.msi`, `Win11SDK_*.msi`) that is
//     brand new (i.e. inside the session window) is REJECTED by the gate, while
//   * a `pip-*` file written into the SAME directory in the SAME second is ADMITTED;
//   * the PRD §3.3 credential-name safety valve admits a file that matches NO signature;
//   * 'audit' counts a would-be drop in stats().gated but still delivers;
//   * 'off' is the Phase 1 passthrough and never touches stats().gated;
//   * both decision paths are exercised: the `_settle` fast path (rule #1 provably
//     impossible because tree.hasHandleBackend === false) and the authoritative
//     post-attribution decision in `_emit` (flag absent, ownerOf resolves to null);
//   * stats() counters are exact, not "greater than".
//
// Run: node test/_dev-noise-gate.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { CWatcher } from '../lib/watcher.js';

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL ${name}: ${err && err.message ? err.message : String(err)}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const STAMP = Date.now().toString(36);

/** Give the watcher time to debounce, attribute and deliver, or give up. */
async function waitFor(pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(40);
  }
  return pred();
}

/** A tree stub with NO hasHandleBackend key -> the fast path must NOT fire. */
const treeNoFlag = () => ({
  ownerOf: async () => null,
  nameOf: () => null,
  isTreeMember: () => false,
  pids: () => new Set(),
  snapshot: () => [],
  refresh: async () => ({ count: 0, total: 0 }),
});

/** A tree stub that admits rule #1 is impossible -> the `_settle` fast path fires. */
const treeNoBackend = () => ({ ...treeNoFlag(), hasHandleBackend: false });

// NOTE on the probe root: it must NOT live under a protectRoot, or the protected-path
// veto fires before the gate is ever consulted (which is correct behaviour, but proves
// nothing about the gate). `os.tmpdir()` on this host resolves into
// `E:\dsh_escape_cache\temp`, and `E:\dsh_escape_cache` IS the default `escapeRoot`
// protectRoot — so the probe deliberately uses the production Temp location instead.
const TMP_BASE = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Temp')
  : os.tmpdir();
fs.mkdirSync(TMP_BASE, { recursive: true });
const ROOT = fs.mkdtempSync(path.join(TMP_BASE, 'cc-gate-'));
console.log(`probe root = ${ROOT}`);
console.log(`os.tmpdir() = ${os.tmpdir()}`);

/** Build a watcher over a fresh subdirectory with the given mode. */
function makeWatcher(mode, tree, dir) {
  const cfg = resolveConfig({
    noiseGate: mode,
    debounceMs: 250,
    watchDirs: [{ path: dir, recursive: false, maxDepth: 1 }],
  });
  const hits = [];
  const w = new CWatcher({ cfg, tree, log: LOG, onCandidate: (c) => hits.push(c) });
  return { w, hits, cfg };
}

async function main() {
  // ---------------------------------------------------------------- enforce ----
  // Fast path: rule #1 is provably impossible (hasHandleBackend === false).
  {
    const dir = path.join(ROOT, 'enforce-fast');
    fs.mkdirSync(dir, { recursive: true });
    const { w, hits } = makeWatcher('enforce', treeNoBackend(), dir);
    const started = w.start();
    console.log(`enforce-fast watching = ${JSON.stringify(started.watching)}`);

    const pip = path.join(dir, `pip-gate-probe-${STAMP}.log`);
    const msi = path.join(dir, `ScopedDir_kgate_${STAMP}.msi`);
    const sdk = path.join(dir, `Win11SDK_kgate_${STAMP}.msi`);
    const cred = path.join(dir, `credentials-${STAMP}.json`);

    fs.writeFileSync(pip, 'x'.repeat(2048));
    fs.writeFileSync(msi, 'y'.repeat(4096));
    fs.writeFileSync(sdk, 'z'.repeat(4096));
    fs.writeFileSync(cred, '{"token":"redacted"}');

    await waitFor(() => w.stats().candidates >= 2 || hits.length >= 2);
    await sleep(600); // let any late (wrong) delivery show up before asserting
    const st = w.stats();
    w.stop();

    const delivered = hits.map((h) => path.basename(h.path)).sort();
    console.log(`enforce-fast delivered = ${JSON.stringify(delivered)}`);
    console.log(
      `enforce-fast stats = ${JSON.stringify({
        events: st.events,
        candidates: st.candidates,
        filtered: st.filtered,
        gated: st.gated,
        scanned: st.scanned,
      })}`,
    );

    check('enforce: pip-* admitted by rule #2 (signature glob)', () => {
      if (!delivered.includes(path.basename(pip))) throw new Error(`pip file not delivered: ${JSON.stringify(delivered)}`);
    });
    check('enforce: credentials-* admitted by the §3.3 valve (no signature match)', () => {
      if (!delivered.includes(path.basename(cred)))
        throw new Error(`credential file not delivered: ${JSON.stringify(delivered)}`);
    });
    check('enforce: ScopedDir_*.msi REJECTED (other-software Temp artifact)', () => {
      if (delivered.includes(path.basename(msi))) throw new Error('other-software .msi was admitted');
    });
    check('enforce: Win11SDK_*.msi REJECTED (other-software Temp artifact)', () => {
      if (delivered.includes(path.basename(sdk))) throw new Error('other-software .msi was admitted');
    });
    check('enforce: exactly 2 candidates and exactly 2 gated (exact, not >=)', () => {
      if (st.candidates !== 2) throw new Error(`candidates=${st.candidates}, expected 2`);
      if (st.gated !== 2) throw new Error(`gated=${st.gated}, expected 2`);
      if (st.scanned !== 4) throw new Error(`scanned=${st.scanned}, expected 4`);
    });
    check('enforce: gated drops are also counted in filtered', () => {
      if (st.filtered !== 2) throw new Error(`filtered=${st.filtered}, expected 2`);
    });
  }

  // ----------------------------------------------- enforce, authoritative path ----
  // No hasHandleBackend flag -> _settle must NOT short-circuit; the decision is made in
  // `_emit` AFTER ownerOf() resolved to null.
  {
    const dir = path.join(ROOT, 'enforce-emit');
    fs.mkdirSync(dir, { recursive: true });
    const { w, hits } = makeWatcher('enforce', treeNoFlag(), dir);
    w.start();

    const pip = path.join(dir, `pip-emit-probe-${STAMP}.log`);
    const junk = path.join(dir, `ScopedDir_emit_${STAMP}.msi`);
    fs.writeFileSync(pip, 'x');
    fs.writeFileSync(junk, 'y');

    await waitFor(() => hits.length >= 1);
    await sleep(600);
    const st = w.stats();
    w.stop();

    const delivered = hits.map((h) => path.basename(h.path)).sort();
    console.log(`enforce-emit delivered = ${JSON.stringify(delivered)}`);
    console.log(`enforce-emit stats = ${JSON.stringify({ candidates: st.candidates, filtered: st.filtered, gated: st.gated })}`);

    check('enforce (post-attribution): pip-* admitted, other-software REJECTED', () => {
      if (!delivered.includes(path.basename(pip))) throw new Error('pip file not delivered');
      if (delivered.includes(path.basename(junk))) throw new Error('other-software file was admitted');
      if (st.candidates !== 1) throw new Error(`candidates=${st.candidates}, expected 1`);
      if (st.gated !== 1) throw new Error(`gated=${st.gated}, expected 1`);
    });
  }

  // ------------------------------------------------------------------ audit ----
  {
    const dir = path.join(ROOT, 'audit');
    fs.mkdirSync(dir, { recursive: true });
    const { w, hits } = makeWatcher('audit', treeNoBackend(), dir);
    w.start();

    const junk = path.join(dir, `ScopedDir_audit_${STAMP}.msi`);
    fs.writeFileSync(junk, 'y');

    await waitFor(() => hits.length >= 1);
    await sleep(600);
    const st = w.stats();
    w.stop();

    console.log(`audit delivered = ${JSON.stringify(hits.map((h) => path.basename(h.path)))}`);
    console.log(`audit stats = ${JSON.stringify({ candidates: st.candidates, filtered: st.filtered, gated: st.gated })}`);

    check('audit: would-be drop is STILL delivered and counted in gated', () => {
      if (hits.length !== 1) throw new Error(`hits=${hits.length}, expected the file to still be delivered`);
      if (st.gated !== 1) throw new Error(`gated=${st.gated}, expected 1`);
      if (st.candidates !== 1) throw new Error(`candidates=${st.candidates}, expected 1`);
      if (st.filtered !== 0) throw new Error(`filtered=${st.filtered}, audit must not drop`);
    });
  }

  // -------------------------------------------------------------------- off ----
  {
    const dir = path.join(ROOT, 'off');
    fs.mkdirSync(dir, { recursive: true });
    const { w, hits } = makeWatcher('off', treeNoBackend(), dir);
    w.start();

    const junk = path.join(dir, `ScopedDir_off_${STAMP}.msi`);
    fs.writeFileSync(junk, 'y');

    await waitFor(() => hits.length >= 1);
    await sleep(600);
    const st = w.stats();
    w.stop();

    console.log(`off delivered = ${JSON.stringify(hits.map((h) => path.basename(h.path)))}`);
    console.log(`off stats = ${JSON.stringify({ candidates: st.candidates, filtered: st.filtered, gated: st.gated })}`);

    check("off: passthrough delivers and never touches gated", () => {
      if (hits.length !== 1) throw new Error(`hits=${hits.length}, expected passthrough delivery`);
      if (st.gated !== 0) throw new Error(`gated=${st.gated}, 'off' must never count`);
      if (st.candidates !== 1) throw new Error(`candidates=${st.candidates}, expected 1`);
    });
  }

  // ------------------------------------------------- valve is switchable off ----
  {
    const dir = path.join(ROOT, 'valve-off');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = resolveConfig({
      noiseGate: 'enforce',
      admitCriticalNames: false,
      debounceMs: 250,
      watchDirs: [{ path: dir, recursive: false, maxDepth: 1 }],
    });
    const hits = [];
    const w = new CWatcher({ cfg, tree: treeNoBackend(), log: LOG, onCandidate: (c) => hits.push(c) });
    w.start();

    fs.writeFileSync(path.join(dir, `token-${STAMP}.json`), '{"k":"v"}');
    await waitFor(() => w.stats().gated >= 1);
    await sleep(400);
    const st = w.stats();
    w.stop();

    console.log(`valve-off delivered = ${JSON.stringify(hits.map((h) => path.basename(h.path)))}`);
    check('admitCriticalNames:false turns the §3.3 valve off (credential-shaped name rejected)', () => {
      if (hits.length !== 0) throw new Error(`hits=${hits.length}, expected the valve to be off`);
      if (st.gated !== 1) throw new Error(`gated=${st.gated}, expected 1`);
    });
  }

  // ------------------------------------------- fail-closed mode + in-window check ----
  {
    const dir = path.join(ROOT, 'modes');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = resolveConfig({
      noiseGate: 'DISABLED', // junk -> must fail CLOSED to enforce
      debounceMs: 250,
      watchDirs: [{ path: dir, recursive: false, maxDepth: 1 }],
    });
    console.log(`junk noiseGate -> cfg.noiseGate = ${JSON.stringify(cfg.noiseGate)}`);
    check("junk noiseGate resolves to 'enforce' (fail closed)", () => {
      if (cfg.noiseGate !== 'enforce') throw new Error(`got ${cfg.noiseGate}`);
    });

    const hits = [];
    const w = new CWatcher({ cfg, tree: treeNoBackend(), log: LOG, onCandidate: (c) => hits.push(c) });
    w.start();
    fs.writeFileSync(path.join(dir, `ScopedDir_mode_${STAMP}.msi`), 'y');
    await waitFor(() => w.stats().gated >= 1);
    await sleep(400);
    const st = w.stats();
    w.stop();
    check("a cfg object carrying junk mode still behaves as 'enforce'", () => {
      if (hits.length !== 0) throw new Error('junk mode let an other-software file through');
      if (st.gated !== 1) throw new Error(`gated=${st.gated}, expected 1`);
    });

    // Out-of-window: even a signature-matching file must be rejected when it is older
    // than sessionWindowMs (rule #2 requires BOTH halves).
    const dir2 = path.join(ROOT, 'oldfile');
    fs.mkdirSync(dir2, { recursive: true });
    const old = path.join(dir2, `pip-old-${STAMP}.log`);
    fs.writeFileSync(old, 'old');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);

    const cfg2 = resolveConfig({
      noiseGate: 'enforce',
      sessionWindowMs: 10 * 60 * 1000,
      debounceMs: 250,
      watchDirs: [{ path: dir2, recursive: false, maxDepth: 1 }],
    });
    const hits2 = [];
    const w2 = new CWatcher({ cfg: cfg2, tree: treeNoBackend(), log: LOG, onCandidate: (c) => hits2.push(c) });
    w2.start();
    // Touch it so the watcher sees an event, but keep the mtime old.
    fs.writeFileSync(old, 'old-but-evented');
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
    await waitFor(() => w2.stats().gated >= 1);
    await sleep(400);
    const st2 = w2.stats();
    w2.stop();

    console.log(`old-file delivered = ${JSON.stringify(hits2.map((h) => path.basename(h.path)))}`);
    check('rule #2 requires the session window: an old pip-*.log is rejected', () => {
      if (hits2.length !== 0) throw new Error('a file outside the session window was admitted');
      if (st2.gated !== 1) throw new Error(`gated=${st2.gated}, expected 1`);
    });

    // The same claim, but forced through the AUTHORITATIVE post-attribution decision in
    // `_emit` (tree has no handle-backend flag, so `_settle` must not short-circuit).
    // Without this case the `inWindow &&` half of rule #2 could be deleted from `_emit`
    // and the probe would still pass — that mutation survived until this case was added.
    const dir3 = path.join(ROOT, 'oldfile-emit');
    fs.mkdirSync(dir3, { recursive: true });
    const old3 = path.join(dir3, `pip-old-emit-${STAMP}.log`);
    fs.writeFileSync(old3, 'old');
    fs.utimesSync(old3, twoHoursAgo, twoHoursAgo);

    const cfg3 = resolveConfig({
      noiseGate: 'enforce',
      sessionWindowMs: 10 * 60 * 1000,
      debounceMs: 250,
      watchDirs: [{ path: dir3, recursive: false, maxDepth: 1 }],
    });
    const hits3 = [];
    const w3 = new CWatcher({ cfg: cfg3, tree: treeNoFlag(), log: LOG, onCandidate: (c) => hits3.push(c) });
    w3.start();
    fs.writeFileSync(old3, 'old-but-evented');
    fs.utimesSync(old3, twoHoursAgo, twoHoursAgo);
    await waitFor(() => w3.stats().gated >= 1);
    await sleep(400);
    const st3 = w3.stats();
    w3.stop();

    console.log(`old-file (post-attribution) delivered = ${JSON.stringify(hits3.map((h) => path.basename(h.path)))}`);
    check('rule #2 session window is enforced in the post-attribution decision too', () => {
      if (hits3.length !== 0) throw new Error('an out-of-window file was admitted by _emit');
      if (st3.gated !== 1) throw new Error(`gated=${st3.gated}, expected 1`);
      if (st3.candidates !== 0) throw new Error(`candidates=${st3.candidates}, expected 0`);
    });

    // And the mirror image in 'audit': the SAME out-of-window pip file must be counted as
    // a would-be drop yet still delivered — proving the in-window half is part of the
    // admission decision rather than a separate early return.
    const dir4 = path.join(ROOT, 'oldfile-audit');
    fs.mkdirSync(dir4, { recursive: true });
    const old4 = path.join(dir4, `pip-old-audit-${STAMP}.log`);
    fs.writeFileSync(old4, 'old');
    fs.utimesSync(old4, twoHoursAgo, twoHoursAgo);

    const cfg4 = resolveConfig({
      noiseGate: 'audit',
      sessionWindowMs: 10 * 60 * 1000,
      debounceMs: 250,
      watchDirs: [{ path: dir4, recursive: false, maxDepth: 1 }],
    });
    const hits4 = [];
    const w4 = new CWatcher({ cfg: cfg4, tree: treeNoFlag(), log: LOG, onCandidate: (c) => hits4.push(c) });
    w4.start();
    fs.writeFileSync(old4, 'old-but-evented');
    fs.utimesSync(old4, twoHoursAgo, twoHoursAgo);
    await waitFor(() => w4.stats().gated >= 1);
    await sleep(400);
    const st4 = w4.stats();
    w4.stop();

    console.log(`old-file (audit) delivered = ${JSON.stringify(hits4.map((h) => path.basename(h.path)))}`);
    check('audit: an out-of-window pip-*.log is gated AND still delivered', () => {
      if (st4.gated !== 1) throw new Error(`gated=${st4.gated}, expected 1`);
      if (hits4.length !== 1) throw new Error(`hits=${hits4.length}, audit must still deliver`);
      if (st4.candidates !== 1) throw new Error(`candidates=${st4.candidates}, expected 1`);
    });
  }

  // ------------------------------- the fast path really SKIPS attribution ----
  // The `_settle` short-circuit exists to avoid a provably-futile attribution round-trip.
  // Its admission verdict and every counter are IDENTICAL to "attribute, then reject in
  // `_emit`", so the call count is the only observable that separates them. It is also
  // what kills the otherwise-equivalent-looking mutation that forces `inSessionWindow`
  // to true inside `_gateInputs`: the stale-but-signature-shaped `pip-*.log` below would
  // then fall through to `ownerOf` and the count would be 2 instead of 1.
  {
    const dir = path.join(ROOT, 'fastpath');
    fs.mkdirSync(dir, { recursive: true });
    let ownerCalls = 0;
    const countingTree = {
      ownerOf: async () => {
        ownerCalls += 1;
        return null;
      },
      nameOf: () => null,
      isTreeMember: () => false,
      hasHandleBackend: false, // rule #1 is provably impossible -> fast path is legal
    };
    const cfg = resolveConfig({
      noiseGate: 'enforce',
      sessionWindowMs: 10 * 60 * 1000,
      debounceMs: 250,
      watchDirs: [{ path: dir, recursive: false, maxDepth: 1 }],
    });
    const hits = [];
    const w = new CWatcher({ cfg, tree: countingTree, log: LOG, onCandidate: (c) => hits.push(c) });
    w.start();

    // Signature-shaped but OUTSIDE the window -> fast path must reject it without asking.
    const stalePip = path.join(dir, `pip-stale-${STAMP}.log`);
    fs.writeFileSync(stalePip, 'stale');
    const twoHoursAgo2 = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stalePip, twoHoursAgo2, twoHoursAgo2);
    // Signature-shaped and INSIDE the window -> must be attributed (one ownerOf call).
    const freshPip = path.join(dir, `pip-fresh-${STAMP}.log`);
    fs.writeFileSync(freshPip, 'fresh');

    await waitFor(() => w.stats().gated >= 1 && w.stats().candidates >= 1);
    await sleep(500);
    const st = w.stats();
    w.stop();
    console.log(
      `fastpath: ownerOf calls = ${ownerCalls}, gated = ${st.gated}, candidates = ${st.candidates}, ` +
        `delivered = ${JSON.stringify(hits.map((h) => path.basename(h.path)))}`,
    );

    check('fast path drops a provably-rejected file WITHOUT consulting attribution', () => {
      if (st.gated !== 1) throw new Error(`gated=${st.gated}, expected 1 (the stale pip-*.log)`);
      if (ownerCalls !== 1) {
        throw new Error(`ownerOf calls=${ownerCalls}, expected exactly 1 (only the in-window file); ` +
          'the out-of-window file must be rejected in _settle, before attribution');
      }
      if (st.candidates !== 1) throw new Error(`candidates=${st.candidates}, expected 1`);
      if (!hits.map((h) => path.basename(h.path)).includes(path.basename(freshPip))) {
        throw new Error('the in-window pip-*.log was not admitted');
      }
    });
  }

  console.log(`SUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  process.exit(fail === 0 ? 0 : 1);
}

await main();
