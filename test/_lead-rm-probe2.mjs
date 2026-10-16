// Lead probe, CORRECTED: can we map a genuinely-locked file -> holding PID with zero dependencies?
//
// What was WRONG in v1 (kept as a lesson):
//   1. `$paths = @(["..."])` is a PowerShell SYNTAX ERROR — `[` starts a type literal. RM was never called,
//      so v1's verdict "RM did NOT identify the holder" was a BAD PROBE, not a finding.
//   2. The holder child used Node's `fs.openSync(p,'r+')`, which on Windows opens with
//      FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE — so it is NOT an exclusive lock, and a second
//      Node open succeeds. Ground truth requires a FileShare.None handle (what most Windows apps use).
//
// This version: PowerShell holder with FileShare.None, verified EBUSY before measuring, and a correctly
// quoted PS array. It also answers the PRD 6.1 cost question by timing the compile vs the warm call.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TMP = 'C:\\Users\\kiuhg\\AppData\\Local\\Temp\\dshcc_rm2_' + process.pid;
fs.mkdirSync(TMP, { recursive: true });
const LOCKED = path.join(TMP, 'held-exclusively.lock');
const FREE = path.join(TMP, 'not-locked.txt');
fs.writeFileSync(LOCKED, 'x'.repeat(64));
fs.writeFileSync(FREE, 'y'.repeat(64));

const psQuote = (p) => `'${String(p).replace(/'/g, "''")}'`;

// --- holder: FileShare.None, reports its own PID, sleeps long enough to measure against ---
const HOLDER_PS = `
$h = [System.IO.File]::Open(${psQuote(LOCKED)}, 'Open', 'ReadWrite', 'None')
"HOLDER_PID=$PID"
[Console]::Out.Flush()
Start-Sleep -Seconds 90
$h.Close()
`;
const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HOLDER_PS], { windowsHide: true });
const holderPid = await new Promise((resolve) => {
  let buf = '';
  holder.stdout.on('data', (d) => {
    buf += d.toString();
    const m = /HOLDER_PID=(\d+)/.exec(buf);
    if (m) resolve(Number(m[1]));
  });
});
console.log(`=== ground truth ===`);
console.log(`  FileShare.None holder: pid ${holderPid}`);

let lockSeen = 'NO THROW (not locked!)';
try { const fd = fs.openSync(LOCKED, 'r+'); fs.closeSync(fd); } catch (e) { lockSeen = e.code; }
console.log(`  openSync(LOCKED,'r+') -> ${lockSeen}   (expect EBUSY)`);
let freeSeen = 'THREW';
try { const fd = fs.openSync(FREE, 'r+'); fs.closeSync(fd); freeSeen = 'no throw'; } catch (e) { freeSeen = e.code; }
console.log(`  openSync(FREE,'r+')   -> ${freeSeen}   (expect no throw)`);
if (lockSeen !== 'EBUSY') {
  console.log('  !! ground truth is not established; aborting rather than reporting a bogus verdict');
  holder.kill();
  process.exit(2);
}

const PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RM {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  const int CCH_RM_MAX_APP_NAME = 255, CCH_RM_MAX_SVC_NAME = 63;
  enum RM_APP_TYPE { RmUnknownApp=0, RmMainWindow=1, RmOtherWindow=2, RmService=3, RmExplorer=4, RmConsole=5, RmCritical=1000 }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=CCH_RM_MAX_APP_NAME+1)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=CCH_RM_MAX_SVC_NAME+1)] public string strServiceShortName;
    public RM_APP_TYPE ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nSvcs, string[] svcs);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint count, [In,Out] RM_PROCESS_INFO[] arr, ref uint reasons);
  public static string Who(string[] paths) {
    uint session; var key = Guid.NewGuid().ToString();
    int r = RmStartSession(out session, 0, key);
    if (r != 0) return "ERR:RmStartSession=" + r;
    try {
      r = RmRegisterResources(session, (uint)paths.Length, paths, 0, null, 0, null);
      if (r != 0) return "ERR:RmRegisterResources=" + r;
      uint needed = 0, count = 0, reasons = 0;
      r = RmGetList(session, out needed, ref count, null, ref reasons);
      if (r == 234) { count = needed; var a = new RM_PROCESS_INFO[count]; r = RmGetList(session, out needed, ref count, a, ref reasons); if (r == 0) { var s = new List<string>(); for (int i=0;i<count;i++) s.Add(a[i].strAppName + ":" + a[i].Process.dwProcessId); return string.Join(",", s); } }
      if (r != 0) return "ERR:RmGetList=" + r;
      return "NONE";
    } finally { RmEndSession(session); }
  }
}
'@
$fs = @(${psQuote(LOCKED)}, ${psQuote(FREE)})
$sw = [System.Diagnostics.Stopwatch]::StartNew()
"COMPILE_MS|$([int]$sw.ElapsedMilliseconds)"
foreach ($p in $fs) {
  $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
  $who = [RM]::Who(@($p))
  "RESULT|$p|$([int]$sw2.ElapsedMilliseconds)ms|$who"
}
$sw3 = [System.Diagnostics.Stopwatch]::StartNew()
$n = 0; while ($n -lt 20) { [void][RM]::Who(@($fs[0])); $n++ }
"BATCH_20_MS|$([int]$sw3.ElapsedMilliseconds)"
`;

function runPs(label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      console.log(`\n--- ${label}: wall ${Date.now() - t0}ms exit ${code} ---`);
      for (const l of out.split('\n').map((s) => s.trim()).filter(Boolean)) console.log(`    ${l}`);
      if (code !== 0) console.log(`    stderr: ${err.trim().split('\n').slice(0, 3).join(' | ')}`);
      resolve({ wall: Date.now() - t0, out, code });
    });
  });
}

const r1 = await runPs('call 1 (COLD: C# Add-Type compile included)');
const r2 = await runPs('call 2 (fresh process, recompiles)');

const hit = (r) => r.out.includes(`:${holderPid}`);
console.log('\n=== verdict ===');
console.log(`  ground truth lock confirmed : EBUSY`);
console.log(`  call 1 identified holder    : ${hit(r1)}`);
console.log(`  call 2 identified holder    : ${hit(r2)}`);
console.log(`  wall clock cold / warm      : ${r1.wall}ms / ${r2.wall}ms`);
const comp = /COMPILE_MS\|(\d+)/.exec(r1.out);
const b20 = /BATCH_20_MS\|(\d+)/.exec(r1.out);
if (comp && b20) {
  const perCall = Number(b20[1]) / 20;
  console.log(`  compile portion             : ${comp[1]}ms`);
  console.log(`  20 warm RM calls            : ${b20[1]}ms  => ${perCall.toFixed(1)}ms per call (in-process)`);
}
console.log(hit(r1)
  ? '  => Restart Manager WORKS, zero dependencies, no admin. Cost = one Add-Type compile per spawned process.'
  : '  => RM did not identify the holder; do not build on it.');

holder.kill();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
