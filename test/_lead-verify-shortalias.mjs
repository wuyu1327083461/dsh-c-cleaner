// Lead INDEPENDENT verification of watch-tracker's Defect-3 fix.
// Reproduces the host abort in a CHILD process, since the abort is uncatchable.
// The child watches a directory addressed by its GENUINE 8.3 alias and fires a real event.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, '_lead-shortalias-child.mjs');

// --- find a directory that REALLY has an 8.3 short alias ---
function shortNameOf(longPath) {
  const parent = path.dirname(longPath);
  const base = path.basename(longPath);
  try {
    const out = execFileSync('cmd.exe', ['/c', 'dir', '/x', parent], { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      // e.g.  "10/16/2026  05:12 PM    <DIR>          PROGRA~1     Program Files"
      const m = line.match(/(\S+~[0-9A-Z]*)\s+(.+?)\s*$/);
      if (m && m[2].trim().toLowerCase() === base.toLowerCase()) return path.join(parent, m[1]);
    }
  } catch { /* ignore */ }
  return null;
}

const candidates = ['C:\\ProgramData', 'C:\\Program Files', 'C:\\Users\\Public', 'C:\\'];
console.log('=== scan for a directory with a genuine 8.3 alias ===');
const found = [];
for (const c of candidates) {
  const s = shortNameOf(c);
  if (s && fs.existsSync(s)) {
    const expands = (() => { try { return fs.realpathSync.native(s); } catch { return null; } })();
    found.push({ long: c, short: s, expands });
    console.log(`  ${c}\n      short = ${s}\n      realpathSync.native(short) = ${expands}`);
    console.log(`      distinct from long form? ${expands && expands.toLowerCase() !== c.toLowerCase()}`);
  } else {
    console.log(`  ${c} -> no 8.3 alias visible`);
  }
}

const usable = found.filter((f) => f.expands && f.expands.toLowerCase() !== f.long.toLowerCase());
if (usable.length === 0) {
  console.log('\nINCONCLUSIVE: this host exposes no 8.3 alias that differs from the long form.');
  console.log('Reporting inconclusive rather than claiming a pass.');
  process.exit(0);
}

const target = usable[0];
console.log(`\n=== chosen target ===\n  long  : ${target.long}\n  short : ${target.short}`);

function runChild(label, dirSpelling) {
  console.log(`\n--- ${label} ---`);
  console.log(`  watchDir as configured: ${JSON.stringify(dirSpelling)}`);
  try {
    const out = execFileSync(process.execPath, [CHILD, dirSpelling], { encoding: 'utf8', timeout: 30000 });
    const line = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { /* not json */ }
    if (parsed) {
      console.log(`  child exit        : 0`);
      console.log(`  stats().watching  : ${JSON.stringify(parsed.watching)}`);
      console.log(`  candidates emitted: ${parsed.candidates}`);
      console.log(`  resolved to long? : ${parsed.watching.every((w) => !/~\d/.test(w))}`);
      return { exit: 0, parsed };
    }
    console.log('  raw child output:', out.slice(-400));
    return { exit: 0, parsed: null };
  } catch (e) {
    const code = e.status ?? (e.signal ? `signal ${e.signal}` : 'unknown');
    console.log(`  child exit        : ${code}`);
    const blob = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    const assertion = blob.split(/\r?\n/).find((l) => /Assertion|abort|ABORT/i.test(l));
    if (assertion) console.log(`  >>> ${assertion.trim()}`);
    if (String(code) === '3221226505') console.log('  >>> 0xC0000409 STATUS_STACK_BUFFER_OVERRUN (libuv fail-fast)');
    return { exit: code, parsed: null };
  }
}

// The child writes its own event file, so no external writer is needed.
const shortResult = runChild('A: watch via the 8.3 SHORT alias (used to abort)', target.short);
const longResult = runChild('B: watch via the LONG spelling (control)', target.long);

console.log('\n=== verdict (Lead, independent) ===');
const abortedBefore = shortResult.exit === 3221226505 || shortResult.exit === 1;
console.log(`  short-alias child exit : ${shortResult.exit}`);
console.log(`  long-form child exit   : ${longResult.exit}`);
if (shortResult.exit === 0) {
  console.log('  >>> FIXED: the short-alias spelling no longer aborts the host.');
  if (shortResult.parsed) {
    console.log(`  >>> watchDir was resolved to: ${JSON.stringify(shortResult.parsed.watching)}`);
  }
} else {
  console.log('  >>> STILL ABORTS: defect 3 is NOT fixed.');
}
