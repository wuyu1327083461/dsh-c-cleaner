// Lead integration test: run apply() against a MOCK Cordis context and prove the wiring.
// This is the only test that exercises index.js end to end without installing the plugin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wire-'));
const ESCAPE = path.join(TMP, 'escape');

const events = [];
const log = {
  debug: (m) => events.push(['debug', m]),
  info: (m) => events.push(['info', m]),
  warn: (m) => events.push(['warn', m]),
  error: (m) => events.push(['error', m]),
};

let registered = null;
let disposed = 0;
const disposers = [];

const ctx = {
  logger: log,
  commands: {
    register(def) {
      registered = def;
      const d = () => { disposed += 1; };
      disposers.push(d);
      return d;
    },
  },
  // Faithful to cordis _execute (lib/index.js:1142-1143):
  //   const effect = runner.execute.call(this);
  //   if (typeof effect === "function") return runner.collect(effect);
  // The callback's RETURN VALUE is the disposer. A mock that merely calls cb() would NOT
  // run cleanup, and would then leak the SQLite handle (surfacing as EPERM on cleanup).
  effect(cb) {
    const effect = cb();
    if (typeof effect === 'function') disposers.push(effect);
    return () => {};
  },
};

const { apply, Config } = await import('../index.js');

// Validate the config the way cordis does, then apply.
const validated = Config['~standard'].validate({
  escapeRoot: ESCAPE,
  stateDir: path.join(TMP, 'state'),
  // Watch a directory we control, so the test does not depend on the real %TEMP% churn.
  watchDirs: [{ path: path.join(TMP, 'watch'), recursive: true, maxDepth: 2 }],
  debounceMs: 150,
  pollIntervalMs: 100000,
});
if (validated.issues) throw new Error('config invalid: ' + JSON.stringify(validated.issues));

fs.mkdirSync(path.join(TMP, 'watch'), { recursive: true });

const before = process.env.TEMP;
apply(ctx, validated.value);

console.log('--- wired ---');
console.log('command registered :', registered?.name, '| has handler:', typeof registered?.handler);
console.log('command input hint :', JSON.stringify(registered?.input));

console.log('--- env hijack ---');
console.log('TEMP before        :', before);
console.log('TEMP after         :', process.env.TEMP);
console.log('TEMP under escape  :', String(process.env.TEMP).startsWith(ESCAPE));
console.log('escape dir created :', fs.existsSync(ESCAPE));

console.log('--- state db ---');
const dbFile = path.join(TMP, 'state', 'state.db');
console.log('db exists          :', fs.existsSync(dbFile));

// status must be cheap + read-only and must not throw
const status = await registered.handler({ rawInput: ' status ', signal: { aborted: false } });
console.log('--- /c-clean status ---');
console.log('kind               :', status.kind);
console.log('text               :');
console.log(status.text);

// unknown args -> usage
const usage = await registered.handler({ rawInput: ' bogus', signal: { aborted: false } });
console.log('--- /c-clean bogus ---');
console.log('kind               :', usage.kind, '| mentions status/now:', /status/.test(usage.text) && /now/.test(usage.text));

console.log('--- teardown ---');
for (const d of disposers.reverse()) { try { d(); } catch (e) { console.log('dispose threw:', e.message); } }
console.log('TEMP restored      :', process.env.TEMP === before);
console.log('disposed count     :', disposed);

console.log('--- log lines ---');
for (const [lvl, m] of events) console.log(`  ${lvl}: ${m}`);

fs.rmSync(TMP, { recursive: true, force: true });
