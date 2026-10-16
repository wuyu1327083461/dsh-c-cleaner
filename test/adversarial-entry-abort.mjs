// verifier probe: does a SHORT-SPELLED watchDir passed through the real plugin entry
// (index.js apply -> resolveConfig -> CWatcher.start -> fs.watch) abort the host process?
// This is the reachability question for both Defect 1 (8.3 alias) and Defect 3 (hard abort).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = path.sep;
const here = path.dirname(fileURLToPath(import.meta.url));
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const realDir = path.join('C:' + B + 'ProgramData', `dshcc_entry_${STAMP}`);
fs.mkdirSync(realDir, { recursive: true });
const shortCfg = realDir.replace(/^C:\\ProgramData/, 'C:' + B + 'PROGRA~3');

const CHILD = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const shortCfg = process.env.DCC_SHORT_CFG;
const dshHome = path.join(os.tmpdir(), 'dshcc_entry_home_' + process.pid);
let registered = null;
const ctx = {
  commands: { register(def) { registered = def.name; return () => {}; } },
  on() { return () => {}; },
  effect(fn) { try { const d = fn(); return () => { try { d?.(); } catch {} }; } catch { return () => {}; } },
  logger: { debug(){}, info(){}, warn(){}, error(){} },
  log: { debug(){}, info(){}, warn(){}, error(){} },
};
const mod = await import('../index.js');
const app = mod.default ?? mod;
console.log('  plugin name =', app.name, '| inject =', JSON.stringify(app.inject));
app.apply(ctx, {
  enabled: true,
  watchDirs: [{ path: shortCfg, recursive: false, maxDepth: 1 }],
  stateDir: dshHome,
});
console.log('  apply() returned without throwing; command registered =', registered);
await new Promise((r) => setTimeout(r, 900));
console.log('  SURVIVED full plugin apply with a short-spelled watchDir');
process.exit(0);
`;

console.log('--- real-config control (long spelling) ---');
const ctl = `
import path from 'node:path';
const ctx = { commands: { register(d){ return () => {}; } }, on(){ return () => {}; }, effect(fn){ try { const d = fn(); return () => { try { d?.(); } catch {} }; } catch { return () => {}; } }, logger: { debug(){},info(){},warn(){},error(){} }, log: { debug(){},info(){},warn(){},error(){} } };
const mod = await import('../index.js');
(mod.default ?? mod).apply(ctx, { enabled: true, watchDirs: [{ path: process.env.DCC_LONG, recursive: false, maxDepth: 1 }] });
await new Promise((r) => setTimeout(r, 900));
console.log('  SURVIVED full plugin apply with the long spelling');
process.exit(0);
`;
const r0 = spawnSync(process.execPath, ['--input-type=module', '-e', ctl], {
  encoding: 'utf8', cwd: here, env: { ...process.env, DCC_LONG: realDir },
});
console.log(`${r0.stdout || ''}${r0.stderr || ''}`.trim().split('\n').map((l) => `  | ${l}`).join('\n'));
console.log(`  exit=${r0.status}\n`);

console.log('--- real-config test (8.3 short spelling) ---');
const r1 = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
  encoding: 'utf8', cwd: here, env: { ...process.env, DCC_SHORT_CFG: shortCfg },
});
console.log(`${r1.stdout || ''}${r1.stderr || ''}`.trim().split('\n').map((l) => `  | ${l}`).join('\n'));
console.log(`  exit=${r1.status}${r1.signal ? ` signal=${r1.signal}` : ''}`);
if (r1.status === 3221226505 || r1.status === -1073740791) {
  console.log('  >>> REAL DEFECT: the host process was KILLED by the plugin config (0xC0000409 fail-fast)');
} else if (r1.status === 0) {
  console.log('  >>> survived (no abort via the entry path)');
}

fs.rmSync(realDir, { recursive: true, force: true });
