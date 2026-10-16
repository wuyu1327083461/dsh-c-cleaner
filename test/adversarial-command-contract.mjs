// verifier probe: validate lib/commands.js against the AUTHORITATIVE Host Service contract,
// fetched live via cordis_inspect_query(platform:'host', provider:'Service', method:'listService',
// service:'commands'). This is stronger than my earlier stubbed harness check because it asserts
// the exact CommandDefinition/CommandResult field set the real registry enforces, including
// result-kind dispatch and the `input.hint` descriptor.
//
// Authoritative contract (verbatim from the Host Service):
//   CommandDefinition = { definitionId?, name, description, input?: {hint, attachments?},
//                         recordInput?, handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult> }
//   CommandInvocation = { commandId, agent, rawInput, attachments, signal }
//   CommandResult = { kind:'success', text?, sourceEventSeq? } | { kind:'error', text }
import fs from 'node:fs';
import path from 'node:path';

const { resolveConfig } = await import('../lib/config.js');
const { registerCommands } = await import('../lib/commands.js');
const { CATEGORY } = await import('../lib/classifier.js');
const cfg = resolveConfig({});
const LOG = { debug(){}, info(){}, warn(){}, error(){} };
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
const dir = path.join(process.env.LOCALAPPDATA || '', 'Temp', `dshcc_cmd_${STAMP}`);
fs.mkdirSync(dir, { recursive: true });
let failures = 0;
const verdict = (ok, msg) => { console.log('  ->', ok ? 'OK' : 'DEFECT:', msg); if (!ok) failures++; };

// --- a registry that enforces the real CommandDefinition contract ---
const registry = [];
let disposerCalls = 0;
const ctx = {
  commands: {
    register(definition) {
      // Enforce exactly the documented field set: unknown own fields are a contract violation.
      const allowed = new Set(['definitionId', 'name', 'description', 'input', 'recordInput', 'handler']);
      const unknown = Object.keys(definition).filter((k) => !allowed.has(k));
      if (unknown.length) throw new Error(`CommandDefinition has undocumented field(s): ${unknown.join(', ')}`);
      if (typeof definition.name !== 'string' || !definition.name) throw new Error('name must be a non-empty string');
      if (typeof definition.description !== 'string') throw new Error('description must be a string');
      if (typeof definition.handler !== 'function') throw new Error('handler must be a function');
      if (definition.input !== undefined) {
        if (typeof definition.input !== 'object' || definition.input === null) throw new Error('input must be an object');
        const ia = new Set(['hint', 'attachments']);
        const iu = Object.keys(definition.input).filter((k) => !ia.has(k));
        if (iu.length) throw new Error(`input has undocumented field(s): ${iu.join(', ')}`);
        if (typeof definition.input.hint !== 'string') throw new Error('input.hint must be a string');
      }
      registry.push(definition);
      return () => { disposerCalls++; };
    },
  },
};

const records = [];
const db = {
  summary: () => ({
    SAFE: { count: 2, bytes: 8300 },
    CAUTION: { count: 1, bytes: 1200000 },
    LOCKED: { count: 3, bytes: 4096 },
  }),
  list: () => records.slice(),
};
// Contract-shaped stub (CONTRACTS §4): { installed, escapeRoot, entries:[{name,expected,actual,ok}] }.
// NOTE: an earlier version of this probe omitted `installed`, which made commands.js render
// "⚠️ 未生效" — that was a MY-STUB artifact, not a defect. commands.js:182 legitimately reads
// hijack.installed, which is the documented field.
const hijacker = {
  status: () => ({
    installed: true,
    escapeRoot: 'E:\\dsh_escape_cache',
    entries: [
      { name: 'TEMP', expected: 'E:\\dsh_escape_cache\\temp', actual: 'E:\\dsh_escape_cache\\temp', ok: true },
      { name: 'TMP', expected: 'E:\\dsh_escape_cache\\temp', actual: 'E:\\dsh_escape_cache\\temp', ok: true },
    ],
  }),
};

console.log('=== 1) registration against the authoritative CommandDefinition contract ===');
let dispose;
try {
  dispose = registerCommands(ctx, { cfg, log: LOG, db, hijacker, refresh: async () => {}, collect: async () => records.slice() });
} catch (e) {
  verdict(false, `registerCommands threw: ${e.message}`);
}
verdict(registry.length === 1, `registered exactly one command (got ${registry.length})`);
const cmd = registry[0];
if (cmd) {
  console.log('  name        =', JSON.stringify(cmd.name));
  console.log('  description =', JSON.stringify(cmd.description));
  console.log('  input       =', JSON.stringify(cmd.input));
  console.log('  fields      =', JSON.stringify(Object.keys(cmd)));
  verdict(cmd.name === 'c-clean', `command name is "c-clean" (got ${JSON.stringify(cmd.name)})`);
  verdict(typeof cmd.input?.hint === 'string' && cmd.input.hint.length > 0, 'input.hint is a non-empty string');
}

// --- invoke through a REAL-shaped CommandInvocation ---
async function invoke(rawInput, { aborted = false } = {}) {
  const invocation = {
    commandId: `cmd_${STAMP}_${Math.random().toString(36).slice(2, 8)}`,
    agent: { id: `sess_${STAMP}` },
    rawInput,
    attachments: [],
    signal: { aborted, addEventListener(){}, removeEventListener(){} },
  };
  const res = await cmd.handler(invocation);
  return res;
}
function assertResult(label, res, expectKind) {
  const kindsOk = res && (res.kind === 'success' || res.kind === 'error');
  const textOk = res?.kind === 'success' ? (res.text === undefined || typeof res.text === 'string') : typeof res.text === 'string';
  const extra = Object.keys(res || {}).filter((k) => !['kind', 'text', 'sourceEventSeq'].includes(k));
  const ok = kindsOk && textOk && extra.length === 0 && res.kind === expectKind;
  console.log(`  ${label.padEnd(38)} kind=${res?.kind}${res?.text ? ' text=' + JSON.stringify(res.text.slice(0, 78)) : ''}`);
  if (extra.length) console.log('      UNDOCUMENTED result field(s):', extra.join(', '));
  verdict(ok, `${label}: kind=${res?.kind} (expected ${expectKind}), documented fields only`);
  return res;
}

console.log('');
console.log('=== 2) CommandResult shape for every documented invocation ===');
assertResult('status', await invoke('status'), 'success');
assertResult('status with trailing spaces', await invoke('   status   '), 'success');
assertResult('now (empty record set)', await invoke('now'), 'success');
assertResult('now --force', await invoke('now --force'), 'success');
assertResult('now --deep', await invoke('now --deep'), 'success');
assertResult('now --deep --force', await invoke('now --deep --force'), 'success');
assertResult('unknown verb', await invoke('frobnicate'), 'error');
assertResult('empty input', await invoke(''), 'error');
assertResult('now --bogus', await invoke('now --bogus'), 'error');
assertResult('now --deep --deep', await invoke('now --deep --deep'), 'error');

console.log('');
console.log('=== 3) abort signal is honoured (CommandInvocation.signal) ===');
assertResult('status with signal ALREADY aborted', await invoke('status', { aborted: true }), 'error');

console.log('');
console.log('=== 4) status is read-only + cheap (CONTRACTS §10: no PowerShell, no disk walk) ===');
{
  // A poisoned db/hijacker proves the handler never walks the disk for `status`.
  const calls = { summary: 0, status: 0, list: 0 };
  const poisonedCtx = { commands: { register: (d) => { poisonedCtx._cmd = d; return () => {}; } } };
  registerCommands(poisonedCtx, {
    cfg, log: LOG,
    db: { summary: () => { calls.summary++; return { SAFE: { count: 0, bytes: 0 }, CAUTION: { count: 0, bytes: 0 }, LOCKED: { count: 0, bytes: 0 } }; },
          list: () => { calls.list++; return records.slice(); } },
    hijacker: { status: () => { calls.status++; return { entries: [] }; } },
    refresh: async () => {}, collect: async () => { throw new Error('status must not collect()'); },
  });
  const res = await poisonedCtx._cmd.handler({ commandId: 'x', agent: { id: 'y' }, rawInput: 'status', attachments: [], signal: { aborted: false } });
  console.log('  db.summary calls =', calls.summary, '| hijacker.status calls =', calls.status, '| db.list calls =', calls.list);
  verdict(calls.summary === 1 && calls.status === 1 && calls.list === 0,
    `status read db.summary()+hijacker.status() once and did NOT touch db.list/collect (${JSON.stringify(calls)})`);
  console.log('  status text =', JSON.stringify(res.text));
}

console.log('');
console.log('=== 5) disposer from register() is returned and callable ===');
verdict(typeof dispose === 'function', `registerCommands returned a function (got ${typeof dispose})`);
if (typeof dispose === 'function') {
  dispose();
  console.log('  disposerCalls after dispose() =', disposerCalls);
  verdict(disposerCalls === 1, `disposer unregistered via ctx effect (called ${disposerCalls}x)`);
}

console.log('');
console.log(`>>> ${failures === 0 ? 'COMMANDS SURFACE CONFORMS to the authoritative Host Service contract' : failures + ' CONTRACT DEFECT(S)'}`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
