/**
 * Attribution probe: when many files are created in a BURST inside a watched directory, does the
 * plugin's CWatcher drop them, or does the OS watcher drop the events before we ever see them?
 *
 * This matters because the live 800-file end-to-end probe tracked only 206 of 800. Two very
 * different conclusions follow:
 *   - a plugin-level cap or filter  -> our bug, fixable here;
 *   - Windows ReadDirectoryChangesW buffer overflow under burst -> an OS boundary, documentable,
 *     and the remedy is a rescan rather than a filter change.
 *
 * CRITICAL METHODOLOGY NOTE (a first version of this probe was wrong): the writer MUST run in a
 * SEPARATE PROCESS. A synchronous write loop in the same process starves the event loop, so the
 * watcher cannot drain events until the loop yields -- which measures Node's loop, not the OS
 * watcher, and not the plugin. In production the watcher lives in the harness process while the
 * writer is some other program, so a child-process writer is the faithful model.
 *
 * Rooted at %LOCALAPPDATA%\Temp deliberately: os.tmpdir() is redirected by the plugin's own env
 * hijack into the escape root, which is a protectRoot, so a probe there would test the protection
 * veto instead of the gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const mod = await import(new URL('../lib/watcher.js', import.meta.url).href);
const { CWatcher } = mod;
const cfgMod = await import(new URL('../lib/config.js', import.meta.url).href);
const { resolveConfig } = cfgMod;

const tmpRoot = path.join(process.env.LOCALAPPDATA, 'Temp');
const dir = fs.mkdtempSync(path.join(tmpRoot, 'dshcc_burst_'));

const writer = `
import fs from 'node:fs';
import path from 'node:path';
const [dir, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i += 1) {
  fs.writeFileSync(path.join(dir, 'pip-burst-' + i + '.log'), Buffer.alloc(1024, 0x64));
}
`;

function runWriter(writerPath, sub, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writerPath, sub, String(count)], { stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exit ${code}`))));
    child.on('error', reject);
  });
}

const COUNTS = [50, 200, 800];
const results = [];

for (const COUNT of COUNTS) {
  const sub = path.join(dir, `burst-${COUNT}`);
  fs.mkdirSync(sub, { recursive: true });

  const delivered = new Set();
  const rawSeen = new Set();
  const raw = fs.watch(sub, { recursive: false }, (evt, name) => {
    if (name) rawSeen.add(String(name));
  });

  const cfg = {
    ...resolveConfig({}),
    watchDirs: [{ path: sub, recursive: false, maxDepth: 1 }],
    debounceMs: 20,
  };
  const watcher = new CWatcher({
    cfg,
    tree: null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onCandidate: (c) => delivered.add(c.path),
  });
  watcher.start();

  const writerPath = path.join(dir, 'writer.mjs');
  fs.writeFileSync(writerPath, writer);
  await runWriter(writerPath, sub, COUNT);

  // Let the debounce window and any queued events settle. Generous, because the question is
  // "did they EVER arrive", not "did they arrive quickly".
  await new Promise((r) => setTimeout(r, 5000));

  raw.close();
  watcher.stop();

  const created = fs.readdirSync(sub).filter((f) => f.endsWith('.log')).length;
  const d = delivered.size;
  const r = rawSeen.size;
  results.push({ COUNT, created, delivered: d, raw: r });
  console.log(
    `burst of ${COUNT}: created ${created}, plugin delivered ${d}, raw fs.watch saw ${r}` +
      ` -> ${d >= created ? 'COMPLETE' : `LOST ${created - d}`}`,
  );
  fs.rmSync(sub, { recursive: true, force: true });
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

const worst = results.find((x) => x.delivered < x.created);
console.log(`\nverdict=${worst === undefined ? 'BURST-OK' : 'BURST-LOSS'}`);
if (worst) {
  console.log(`first loss at ${worst.COUNT} files: delivered ${worst.delivered}/${worst.created}, raw saw ${worst.raw}`);
  console.log(`raw fs.watch itself saw ${worst.raw}/${worst.created}: ${worst.raw < worst.created ? 'the loss is BELOW the plugin (OS dirwatch buffer overflow)' : 'the OS delivered everything -- the loss is IN the plugin'}`);
}
process.exitCode = 0;
