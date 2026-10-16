/**
 * lib/cleaner.js — dsh-c-cleaner
 * Owner: classify-clean (shared task task-2).
 * FROZEN signatures: CONTRACTS.md §8 (do not change without telling the Lead).
 *
 *   toRecycleBin(paths, log) -> CleanupReport   (PowerShell Microsoft.VisualBasic
 *                                                FileSystem.DeleteFile + SendToRecycleBin,
 *                                                <=50 paths per PowerShell invocation)
 *   hardDelete(paths, log)   -> CleanupReport   (fs.rmSync(p, {recursive:true, force:false}))
 *   clean(records, opts)     -> CleanupReport   (the orchestrator)
 *
 * Load-bearing requirements (PRD §3.4 / §6.3):
 *  - clean() MUST NEVER THROW.
 *  - Instant re-validation immediately before each delete: re-run isLocked; on a
 *    fresh lock, push to skippedList and CONTINUE.
 *  - EPERM / EACCES / EBUSY per file -> record, CONTINUE; never abort the batch.
 *  - Never touches LOCKED_CRITICAL and never touches an isProtectedPath hit.
 *
 * @typedef {{ removed:number, skipped:number, bytesFreed:number,
 *              errors:Array<{path:string,code:string,message:string}>,
 *              skippedList:Array<{path:string,reason:string}> }} CleanupReport
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CATEGORY, isLocked, isProtectedPath } from './classifier.js';

/** CONTRACTS §8: one PowerShell invocation per chunk of <= 50 paths. */
export const RECYCLE_CHUNK = 50;

/** Guard so a wedged PowerShell (e.g. an unexpected modal dialog) can never hang a run. */
const PS_TIMEOUT_MS = 120000;

const LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/* ------------------------------ tiny utilities --------------------------- */

function callLog(log, level, msg) {
  try {
    if (log && typeof log[level] === 'function') log[level](msg);
  } catch {
    /* logging must never break the cleaner */
  }
}

function emptyReport() {
  return { removed: 0, skipped: 0, bytesFreed: 0, errors: [], skippedList: [] };
}

function normalizeList(paths) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(paths)) return out;
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    return Number.isFinite(st.size) ? st.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Classify what is actually on disk right before deleting it. PRD §3.4 cleans FILES and
 * CONTRACTS §8 hands clean() Classified *file* records, so a directory must never reach a
 * delete call: `fs.rmSync(p, {recursive:true})` would destroy a whole tree, and the
 * recycle-bin shell call would silently drop it. Used to refuse directories AND to keep the
 * `bytesFreed` figure honest — a delete is only ever counted with a real measured size.
 * @returns {{kind:'file', size:number}|{kind:'directory'}|{kind:'link'}|{kind:'missing'}|{kind:'error', code:string, message:string}}
 */
function statForDelete(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    const code = (err && err.code) || 'UNKNOWN';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing', code };
    return { kind: 'error', code, message: String((err && err.message) || err) };
  }
  if (st.isDirectory()) return { kind: 'directory' };
  if (st.isSymbolicLink()) return { kind: 'link' };
  if (!st.isFile()) return { kind: 'other' };
  return { kind: 'file', size: Number.isFinite(st.size) ? st.size : 0 };
}

/** Human text for a refuse-at-delete-time verdict (never used for a deletable file). */
function refuseReason(p, verdict) {
  if (verdict.kind === 'directory') {
    return 'directory, not a file — refused (PRD §3.4 cleans files; use symlink migration, Phase 3)';
  }
  if (verdict.kind === 'link') {
    return 'symbolic link / junction, not a regular file — refused (Phase 3 symlink migration)';
  }
  if (verdict.kind === 'missing') {
    return 'instant re-validation: file no longer exists';
  }
  if (verdict.kind === 'other') {
    return 'not a regular file (special file) — refused';
  }
  return `instant re-validation failed: cannot stat ${verdict.code} — refused (size unverifiable)`;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Normalize a PowerShell-side failure message into a stable code so reports look the
 * same whatever the OS language is. "Another program is using this file" (WinError 32 /
 * ERROR_SHARING_VIOLATION) and access-denied messages become EBUSY / EACCES.
 */
function classifyPsFailure(message, fallback = 'RECYCLE_FAILED') {
  const m = String(message || '');
  if (/正在使用此文件|另一个程序|being used by another process|sharing violation|WinError\s*32|0x20\b/i.test(m)) return 'EBUSY';
  if (/拒绝访问|access is denied|WinError\s*5\b/i.test(m)) return 'EACCES';
  return fallback;
}

/* --------------------------- recycle-bin plumbing ------------------------ */

/**
 * Build the PowerShell payload. Paths never touch the command line: they are
 * handed over as a UTF-8 JSON file, and results come back as a UTF-8 (BOM-less)
 * JSON file, so no quoting/encoding hazard can corrupt them.
 */
function buildRecycleScript(inFile, outFile) {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$inFile  = ${psQuote(inFile)}`,
    `$outFile = ${psQuote(outFile)}`,
    '$raw = Get-Content -LiteralPath $inFile -Raw -Encoding UTF8',
    '# PowerShell 5.1 gotcha: `$raw | ConvertFrom-Json` does NOT enumerate a top-level JSON',
    '# array — it emits the whole array as ONE object, so @(...) would nest it and every',
    '# [string] cast would join all paths with spaces ("path format not supported").',
    '# Parse with -InputObject and flatten explicitly, then force [string] per element.',
    '$parsed = ConvertFrom-Json -InputObject $raw',
    '$paths = New-Object System.Collections.ArrayList',
    'foreach ($item in @($parsed)) {',
    '  if ($item -is [System.Array]) { foreach ($sub in $item) { [void]$paths.Add([string]$sub) } }',
    '  else { [void]$paths.Add([string]$item) }',
    '}',
    '$results = New-Object System.Collections.ArrayList',
    'foreach ($p in $paths) {',
    '  $p = [string]$p',
    '  $size = [int64]0',
    '  try { $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop; $size = [int64]$item.Length } catch { $size = [int64]0 }',
    '  try {',
    '    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
    "    [void]$results.Add([pscustomobject]@{ path = [string]$p; ok = $true; size = [int64]$size; code = ''; message = '' })",
    '  } catch {',
    "    [void]$results.Add([pscustomobject]@{ path = [string]$p; ok = $false; size = [int64]$size; code = 'RECYCLE_FAILED'; message = [string]$_.Exception.Message })",
    '  }',
    '}',
    '$json = ConvertTo-Json -InputObject @($results) -Compress -Depth 4',
    '[System.IO.File]::WriteAllText($outFile, $json, (New-Object System.Text.UTF8Encoding($false)))',
    '',
  ].join('\r\n');
}

function makeScratchDir() {
  const bases = [os.tmpdir(), process.cwd()];
  for (const base of bases) {
    try {
      return fs.mkdtempSync(path.join(base, 'dsh-cclean-'));
    } catch {
      /* try the next base */
    }
  }
  throw Object.assign(new Error('no writable scratch directory'), { code: 'ESCRATCH' });
}

function runPowerShell(scriptPath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      execFile(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => finish({ err: err || null, stdout: String(stdout || ''), stderr: String(stderr || '') }),
      ).on('error', (err) => finish({ err, stdout: '', stderr: '' }));
    } catch (err) {
      finish({ err, stdout: '', stderr: '' });
    }
  });
}

function readResults(outFile) {
  const text = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(text);
  const arr = Array.isArray(parsed) ? parsed : parsed == null ? [] : [parsed];
  return arr.map((r) => ({
    path: String(r && r.path != null ? r.path : ''),
    ok: !!(r && r.ok),
    size: Number.isFinite(r && r.size) ? Number(r.size) : 0,
    code: String((r && r.code) || ''),
    message: String((r && r.message) || ''),
  }));}

/** Delete one chunk of <=50 paths via a single PowerShell invocation. Never throws. */
async function recycleChunk(chunk) {
  let scratch = null;
  try {
    scratch = makeScratchDir();
    const inFile = path.join(scratch, 'in.json');
    const outFile = path.join(scratch, 'out.json');
    const scriptFile = path.join(scratch, 'recycle.ps1');
    fs.writeFileSync(inFile, JSON.stringify(chunk), 'utf8');
    fs.writeFileSync(scriptFile, buildRecycleScript(inFile, outFile), 'utf8');

    const { err, stderr } = await runPowerShell(scriptFile);
    if (err && !fs.existsSync(outFile)) {
      const code = err.code || (err.killed ? 'PS_TIMEOUT' : 'PS_FAILED');
      return { chunkError: { code, message: String(err.message || err) + (stderr ? ` | stderr: ${stderr.slice(0, 500)}` : '') } };
    }
    return { results: readResults(outFile) };
  } catch (err) {
    return { chunkError: { code: (err && err.code) || 'RECYCLE_FAILED', message: String((err && err.message) || err) } };
  } finally {
    if (scratch) {
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* scratch cleanup is best-effort */
      }
    }
  }
}

/* ------------------------------ §8 toRecycleBin -------------------------- */

/**
 * Move paths to the Windows recycle bin. Never throws.
 * @param {string[]} paths
 * @param {{debug?:Function,info?:Function,warn?:Function,error?:Function}} [log]
 * @returns {Promise<CleanupReport>}
 */
export async function toRecycleBin(paths, log) {
  const report = emptyReport();
  try {
    const list = normalizeList(paths);
    if (list.length === 0) return report;

    for (let i = 0; i < list.length; i += RECYCLE_CHUNK) {
      const chunk = list.slice(i, i + RECYCLE_CHUNK);
      callLog(log, 'debug', `c-cleaner: recycling ${chunk.length} path(s) (batch ${Math.floor(i / RECYCLE_CHUNK) + 1})`);

      let outcome;
      try {
        outcome = await recycleChunk(chunk);
      } catch (err) {
        outcome = { chunkError: { code: (err && err.code) || 'RECYCLE_FAILED', message: String((err && err.message) || err) } };
      }

      if (outcome.chunkError) {
        const { code, message } = outcome.chunkError;
        /* The PowerShell call itself failed (could not even report). The files may still
         * be there, but never claim a removal we did not observe: verify each path. */
        for (const p of chunk) {
          if (fs.existsSync(p)) {
            report.errors.push({ path: p, code, message });
            report.skippedList.push({ path: p, reason: `delete call failed: ${code} (${message.slice(0, 200)})` });
            report.skipped += 1;
          } else {
            report.removed += 1;
            report.bytesFreed += sizeOf(p);
          }
        }
        callLog(log, 'warn', `c-cleaner: recycle batch failed (${code}); continuing with the next batch`);
        continue;
      }

      const results = outcome.results || [];
      const retry = [];
      for (let k = 0; k < chunk.length; k += 1) {
        const p = chunk[k];
        const r = results[k];
        if (!r) {
          report.errors.push({ path: p, code: 'UNACCOUNTED', message: 'PowerShell returned no result for this path' });
          report.skippedList.push({ path: p, reason: 'delete result missing (UNACCOUNTED)' });
          report.skipped += 1;
          continue;
        }
        if (r.ok) {
          report.removed += 1;
          report.bytesFreed += r.size > 0 ? r.size : sizeOf(p);
        } else {
          retry.push({ p, r });
        }
      }

      /* PRD §6.3 isolation: the Shell file operation behind DeleteFile can fail for a
       * whole batch because ONE path is locked. When a chunk of >1 has failures, ask
       * about each failed path on its own so a single locked file cannot cascade into
       * a false "everyone in this batch failed" report — and so the survivors still go
       * to the recycle bin. */
      for (const { p, r } of retry) {
        if (chunk.length > 1) {
          let solo = null;
          try {
            solo = await recycleChunk([p]);
          } catch {
            solo = null;
          }
          const sr = !solo || solo.chunkError ? null : (solo.results || [])[0];
          if (sr && sr.ok) {
            report.removed += 1;
            report.bytesFreed += sr.size > 0 ? sr.size : sizeOf(p);
            continue;
          }
          if (sr && !sr.ok) r.message = sr.message || r.message;
          if (!sr && fs.existsSync(p) === false) {
            /* It is genuinely gone even though the batch call choked on it. */
            report.removed += 1;
            report.bytesFreed += r.size > 0 ? r.size : sizeOf(p);
            continue;
          }
        }
        const code = classifyPsFailure(r.message, r.code || 'RECYCLE_FAILED');
        report.errors.push({ path: p, code, message: r.message || 'recycle failed' });
        report.skippedList.push({ path: p, reason: `recycle failed: ${r.message || r.code}` });
        report.skipped += 1;
      }
    }
  } catch (err) {
    report.errors.push({ path: '*', code: (err && err.code) || 'RECYCLE_FAILED', message: String((err && err.message) || err) });
  }
  return report;
}

/* ------------------------------- §8 hardDelete --------------------------- */

/**
 * Physical delete. Never throws.
 * @param {string[]} paths
 * @param {{debug?:Function,info?:Function,warn?:Function,error?:Function}} [log]
 * @returns {Promise<CleanupReport>}
 */
export async function hardDelete(paths, log) {
  const report = emptyReport();
  try {
    const list = normalizeList(paths);
    for (const p of list) {
      const size = sizeOf(p);
      try {
        fs.rmSync(p, { recursive: true, force: false });
        report.removed += 1;
        report.bytesFreed += size;
      } catch (err) {
        const code = (err && err.code) || 'UNKNOWN';
        if (code === 'ENOENT') {
          report.skippedList.push({ path: p, reason: 'file no longer exists (already gone)' });
          report.skipped += 1;
          continue;
        }
        /* PRD §6.3: permission/lock errors demote that file and the loop continues. */
        report.errors.push({ path: p, code, message: String((err && err.message) || err) });
        report.skippedList.push({
          path: p,
          reason: LOCK_CODES.has(code)
            ? `delete failed: ${code} (locked / in use by another process)`
            : `delete failed: ${code}`,
        });
        report.skipped += 1;
        callLog(log, 'warn', `c-cleaner: hardDelete failed for ${p}: ${code}; continuing`);
      }
    }
  } catch (err) {
    report.errors.push({ path: '*', code: (err && err.code) || 'DELETE_FAILED', message: String((err && err.message) || err) });
  }
  return report;
}

/* --------------------------------- §8 clean ------------------------------ */

/**
 * One-click cleaner (PRD §3.4). Selects SAFE_TO_DELETE (+ CAUTION_CACHE when
 * `deep`), re-validates every file's lock state immediately before deleting it,
 * and NEVER throws.
 * @param {Array<any>} records Classified[]
 * @param {{deep?:boolean, force?:boolean, cfg?:any, log?:any}} [opts]
 * @returns {Promise<CleanupReport>}
 */
export async function clean(records, opts = {}) {
  const report = emptyReport();
  const log = opts && opts.log ? opts.log : null;

  try {
    const deep = !!(opts && opts.deep);
    const force = !!(opts && opts.force);
    const cfg = (opts && opts.cfg) || null;
    const protectRoots = Array.isArray(cfg && cfg.protectRoots) ? cfg.protectRoots : [];

    const pushSkip = (p, reason) => {
      report.skippedList.push({ path: p, reason });
      report.skipped += 1;
    };

    const input = Array.isArray(records) ? records : [];
    if (input.length === 0) return report;

    /* ---------------- selection: category + protected-path gate ---------------- */
    const selected = [];
    const seen = new Set();

    for (const rec of input) {
      try {
        const p = typeof rec === 'string' ? rec : rec && rec.path;
        if (typeof p !== 'string' || p.length === 0) {
          pushSkip(String(p ?? '<unknown>'), 'invalid record: no path');
          continue;
        }
        const key = p.toLowerCase();
        if (seen.has(key)) {
          pushSkip(p, 'duplicate record (already processed)');
          continue;
        }
        seen.add(key);

        /* Structural refusal, FIRST and independent of category: a directory (or a link /
         * special file) is not a file. `fs.rmSync(p,{recursive:true})` would destroy a whole
         * tree, so no category value — not even a hand-built SAFE record — may widen the file
         * clean into a tree delete. Done before the category branches so the reported reason is
         * accurate instead of the generic "critical persistence pattern" text. */
        const kind = statForDelete(p);
        if (kind.kind === 'directory' || kind.kind === 'link' || kind.kind === 'other') {
          pushSkip(p, refuseReason(p, kind));
          callLog(log, 'warn', `c-cleaner: refusing ${p} — ${kind.kind}, not a regular file (PRD §3.4 cleans files)`);
          continue;
        }

        const category = rec && typeof rec === 'object' ? rec.category : null;

        if (category === CATEGORY.LOCKED) {
          const detail = rec && rec.isLocked
            ? `file is locked/in use${rec.lockedByPid ? ` (pid ${rec.lockedByPid}${rec.lockedByProcess ? ` ${rec.lockedByProcess}` : ''})` : ''}`
            : 'critical persistence name pattern (treated as locked)';
          pushSkip(p, `LOCKED_CRITICAL — never deleted: ${detail}`);
          continue;
        }
        if (category !== CATEGORY.SAFE && !(deep && category === CATEGORY.CAUTION)) {
          pushSkip(p, `category ${category || 'unknown'} not selected (run with --deep to include CAUTION_CACHE)`);
          continue;
        }
        if (isProtectedPath(p, protectRoots)) {
          pushSkip(p, 'protected path (PRD 6.2 hardcoded blacklist) — refused');
          continue;
        }
        selected.push({ path: p, size: Number.isFinite(rec && rec.size) ? Number(rec.size) : sizeOf(p) });
      } catch (err) {
        pushSkip('<unknown>', `record error: ${(err && err.message) || err}`);
      }
    }

    callLog(
      log,
      'info',
      `c-cleaner: clean() selected ${selected.length} of ${input.length} record(s) (deep=${deep}, force=${force}, mode=${force ? 'physical' : 'recycle-bin'})`,
    );

    /* ------- delete phase: instant re-validation, then chunked deletion ------- */
    for (let i = 0; i < selected.length; i += RECYCLE_CHUNK) {
      const chunk = selected.slice(i, i + RECYCLE_CHUNK);
      const live = [];

      for (const item of chunk) {
        /* PRD §3.4 "瞬时二次校验": re-run the exclusive-open probe right before deleting. */
        let probe;
        try {
          probe = isLocked(item.path);
        } catch {
          probe = { locked: false, code: null };
        }
        if (probe.locked) {
          pushSkip(item.path, `instant re-validation: file became locked (${probe.code}) — skipped, not deleted`);
          callLog(log, 'warn', `c-cleaner: skipping ${item.path} — locked (${probe.code}) at delete time`);
          continue;
        }
        if (!fs.existsSync(item.path)) {
          pushSkip(item.path, 'instant re-validation: file no longer exists');
          continue;
        }
        /* PRD §6.2 at the instant of deletion: `{ fresh: true }` bypasses the classifier's
         * per-directory resolve memo, so a directory that became a junction/reparse point
         * AFTER classify() is still recognised as protected. This is the "绝对拒绝" guarantee —
         * it must not depend on a cached resolve taken at classify time. */
        if (isProtectedPath(item.path, protectRoots, { fresh: true })) {
          pushSkip(item.path, 'protected path (PRD 6.2 hardcoded blacklist) — refused');
          continue;
        }
        /* Re-stat immediately before the delete: the path could have been swapped for a
         * directory (or a link) since selection. Never hand a non-regular file to the
         * recursive deleter, and record the REAL byte count so the report cannot claim
         * 0 bytes freed while content was destroyed. */
        const fresh = statForDelete(item.path);
        if (fresh.kind !== 'file') {
          pushSkip(item.path, refuseReason(item.path, fresh));
          callLog(log, 'warn', `c-cleaner: refusing ${item.path} at delete time — ${fresh.kind}`);
          continue;
        }
        live.push({ path: item.path, size: fresh.size });
      }

      if (live.length === 0) continue;

      const targets = live.map((x) => x.path);
      let sub;
      try {
        sub = force ? await hardDelete(targets, log) : await toRecycleBin(targets, log);
      } catch (err) {
        const code = (err && err.code) || 'DELETE_FAILED';
        for (const p of targets) {
          report.errors.push({ path: p, code, message: String((err && err.message) || err) });
          pushSkip(p, `delete call threw: ${code} — continuing with the remaining files`);
        }
        continue;
      }

      report.removed += sub.removed;
      report.bytesFreed += sub.bytesFreed;
      for (const e of sub.errors) report.errors.push(e);
      for (const s of sub.skippedList) pushSkip(s.path, s.reason);

      const failed = new Set();
      for (const e of sub.errors) failed.add(String(e.path).toLowerCase());
      for (const s of sub.skippedList) failed.add(String(s.path).toLowerCase());
      const expectedRemoved = targets.filter((p) => !failed.has(p.toLowerCase())).length;
      if (sub.removed !== expectedRemoved) {
        callLog(
          log,
          'warn',
          `c-cleaner: accounting mismatch in batch — removed=${sub.removed}, expected=${expectedRemoved} (paths: ${targets.length})`,
        );
      }
    }
  } catch (err) {
    /* Belt-and-braces: clean() MUST NEVER THROW (PRD §6.3). */
    report.errors.push({ path: '*', code: (err && err.code) || 'CLEAN_FAILED', message: String((err && err.message) || err) });
    callLog(log, 'error', `c-cleaner: clean() aborted internally: ${(err && err.message) || err}`);
  }

  return report;
}

export default { toRecycleBin, hardDelete, clean, RECYCLE_CHUNK };
