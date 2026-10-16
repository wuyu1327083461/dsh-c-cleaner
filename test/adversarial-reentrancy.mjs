// verifier probe: the re-entrancy guard (lib/commands.js:150 `let busy`, guarded at :247-255).
// A long-running `now` must reject a CONCURRENT `now` with an error result (not corrupt state,
// not throw), while `status` must stay available (it is read-only).
import fs from 'node:fs';
import path from 'node:path';

const { resolveConfig } = await import('../lib/config.js');
const { registerCommands } = await import('../lib/commands.js');
const cfg = resolveConfig({});
const LOG = { debug(){}, info(){}, warn(){}, error(){} };
let failures = 0;
const verdict = (ok, msg) => { console.log('  ->', ok ? 'OK' : 'DEFECT:', msg); if (!ok) failures++; };

let cmd = null;
registerCommands({ commands: { register: (d) => { cmd = d; return () => {}; } } }, {
  cfg, log: LOG,
  db: { summary: () => ({ SAFE: { count: 0, bytes: 0 }, CAUTION: { count: 0, bytes: 0 }, LOCKED: { count: 0, bytes: 0 } }) },
  hijacker: { status: () => ({ installed: false, escapeRoot: 'E:\\x', entries: [] }) },
  refresh: async () => {},
  collect: async () => [],
  // A deliberately SLOW clean so the first `now` is still in flight when the second arrives.
  clean: async () => { await new Promise((r) => setTimeout(r, 1200)); return { removed: 0, skipped: 0, bytesFreed: 0, errors: [] }; },
});

const inv = (rawInput) => ({ commandId: 'c', agent: { id: 'a' }, rawInput, attachments: [], signal: { aborted: false } });

console.log('=== concurrent invocations ===');
const first = cmd.handler(inv('now'));                 // enters runNow, holds `busy`
await new Promise((r) => setTimeout(r, 150));          // let it get past the guard
const second = await cmd.handler(inv('now'));          // must be REJECTED by the guard
console.log('  second now -> kind=' + second.kind + ' text=' + JSON.stringify(second.text));
verdict(second.kind === 'error' && /进行中/.test(second.text), 'a concurrent `now` was rejected without throwing');

const during = await cmd.handler(inv('status'));       // status must remain usable while busy
console.log('  status while busy -> kind=' + during.kind + ' text=' + JSON.stringify(String(during.text).split('\n')[0]));
verdict(during.kind === 'success', 'status stayed available while a clean was in flight');

const firstRes = await first;
console.log('  first now -> kind=' + firstRes.kind);
verdict(firstRes.kind === 'success', 'the first `now` completed successfully');

console.log('');
console.log('=== the guard must RELEASE (a later now must be accepted) ===');
const third = await cmd.handler(inv('now'));
console.log('  after completion -> kind=' + third.kind);
verdict(third.kind === 'success', 'busy was released in the finally block; a later `now` succeeds');

console.log('');
console.log('=== the guard must release even when clean() THROWS ===');
let cmd2 = null;
registerCommands({ commands: { register: (d) => { cmd2 = d; return () => {}; } } }, {
  cfg, log: LOG,
  db: { summary: () => ({}) }, hijacker: null, refresh: async () => {}, collect: async () => [],
  clean: async () => { throw new Error('clean exploded'); },
});
const boom = await cmd2.handler(inv('now'));
console.log('  throwing clean -> kind=' + boom.kind + ' text=' + JSON.stringify(String(boom.text).slice(0, 60)));
verdict(boom.kind === 'error', 'a throwing clean() degraded to an error result');
let cmd3 = null;
registerCommands({ commands: { register: (d) => { cmd3 = d; return () => {}; } } }, {
  cfg, log: LOG, db: { summary: () => ({}) }, hijacker: null, refresh: async () => {}, collect: async () => [],
  clean: async () => ({ removed: 0, skipped: 0, bytesFreed: 0, errors: [] }),
});
// NOTE: cmd2's clean ALWAYS throws, so a second `now` on cmd2 legitimately errors again. The
// assertion must therefore distinguish WHICH error: if `busy` had leaked, the text would be the
// busy message (上一次清理仍在进行中); getting the clean failure again proves the guard released.
const after = await cmd2.handler(inv('now'));
const busyMsg = /进行中/.test(String(after.text));
console.log('  next now on the SAME registration -> kind=' + after.kind + ' text=' + JSON.stringify(String(after.text).slice(0, 60)));
console.log('  hit the BUSY guard again =', busyMsg, '(must be false: proving the finally released it)');
verdict(after.kind === 'error' && !busyMsg,
  'busy was released even on the throwing path: the second call re-ran clean() and failed for the SAME reason, not with a busy error');

// Independent confirmation on a registration whose clean() SUCCEEDS: the second call must be accepted.
const ok = await cmd3.handler(inv('now'));
console.log('  same sequence on a healthy registration -> kind=' + ok.kind);
verdict(ok.kind === 'success', 'a healthy registration accepts `now` after the guard has cycled');

console.log('');
console.log(`>>> ${failures === 0 ? 'RE-ENTRANCY GUARD CORRECT' : failures + ' DEFECT(S)'}`);
