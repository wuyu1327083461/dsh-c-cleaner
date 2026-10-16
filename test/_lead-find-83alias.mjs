// Lead: find a GENUINE 8.3 alias (short spelling differs from the long spelling) using
// PowerShell's GetShortPathName, and check the alias actually resolves.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const dirs = [
  'C:\\ProgramData', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\Users',
  'C:\\Users\\Public', 'C:\\Users\\kiuhg', 'C:\\Users\\kiuhg\\AppData',
  'C:\\Users\\kiuhg\\AppData\\Local', 'C:\\Users\\kiuhg\\AppData\\Local\\Temp',
  'C:\\Windows', 'C:\\Windows\\Temp', 'C:\\',
];

const script =
  'Get-CimInstance Win32_LogicalFileSecuritySetting -ErrorAction SilentlyContinue | Out-Null;' +
  '$fso = New-Object -ComObject Scripting.FileSystemObject;' +
  'foreach ($p in @(' + dirs.map((d) => `'${d}'`).join(',') + ')) {' +
  '  try { $s = $fso.GetFolder($p).ShortPath; [Console.WriteLine]($p + "`t" + $s) }' +
  '  catch { [Console.WriteLine]($p + "`tERR") }' +
  '}';

console.log('=== PowerShell GetShortPathName survey ===');
let out = '';
try {
  out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 60000,
  });
} catch (e) {
  out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
}
console.log(out.trim());

console.log('\n=== which aliases are GENUINE (spelling differs) and RESOLVE? ===');
const genuine = [];
for (const line of out.split(/\r?\n/)) {
  const [long, short] = line.split('\t');
  if (!long || !short || short === 'ERR') continue;
  const differs = short.toLowerCase() !== long.toLowerCase();
  let resolves = false;
  let real = null;
  try { real = fs.realpathSync.native(short); resolves = true; } catch { /* no */ }
  console.log(`  ${differs ? 'GENUINE' : 'same   '}  ${long}\n            short=${short}  resolves=${resolves}  realpath=${real}`);
  if (differs) genuine.push({ long, short, real });
}

console.log(`\n  ${genuine.length} genuine alias(es) found.`);
if (genuine.length === 0) {
  console.log('\n  NOTE: no directory on this host exposes a short spelling that differs from its long');
  console.log('  spelling, so the 8.3-abort path cannot be triggered here. Any claim about Defect 3');
  console.log('  on THIS host must therefore be "inconclusive", not "fixed" or "still broken".');
} else {
  console.log('\n  Usable aliases:');
  for (const g of genuine) console.log(`    ${g.short}  ->  ${g.real}`);
}
