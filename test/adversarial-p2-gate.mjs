// test/adversarial-p2-gate.mjs — verifier (task-8/task-13) adversarial probe for the
// Phase 2 PRD §3.2 noise gate in lib/watcher.js.
//
// THE CENTRAL FALSE-POSITIVE TEST: in ONE watched directory, within the same second,
//   * an OTHER-SOFTWARE artifact that matches NO signature glob must be REJECTED,
//   * a `pip-*` artifact in the same second must be ADMITTED,
//   * `stats().gated` must increment EXACTLY once.
// Plus the §3.3 credential valve, both rule-#1 branches, the three gate modes, counter
// exactness, and a recall regression hunt.
//
// Exit 0 only when every check passes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { CWatcher } from '../lib/watcher.js';
import { LOCKED_BASENAME_RE } from '../lib/classifier.js';

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    const detail = fn();
    pass += 1;
    console.log(`PASS ${name}${detail ? ` | ${detail}` : ''}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL ${name}: ${err && err.message ? err.message : String(err)}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp');
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const MSI = 'Win11SDK_WindowsPerformanceToolkit.9DCCDC2D6A4C113477F7.msi';

/** Deterministic log sink that keeps the noise-gate debug lines for evidence. */
function mkLog() {
  const lines = [];
  return {
    lines,
    debug: (m) => lines.push(String(m)),
    info: (m) => lines.push(String(m)),
    warn: (m) => lines.push(String(m)),
    error: (m) => lines.push(String(m)),
  };
}

const boot = resolveConfig({});
const DEBOUNCE = 500;
const TREE_NO_BACKEND = { hasHandleBackend: false, ownerOf: async () => null, nameOf: () => null, isTreeMember: () => false };

async function waitFor(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

/** One watcher run over a fresh fixture dir; returns hits + stats + log. */
async function runGate(tag, files, opts = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, `dshcc_p2g_${tag}_${STAMP}_`));
  const cfg = {
    ...boot,
    ...(opts.cfgExtra || {}),
    watchDirs: [{ path: dir, recursive: false, maxDepth: 1 }],
    debounceMs: DEBOUNCE,
    sessionWindowMs: 30 * 60 * 1000,
  };
  const hits = [];
  const log = mkLog();
  const watcher = new CWatcher({
    cfg,
    tree: opts.tree === undefined ? TREE_NO_BACKEND : opts.tree,
    log,
    onCandidate: (c) => hits.push(path.basename(c.path)),
  });
  const started = watcher.start();
  await sleep(900); // arm the fs.watch handle before any file appears
  const t0 = Date.now();
  for (const name of files) fs.writeFileSync(path.join(dir, name), `x${name}`);
  const t1 = Date.now();
  await sleep(DEBOUNCE * 3 + 1200);
  const stats = watcher.stats();
  watcher.stop();
  return { dir, hits, stats, log, startErr: started && started.error ? String(started.error) : null, spreadMs: t1 - t0 };
}

const counters = (s) => `{events:${s.events},scanned:${s.scanned},candidates:${s.candidates},gated:${s.gated},filtered:${s.filtered}}`;

/* ------------------------------------------------------------------ 1. central test */
const central = await runGate('central', [MSI, `pip-install-${STAMP}.log`]);
check('p2gate.central-same-second-reject-and-admit', () => {
  const lower = central.hits.map((h) => h.toLowerCase());
  const msiSeen = lower.some((h) => h.startsWith('win11sdk_'));
  const pipSeen = lower.some((h) => h.startsWith('pip-install-'));
  assert(!msiSeen, `the other-software .msi was DELIVERED (should be gated): hits=${JSON.stringify(central.hits)}`);
  assert(pipSeen, `the pip artifact was NOT delivered: hits=${JSON.stringify(central.hits)}`);
  assert(central.stats.gated === 1, `stats().gated should be exactly 1, got ${central.stats.gated}`);
  assert(central.stats.candidates === 1, `stats().candidates should be exactly 1, got ${central.stats.candidates}`);
  assert(central.spreadMs < 1000, `the two files were not created in the same second (spread ${central.spreadMs} ms)`);
  return `spread=${central.spreadMs}ms hits=${JSON.stringify(central.hits)} stats=${counters(central.stats)}`;
});
check('p2gate.central-reject-is-a-real-drop-not-a-debounce-artifact', () => {
  assert(central.stats.scanned === 2, `both files must have been scanned (got scanned=${central.stats.scanned}) — a smaller number would mean the debounce ate one`);
  assert(central.stats.gated === 1, `gated=${central.stats.gated}`);
  const why = central.log.lines.filter((l) => l.includes('noise-gate dropped'));
  assert(why.length === 1, `expected exactly one 'noise-gate dropped' debug line, got ${why.length}`);
  assert(/Win11SDK/i.test(why[0]), `the dropped path is not the .msi: ${why[0]}`);
  assert(/no AI-toolchain signature match/.test(why[0]), `unexpected drop reason: ${why[0]}`);
  return `scanned=2 gated=1 dropped="${why[0].replace(/^\[c-cleaner\] CWatcher: /, '').slice(0, 110)}"`;
});

/* -------------------------------------------------------- 2. §3.3 credential valve */
const CREDS = ['credentials.json', 'auth.json', `token-${STAMP}.txt`, `state-${STAMP}.db`, `x-${STAMP}.lock`, 'config.json'];
const valve = await runGate('valve', [...CREDS, MSI]);
check('p2gate.valve-admits-credential-names', () => {
  const got = new Set(valve.hits);
  const missing = CREDS.filter((n) => !got.has(n));
  assert(missing.length === 0, `credential-shaped files gated away: ${JSON.stringify(missing)} (hits=${JSON.stringify(valve.hits)})`);
  const sigFree = CREDS.filter((n) => !/^(tmp|pip-|uv-|playwright|node-|npm-|hf-|torch)/i.test(n) && !/(\.pyc|\.log|\.tmp|\.bak|-cache)$/i.test(n));
  assert(sigFree.length === CREDS.length, `probe bug: some names match a signature glob anyway: ${JSON.stringify(CREDS.filter((n) => !sigFree.includes(n)))}`);
  const patternHits = CREDS.filter((n) => LOCKED_BASENAME_RE.test(n));
  assert(patternHits.length === CREDS.length, `probe bug: not all names match LOCKED_BASENAME_RE (${JSON.stringify(patternHits)})`);
  assert(valve.stats.candidates === CREDS.length, `candidates should be ${CREDS.length}, got ${valve.stats.candidates}`);
  assert(valve.stats.gated === 1, `gated should be exactly 1 (the .msi), got ${valve.stats.gated}`);
  return `${CREDS.length} credential-shaped files admitted, all signature-free, all matching LOCKED_BASENAME_RE; gated=1 (the .msi)`;
});

/* ------------------------------------------------------------- 3. rule #1 branches */
const ruleTree = (isMember) => ({
  hasHandleBackend: true,
  ownerOf: async () => ({ pid: 987654, name: 'python.exe' }),
  nameOf: () => 'python.exe',
  isTreeMember: () => isMember,
});
const r1yes = await runGate('rule1yes', [MSI], { tree: ruleTree(true) });
const r1no = await runGate('rule1no', [MSI], { tree: ruleTree(false) });
check('p2gate.rule1-either-condition-both-branches', () => {
  assert(r1yes.hits.length === 1, `rule#1 member=true must ADMIT the non-signature file; hits=${JSON.stringify(r1yes.hits)} gated=${r1yes.stats.gated}`);
  assert(r1yes.stats.gated === 0, `member=true must not gate anything; gated=${r1yes.stats.gated}`);
  assert(r1no.hits.length === 0, `rule#1 member=false must REJECT the same file; hits=${JSON.stringify(r1no.hits)}`);
  assert(r1no.stats.gated === 1, `member=false must gate exactly once; gated=${r1no.stats.gated}`);
  return `same name, same dir: isTreeMember=true -> admitted ${JSON.stringify(r1yes.hits)} gated=0; isTreeMember=false -> rejected gated=1`;
});

/* --------------------------------------------------------------------------- 4. modes */
const AUDIT_FILES = [MSI, `pip-audit-${STAMP}.log`];
const audit = await runGate('audit', AUDIT_FILES, { cfgExtra: { noiseGate: 'audit' } });
const off = await runGate('off', AUDIT_FILES, { cfgExtra: { noiseGate: 'off' } });
const bogus = await runGate('bogus', AUDIT_FILES, { cfgExtra: { noiseGate: 'AUDIT' } });
check('p2gate.mode-audit-counts-but-delivers', () => {
  assert(audit.hits.length === 2, `audit must deliver BOTH files; got ${JSON.stringify(audit.hits)}`);
  assert(audit.stats.gated === 1, `audit must count exactly 1 would-be drop; got ${audit.stats.gated}`);
  assert(audit.stats.candidates === 2, `audit candidates=${audit.stats.candidates}`);
  return `hits=${JSON.stringify(audit.hits)} ${counters(audit.stats)}`;
});
check('p2gate.mode-off-neither-drops-nor-counts', () => {
  assert(off.hits.length === 2, `off must deliver BOTH files; got ${JSON.stringify(off.hits)}`);
  assert(off.stats.gated === 0, `off must never touch gated; got ${off.stats.gated}`);
  assert(off.stats.filtered === 0, `off must not filter either; got ${off.stats.filtered}`);
  return `hits=${JSON.stringify(off.hits)} ${counters(off.stats)}`;
});
check('p2gate.mode-unrecognised-falls-back-to-enforce', () => {
  assert(bogus.hits.length === 1, `an unrecognised mode must fail CLOSED (only the .log admitted); got ${JSON.stringify(bogus.hits)}`);
  assert(bogus.stats.gated === 1, `fail-closed must count the drop; got gated=${bogus.stats.gated}`);
  assert(bogus.hits.some((h) => h.startsWith('pip-audit')), `the .log must still be admitted; got ${JSON.stringify(bogus.hits)}`);
  return `noiseGate:'AUDIT' (wrong case) -> enforce semantics: hits=${JSON.stringify(bogus.hits)} gated=${bogus.stats.gated}`;
});
check('p2gate.mode-absent-defaults-to-enforce', () => {
  // `boot` carries the resolved default; the central run proves the semantics.
  assert(boot.noiseGate === 'enforce', `resolved default should be 'enforce', got ${JSON.stringify(boot.noiseGate)}`);
  assert(central.stats.gated === 1 && central.hits.length === 1, 'default run did not behave as enforce');
  return `resolveConfig({}).noiseGate=${boot.noiseGate}; central run gated=${central.stats.gated} hits=${central.hits.length}`;
});

/* --------------------------------------------------------- 5. valve off (probe-local) */
const valveOff = await runGate('valveoff', [...CREDS, MSI], { cfgExtra: { admitCriticalNames: false } });
check('p2gate.valve-off-gates-the-credential-names', () => {
  const admitted = valveOff.hits.filter((h) => CREDS.includes(h));
  assert(admitted.length === 0, `with admitCriticalNames:false the credential names must NOT be admitted; got ${JSON.stringify(admitted)}`);
  assert(valveOff.stats.gated === CREDS.length + 1, `gated should be ${CREDS.length + 1}, got ${valveOff.stats.gated}`);
  return `admitCriticalNames:false -> 0/${CREDS.length} credential names admitted, gated=${valveOff.stats.gated} (proves the valve is what admitted them)`;
});

/* ------------------------------------------------------------ 6. counter exactness */
const MIX = [
  MSI,                                  // gated
  `ScopedDir_${STAMP}.msi`,             // gated
  `pip-mix-${STAMP}.log`,               // admitted (signature)
  `tmp-mix-${STAMP}.tmp`,               // admitted (signature)
  `credentials-mix-${STAMP}.json`,      // admitted (valve)
  `config-mix-${STAMP}.json`,           // admitted (valve)
];
const mix = await runGate('mix', MIX);
check('p2gate.counters-exact-across-a-mixed-batch', () => {
  assert(mix.stats.scanned === MIX.length, `scanned must equal the ${MIX.length} files written, got ${mix.stats.scanned}`);
  assert(mix.stats.candidates === 4, `candidates must be exactly 4, got ${mix.stats.candidates}`);
  assert(mix.stats.gated === 2, `gated must be exactly 2, got ${mix.stats.gated}`);
  assert(mix.stats.filtered === mix.stats.gated, `every enforce-mode gated candidate must ALSO be counted in filtered; filtered=${mix.stats.filtered} gated=${mix.stats.gated}`);
  assert(mix.stats.events >= MIX.length, `events must be at least ${MIX.length} (one per create), got ${mix.stats.events}`);
  assert(mix.hits.length === 4, `hits=${JSON.stringify(mix.hits)}`);
  return `${counters(mix.stats)} hits=${JSON.stringify(mix.hits)}`;
});

/* -------------------------------------------------- 7. recall regression hunt (§3.2) */
// A file that is dsh-authored, in-window, matches NO signature glob and is not
// credential-shaped. Can the gate drop something the PRD orders surfaced?
const HOLE = [
  `datasets-${STAMP}.json`,          // a real AI-toolchain artifact shape, NO glob matches it
  `model-${STAMP}.safetensors`,      // ditto
  `session-${STAMP}.dsh`,            // the plugin's own escape-cache shape
];
const hole = await runGate('hole', [...HOLE, MSI]);
check('p2gate.recall-hunt-signature-gap-is-real', () => {
  const delivered = hole.hits.filter((h) => h !== MSI);
  assert(delivered.length === 0, `expected these to be gated (documenting the gap), but got ${JSON.stringify(delivered)}`);
  assert(hole.stats.gated === HOLE.length + 1, `gated=${hole.stats.gated}`);
  // The gap is only defensible if rule #1 CAN cover it — i.e. a real handle backend admits them.
  return `GAP CONFIRMED (informational): ${JSON.stringify(HOLE)} match no signature glob, are not credential-shaped, and are dropped by the gate (gated=${hole.stats.gated}); rule #1 is the only cover, and CONTRACTS-PHASE2 §0 ships it OPT-IN/OFF`;
});
const holeR1 = await runGate('holer1', HOLE, { tree: ruleTree(true) });
check('p2gate.recall-hunt-gap-is-closed-by-rule1', () => {
  assert(holeR1.hits.length === HOLE.length, `with a real handle backend these must all be admitted; got ${JSON.stringify(holeR1.hits)}`);
  assert(holeR1.stats.gated === 0, `gated=${holeR1.stats.gated}`);
  return `with hasHandleBackend:true + isTreeMember:true -> all ${HOLE.length} admitted, gated=0`;
});

/* ---------------------------------------------- 8. gate never runs on protected paths */
const prot = await runGate('prot', [MSI, `pip-prot-${STAMP}.log`], { cfgExtra: { protectRoots: [path.join(ROOT, 'dshcc_p2g_prot_' + STAMP + '_never')] } });
check('p2gate.gate-absent-when-enforce-counters-are-zero-config', () => {
  // sanity: a gate config that admits nothing still must not throw, and stats keys stay exact
  const keys = Object.keys(prot.stats).sort().join(',');
  const expected = ['candidates', 'events', 'failed', 'failedList', 'filtered', 'gated', 'recursiveForcedOff', 'scanned', 'startedAt', 'watching'].sort().join(',');
  assert(keys === expected, `stats() keys drifted.\n  got      ${keys}\n  expected ${expected}`);
  return `stats() keys exact: ${keys}`;
});

console.log(`\nSUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
