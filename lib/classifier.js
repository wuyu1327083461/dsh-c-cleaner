/**
 * lib/classifier.js — dsh-c-cleaner
 * Owner: classify-clean (shared task task-2).
 * FROZEN signatures: CONTRACTS.md §7 (do not change without telling the Lead).
 *
 * Implements the PRD §3.3 three-tier table and the PRD §6.2 hardcoded
 * protection blacklist.
 *
 *   LOCKED_CRITICAL  : live handle lock  OR  critical basename pattern   (checked FIRST, wins)
 *   SAFE_TO_DELETE   : not locked AND (under a Temp dir OR ext in .tmp/.log/.pyc/.bak
 *                                       OR one-shot temp/extraction basename)
 *   CAUTION_CACHE    : everything else (toolchain caches, model weights, browser kernels)
 *
 * @typedef {{ path:string, size:number, mtimeMs:number, sourceProcess:string|null }} Candidate
 * @typedef {{ path:string, size:number, category:string, isLocked:boolean,
 *              lockedByPid:number|null, lockedByProcess:string|null,
 *              reason:string, sourceProcess:string|null, mtimeMs:number }} Classified
 */
import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Category enum. lib/config.js is owned by the Lead; until it lands we
 * use a fallback that is byte-identical to CONTRACTS.md §3. The lazy
 * import below never throws, so this module is never blocked on it.
 * ------------------------------------------------------------------ */
const FALLBACK_CATEGORY = Object.freeze({
  SAFE: 'SAFE_TO_DELETE',
  CAUTION: 'CAUTION_CACHE',
  LOCKED: 'LOCKED_CRITICAL',
});

/** @type {{SAFE:string, CAUTION:string, LOCKED:string}} */
export let CATEGORY = FALLBACK_CATEGORY;

try {
  const cfgMod = await import('./config.js');
  const c = cfgMod && cfgMod.CATEGORY;
  if (c && typeof c.SAFE === 'string' && typeof c.CAUTION === 'string' && typeof c.LOCKED === 'string') {
    CATEGORY = Object.freeze({ SAFE: c.SAFE, CAUTION: c.CAUTION, LOCKED: c.LOCKED });
  }
} catch {
  /* lib/config.js not written yet (or currently unreadable) — keep the fallback enum. */
}

/* ------------------------------ rule tables ------------------------------ */

/**
 * CONTRACTS.md §7, character-for-character. Applied to the basename only.
 *
 * This is the TIER predicate (PRD §3.3 "属于关键状态"): a name that looks like persistent
 * state is classified 🔴 LOCKED_CRITICAL. It is deliberately the LOOSE form — a bare
 * substring test. Over-classifying here is the SAFE direction: a 🔴 row is greyed out and
 * is never deleted at any flag (PRD §3.3/§4), so a false positive costs a row the user can
 * still see, never a file.
 */
export const LOCKED_BASENAME_RE = /\.lock$|\.sqlite3?$|\.db$|auth|config|token|credential/i;

/**
 * The GATE predicate (PRD §3.2 rule #2 + the §3.3 safety valve). Same job as
 * LOCKED_BASENAME_RE but with the tokens matched as WORDS, not substrings.
 *
 * Why a second pattern is required rather than reusing the loose one: the valve's purpose
 * is to stop the noise gate from silently discarding a credential-shaped file, so an
 * over-admission here does not cost a file — it DEFEATS the gate. Measured live: with the
 * loose pattern, `Contoso Configuration Bundle.msi` was admitted because `Config` appears
 * inside `Configuration`, and `Kits Configuration Installer-x86_en-us.msi` (a Windows SDK
 * installer) landed in the DB as LOCKED_CRITICAL. Every token that must survive still
 * matches (`credentials.json`, `auth.json`, `session.token`, `config.json`, `state.db`,
 * `worker.pid.lock`, `token-47812_x.txt`), and the 245-case fuzz in
 * `test/_lead-p2-regex-design.mjs` proves TIGHT ⊆ LOOSE, so the valve can never admit a
 * name the tier would not also call 🔴.
 *
 * A token must be delimited by a non-alphanumeric boundary (or the string edge), so
 * `acc-product-config-v3.json` and `credentials-mix-1.json` match while `Configuration`
 * and `TokenManager` do not. The suffix alternatives stay as-is: a file ENDING in `.db`
 * is persistent state by the PRD's own pattern list, and that call is the tier's to make.
 */
export const CREDENTIAL_NAME_RE =
  /\.lock$|\.sqlite3?$|\.db$|(?:^|[^a-z0-9])(?:auth|config|credentials?|token)(?=[^a-z0-9]|$)/i;

/** PRD §3.3 "后缀为 .tmp, .log, .pyc, .bak" — frozen list, exactly these four. */
const SAFE_EXT_RE = /\.(tmp|log|pyc|bak)$/i;

/** Path segments that mean "this is a Temp directory" (case-insensitive). */
const TEMP_SEGMENTS = new Set(['temp', 'tmp', 'temporary']);

/**
 * PRD §3.3 "已知一次性解压缓存" — one-shot temp / extraction artifacts.
 * The `tmp*` stem comes from the PRD §3.2 AI-toolchain characteristic list ("tmp*").
 * A basename whose *extension* is a SAFE_EXT is matched by SAFE_EXT_RE first, so
 * this rule only ever fires for names like `tmp8f3a1b.part` / `pip-unpack-ab12/`.
 * Note the LOCKED test runs first, so `tmpconfig.json` is still LOCKED_CRITICAL.
 */
const ONE_SHOT_BASENAME_RE = /^(tmp[\w.-]*|pip-unpack[\w.-]*|pip-install[\w.-]*|pip-req-build[\w.-]*|_mei[\w.-]*)$/i;

/* ------------------------------ small helpers ---------------------------- */

function basenameOf(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

function extOf(base) {
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/*
 * PRD §6.2's blacklist is the last line of defence, so it must not be bypassable by
 * SPELLING. Win32 resolves every one of these to the SAME file as C:\Windows\notepad.exe:
 *   C:\Windows \ notepad.exe     trailing space in a component — Win32 trims it
 *   C:\Windows.\notepad.exe      trailing dot in a component  — Win32 trims it
 *   \\?\C:\Windows\notepad.exe   extended-length device namespace
 *   //?/C:/Windows/notepad.exe   device namespace + forward slashes
 *   C:\PROGRA~1\evil.exe         8.3 short name
 *   <temp>\innocent-cache\x.log  a JUNCTION pointing at C:\Windows\Temp
 * path.resolve() knows none of that. Two-stage canonicalisation instead:
 *
 *   1. canonicalString() — pure string, zero syscalls. Normalise separators,
 *      strip the device namespace, collapse ., .. and drive-relative forms,
 *      trim trailing dots/spaces from EVERY component, lowercase.
 *   2. canonical() — resolve the DIRECTORY chain to its real on-disk form via
 *      fs.realpathSync.native, then re-attach the leaf untouched. This is what
 *      catches a junction / reparse point, whose spelling contains no '~'; an
 *      earlier version of this file only realpath'd when '~' was present, which
 *      let `<temp>\<junction-to-C:\Windows\Temp>\victim.log` classify as
 *      SAFE_TO_DELETE and be deleted for real (the verifier's junction repro).
 *      The leaf is never realpath'd: it is usually already deleted when we
 *      classify, and realpath(leaf) would just throw ENOENT — "gone" must stay
 *      "not protected" so a vanished row can still be dropped from the DB.
 *      PRD §6.1 caps CPU (<2%), and a cold realpath costs ~91 µs, so the result
 *      is memoized PER DIRECTORY (`dirMemo`): one syscall per watched directory,
 *      not per file — ~0.9 µs/call measured. The memo is bounded and TTL'd so a
 *      directory that turns INTO a reparse point is re-resolved shortly after.
 */
const DEVICE_PREFIX = /^\\\\[?.]\\+/;

/** Servers that mean "this machine" in a UNC path; `C$` then really is drive C:. */
const LOCAL_SERVER_RE = /^(localhost|127\.0\.0\.1|\[?::1\]?|\.)$/i;
const ADMIN_SHARE_RE = /^([a-z])\$$/i;

function trimTrailingDotsAndSpaces(s) {
  return s
    .split('\\')
    .map((seg) => seg.replace(/[. ]+$/, '') || seg)
    .join('\\');
}

function canonicalString(p) {
  let s = String(p);
  s = s.replace(/\//g, '\\'); // forward slashes FIRST, before any prefix test

  // A device prefix may carry REPEATED separators (`\\?\\C:\x`, `//?//C:/x`) — Win32 accepts them
  // and fs.realpathSync.native resolves them to the same file, so collapse them here or the
  // blacklist is bypassable by one extra backslash.
  //
  // \\?\UNC\... is a device-flagged UNC path; rewrite it to the plain UNC form FIRST and let the
  // UNC branch below decide, so both spellings share one code path.
  s = s.replace(/^\\\\[?.]\\+UNC\\+/i, '\\\\');
  s = s.replace(DEVICE_PREFIX, ''); // \\?\C:\..  and  \\.\C:\..  ->  C:\..

  if (/^\\\\/.test(s)) {
    // Plain UNC. Split on runs of separators so `\\localhost\\C$\x` keeps working.
    const parts = s.replace(/^\\+/, '').split(/\\+/);
    const server = parts.shift() || '';
    const share = parts.shift() || '';
    const tail = parts.join('\\');
    const host = (process.env.COMPUTERNAME || '').toLowerCase();
    const isLocal = LOCAL_SERVER_RE.test(server) || (host && server.toLowerCase() === host);
    const admin = share.match(ADMIN_SHARE_RE);

    if (isLocal && admin && tail) {
      // \\localhost\C$\Windows\x -> C:\Windows\x. A local administrative share is a live alias
      // for the same physical file (statSync/openSync confirm it), so leaving it unmapped would
      // be a real blacklist bypass; only TRUE remote shares stay treated as remote below.
      s = `${admin[1].toUpperCase()}:\\${tail}`;
    } else {
      // Genuinely remote (or none of our business). path.win32.resolve would invent a drive
      // letter for a network share, so return the UNC form untouched instead.
      s = `\\\\${server}\\${share}${tail ? `\\${tail}` : ''}`;
      return trimTrailingDotsAndSpaces(s).toLowerCase().replace(/\\+$/, '');
    }
  }

  try {
    s = path.win32.resolve(s);
  } catch {
    /* keep the string form */
  }
  // Win32 strips trailing dots/spaces from EVERY component, not just the last one.
  return trimTrailingDotsAndSpaces(s).toLowerCase().replace(/\\+$/, '');
}

/**
 * Stage 2 worker: resolve a DIRECTORY to its real on-disk name.
 *
 * realpathSync.native does the heavy lifting: it expands 8.3 short names (PROGRA~1 ->
 * Program Files) AND follows junctions / symlinks / reparse points — the two spellings that
 * would otherwise walk straight through the PRD §6.2 blacklist.
 *
 * A component may not exist (`C:\PROGRA~1\SomeApp\a.dll` after SomeApp was removed), so
 * realpath-ing one node is not enough: walk up to the LONGEST EXISTING prefix, resolve that,
 * and re-attach the remaining components verbatim. The caller passes a directory, never a
 * leaf, because the leaf is usually already deleted by the time we classify.
 *
 * Returns a canonicalString-shaped value (lowercased, no trailing separator) so callers can
 * concatenate it with a leaf and keep comparing with isUnder().
 */
function resolveDir(s) {
  if (!/^[a-z]:\\/i.test(s)) return s; // drive-absolute only; UNC/remote is returned earlier
  const parts = s.split('\\');
  for (let i = parts.length; i >= 2; i -= 1) {
    let real = null;
    try {
      real = fs.realpathSync.native(parts.slice(0, i).join('\\'));
    } catch {
      continue; // this prefix does not exist (or is not accessible) — try its parent
    }
    if (!real) continue;
    return [real, ...parts.slice(i)].join('\\').toLowerCase().replace(/\\+$/, '');
  }
  return s; // nothing on disk: the string form is the best we have
}

/* ------------------------- stage-2 directory memo ------------------------- *
 * A cold realpath costs ~91 µs (measured, PRD §6.1 caps CPU at 2%), so the result is cached
 * PER DIRECTORY — one syscall per watched directory instead of one per file (~0.9 µs/call).
 * Bounded (DIR_MEMO_MAX) so a pathological path set cannot grow RSS past PRD §6.1's 30 MB,
 * and TTL'd (DIR_MEMO_TTL_MS) so that a directory which BECOMES a reparse point is
 * re-resolved shortly after rather than being trusted forever.
 *
 * Delete-time callers must NOT read this cache: clean()'s immediate re-validation passes
 * { fresh: true }, because PRD §6.2's "绝对拒绝" has to hold at the instant of deletion and a
 * cached resolve could still describe the directory as it was before the junction appeared.
 * ------------------------------------------------------------------------- */
const DIR_MEMO_MAX = 4096;
const DIR_MEMO_TTL_MS = 5000;
/** @type {Map<string, {value:string, at:number}>} */
const dirMemo = new Map();

/** Uncached resolve — the delete-time path. Never throws. */
function resolveDirFresh(dir) {
  return resolveDir(dir);
}

function resolveDirCached(dir) {
  const now = Date.now();
  const hit = dirMemo.get(dir);
  if (hit !== undefined && now - hit.at < DIR_MEMO_TTL_MS) return hit.value;
  const value = resolveDir(dir);
  if (dirMemo.size >= DIR_MEMO_MAX) dirMemo.clear();
  dirMemo.set(dir, { value, at: now });
  return value;
}

/** Stage 2 wrapper. `fresh:true` bypasses the memo (delete-time re-validation). */
function canonical(p, { expandShortNames: expand = true, fresh = false } = {}) {
  const s = canonicalString(p);
  if (!expand) return s; // explicit opt-out honoured (no call site passes it today)
  if (!/^[a-z]:\\/i.test(s)) return s; // UNC / remote: already finalised by canonicalString
  const idx = s.lastIndexOf('\\');
  if (idx < 2) return s; // drive root ("c:") or malformed — nothing to resolve
  const dir = s.slice(0, idx);
  const leaf = s.slice(idx + 1);
  // An 8.3 alias can also be the LEAF itself (a protectRoot spelled `C:\PROGRA~1`): the walk-up form
  // resolves the whole string, so keep it for that case. Junctions are handled by the dir resolve.
  if (leaf.includes('~')) return resolveDir(s);
  const resolvedDir = fresh ? resolveDirFresh(dir) : resolveDirCached(dir);
  return `${resolvedDir}\\${leaf}`;
}

/**
 * Legacy name kept for the temp-location / root comparisons: pure-string
 * canonicalisation (no syscalls), so it is safe to call per candidate.
 */
function normalizePath(p) {
  return canonicalString(p);
}

const rootCanonCache = new Map();

function canonicalRoot(root) {
  const key = String(root);
  const hit = rootCanonCache.get(key);
  if (hit !== undefined) return hit;
  const val = canonical(key);
  if (rootCanonCache.size > 64) rootCanonCache.clear();
  rootCanonCache.set(key, val);
  return val;
}

/** Path-segment-aware, case-insensitive prefix test. 'c:\windowsapps' is NOT under 'c:\windows'. */
function isUnder(childNorm, rootNorm) {
  if (!rootNorm) return false;
  if (childNorm === rootNorm) return true;
  return childNorm.startsWith(rootNorm + '\\') || childNorm.startsWith(rootNorm + '/');
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/* --------------------- PRD §6.2 hardcoded blacklist ---------------------- */

const USER_SHELL_DIR_RE = /[\\/]users[\\/][^\\/]+[\\/](desktop|documents|桌面|文档)([\\/]|$)/i;

let systemRootsCache = null;

function systemProtectedRoots() {
  if (systemRootsCache) return systemRootsCache;
  const roots = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) roots.push(v);
  };

  push(process.env.SystemRoot);
  push('C:\\Windows'); // PRD §6.2 literal
  push(process.env.ProgramFiles);
  push('C:\\Program Files'); // PRD §6.2 literal
  push(process.env['ProgramFiles(x86)']);
  push('C:\\Program Files (x86)'); // PRD §6.2 literal
  push(process.env.ProgramW6432);

  const home =
    process.env.USERPROFILE ||
    process.env.HOME ||
    (process.env.HOMEDRIVE && process.env.HOMEPATH
      ? process.env.HOMEDRIVE + process.env.HOMEPATH
      : '');
  if (home) {
    // Desktop / Documents, including zh-CN shell folder names and OneDrive redirection.
    for (const name of ['Desktop', 'Documents', '桌面', '文档']) {
      push(path.join(home, name));
      push(path.join(home, 'OneDrive', name));
    }
  }

  systemRootsCache = roots.map(canonicalRoot).filter(Boolean);
  return systemRootsCache;
}

/**
 * PRD §6.2 belt-and-braces: absolute refusal to delete under the hardcoded
 * system blacklist, regardless of what the configuration says.
 *
 * The junction defence is only as fresh as the directory memo. Delete-time callers MUST pass
 * `{ fresh: true }` so the resolve is taken at the instant of the decision: a directory can be
 * turned into a reparse point after it was last classified, and PRD §6.2 has to hold then too.
 * @param {string} filePath
 * @param {string[]} [protectRoots] extra roots from cfg.protectRoots
 * @param {{fresh?: boolean}} [opts] fresh:true bypasses the per-directory resolve memo
 * @returns {boolean}
 */
export function isProtectedPath(filePath, protectRoots, opts) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const fresh = Boolean(opts && opts.fresh);
  let child;
  try {
    child = canonical(filePath, { fresh });
  } catch {
    return false;
  }

  for (const root of systemProtectedRoots()) {
    if (isUnder(child, root)) return true;
  }
  if (USER_SHELL_DIR_RE.test(child)) return true;

  if (Array.isArray(protectRoots)) {
    for (const root of protectRoots) {
      if (typeof root !== 'string' || !root) continue;
      // A config-supplied root may itself be spelled through a junction/8.3 alias, so resolve it
      // fresh as well; otherwise the child resolves and the root does not, and isUnder() misses.
      if (isUnder(child, canonical(root, { fresh }))) return true;
    }
  }
  return false;
}

/* ------------------------------ §7 isLocked ------------------------------ */

/**
 * Delete-permission probe. Never throws, never modifies the file.
 *
 * ## Why this no longer uses `openSync(p,'r+')`
 *
 * The original probe opened the file for read+write and called it unlocked when that
 * succeeded. Measured on this host against the four Adobe logs that `fs.unlinkSync`
 * rejected with EBUSY, `openSync(p,'r+')` succeeded on **all four**:
 *
 * ```
 * open r+: ok  |  unlink: EBUSY   (AdobeIPCBroker.log, NGLClient_Photoshop126.0.0.log, ...)
 * open r+: ok  |  unlink: ok
 * ```
 *
 * A process may open a file WITH read/write sharing but WITHOUT delete sharing. `r+` only
 * asks for read+write, so it answers "can I write here", not "can this be deleted". The
 * classifier therefore tagged delete-locked files 🟢 and clean() tried to delete them,
 * which is the opposite of PRD §6.3's 优雅降级.
 *
 * ## What it does instead
 *
 * A same-name rename, `fs.renameSync(p, p)`. Windows requires DELETE access to rename, so
 * this asks for exactly the permission deletion needs — and a rename onto the name the file
 * already has cannot move or alter anything. Measured side-effect-free on this host: size,
 * content hash, inode, mtime and ctime are all identical before and after, and the file is
 * still unlinkable afterwards.
 *
 * - rename succeeds                   -> { locked:false, code:null }
 * - ENOENT / ENOTDIR                  -> { locked:false, code:<errno> }  (gone is not locked)
 * - EPERM / EACCES / EBUSY / ...      -> { locked:true,  code:<errno> }
 *
 * @param {string} filePath
 * @returns {{locked:boolean, code:string|null, pid:number|null, process:string|null}}
 */
export function isLocked(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { locked: false, code: null, pid: null, process: null };
  }
  try {
    fs.renameSync(filePath, filePath);
  } catch (err) {
    const code = (err && err.code) || 'UNKNOWN';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { locked: false, code, pid: null, process: null };
    }
    return { locked: true, code, pid: null, process: null };
  }
  return { locked: false, code: null, pid: null, process: null };
}

/* --------------------------- temp-location test -------------------------- */

function tempRoots() {
  const out = [];
  for (const v of [process.env.TEMP, process.env.TMP, process.env.TMPDIR]) {
    if (typeof v === 'string' && v.trim()) out.push(v);
  }
  out.push('C:\\Windows\\Temp', 'C:\\Temp');
  if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'Temp'));
  return out;
}

/** @returns {{hit:boolean, why:string|null}} */
function isTempLocation(filePath) {
  const child = normalizePath(filePath);
  for (const root of tempRoots()) {
    if (isUnder(child, normalizePath(root))) return { hit: true, why: `under Temp root ${root}` };
  }
  const segments = child.split(/[\\/]/).slice(0, -1);
  for (const seg of segments) {
    if (TEMP_SEGMENTS.has(seg)) return { hit: true, why: `path segment "${seg}"` };
  }
  return { hit: false, why: null };
}

/* ------------------------- best-effort lock owner ------------------------ */

function ownerOfSync(filePath, tree) {
  if (!tree) return { pid: null, process: null };
  try {
    if (typeof tree.ownerOfSync === 'function') {
      const owner = tree.ownerOfSync(filePath);
      if (owner && typeof owner === 'object') {
        return { pid: Number.isFinite(owner.pid) ? owner.pid : null, process: owner.name ?? owner.process ?? null };
      }
    }
  } catch {
    /* best-effort only — CONTRACTS §5 says ownerOf never throws, classify must not either */
  }
  return { pid: null, process: null };
}

/* ------------------------------ §7 classify ------------------------------ */

/**
 * PRD §3.3 classifier. Never throws.
 * @param {Candidate|string} candidate
 * @param {{cfg?:any, tree?:any}} [opts]
 * @returns {Classified}
 */
export function classify(candidate, opts = {}) {
  const cfg = (opts && opts.cfg) || null;
  const tree = (opts && opts.tree) || null;

  try {
    const raw = candidate && typeof candidate === 'object' ? candidate : { path: candidate };
    const filePath = typeof raw.path === 'string' ? raw.path : String(raw.path ?? '');
    const stat = safeStat(filePath);
    const size = Number.isFinite(raw.size) ? Number(raw.size) : stat ? stat.size : 0;
    const mtimeMs = Number.isFinite(raw.mtimeMs) ? Number(raw.mtimeMs) : stat ? stat.mtimeMs : 0;
    const sourceProcess = raw.sourceProcess ?? null;

    const base = basenameOf(filePath);
    const lock = isLocked(filePath);
    const patternHit = LOCKED_BASENAME_RE.test(base) ? (base.match(LOCKED_BASENAME_RE) || [''])[0] : null;

    let category;
    let reason;
    let isLockedFlag = false;
    let lockedByPid = Number.isFinite(raw.lockedByPid) ? Number(raw.lockedByPid) : null;
    let lockedByProcess = raw.lockedByProcess ?? null;

    if (stat && stat.isDirectory()) {
      /* PRD §3.4 cleans FILES; CONTRACTS §8 hands clean() Classified *file* records. A
       * directory is therefore not a deletable candidate at all — fail closed to the tier
       * that is never deleted, so no downstream consumer can recursively destroy a tree. */
      category = CATEGORY.LOCKED;
      reason =
        'locked: path is a directory, not a file — not a deletable candidate ' +
        '(PRD §3.4 cleans files; use symlink migration, Phase 3)';
    } else if (lock.locked || patternHit) {
      /* ---- 🔴 LOCKED_CRITICAL — evaluated first, wins over everything ---- */
      category = CATEGORY.LOCKED;
      isLockedFlag = !!lock.locked;
      if (isLockedFlag) {
        const owner = ownerOfSync(filePath, tree);
        if (lockedByPid === null) lockedByPid = owner.pid;
        if (lockedByProcess === null) lockedByProcess = owner.process;
      }
      if (lock.locked && patternHit) {
        reason = `locked: exclusive open (openSync r+) failed with ${lock.code}; critical basename pattern "${patternHit}" also matched`;
      } else if (lock.locked) {
        reason = `locked: exclusive open (openSync r+) failed with ${lock.code} — live handle, WinError 32 equivalent`;
      } else {
        reason = `locked: critical persistence pattern "${patternHit}" in basename (${base}) — treats as locked`;
      }
    } else {
      const tempLoc = isTempLocation(filePath);
      const ext = extOf(base);
      if (tempLoc.hit) {
        /* ---- 🟢 SAFE_TO_DELETE (temp directory) ---- */
        category = CATEGORY.SAFE;
        reason = `safe: no lock and path is in a Temp location (${tempLoc.why})`;
      } else if (SAFE_EXT_RE.test(ext)) {
        /* ---- 🟢 SAFE_TO_DELETE (one-shot extension) ---- */
        category = CATEGORY.SAFE;
        reason = `safe: no lock and extension "${ext}" is in .tmp/.log/.pyc/.bak`;
      } else if (ONE_SHOT_BASENAME_RE.test(base)) {
        /* ---- 🟢 SAFE_TO_DELETE (known one-shot extraction cache) ---- */
        category = CATEGORY.SAFE;
        reason = `safe: no lock and basename "${base}" is a known one-shot temp/extraction artifact`;
      } else {
        /* ---- 🟡 CAUTION_CACHE ---- */
        category = CATEGORY.CAUTION;
        reason =
          `caution: no lock, but not under a Temp directory and extension "${ext || '(none)'}" ` +
          `is not in .tmp/.log/.pyc/.bak — treated as toolchain cache / model weights / browser kernel`;
      }
    }

    if (isProtectedPath(filePath, cfg && cfg.protectRoots)) {
      reason += ' | protected path (PRD 6.2): clean() will refuse to delete';
    }

    return {
      path: filePath,
      size,
      category,
      isLocked: isLockedFlag,
      lockedByPid,
      lockedByProcess,
      reason,
      sourceProcess,
      mtimeMs,
    };
  } catch (err) {
    /* classify() must never throw; fail closed (🔴) on any surprise. */
    const message = (err && err.message) || String(err);
    return {
      path: (candidate && typeof candidate === 'object' && typeof candidate.path === 'string' && candidate.path) || '',
      size: 0,
      category: CATEGORY.LOCKED,
      isLocked: false,
      lockedByPid: null,
      lockedByProcess: null,
      reason: `classified as locked (fail-closed): classifier error ${message}`,
      sourceProcess: null,
      mtimeMs: 0,
    };
  }
}

export default {
  CATEGORY,
  isLocked,
  isProtectedPath,
  classify,
  LOCKED_BASENAME_RE,
  CREDENTIAL_NAME_RE,
};
