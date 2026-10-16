// Lead: is the "protected file classifies as SAFE_TO_DELETE" wart REACHABLE in production?
// classify() tiers by PRD §3.3; clean() applies the PRD §6.2 veto independently. The wart only
// matters if a watched directory can actually contain a protected path.
import { resolveConfig } from '../lib/config.js';

const cfg = resolveConfig({}, process.env);
const norm = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

console.log('=== does any configured watchDir fall inside a protectRoot? ===');
let overlap = 0;
for (const w of cfg.watchDirs) {
  const nw = norm(w.path);
  const hits = cfg.protectRoots.filter((r) => nw === norm(r) || nw.startsWith(norm(r) + '\\'));
  if (hits.length) overlap += 1;
  console.log(`  watch ${JSON.stringify(w.path)}`);
  console.log(`      inside protectRoots: ${hits.length ? JSON.stringify(hits) : 'no'}`);
}
console.log(`  watchDirs overlapping a protectRoot: ${overlap}`);

console.log('\n=== the reverse direction: is a protectRoot inside a watchDir? ===');
for (const r of cfg.protectRoots) {
  const nr = norm(r);
  const hits = cfg.watchDirs.filter((w) => nr.startsWith(norm(w.path) + '\\'));
  console.log(`  ${hits.length ? 'INSIDE WATCH' : 'not watched '}  ${JSON.stringify(r)}${hits.length ? '  <- ' + JSON.stringify(hits.map((h) => h.path)) : ''}`);
}

console.log('\n=== escapeRoot / stateDir relationship ===');
console.log('  escapeRoot :', JSON.stringify(cfg.escapeRoot));
console.log('  stateDir   :', JSON.stringify(cfg.stateDir));
console.log('  escapeRoot is a protectRoot :', cfg.protectRoots.some((r) => norm(r) === norm(cfg.escapeRoot)));
console.log('  escapeRoot under a watchDir :', cfg.watchDirs.some((w) => norm(cfg.escapeRoot).startsWith(norm(w.path) + '\\')));
console.log('  stateDir   under a watchDir :', cfg.watchDirs.some((w) => norm(cfg.stateDir).startsWith(norm(w.path) + '\\')));
console.log('\n  => if overlap is 0 in both directions, the classify/clean asymmetry cannot be');
console.log('     triggered by the watcher: no protected path ever reaches classify() in production.');
