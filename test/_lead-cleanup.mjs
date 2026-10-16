// Lead: SAFE cleanup of our own probe residue.
//
// DANGER THIS SCRIPT GUARDS AGAINST: if any probe left a JUNCTION behind, `fs.rmSync(dir,{recursive})`
// would follow it and delete the TARGET's contents — potentially inside C:\Windows\Temp. So every
// candidate is checked for a reparse point FIRST and refused (reported, not deleted) if it is one.
// Only plain directories we named with our own prefixes are removed, and each resolved absolute path
// is printed before removal.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOTS = [
  'C:\\Users\\kiuhg\\AppData\\Local\\Temp',
  'E:\\dsh_escape_cache',
];
const PREFIXES = ['dshcc_', 'dshcc-', 'ccl-', 'cc-wire-', 'cc-perf-', 'cc-real-'];

function isReparsePoint(p) {
  // fs.lstatSync gives us the reparse bit on Windows via the 'isSymbolicLink' flag only for
  // symlinks; junctions need the raw attributes. PowerShell's LinkType/Attributes is definitive.
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$i = Get-Item -LiteralPath '${p.replace(/'/g, "''")}' -Force -ErrorAction Stop; ` +
      `"$($i.LinkType)|$($i.Attributes)"`,
    ], { windowsHide: true, encoding: 'utf8' }).trim();
    const [linkType, attrs] = out.split('|');
    return { linkType: linkType || '', attrs: attrs || '', reparse: /ReparsePoint/i.test(attrs || '') };
  } catch (e) {
    return { linkType: '', attrs: '', reparse: false, error: e.message };
  }
}

const candidates = [];
for (const root of ROOTS) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    if (!PREFIXES.some((p) => e.name.startsWith(p))) continue;
    candidates.push({ full: path.join(root, e.name), isDir: e.isDirectory(), root });
  }
}

console.log(`=== ${candidates.length} residue candidate(s) ===`);
const refused = [];
const removable = [];
for (const c of candidates) {
  if (c.isDir) {
    const info = isReparsePoint(c.full);
    if (info.reparse) {
      refused.push({ ...c, info });
      console.log(`  REFUSE (reparse point, would delete its target) ${c.full}`);
      console.log(`         LinkType=${info.linkType} Attributes=${info.attrs}`);
    } else {
      removable.push(c);
      console.log(`  remove  ${c.full}   (plain dir, attrs=${info.attrs})`);
    }
  } else {
    removable.push(c);
    console.log(`  remove  ${c.full}   (file)`);
  }
}

console.log(`\n=== removing ${removable.length} item(s) ===`);
let removed = 0, failed = 0;
for (const r of removable) {
  // re-verify immediately before deletion (defence in depth: a TOCTOU swap to a junction would be fatal)
  if (r.isDir) {
    const info = isReparsePoint(r.full);
    if (info.reparse) {
      console.log(`  SKIP (became a reparse point) ${r.full}`);
      failed += 1;
      continue;
    }
  }
  try {
    fs.rmSync(r.full, { recursive: true, force: true });
    removed += 1;
  } catch (e) {
    failed += 1;
    console.log(`  FAILED ${r.full}: ${e.code || e.message}`);
  }
}
console.log(`  removed: ${removed}  failed: ${failed}  refused-reparse: ${refused.length}`);

// final verification: nothing left, and C:\Windows\Temp was NOT disturbed
console.log('\n=== post-clean verification ===');
for (const root of ROOTS) {
  const left = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => PREFIXES.some((p) => e.name.startsWith(p)))
    .map((e) => e.name);
  console.log(`  ${root} leftover: ${left.length} ${left.length ? JSON.stringify(left) : ''}`);
}

const winTemp = 'C:\\Windows\\Temp';
const stillThere = fs.existsSync(winTemp);
console.log(`  C:\\Windows\\Temp still exists: ${stillThere}   <- must be true`);
if (stillThere) {
  const n = fs.readdirSync(winTemp).length;
  console.log(`  C:\\Windows\\Temp entry count : ${n}`);
  const ourVictims = fs.readdirSync(winTemp).filter((n2) => /^(ccl-|dshcc)/i.test(n2));
  console.log(`  our leftover victims there  : ${ourVictims.length} ${ourVictims.length ? JSON.stringify(ourVictims) : ''}`);
  for (const v of ourVictims) {
    try { fs.rmSync(path.join(winTemp, v), { force: true }); console.log(`    removed leftover victim ${v}`); } catch (e) { console.log(`    could not remove ${v}: ${e.code}`); }
  }
}
