// Lead-owned audit (read-only): classify EVERY persisted row against the CURRENT shipped gate.
//
// WHY: a superseded watcher generation keeps writing rows under the gate rules it was born
// with, so some persisted rows are ones the current gate would REJECT. This audit quantifies
// that residue per tier and, crucially, proves the safety claim: the residue must be confined
// to tiers that are never deleted (PRD 3.3), never to the deletable green tier.
//
// A row that is RED but gate-rejected is a sound phantom signature: red requires the loose TIER
// predicate to match, and the gate then rejects it, which means neither a signature glob nor the
// TIGHT valve matched — i.e. it was admitted by the OLD loose valve (or pre-gate Phase 1).
//
// RUN: node test/_lead-p2-gate-residue.mjs
import { DatabaseSync } from 'node:sqlite';
import { compileSignatureGlobs, signatureListFrom, classifyName } from '../lib/watcher.js';
import { resolveConfig } from '../lib/config.js';

const DB = process.argv[2] ?? 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db';
const db = new DatabaseSync(DB);
const rows = db.prepare('SELECT file_path, category, is_locked FROM tracked_files').all();
db.close();

const cfg = resolveConfig({});
const globs = compileSignatureGlobs(signatureListFrom(cfg));
const admitCritical = cfg.admitCriticalNames !== false;

const byCat = new Map();
const rejected = new Map();
const examples = new Map();
for (const r of rows) {
  const cat = r.category ?? '(none)';
  byCat.set(cat, (byCat.get(cat) ?? 0) + 1);
  const { pass } = classifyName(r.file_path, globs, admitCritical);
  if (!pass) {
    rejected.set(cat, (rejected.get(cat) ?? 0) + 1);
    if (!examples.has(cat)) examples.set(cat, []);
    if (examples.get(cat).length < 4) examples.get(cat).push(r.file_path);
  }
}

console.log(`DB: ${DB}`);
console.log(`total rows: ${rows.length}`);
console.log('');
for (const [cat, n] of [...byCat.entries()].sort()) {
  const rej = rejected.get(cat) ?? 0;
  console.log(`${cat.padEnd(18)} ${String(n).padStart(5)}   gate-rejected: ${String(rej).padStart(5)}`);
  for (const p of examples.get(cat) ?? []) console.log(`      - ${p}`);
}
const greenRejected = rejected.get('SAFE_TO_DELETE') ?? 0;
console.log('');
console.log(
  greenRejected === 0
    ? 'SAFETY OK: no DELETABLE row is gate-rejected, so the phantom residue is never a deletion hazard'
    : `SAFETY VIOLATION: ${greenRejected} deletable row(s) are gate-rejected`,
);
process.exitCode = greenRejected === 0 ? 0 : 1;
