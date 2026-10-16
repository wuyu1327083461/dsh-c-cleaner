/**
 * dsh-c-cleaner — STEP 4 CORRECTED alias probe (verifier-owned).
 *
 *   node /f/work/dsh-c-cleaner/test/adversarial-alias.mjs
 *
 * Supersedes the alias section of test/adversarial.mjs, whose extended-prefix
 * strings were constructed WRONG (it built "?\\C:\..." instead of "\\?\C:\..."
 * and "\\?\UNC\\localhost..." instead of "\\?\UNC\localhost..."), producing
 * false MISS results. Corrected here, plus the decisive question:
 * is there a WRITABLE protectRoot that has a live, unrecognised 8.3 alias?
 */
import fs from 'node:fs';
import path from 'node:path';

const B = '\\';                             // one real backslash
const EXT = `${B}${B}?${B}`;                // \\?\
const UNCP = `${B}${B}?${B}UNC${B}`;        // \\?\UNC\

const { isProtectedPath, classify } = await import(new URL('../lib/classifier.js', import.meta.url));
const { clean } = await import(new URL('../lib/cleaner.js', import.meta.url));
const { resolveConfig } = await import(new URL('../lib/config.js', import.meta.url));
const CFG = resolveConfig({});
const LOG = { debug() {}, info() {}, warn() {}, error() {} };

const probe = (label, p, want) => {
  let got;
  try { got = isProtectedPath(p, CFG.protectRoots); } catch (e) { got = `THREW ${e.message}`; }
  let exists = false;
  let real = '';
  try { exists = fs.existsSync(p); } catch { /* ignore */ }
  try { real = fs.realpathSync.native(p); } catch (e) { real = `(${e.code})`; }
  const ok = got === want;
  console.log(`${ok ? 'OK  ' : 'MISS'} ${label.padEnd(42)} isProtectedPath=${String(got).padEnd(5)} want=${String(want).padEnd(5)} exists=${String(exists).padEnd(5)} realpath=${real}`);
  return { ok, got, want, p, label, exists, real };
};

console.log('=== A1-corrected: extended-length / device prefix spellings ===');
console.log(`EXT prefix = ${JSON.stringify(EXT)}   UNC prefix = ${JSON.stringify(UNCP)}\n`);

const win = `C:${B}Windows${B}notepad.exe`;
probe('plain baseline', win, true);
probe('EXT plain', EXT + win, true);
probe('EXT UNC', `${UNCP}localhost${B}C$${B}Windows${B}notepad.exe`, true);
probe('forward-slash device', '//?/C:/Windows/notepad.exe', true);
probe('trailing-space component', `C:${B}Windows ${B}notepad.exe`, true);
probe('trailing-dot component', `C:${B}Windows.${B}notepad.exe`, true);

console.log('\n=== A1b: discover live 8.3 aliases of every protectRoot ===');
const aliases = [];
for (const root of CFG.protectRoots) {
  const parsed = path.parse(root);
  if (parsed.dir !== parsed.root) {
    console.log(`  ${root.padEnd(46)} (not a top-level root; skipped)`);
    continue;
  }
  const stem = path.basename(root).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!stem) continue;
  const found = [];
  // Windows 8.3 aliases are %NAME:~6~% plus a digit: PROGRA~1, WINDOW~1, ...
  for (let n = 1; n <= 9; n += 1) {
    const cand = path.join(parsed.root, `${stem.slice(0, 6)}~${n}`);
    let real = null;
    try { real = fs.realpathSync.native(cand); } catch { continue; }
    if (real.toLowerCase() === root.toLowerCase()) {
      const recognised = isProtectedPath(cand, CFG.protectRoots) && isProtectedPath(path.join(cand, 'evil.dll'), CFG.protectRoots);
      let writable = false;
      try {
        const t = path.join(cand, `dshcc_alias_${process.pid}.tmp`);
        fs.writeFileSync(t, 'x');
        fs.rmSync(t, { force: true });
        writable = true;
      } catch { writable = false; }
      found.push({ alias: cand, recognised, writable });
      console.log(`  ${root.padEnd(46)} alias=${cand.padEnd(22)} recognised=${String(recognised).padEnd(5)} writable=${writable}`);
      aliases.push({ root, alias: cand, recognised, writable });
    }
  }
  if (!found.length) console.log(`  ${root.padEnd(46)} (no live 8.3 alias)`);
}

console.log('\n=== A1c: is any alias a REAL bypass? (requires writable=true) ===');
const bypasses = aliases.filter((a) => a.writable && a.recognised !== true);
if (!bypasses.length) {
  console.log('  none: every protectRoot with a live 8.3 alias is either recognised or not writable by this user.');
}
for (const a of bypasses) console.log(`  CANDIDATE: ${a.alias} -> ${a.root}`);

console.log('\n=== DECISIVE: clean() through an unrecognised 8.3 alias ===');
for (const a of bypasses) {
  const victim = path.join(a.alias, `dshcc_alias_victim_${process.pid}.tmp`);
  try {
    fs.writeFileSync(victim, 'PRD 6.2 protected payload');
  } catch (e) {
    console.log(`  ${a.alias}: cannot create the victim (${e.code}) — not exploitable on this host`);
    continue;
  }
  const c = classify({ path: victim, size: fs.statSync(victim).size, mtimeMs: Date.now() }, { cfg: CFG });
  let report = null;
  let err = null;
  try {
    report = await clean([c], { deep: false, force: false, cfg: CFG, log: LOG });
  } catch (e) {
    err = `${e.code || ''} ${e.message}`;
  }
  const gone = !fs.existsSync(victim);
  console.log(`  ${a.alias}: classify=${c.category} DELETED=${gone} report=${JSON.stringify(report?.skippedList ?? report)}${err ? ` ERR=${err}` : ''}`);
  if (gone) {
    console.log(`  >>> REAL DEFECT: PRD 6.2 must refuse deletion under ${a.root}, but ${victim} was DELETED via the 8.3 alias ${a.alias}.`);
  } else {
    console.log(`  >>> not exploitable: the file survived even though isProtectedPath() missed the alias.`);
  }
  try { fs.rmSync(victim, { force: true }); } catch { /* ignore */ }
}

console.log('\nalias probe complete.');
