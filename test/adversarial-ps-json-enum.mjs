// verifier probe (task-4 re-verify rev3) — item 1: independently re-derive the PowerShell
// `ConvertFrom-Json` enumeration behaviour and the old-vs-new batching defect.
//
// The point of this probe is that it does NOT trust a paraphrase of the script. It reads
// lib/lock-owner.js, extracts the LIVE PS_SCRIPT template literal, and reconstructs the OLD
// variant by substituting exactly one line back. Both are then executed against REAL locked
// files so the raw CCRM output is observed rather than inferred.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const STAMP = `${process.pid}_${Date.now().toString(36)}`;
let failures = 0;
const verdict = (ok, msg) => { console.log('  ->', ok ? 'OK' : 'DEFECT:', msg); if (!ok) failures++; };

// --- extract the shipped script -----------------------------------------------------------------
const src = fs.readFileSync(new URL('../lib/lock-owner.js', import.meta.url), 'utf8');
const OPEN = 'const PS_SCRIPT = `';
const start = src.indexOf(OPEN);
if (start < 0) { console.log('FATAL: could not locate PS_SCRIPT in lib/lock-owner.js'); process.exit(2); }
const bodyStart = start + OPEN.length;
const end = src.indexOf('`;', bodyStart);
if (end < 0) { console.log('FATAL: could not locate the end of PS_SCRIPT'); process.exit(2); }
const PS_NEW = src.slice(bodyStart, end);

const NEW_LINE = 'if ($env:CC_RM_PATHS) { $o = ConvertFrom-Json -InputObject $env:CC_RM_PATHS; foreach ($i in @($o)) { $paths += [string]$i } }';
const OLD_LINE = 'if ($env:CC_RM_PATHS) { $paths = @($env:CC_RM_PATHS | ConvertFrom-Json) }';

console.log('=== extracted the shipped script ===');
console.log('  PS_SCRIPT length =', PS_NEW.length);
console.log('  contains the NEW (-InputObject + foreach) line  =', PS_NEW.includes(NEW_LINE));
verdict(PS_NEW.includes(NEW_LINE), 'the live script uses the -InputObject + foreach form');
verdict(!PS_NEW.includes(OLD_LINE), 'the live script no longer contains the pipe-into-ConvertFrom-Json form');

const PS_OLD = PS_NEW.replace(NEW_LINE, OLD_LINE);
verdict(PS_OLD !== PS_NEW && PS_OLD.includes(OLD_LINE), 'reconstructed the OLD variant from the live script by substituting exactly one line');

function runPs(script, paths, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
        env: { ...process.env, CC_RM_PATHS: JSON.stringify(paths) } },
      (err, stdout, stderr) => resolve({ err: err ? (err.code || err.message) : null, stdout: stdout || '', stderr: stderr || '' }));
  });
}

// --- A. the pure enumeration semantics, isolated from the Restart Manager ----------------------
console.log('');
console.log('=== A. how each form enumerates a JSON array (0/1/2/3/25 paths) ===');
const ENUM = `
$ErrorActionPreference='Stop'
$json = $env:CC_JSON
# form 1: pipe into ConvertFrom-Json (the OLD line)
$p1 = @()
if ($json) { $p1 = @($json | ConvertFrom-Json) }
# form 2: -InputObject + foreach (the NEW line)
$p2 = @()
if ($json) { $o = ConvertFrom-Json -InputObject $json; foreach ($i in @($o)) { $p2 += [string]$i } }
$n1 = @($p1).Count; $n2 = @($p2).Count
$s1 = (@($p1) -join '~'); $s2 = (@($p2) -join '~')
Write-Output ("N1=" + $n1 + " N2=" + $n2)
Write-Output ("S1=" + $s1)
Write-Output ("S2=" + $s2)
`;
for (const n of [0, 1, 2, 3, 25]) {
  const paths = Array.from({ length: n }, (_, i) => `E:\\enum\\file_${i}.tmp`);
  const json = n === 0 ? '' : JSON.stringify(paths);
  const res = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ENUM],
      { timeout: 60000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CC_JSON: json } },
      (e, so) => resolve({ e, so: so || '' }));
  });
  const n1 = (res.so.match(/N1=(\d+)/) || [])[1];
  const n2 = (res.so.match(/N2=(\d+)/) || [])[1];
  const s1 = (res.so.match(/S1=(.*)/) || [])[1] || '';
  const mismatch = n >= 2 && Number(n1) !== n;
  console.log(`  paths=${String(n).padStart(2)}: OLD(piped).Count=${n1}  NEW(-InputObject).Count=${n2}  ${mismatch ? '<<< MISMATCH' : ''}`);
  if (n === 2) {
    console.log(`        OLD joined  = ${JSON.stringify(s1)}`);
    console.log(`        NEW joined  = ${JSON.stringify((res.so.match(/S2=(.*)/) || [])[1] || '')}`);
    verdict(Number(n1) === 1, `OLD form collapses 2 paths into ONE item (RESTART MANAGER got a space-joined filename)`);
    verdict(Number(n2) === 2, `NEW form preserves both paths (got ${n2})`);
  }
  if (n >= 1) verdict(Number(n2) === n, `NEW form enumerates ${n} path(s) correctly (got ${n2})`);
}

// --- B. the REAL script against REAL locked files ---------------------------------------------
console.log('');
console.log('=== B. the real scripts against two live exclusive handles ===');
const base = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp', `dshcc_psjson_${STAMP}`);
fs.mkdirSync(base, { recursive: true });
const holders = [];
const held = [];
try {
  const v1 = path.join(base, 'held-a.tmp');
  const v2 = path.join(base, 'held-b.tmp');
  for (const v of [v1, v2]) {
    fs.writeFileSync(v, 'L'.repeat(32));
    const flag = `${v}.ready`;
    const ps = [
      `$ErrorActionPreference='Stop'`,
      `$f=[System.IO.File]::Open('${v}','Open','ReadWrite','None')`,
      `[System.IO.File]::WriteAllText('${flag}','ok')`,
      `Start-Sleep -Seconds 120`,
      `$f.Close()`,
    ].join('; ');
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
    holders.push(c);
    const t0 = Date.now();
    while (!fs.existsSync(flag) && Date.now() - t0 < 25000) await new Promise((r) => setTimeout(r, 200));
    if (!fs.existsSync(flag)) { console.log('INCONCLUSIVE: holder for', v, 'never became ready'); }
  }
  const readyCount = holders.filter((c, i) => fs.existsSync(`${i === 0 ? v1 : v2}.ready`)).length;
  if (readyCount < 2) {
    console.log(`INCONCLUSIVE: only ${readyCount}/2 exclusive handles could be taken; cannot test a 2-path batch`);
    console.log('>>> PS JSON ENUM: inconclusive');
    process.exit(0);
  }
  console.log('  holder pids =', holders.map((c) => c.pid).join(', '));

  for (const [label, script] of [['OLD(piped)', PS_OLD], ['NEW(-InputObject)', PS_NEW]]) {
    const res = await runPs(script, [v1, v2]);
    const lines = res.stdout.split(/\r?\n/).filter((l) => l.startsWith('CCRM|'));
    console.log(`  ${label}: raw stdout lines = ${lines.length}`);
    for (const l of lines) console.log('     ', l);
    if (label.startsWith('OLD')) {
      const errs = lines.filter((l) => l.includes('ERR|RmGetList|6'));
      verdict(errs.length >= 1, `OLD form reproduces ERR|RmGetList|6 for a 2-path batch (found ${errs.length})`);
      const hits = lines.filter((l) => l.includes('HIT|'));
      verdict(hits.length === 0, `OLD form yields NO usable HIT for either path (found ${hits.length})`);
    } else {
      const hits = lines.filter((l) => l.includes('HIT|'));
      verdict(hits.length === 2, `NEW form yields a HIT for BOTH paths (found ${hits.length})`);
      let matched = 0;
      for (let i = 0; i < 2; i += 1) {
        const want = i === 0 ? v1 : v2;
        const wantPid = holders[i].pid;
        const b64 = Buffer.from(want, 'utf8').toString('base64');
        const line = lines.find((l) => l.startsWith(`CCRM|${b64}|`));
        const ok = Boolean(line) && line.includes(`|${wantPid}`) && line.includes('HIT|');
        if (ok) matched += 1;
        console.log(`     path${i + 1}: answered=${Boolean(line)} pid-match=${Boolean(line) && line.includes(`|${wantPid}`)} (want ${wantPid})`);
      }
      verdict(matched === 2, `NEW form reports each path's OWN holder pid (matched ${matched}/2)`);
    }
  }
} finally {
  for (const c of holders) { try { c.kill(); } catch {} }
  await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log(`>>> PS JSON ENUM: ${failures === 0 ? 'DEFECT CONFIRMED AND FIX CONFIRMED' : failures + ' UNEXPECTED RESULT(S)'}`);
process.exit(failures === 0 ? 0 : 1);
