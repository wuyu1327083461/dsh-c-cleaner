// Validate the proposed tight credential-name regex before it is written into lib/.
const LOOSE = /\.lock$|\.sqlite3?$|\.db$|auth|config|token|credential/i;
const TIGHT = /\.lock$|\.sqlite3?$|\.db$|(?:^|[^a-z0-9])(?:auth|config|credentials?|token)(?=[^a-z0-9]|$)/i;

const TRUE_POS = [
  'credentials.json', 'credentials-mix-1.json', 'auth.json', 'session.token',
  'config.json', 'acc-product-config-v3.json', 'state.db', 'state-1.db',
  'cache.sqlite', 'session-state.sqlite3', 'keep-me.sqlite3',
  'worker.pid.lock', 'x-1.lock', 'held-exclusively.lock', 'token-47812_x.txt',
];
const FALSE_POS = [
  'Kits Configuration Installer-x86_en-us.msi',
  'Contoso Configuration Bundle.msi',
  'VSF51A3FBF.Microsoft.VisualStudio.Copilot.TokenManager.Service.0.3.BrokeredS',
  'VSD93E52BC.Microsoft.VisualStudio.Copilot.TokenManager.Service.0.3.BrokeredS',
  'VSF51A3FBF.Microsoft.Developer.IdentityService.ProxyConfigurationProvider.1.0.',
  'NglFeatureConfig', 'EstConfig.ini', 'IconCache.db',
];

let bad = 0;
console.log('--- true positives must match TIGHT (and LOOSE) ---');
for (const n of TRUE_POS) {
  const t = TIGHT.test(n), l = LOOSE.test(n);
  const ok = t && l;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  tight=${t} loose=${l}  ${n}`);
}
console.log('\n--- false positives must NOT match TIGHT ---');
for (const n of FALSE_POS) {
  const t = TIGHT.test(n), l = LOOSE.test(n);
  const ok = n === 'IconCache.db' ? t : !t; // IconCache.db is a real .db -> tier keeps it
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  tight=${t} loose=${l}  ${n}`);
}

// The invariant the watcher relies on: anything the tight valve admits is also tier-🔴.
console.log('\n--- invariant: TIGHT match => LOOSE match (valve never admits a non-🔴 name) ---');
const fuzz = [];
for (const stem of ['', 'x', 'my', 'pre-', 'a_']) {
  for (const tok of ['auth', 'config', 'token', 'credential', 'credentials', 'Configuration', 'TokenManager']) {
    for (const ext of ['', '.json', '.db', '.log', '.txt', '-v2.json', 's.json']) fuzz.push(stem + tok + ext);
  }
}
let viol = 0;
for (const n of fuzz) if (TIGHT.test(n) && !LOOSE.test(n)) { viol++; console.log('VIOLATION', n); }
console.log(`fuzz cases=${fuzz.length} violations=${viol}`);
if (viol) bad++;

// global-flag hazard: both regexes are non-global, so .test() has no lastIndex state.
console.log(`\nTIGHT.global=${TIGHT.global} LOOSE.global=${LOOSE.global} (must both be false)`);
if (TIGHT.global || LOOSE.global) bad++;

console.log(`\n${bad === 0 ? 'REGEX OK' : `REGEX BAD (${bad} problems)`}`);
process.exitCode = bad === 0 ? 0 : 1;
