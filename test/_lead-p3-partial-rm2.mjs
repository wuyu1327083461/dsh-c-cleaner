/**
 * Probe: does `fs.rmSync(dir, {recursive:true})` delete SOME files before failing on a file
 * another process holds WITHOUT delete sharing?
 *
 * This is the load-bearing question for the live EPERM defect: `moveDirectory`'s recovery
 * path deletes the verified COPY at the target when the source delete fails. If rmSync
 * removed part of the source first, that recovery would destroy data present in NEITHER
 * tree — silent, unrecoverable loss.
 *
 * Node cannot express "open with FileShare.None", so the holder is PowerShell.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrm2_'));
const src = path.join(dir, 'tree');
fs.mkdirSync(src);
fs.mkdirSync(path.join(src, 'nested'));

// Names chosen so a walker deletes a LOT before reaching the locked one.
const names = ['a1.bin', 'a2.bin', 'a3.bin', 'nested/b1.bin', 'nested/b2.bin', 'nested/zlocked.bin', 'zz1.bin', 'zz2.bin'];
for (const n of names) fs.writeFileSync(path.join(src, n), n.repeat(300));

const lockedPath = path.join(src, 'nested', 'zlocked.bin');

// PowerShell holder: FileShare.None, held for 8 s.
const psFile = path.join(dir, 'hold.ps1');
fs.writeFileSync(psFile, `
$ErrorActionPreference = 'Stop'
$fs = [System.IO.File]::Open('${lockedPath.replace(/'/g, "''")}', 'Open', 'Read', 'None')
Write-Output 'HELD'
Start-Sleep -Seconds 8
$fs.Close()
`);
const holder = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { stdio: ['ignore', 'pipe', 'pipe'] });
const heltOut = await new Promise((resolve) => {
  let buf = '';
  holder.stdout.on('data', (d) => { buf += d.toString(); if (buf.includes('HELD')) resolve(buf.trim()); });
  setTimeout(() => resolve(buf.trim() || 'TIMEOUT'), 6000);
});
console.log('holder said:', heltOut);

console.log('before:', fs.readdirSync(src), fs.readdirSync(path.join(src, 'nested')));

let err = null;
try {
  fs.rmSync(src, { recursive: true, force: false });
} catch (e) {
  err = e;
}
console.log('rmSync error:', err ? `${err.code} ${err.message}` : 'none');
console.log('src exists after:', fs.existsSync(src));
if (fs.existsSync(src)) {
  console.log('src contents after:', fs.readdirSync(src));
  const n = path.join(src, 'nested');
  console.log('nested contents after:', fs.existsSync(n) ? fs.readdirSync(n) : 'GONE');
  // THE POINT: did anything vanish?
  let survivors = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full); else survivors.push(path.relative(src, full));
    }
  };
  walk(src);
  const lost = names.filter((n2) => !survivors.includes(n2.replace(/\//g, path.sep)));
  console.log('survivors:', survivors.length, '/', names.length);
  console.log('LOST FILES:', lost.length ? lost : 'none');
}

holder.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
