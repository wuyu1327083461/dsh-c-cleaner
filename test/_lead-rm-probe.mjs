// Lead probe: can we map a LOCKED file -> holding PID with ZERO dependencies?
//
// Windows' own "file in use" dialog uses the Restart Manager API (rstrtmgr.dll). It needs NO admin,
// NO native addon, and NO Sysinternals binary — only a P/Invoke we can compile once via PowerShell
// Add-Type. This probe answers three questions before we commit to it:
//   1. Does RM actually identify the holder of an exclusively-locked file on this host?
//   2. How long does the FIRST call take (C# compile) vs a WARM call (this is the PRD 6.1 question)?
//   3. Can it be BATCHED (N files -> one process) so the per-file cost stays near zero?
//
// The child process opens LOCK_PATH with an exclusive handle and holds it, so we have ground truth.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp\\dshcc_rm_' + process.pid;
fs.mkdirSync(TMP, { recursive: true });
const LOCK_PATH = path.join(TMP, 'held-by-child.lock');
fs.writeFileSync(LOCK_PATH, 'x'.repeat(64));

// PowerShell that (a) compiles the RM P/Invoke once, (b) reports holders for every path given.
const PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RM {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  const int RmRebootReasonNone = 0, CCH_RM_MAX_APP_NAME = 255, CCH_RM_MAX_SVC_NAME = 63;
  enum RM_APP_TYPE { RmUnknownApp=0, RmMainWindow=1, RmOtherWindow=2, RmService=3, RmExplorer=4, RmConsole=5, RmCritical=1000 }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=CCH_RM_MAX_APP_NAME+1)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=CCH_RM_MAX_SVC_NAME+1)] public string strServiceShortName;
    public RM_APP_TYPE ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In,Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
  public static List<int> Who(string[] paths) {
    uint session; var key = Guid.NewGuid().ToString();
    int r = RmStartSession(out session, 0, key);
    if (r != 0) throw new Exception("RmStartSession failed " + r);
    try {
      r = RmRegisterResources(session, (uint)paths.Length, paths, 0, null, 0, null);
      if (r != 0) throw new Exception("RmRegisterResources failed " + r);
      uint needed = 0, count = 0, reasons = 0;
      r = RmGetList(session, out needed, ref count, null, ref reasons);
      if (r == 234) { count = needed; var arr = new RM_PROCESS_INFO[count]; r = RmGetList(session, out needed, ref count, arr, ref reasons); }
      if (r != 0) throw new Exception("RmGetList failed " + r);
      var pids = new List<int>();
      for (int i = 0; i < count; i++) pids.Add(arr[i].Process.dwProcessId);
      return pids;
    } finally { RmEndSession(session); }
  }
}
'@
$paths = @(${JSON.stringify([LOCK_PATH])} | ForEach-Object { $_ })
$t = [System.Diagnostics.Stopwatch]::StartNew()
foreach ($p in $paths) {
  $pids = [RM]::Who(@($p))
  $names = @()
  foreach ($pid in $pids) { try { $names += "$(Get-Process -Id $pid -ErrorAction Stop | Select-Object -ExpandProperty ProcessName):$pid" } catch { $names += "unknown:$pid" } }
  "RESULT|$p|$($pids.Count)|$($names -join ',')"
}
"ELAPSED_MS|$([int]$t.ElapsedMilliseconds)"
`;

console.log(`=== ground truth: a child process will hold ${LOCK_PATH} exclusively ===`);

// Isolate the child script in this dir so its relative imports resolve (ESM lesson).
const CHILD = path.join(TMP, 'holder.mjs');
fs.writeFileSync(CHILD, `
import fs from 'node:fs';
const fd = fs.openSync(${JSON.stringify(LOCK_PATH)}, 'r+');
console.error('CHILD_HOLDING|' + process.pid);
setTimeout(() => { fs.closeSync(fd); }, 60000);
`);

const child = spawn(process.execPath, [CHILD], { stdio: ['ignore', 'ignore', 'pipe'] });
const childPid = await new Promise((resolve) => {
  child.stderr.on('data', (d) => {
    const m = /CHILD_HOLDING\|(\d+)/.exec(d.toString());
    if (m) resolve(Number(m[1]));
  });
});
console.log(`  child holding the lock: pid ${childPid}`);

// Confirm the lock is real (this is the same probe classifier.isLocked uses)
let lockObserved = 'no throw (NOT locked!)';
try { const fd = fs.openSync(LOCK_PATH, 'r+'); fs.closeSync(fd); }
catch (e) { lockObserved = `${e.code}`; }
console.log(`  openSync('r+') -> ${lockObserved}   (expect EBUSY)`);

function runPs(label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      const wall = Date.now() - t0;
      const res = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('RESULT|') || l.startsWith('ELAPSED_MS|'));
      console.log(`\n--- ${label}: wall ${wall}ms exit ${code} ---`);
      for (const r of res) console.log(`    ${r}`);
      if (code !== 0) console.log(`    stderr: ${err.trim().split('\n').slice(0, 4).join(' | ')}`);
      resolve({ wall, res, code });
    });
  });
}

const cold = await runPs('call 1 (COLD: includes C# compile)');
const warm = await runPs('call 2 (WARM-ish: new powershell, same compiled type? no — recompiles)');

console.log('\n=== verdict ===');
const coldHit = cold.res.some((r) => r.includes(`:${childPid}`));
console.log(`  RM identified the real holder (pid ${childPid}): ${coldHit}`);
console.log(`  cold wall: ${cold.wall}ms   warm wall: ${warm.wall}ms`);
console.log(coldHit
  ? '  => Restart Manager WORKS with zero dependencies; cost is the Add-Type compile per spawn.'
  : '  => RM did NOT identify the holder; do not build on it.');

child.kill();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
