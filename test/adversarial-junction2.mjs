// verifier probe: DECISIVE junction test with NO lexical confound.
//
// Earlier junction probes put the junction under E:\dsh_escape_cache, which is ITSELF a
// protectRoot — so isProtectedPath() returned true LEXICALLY and proved nothing about
// junction resolution. Same for clean()'s refusal.
//
// This probe places the junction in %LOCALAPPDATA%\Temp, which is NOT a protectRoot, so the
// ONLY way a file through it can be protected is real filesystem resolution (realpath).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const B = path.sep;
const { resolveConfig } = await import('../lib/config.js');
const { isProtectedPath, classify, CATEGORY } = await import('../lib/classifier.js');
const { clean } = await import('../lib/cleaner.js');
const cfg = resolveConfig({});
const LOG = { debug(){}, info(){}, warn(){}, error(){} };

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const tmpBase = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp');
const holder = path.join(tmpBase, `dshcc_junc2_${STAMP}`);
fs.mkdirSync(holder, { recursive: true });

const junction = path.join(holder, 'innocent-cache');
const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', junction, 'C:\\Windows\\Temp'], { encoding: 'utf8' });
if (!fs.existsSync(junction)) {
  console.log('junction not created:', (r.stderr || r.stdout || '').trim());
  process.exit(0);
}

console.log('holder   =', JSON.stringify(holder));
console.log('  under a protectRoot (lexical)?', cfg.protectRoots.some((x) => holder.toLowerCase().startsWith(x.toLowerCase() + B)));
console.log('junction =', JSON.stringify(junction), '-> C:\\Windows\\Temp');
console.log('');

// Create a REAL file physically inside C:\Windows\Temp, addressed through the junction.
const victimReal = path.join('C:\\Windows\\Temp', `dshcc_junc2_victim_${STAMP}.log`);
fs.writeFileSync(victimReal, 'v'.repeat(48));
const victimViaJunction = path.join(junction, path.basename(victimReal));
console.log('real victim      =', JSON.stringify(victimReal), 'exists=', fs.existsSync(victimReal));
console.log('via junction     =', JSON.stringify(victimViaJunction), 'exists=', fs.existsSync(victimViaJunction));
console.log('  realpath(junction dir) =', JSON.stringify((() => { try { return fs.realpathSync.native(junction); } catch (e) { return 'THREW ' + e.code; } })()));
console.log('');

console.log('--- isProtectedPath ---');
const pReal = isProtectedPath(victimReal, cfg.protectRoots);
const pJunc = isProtectedPath(victimViaJunction, cfg.protectRoots);
const pJuncDir = isProtectedPath(junction, cfg.protectRoots);
console.log('  isProtectedPath(real C:\\Windows\\Temp file)     =', pReal, '  <- must be true');
console.log('  isProtectedPath(same file via the junction)     =', pJunc, '  <- the question');
console.log('  isProtectedPath(the junction dir itself)        =', pJuncDir);
console.log('');

console.log('--- classify + clean the junction-spelled record ---');
const c = classify({ path: victimViaJunction, size: 48 }, { cfg, tree: { ownerOf: () => null, nameOf: () => null } });
console.log('  classify =', c.category, '|', JSON.stringify(c.reason));
const rep = await clean([{ path: victimViaJunction, category: c.category, size: 48 }], { deep: true, force: true, cfg, log: LOG });
console.log('  clean() report =', JSON.stringify({ removed: rep.removed, skipped: rep.skipped, bytesFreed: rep.bytesFreed, skippedList: rep.skippedList }));
const survived = fs.existsSync(victimReal);
console.log('  REAL C:\\Windows\\Temp file survives =', survived);
console.log('');
console.log(survived
  ? '>>> SAFE: the physical file under C:\\Windows\\Temp survived -> junction resolution guards it'
  : '>>> REAL DEFECT (PRD 6.2, HIGH): clean() DELETED a file physically inside C:\\Windows\\Temp via a junction whose own path is not lexically protected');

try { fs.rmSync(junction, { recursive: true, force: true }); } catch {}
try { fs.rmSync(holder, { recursive: true, force: true }); } catch {}
try { fs.rmSync(victimReal, { force: true }); } catch {}
