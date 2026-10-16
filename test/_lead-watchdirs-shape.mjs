// Lead probe: is a top-level non-array `watchDirs` reachable in PRODUCTION, or does the Cordis
// Config schema reject it before apply() runs? The verifier found it resolves to [] (watches
// nothing) when resolveConfig is called directly; this decides whether that is user-reachable.
import { Config, } from '../lib/config-schema.js';
import { resolveConfig } from '../lib/config.js';

const shapes = [
  ['string', 'C:\\custom\\watch'],
  ['number', 5],
  ['object', { path: 'C:\\custom\\watch' }],
  ['null', null],
  ['bare string ELEMENT in array', ['C:\\custom\\watch']],
  ['empty array (explicit)', []],
];

for (const [label, value] of shapes) {
  const v = Config['~standard'].validate({ watchDirs: value });
  const rejected = Array.isArray(v?.issues) && v.issues.length > 0;
  let resolved;
  try {
    const cfg = resolveConfig({ watchDirs: value });
    resolved = `${cfg.watchDirs.length} dir(s): ${cfg.watchDirs.map((d) => d.path).join(' | ') || '(none)'}`;
  } catch (err) {
    resolved = `THREW ${err.message}`;
  }
  console.log(`${label.padEnd(30)} schema=${rejected ? 'REJECTS (' + v.issues[0].message + ')' : 'accepts'}`);
  console.log(`${''.padEnd(30)} resolveConfig -> ${resolved}`);
}
