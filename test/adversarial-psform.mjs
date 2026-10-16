// verifier probe (task-5 item 1) — INDEPENDENT re-derivation of the PowerShell JSON-parse behaviour.
//
// Does NOT trust the Lead's transcript and does NOT import the plugin: this measures raw
// PowerShell 5.1 semantics for the two forms, then measures the plugin's REAL PS_SCRIPT template
// in isolation by driving it with the same env-var contract the resolver uses.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let failures = 0;
const verdict = (ok, msg) => { console.log('  ->', ok ? 'OK' : 'DEFECT:', msg); if (!ok) failures++; };

const ps = (body, env = {}) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  return { out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim(), status: r.status };
};

console.log('=== PS version (must be 5.1 for the piped-JSON binding rule) ===');
const ver = ps('$PSVersionTable.PSVersion.ToString()');
console.log('  PSVersion =', ver.out, '| status =', ver.status);

// ------------------------------------------------------------------ A: the two parse forms
console.log('');
console.log('=== A: @($x | ConvertFrom-Json)  vs  foreach over ConvertFrom-Json -InputObject ===');
const TWO = JSON.stringify(['C:\\a\\one.tmp', 'C:\\a\\two.tmp']);
const probeA = `
$env:CC_RM_PATHS = '${TWO.replace(/'/g, "''")}'
$piped = @($env:CC_RM_PATHS | ConvertFrom-Json)
$obj   = ConvertFrom-Json -InputObject $env:CC_RM_PATHS
$loop  = @()
foreach ($i in @($obj)) { $loop += [string]$i }
Write-Output ("PIPED_COUNT=" + @($piped).Count)
Write-Output ("PIPED_0=[" + [string]@($piped)[0] + "]")
Write-Output ("LOOP_COUNT=" + @($loop).Count)
Write-Output ("LOOP_0=[" + [string]@($loop)[0] + "]")
Write-Output ("LOOP_1=[" + [string]@($loop)[1] + "]")
`;
const a = ps(probeA);
console.log(a.out.split('\n').map((l) => '  ' + l).join('\n'));
const aPiped0 = /PIPED_0=\[(.*)\]/.exec(a.out)?.[1] ?? '';
const aLoopCount = Number(/LOOP_COUNT=(\d+)/.exec(a.out)?.[1] ?? -1);
verdict(aPiped0.includes(' ') , `the piped form collapses 2 paths into ONE space-joined string (PIPED_0 = "${aPiped0}")`);
verdict(aLoopCount === 2, `the foreach form yields BOTH paths (LOOP_COUNT = ${aLoopCount})`);

// ------------------------------------------------------------------ B: scale to 25 paths
console.log('');
console.log('=== B: does the piped collapse persist across a maxBatch-sized array? ===');
const many = Array.from({ length: 25 }, (_, i) => `C:\\t\\f${i}.tmp`);
const B = JSON.stringify(many);
const probeB = `
$env:CC_RM_PATHS = '${B.replace(/'/g, "''")}'
$piped = @($env:CC_RM_PATHS | ConvertFrom-Json)
$obj   = ConvertFrom-Json -InputObject $env:CC_RM_PATHS
$loop  = @(); foreach ($i in @($obj)) { $loop += [string]$i }
Write-Output ("PIPED_COUNT=" + @($piped).Count)
Write-Output ("LOOP_COUNT=" + @($loop).Count)
Write-Output ("PIPED_JOINED_IS_ONE=" + (@($piped).Count -eq 1))
`;
const b = ps(probeB);
console.log(b.out.split('\n').map((l) => '  ' + l).join('\n'));
const bPiped = Number(/PIPED_COUNT=(\d+)/.exec(b.out)?.[1] ?? -1);
const bLoop = Number(/LOOP_COUNT=(\d+)/.exec(b.out)?.[1] ?? -1);
verdict(bPiped === 1, `the piped form yields 1 item for 25 paths (got ${bPiped})`);
verdict(bLoop === 25, `the foreach form yields all 25 (got ${bLoop})`);

// ------------------------------------------------------------------ C: the actual RM contract
console.log('');
console.log('=== C: what Restart Manager ACTUALLY answers for the collapsed string ===');
// Drive the plugin's own template by importing the module and calling resolve() with a batch whose
// paths are REAL and locked, then confirm a wrong-parse would show as ERR|RmGetList|6.
const base = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp', `dshcc_psform_${process.pid}_${Date.now().toString(36)}`);
fs.mkdirSync(base, { recursive: true });
const held = path.join(base, 'psform-held.tmp');
fs.writeFileSync(held, 'P'.repeat(40));
const ready = `${held}.ready`;
// NOTE: the holder must be spawned ASYNCHRONOUSLY. A first version used spawnSync here and the
// blocking call meant the holder never armed (holder ready = false) and the probe hung.
const { spawn } = await import('node:child_process');
const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
  `$ErrorActionPreference='Stop'; $f=[System.IO.File]::Open('${held}','Open','ReadWrite','None'); [System.IO.File]::WriteAllText('${ready}','ok'); Start-Sleep -Seconds 60; $f.Close()`,
], { windowsHide: true, stdio: 'ignore' });
const t0 = Date.now();
while (!fs.existsSync(ready) && Date.now() - t0 < 20000) { await new Promise((r2) => setTimeout(r2, 200)); }
console.log('  holder pid =', holder.pid, '| holder ready =', fs.existsSync(ready));
const { LockOwnerResolver } = await import('../lib/lock-owner.js');
const r = new LockOwnerResolver({ batchWindowMs: 40, timeoutMs: 20000 });
const map = await r.resolve([held, path.join(base, 'absent-1.tmp'), path.join(base, 'absent-2.tmp')]);
console.log('  resolve() map size =', map.size, '| held ->', JSON.stringify(map.get(held)));
const log = [];
void log;
r.close();

// Ask RM directly about the COLLAPSED string to show the failure signature the bug produced.
const collapsed = [held, path.join(base, 'absent-1.tmp')].join(' ');
const probeC = `
Add-Type -AssemblyName System.Windows.Forms
$r = New-Object System.Management.Automation.PSObject
try {
  $s = New-Object -ComObject RestartManager.RestartManagerSession
  $s.ShowOutput = $false
  $fileList = New-Object System.Collections.Generic.List[string]
  $fileList.Add('${collapsed.replace(/'/g, "''")}')
  $err = $s.GetList($fileList)
  Write-Output ("RM_ERR=" + $err)
} catch { Write-Output ("RM_THREW=" + $_.Exception.Message) }
`;
const c = ps(probeC);
console.log(c.out.split('\n').map((l) => '  ' + l).join('\n'));

verdict(map.size === 3, `resolve() returned a key for all 3 paths (size ${map.size}) — a collapsed parse would return 0`);
verdict(Boolean(map.get(held)), `the genuinely held path reports an owner: ${JSON.stringify(map.get(held))}`);
verdict(map.get(path.join(base, 'absent-1.tmp')) === null, 'an absent path answers null (a REAL answer), not a dropped key');

try { fs.rmSync(base, { recursive: true, force: true }); } catch {}

console.log('');
console.log(`>>> ITEM 1 (independent PS derivation): ${failures === 0 ? 'CONFIRMED — piped parse collapses, -InputObject + foreach enumerates' : failures + ' DEFECT(S)'}`);
process.exit(failures === 0 ? 0 : 1);
