/**
 * Does a Windows directory-change BUFFER OVERFLOW announce itself?
 *
 * Measured context: a burst of 200+ files into one directory makes even a bare `fs.watch` see only
 * ~107/200 (`test/_lead-watch-burst.mjs`). The plugin then tracked 205/800 in the live end-to-end
 * probe. If the overflow were SILENT, the only cure would be a periodic rescan.
 *
 * libuv's `fs-event.c` on Windows maps `ERROR_NOTIFY_ENUM_DIR` (the buffer-overflow error returned
 * by ReadDirectoryChangesW) onto a libuv event. Node surfaces that through `fs.watch`'s callback as
 * `(eventType, filename)`. If libuv reports it with a NULL/empty filename, our `_onEvent` is
 * currently DISCARDING it:
 *
 *     if (filename === null || filename === undefined || String(filename).length === 0) {
 *       this._counters.filtered += 1; // directory-level event, no file to classify
 *       return;
 *     }
 *
 * ...which would be a missed rescan opportunity and a real, fixable defect. This probe answers it
 * empirically: raw `fs.watch` on a directory receiving a child-process burst, logging EVERY
 * callback including null filenames, and counting how many carry a name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmpRoot = path.join(process.env.LOCALAPPDATA, 'Temp');
const dir = fs.mkdtempSync(path.join(tmpRoot, 'dshcc_overflow_'));
const sub = path.join(dir, 'burst');
fs.mkdirSync(sub, { recursive: true });

const writer = `
import fs from 'node:fs';
import path from 'node:path';
const [dir, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i += 1) {
  fs.writeFileSync(path.join(dir, 'pip-ovf-' + i + '.log'), Buffer.alloc(4096, 0x64));
}
`;

const events = [];
const nullEvents = [];

for (const recursive of [true, false]) {
  const s = path.join(sub, `r-${recursive}`);
  fs.mkdirSync(s, { recursive: true });

  const seen = [];
  const nulls = [];
  const watcher = fs.watch(s, { recursive }, (eventType, filename) => {
    seen.push({ eventType, filename });
    if (filename === null || filename === undefined || String(filename).length === 0) {
      nulls.push({ eventType, filename: String(filename) });
    }
  });

  const writerPath = path.join(dir, 'writer.mjs');
  fs.writeFileSync(writerPath, writer);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writerPath, s, '600'], { stdio: 'ignore' });
    child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`))));
    child.on('error', reject);
  });

  await new Promise((r) => setTimeout(r, 6000));
  watcher.close();

  const created = fs.readdirSync(s).filter((f) => f.endsWith('.log')).length;
  const named = seen.filter((e) => e.filename !== null && e.filename !== undefined && String(e.filename).length > 0).length;
  events.push({ recursive, created, callbacks: seen.length, named, nulls: nulls.length });
  nullEvents.push(...nulls);
  console.log(
    `recursive=${recursive}: created ${created}, callbacks ${seen.length}, named ${named}, NULL-filename callbacks ${nulls.length}`,
  );
  if (nulls.length > 0) console.log(`  null sample: ${JSON.stringify(nulls.slice(0, 3))}`);
  fs.rmSync(s, { recursive: true, force: true });
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

const anyNull = events.some((e) => e.nulls > 0);
const lostAny = events.some((e) => e.named < e.created);
console.log(`\nlost files in at least one mode: ${lostAny}`);
console.log(`overflow ANNOUNCED as a null-filename callback: ${anyNull}`);
console.log(`verdict=${anyNull ? 'OVERFLOW-SIGNALLED' : 'OVERFLOW-SILENT'}`);
console.log(
  anyNull
    ? '=> a rescan can be triggered by the null-filename event; the current _onEvent DISCARDS it as "directory-level".'
    : '=> the overflow is invisible to us; only a periodic/time-based rescan can recover the missed files.',
);
process.exitCode = 0;
