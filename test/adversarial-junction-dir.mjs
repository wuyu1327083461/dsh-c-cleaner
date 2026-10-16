// verifier probe (task-5 residual) — the ONE shape the junction fix does not cover:
// `isProtectedPath(<the junction DIR itself>)` is still false. Determine whether that is
// exploitable through clean(), or inert because directory records are refused outright.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { isProtectedPath } from '../lib/classifier.js';
import { clean } from '../lib/cleaner.js';
import { resolveConfig } from '../lib/config.js';

const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const base = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp', `dshcc_jdir_${STAMP}`);
const link = path.join(base, 'cache-view');        // junction -> C:\Windows\Temp
const target = 'C:\\Windows\\Temp';
fs.mkdirSync(base, { recursive: true });
try { execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' }); } catch (e) {
  console.log('INCONCLUSIVE: could not create junction:', String(e.message).slice(0, 200));
  process.exit(0);
}

// A file INSIDE the junction target, and a directory record pointing AT the junction.
const victim = path.join(target, `dshcc_jdir_victim_${STAMP}.log`);
fs.writeFileSync(victim, 'J'.repeat(32));

const cfg = resolveConfig({ protectRoots: undefined });
const silent = { debug() {}, info() {}, warn() {}, error() {} };

console.log('=== shapes ===');
console.log('  junction dir          =', link, '| realpath =', fs.realpathSync.native(link));
console.log('  isProtectedPath(junction DIR itself)  =', isProtectedPath(link));
console.log('  isProtectedPath(file via junction)    =', isProtectedPath(path.join(link, path.basename(victim))));
console.log('  isProtectedPath(real file)            =', isProtectedPath(victim));

// (1) directory record pointing at the junction, under every flag combination.
for (const opts of [{}, { deep: true }, { force: true }, { deep: true, force: true }]) {
  const rec = [{ path: link, size: 0, category: 'SAFE_TO_DELETE', isLocked: false }];
  let report = null;
  let threw = null;
  try { report = await clean(rec, { ...opts, cfg, log: silent }); } catch (e) { threw = e.message; }
  const survives = fs.existsSync(link);
  console.log(`  clean(junction DIR, ${JSON.stringify(opts)}) threw=${threw || 'no'} removed=${report?.removed} skipped=${report?.skipped} dirSurvives=${survives} reason=${JSON.stringify(report?.skippedList?.[0]?.reason ?? null)}`);
}
console.log('  target dir still exists  =', fs.existsSync(target), '| victim exists =', fs.existsSync(victim));

console.log('');
console.log(`>>> RESIDUAL: ${fs.existsSync(link) && fs.existsSync(victim) ? 'NOT EXPLOITABLE — the junction directory record is refused (directories are never cleaned), so the false is inert' : 'EXPLOITABLE — a protected target was removed'}`);
try { fs.rmSync(victim, { force: true }); } catch {}
try { fs.rmdirSync(link); } catch {}
try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
process.exit(0);
