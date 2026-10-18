/**
 * Quantify how much of the tracked set is still NOT plausibly dsh-authored.
 *
 * README claims the PRD 3.2 gate narrows the noise. That claim is worth a number, not an
 * adjective — and the number that matters is the residual, because rule #2 (the only rule
 * that runs in production) is a NAME-SHAPE heuristic, and some shapes it accepts (`*.log`,
 * `*.tmp`) are shapes other software uses too.
 *
 * Read-only. Splits the surviving rows three ways:
 *   A. a toolchain-SPECIFIC signature (pip-*, torch*, hf-*, node-* ...) -> strong dsh signal
 *   B. a GENERIC extension signature (*.log, *.tmp, *.bak, *.pyc) -> weak, ambiguous
 *   C. no signature at all -> only reachable via the PRD 3.3 credential valve
 */
import { StateDB } from '../lib/state-db.js';
import { resolveConfig } from '../lib/config.js';
import { compileSignatureGlobs, signatureListFrom, classifyName } from '../lib/watcher.js';

const cfg = resolveConfig({});
// Split the RAW glob strings first: compileSignatureGlobs() returns RegExp[], which has no
// memory of the glob that produced it. Getting this backwards silently made every row land
// in one bucket on the first run of this probe.
const rawList = signatureListFrom(cfg);
// The split that matters is NOT "extension vs name" — it is whether the pattern names an
// AI toolchain at all. `tmp*`, `tmp-*`, `*.log`, `*.tmp`, `*.bak`, `*.pyc` come straight
// from the PRD's ILLUSTRATIVE list, but on Windows they are shapes the OS and other
// software produce constantly (BITS `BIT*.tmp`, Visual Studio `tmp.edb`, Adobe
// `dunamis-*.log`), so on their own they carry almost no attribution signal.
const GENERIC = /^\*\.(log|tmp|bak|pyc)$|^tmp\*$|^tmp-\*$/i;
const genericGlobs = compileSignatureGlobs(rawList.filter((g) => GENERIC.test(g)));
const specificGlobs = compileSignatureGlobs(rawList.filter((g) => !GENERIC.test(g)));
const all = compileSignatureGlobs(rawList);

// `matchesAnyGlob` is module-private, so drive the two halves through the public
// `classifyName` with the valve OFF — that isolates the pure signature test.
const hitsSpecific = (p) => classifyName(p, specificGlobs, false).signatureMatch;
const hitsGeneric = (p) => classifyName(p, genericGlobs, false).signatureMatch;

const db = new StateDB(process.argv[2] || 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db', { create: false });
const rows = db.list({ limit: 5000 });

let specific = 0;
let generic = 0;
let valve = 0;
let other = 0;
const buckets = { specific: [], generic: [], valve: [], other: [] };

for (const row of rows) {
  const p = row.file_path;
  if (hitsSpecific(p)) {
    specific += 1;
    if (buckets.specific.length < 8) buckets.specific.push(p);
  } else if (hitsGeneric(p)) {
    generic += 1;
    if (buckets.generic.length < 12) buckets.generic.push(p);
  } else if (classifyName(p, all, true).criticalName) {
    valve += 1;
    if (buckets.valve.length < 5) buckets.valve.push(p);
  } else {
    other += 1;
    if (buckets.other.length < 5) buckets.other.push(p);
  }
}

const total = rows.length;
const pct = (n) => `${((n / (total || 1)) * 100).toFixed(1)}%`;

console.log(`db            : ${process.argv[2] || 'E:\\dsh\\.dsh\\plugins\\c_cleaner\\state.db'}`);
console.log(`tracked rows  : ${total}`);
console.log(`signature list: ${all.length} globs (${specificGlobs.length} toolchain-specific, ${genericGlobs.length} generic)`);
console.log('');
console.log(`A toolchain-specific (*pip-*, *torch*, ...) : ${String(specific).padStart(5)}  ${pct(specific)}`);
console.log(`B generic extension (*.log, *.tmp, ...)      : ${String(generic).padStart(5)}  ${pct(generic)}`);
console.log(`C PRD 3.3 credential valve                   : ${String(valve).padStart(5)}  ${pct(valve)}`);
console.log(`D no signature at all                        : ${String(other).padStart(5)}  ${pct(other)}`);
console.log('');
console.log('sample A (toolchain-specific):');
for (const p of buckets.specific) console.log(`  ${p}`);
console.log('sample B (generic — the ambiguous residual):');
for (const p of buckets.generic) console.log(`  ${p}`);

db.close();
process.exit(0);
