// Lead: diagnose why adversarial-h2-e2e.mjs persisted ZERO rows.
// The row is written by onCandidate -> db.upsert, which runs BEFORE enrichOwner (the only code path
// my lock-owner.js edit touches). So either the watcher never emitted, or apply() did not wire the
// watcher at all. This probe uses a VERBOSE logger to see which.
import fs from 'node:fs';
import path from 'node:path';

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const base = path.join(process.env.LOCALAPPDATA || process.cwd(), 'Temp', `dshcc_diag_${STAMP}`);
const watchDir = path.join(base, 'watched');
const escapeRoot = path.join(base, 'escape');
const stateDir = path.join(base, 'state');
for (const d of [watchDir, escapeRoot, stateDir]) fs.mkdirSync(d, { recursive: true });
console.log('watchDir =', watchDir);

const lines = [];
const mk = (lvl) => (...a) => { const s = `[${lvl}] ${a.join(' ')}`; lines.push(s); console.log('   ' + s); };
const log = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };

const cleanups = [];
const ctx = {
  logger: log,
  commands: { register: () => () => {} },
  effect: (fn) => { cleanups.push(fn); return () => {}; },
};

const { apply } = await import('../index.js');
const { StateDB } = await import('../lib/state-db.js');

const cfgUsed = {
  watchDirs: [{ path: watchDir, recursive: true, maxDepth: 2 }],
  escapeRoot, stateDir, dbPath: path.join(stateDir, 'state.db'),
  debounceMs: 2000, resolveLockOwner: true,
};
console.log('apply() now...');
apply(ctx, cfgUsed);

await new Promise((r) => setTimeout(r, 1500));
const victim = path.join(watchDir, `diag-victim-${STAMP}.tmp`);
fs.writeFileSync(victim, 'x'.repeat(32));
console.log('wrote victim:', path.basename(victim));
console.log('victim exists:', fs.existsSync(victim));

await new Promise((r) => setTimeout(r, 8000));

const db = new StateDB(cfgUsed.dbPath);
const rows = db.list({ limit: 50 });
console.log('\n=== rows ===');
console.log('count =', rows.length);
for (const r of rows) console.log('  ', JSON.stringify({ p: r.file_path, cat: r.category, pid: r.locked_by_pid }));
db.close();

console.log('\n=== log lines mentioning watch/candidate ===');
for (const l of lines) if (/watch|candidate|classif|error|warn|fail|ready|hijack/i.test(l)) console.log('  ', l);

console.log('\n=== db files in stateDir ===');
for (const f of fs.readdirSync(stateDir)) {
  const st = fs.statSync(path.join(stateDir, f));
  console.log('  ', f, st.size);
}

for (const fn of cleanups.reverse()) { try { await fn(); } catch (e) { console.log('cleanup err', e.message); } }
try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
setTimeout(() => process.exit(0), 500);
