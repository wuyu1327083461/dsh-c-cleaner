// Lead probe: Phase 2 config keys must resolve, and must fail CLOSED on garbage.
// Run: node test/_lead-p2-config.mjs
import assert from 'node:assert/strict';
import { resolveConfig, NOISE_GATE_MODES } from '../lib/config.js';
import { Config } from '../lib/config-schema.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (err) { fail += 1; console.log(`FAIL ${name}: ${err && err.message}`); }
};

check('NOISE_GATE_MODES is enforce|audit|off', () => {
  assert.deepEqual([...NOISE_GATE_MODES].sort(), ['audit', 'enforce', 'off']);
});

check('defaults: gate ON, handle index OFF, critical names admitted', () => {
  const c = resolveConfig({});
  assert.equal(c.noiseGate, 'enforce');
  assert.equal(c.admitCriticalNames, true);
  assert.equal(c.handleIndex, false);
  assert.equal(c.handleSweepMs, 60000);
  assert.equal(c.pythonPath, null);
  assert.equal(c.recoverClientGraph, true);
});

check('explicit modes survive', () => {
  assert.equal(resolveConfig({ noiseGate: 'audit' }).noiseGate, 'audit');
  assert.equal(resolveConfig({ noiseGate: 'off' }).noiseGate, 'off');
});

check('FAIL-CLOSED: any junk noiseGate resolves to enforce', () => {
  for (const junk of [null, undefined, '', 'ENFORCE', 'disabled', 0, 1, true, {}, [], 'off ', 'on']) {
    const c = resolveConfig({ noiseGate: junk });
    assert.equal(c.noiseGate, 'enforce', `noiseGate=${JSON.stringify(junk)} must fail closed, got ${c.noiseGate}`);
  }
});

check('FAIL-CLOSED: a body that is not an array still yields defaults', () => {
  for (const junk of [null, 'nope', 42, {}]) {
    const c = resolveConfig({ aiSignatureGlobs: junk });
    assert.ok(Array.isArray(c.aiSignatureGlobs) && c.aiSignatureGlobs.includes('pip-*'), `aiSignatureGlobs=${JSON.stringify(junk)}`);
  }
});

check('admitCriticalNames: only literal false turns it off', () => {
  assert.equal(resolveConfig({ admitCriticalNames: false }).admitCriticalNames, false);
  for (const junk of [null, undefined, 0, '', 'false', {}]) {
    assert.equal(resolveConfig({ admitCriticalNames: junk }).admitCriticalNames, true, `admitCriticalNames=${JSON.stringify(junk)}`);
  }
});

check('handleIndex: only literal true turns it on', () => {
  assert.equal(resolveConfig({ handleIndex: true }).handleIndex, true);
  for (const junk of [false, null, undefined, 0, '', 'true', 1, {}]) {
    assert.equal(resolveConfig({ handleIndex: junk }).handleIndex, false, `handleIndex=${JSON.stringify(junk)}`);
  }
});

check('handleSweepMs below the floor falls back to 60000 (safeNumber semantics)', () => {
  // lib/config.js:safeNumber(value, fallback, min) returns the FALLBACK when the value is
  // under the floor — it does NOT clamp up to the floor. That is the behaviour of every
  // other numeric key here (a negative debounceMs becomes 3000, not 0), so an absurd sweep
  // interval lands on the documented default rather than on the minimum.
  assert.equal(resolveConfig({ handleSweepMs: 1000 }).handleSweepMs, 60000);
  assert.equal(resolveConfig({ handleSweepMs: 120000 }).handleSweepMs, 120000);
  assert.equal(resolveConfig({ handleSweepMs: -5 }).handleSweepMs, 60000);
  assert.equal(resolveConfig({ handleSweepMs: NaN }).handleSweepMs, 60000);
  assert.equal(resolveConfig({ handleSweepMs: 'soon' }).handleSweepMs, 60000);
  assert.equal(resolveConfig({ handleSweepMs: 15000 }).handleSweepMs, 15000);
});

check('pythonPath: non-string -> null, string preserved', () => {
  assert.equal(resolveConfig({ pythonPath: 42 }).pythonPath, null);
  assert.equal(resolveConfig({ pythonPath: '' }).pythonPath, null);
  assert.equal(resolveConfig({ pythonPath: {} }).pythonPath, null);
  assert.equal(resolveConfig({ pythonPath: 'E:\\conda\\python.exe' }).pythonPath, 'E:\\conda\\python.exe');
});

check('recoverClientGraph: only literal false turns it off', () => {
  assert.equal(resolveConfig({ recoverClientGraph: false }).recoverClientGraph, false);
  assert.equal(resolveConfig({ recoverClientGraph: 'nope' }).recoverClientGraph, true);
});

check('schema: a typo in noiseGate is REFUSED loudly, not downgraded', () => {
  const res = Config['~standard'].validate({ noiseGate: 'enforc' });
  assert.ok(res.issues && res.issues.length === 1, `expected one issue, got ${JSON.stringify(res)}`);
  assert.match(res.issues[0].message, /enforce \| audit \| off/);
});

check('schema: valid modes round-trip', () => {
  for (const mode of ['enforce', 'audit', 'off']) {
    const res = Config['~standard'].validate({ noiseGate: mode });
    assert.equal(res.value.noiseGate, mode);
  }
});

check('schema: new keys are declared, so a wrong type is an issue', () => {
  const res = Config['~standard'].validate({ handleSweepMs: 'soon' });
  assert.ok(res.issues && res.issues.length >= 1);
  const res2 = Config['~standard'].validate({ handleIndex: 'yes' });
  assert.ok(res2.issues && res2.issues.length >= 1);
});

check('PROTECT ROOTS stay fail-CLOSED with the new keys in play', () => {
  for (const junk of [{ handleIndex: true }, { noiseGate: 'audit' }, { admitCriticalNames: false }]) {
    const c = resolveConfig(junk);
    assert.ok(c.protectRoots.some((p) => /Windows$/i.test(p)), `protectRoots lost C:\\Windows with ${JSON.stringify(junk)}`);
  }
});

console.log(`SUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
