// DECISIVE MECHANISM TEST (Lead).
// Question: does mutating process.env in the plugin's process actually reach child processes
// spawned through the harness's own subprocess pipeline?
//
// Reading the source says yes:
//   dsh-subprocess/lib/index.js:50-56  scrubbedParentEnv() reads LIVE process.env, dropping only
//                                      /KEY|PASSWORD|SECRET|TOKEN/i matches and 'DSH_*' names.
//   dsh-subprocess-local/.../runner-launch: childEnv(spec.env) = scrubbedParentEnv() + spec.env
//   dsh-bash-local/lib/index.js:122    env = { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }
// None of our 9 hijack names contains KEY/PASSWORD/SECRET/TOKEN or starts with DSH_, so they
// should survive. This script proves it against the REAL installed function rather than my reading.

const HARNESS = 'C:/Users/kiuhg/AppData/Roaming/dsh-tauri/dependencies/dsh/node_modules';
const mod = await import(`file:///${HARNESS}/@deepseek-ai/dsh-subprocess/lib/index.js`);

const scrub = mod.scrubbedParentEnv;
if (typeof scrub !== 'function') {
  console.log('scrubbedParentEnv not exported; exports =', Object.keys(mod).join(', '));
  process.exit(1);
}

const VARS = ['TEMP', 'TMP', 'TMPDIR', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'HF_HOME', 'TORCH_HOME', 'NPM_CONFIG_CACHE', 'PLAYWRIGHT_BROWSERS_PATH'];
const ESCAPE = 'E:\\dsh_escape_cache';

const before = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
console.log('--- parent process.env BEFORE hijack ---');
for (const k of VARS) console.log(`  ${k.padEnd(24)} = ${before[k] ?? '(unset)'}`);

// Simulate exactly what EnvHijacker.install() does.
for (const k of VARS) process.env[k] = k === 'TEMP' || k === 'TMP' || k === 'TMPDIR' ? `${ESCAPE}\\temp` : `${ESCAPE}\\${k.toLowerCase()}`;

const scrubbed = scrub();
console.log('\n--- scrubbedParentEnv() AFTER hijack (what every harness child inherits) ---');
let passed = 0;
for (const k of VARS) {
  const got = scrubbed[k];
  const ok = typeof got === 'string' && got.startsWith(ESCAPE);
  if (ok) passed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${k.padEnd(24)} = ${got ?? '(DROPPED)'}`);
}
console.log(`\nRESULT: ${passed}/${VARS.length} hijacked variables survive the harness env scrub`);

// Negative control: prove the scrub really is applied, i.e. this test can fail.
process.env.MY_FAKE_API_KEY = 'x';
process.env.DSH_SHOULD_BE_STRIPPED = 'x';
const scrubbed2 = scrub();
console.log('\n--- negative control (proves the scrub is live) ---');
console.log('  MY_FAKE_API_KEY present      :', 'MY_FAKE_API_KEY' in scrubbed2, '(expect false — matches KEY)');
console.log('  DSH_SHOULD_BE_STRIPPED present:', 'DSH_SHOULD_BE_STRIPPED' in scrubbed2, '(expect false — DSH_ prefix)');
delete process.env.MY_FAKE_API_KEY;
delete process.env.DSH_SHOULD_BE_STRIPPED;

// End-to-end: actually spawn a real child and read back what it sees.
console.log('\n--- end-to-end: real child process ---');
const { execFileSync } = await import('node:child_process');
const out = execFileSync('cmd.exe', ['/c', 'echo %TEMP%'], { env: scrubbed, encoding: 'utf8' }).trim();
console.log('  child cmd.exe saw TEMP =', out);
console.log('  child inherited escape :', out.startsWith(ESCAPE));

for (const k of VARS) if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];

process.exit(passed === VARS.length && out.startsWith(ESCAPE) ? 0 : 1);
