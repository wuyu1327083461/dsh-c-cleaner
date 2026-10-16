// Lead: find a PowerShell form that reliably enumerates a JSON array from an env var,
// for 0/1/2/3/25 elements. The module's current form
//   $paths = @($env:CC_RM_PATHS | ConvertFrom-Json)
// collapses N>1 elements into ONE space-joined string (proven by _lead-h2-raw.mjs).
import { execFile } from 'node:child_process';

const A = 'E:\\one\\a.tmp';
const B = 'E:\\two\\b.tmp';
const C = 'E:\\three\\c.tmp';

const FORMS = {
  'CURRENT  @($env:P | ConvertFrom-Json)': `$paths = @($env:P | ConvertFrom-Json)`,
  'A  foreach over parsed': `$paths = @(); if ($env:P) { $o = ConvertFrom-Json -InputObject $env:P; foreach ($i in $o) { $paths += [string]$i } }`,
  'B  index loop': `$paths = @(); if ($env:P) { $o = ConvertFrom-Json -InputObject $env:P; for ($i = 0; $i -lt @($o).Count; $i++) { $paths += [string]$o[$i] } }`,
  'C  assignment then foreach': `$paths = @(); if ($env:P) { $o = $env:P | ConvertFrom-Json; foreach ($i in @($o)) { $paths += [string]$i } }`,
  'D  JsonArray via .Length': `$paths = @(); if ($env:P) { $o = ConvertFrom-Json -InputObject $env:P; if ($o -is [array]) { $paths = @($o) } else { $paths = @([string]$o) } }`,
};

const CASES = [
  ['empty', []],
  ['one', [A]],
  ['two', [A, B]],
  ['three', [A, B, C]],
  ['twentyfive', Array.from({ length: 25 }, (_, i) => `E:\\p${i}\\f.tmp`)],
];

function probe(form, paths) {
  const script = `${form}
Write-Output ("COUNT=" + @($paths).Count)
foreach ($i in $paths) { Write-Output ("ITEM=" + [string]$i) }`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 20000, windowsHide: true, encoding: 'utf8', env: { ...process.env, P: JSON.stringify(paths) } },
      (e, so) => {
        const counts = /COUNT=(\d+)/.exec(so || '');
        const items = [...String(so || '').matchAll(/ITEM=(.*)/g)].map((m) => m[1].trim());
        resolve({ count: counts ? Number(counts[1]) : -1, items, err: e ? e.message : null });
      },
    );
  });
}

let allGood = true;
for (const [name, form] of Object.entries(FORMS)) {
  const results = [];
  let good = true;
  for (const [label, paths] of CASES) {
    const r = await probe(form, paths);
    const expect = paths.length;
    const ok = r.count === expect && r.items.every((it, i) => it === paths[i]);
    if (!ok) good = false;
    results.push(`${label}:${r.count}/${expect}${ok ? '' : ' MISMATCH ' + JSON.stringify(r.items.slice(0, 3))}`);
  }
  console.log(`${ok(good)} ${name}`);
  console.log(`     ${results.join('  ')}`);
  if (!good) allGood = false;
}
console.log(allGood ? '\nAt least one form is correct for every case.' : '\nNo form passed every case.');

function ok(b) {
  return b ? '  OK  ' : ' FAIL ';
}
