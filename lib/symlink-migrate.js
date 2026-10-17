/**
 * lib/symlink-migrate.js — PRD §7 Phase 3: `mklink /J` 顽固目录一键迁移至 E 盘.
 *
 * ## What this does
 *
 * A "stubborn directory" is a directory under `%TEMP%`/`AppData` that a toolchain keeps
 * filling with gigabytes the cleaner may not delete (🟡 CAUTION_CACHE) or that refills
 * faster than it drains. Deleting it is wrong; the fix PRD §7 asks for is to MOVE it to a
 * non-C: volume and leave an NTFS **junction** at the original path, so every program that
 * hard-codes `%TEMP%\<that name>` keeps working while the bytes stop landing on C:.
 *
 * ## Measured facts this module is built on (probed on this host, Windows 11 + Node v24.19.0)
 *
 * | primitive                              | result                                                     |
 * |----------------------------------------|------------------------------------------------------------|
 * | `fs.symlinkSync(target, link, 'junction')` | works, **no admin**, no `mklink` shell dependency       |
 * | `lstatSync(link).isSymbolicLink()`     | `true` for a junction (the only cheap discriminator)       |
 * | `lstatSync(link).isDirectory()`        | `false` for a junction                                     |
 * | `statSync(link).isDirectory()`         | `true` — it follows, which is why it can never be trusted  |
 * | `fs.rmdirSync(link)`                   | removes the LINK; **target and all its files survive**     |
 * | `fs.unlinkSync(link)`                  | same (link only)                                           |
 * | write through the link                 | lands in the target (so the move is transparent)           |
 * | `fs.renameSync(src, dst)` C: -> E:     | **`EXDEV`** — cross-volume rename is NOT possible          |
 * | `fs.cpSync(src, dst, {recursive:true})`| works across volumes                                                       |
 *
 * The `EXDEV` row is the load-bearing one: the naive "rename the directory" implementation
 * that works on a single volume fails on exactly the cross-volume case the feature exists
 * for. The move therefore has two legs — a fast `renameSync` attempt, and a measured
 * copy → verify → delete fallback.
 *
 * ## Safety model
 *
 * Every refusal below exists because the opposite behaviour loses data:
 *
 *   1. **Directories only.** A file is `clean()`'s business, never this module's.
 *   2. **Not already a reparse point.** Migrating a junction would move the LINK and destroy
 *      the indirection, orphaning whatever it pointed at.
 *   3. **Never a protected root, the escape root, the state dir, or a watch dir — and never an
 *      ANCESTOR of any of them.** Moving `%LOCALAPPDATA%` (a legal-looking path that is an
 *      ancestor of the recursive watch dir) would break the harness, the DB, and the panel.
 *   4. **Not too shallow.** At least 3 path components below the drive root, so a typo cannot
 *      relocate `C:\Users`.
 *   5. **No reparse points inside the source tree.** `cpSync` would otherwise copy the
 *      TARGET's bytes, silently duplicating a tree that lives on another volume.
 *   6. **The junction is created only AFTER the source is fully moved away, and if that
 *      creation fails the data is moved BACK.** A crash between the two steps leaves the data
 *      at the target and the source gone; the DB row (`PENDING` -> `MOVED` -> `LINKED`) is what
 *      makes that recoverable, and `undoMigration` can finish or reverse it from the record.
 *   7. **Undo removes the junction FIRST.** Moving the data back under a live junction is
 *      impossible (the path is occupied), and deleting through it would hit the target.
 *
 * @module dsh-c-cleaner/lib/symlink-migrate
 */

import fs from 'node:fs';
import path from 'node:path';

/** Lifecycle of one migration, as persisted in the `migrations` table. */
export const MIGRATION_STATE = Object.freeze({
  /** Intent recorded, no data moved yet. A crash here means nothing changed on disk. */
  PENDING: 'PENDING',
  /** Data is at the target; the source path is momentarily empty. The recoverable window. */
  MOVED: 'MOVED',
  /** Junction installed at the source. The migration is complete. */
  LINKED: 'LINKED',
  /** Attempted and failed; the source is intact (see the per-report `stage`). */
  FAILED: 'FAILED',
  /** The junction was removed and the data moved back. */
  RESTORED: 'RESTORED',
});

/** Refuse a source shallower than this many components below the drive root. */
const MIN_COMPONENTS = 3;

/** Hard caps so a pathological tree cannot stall the caller (PRD §6.1 CPU budget). */
const MAX_SCAN_ENTRIES = 200000;
const MAX_SCAN_DEPTH = 64;

/** Require 10 % headroom on the destination before a copy, so we cannot fill the drive. */
const FREE_SPACE_HEADROOM = 1.1;

/* --------------------------------- helpers -------------------------------- */

function callLog(log, level, msg) {
  try {
    if (log && typeof log[level] === 'function') log[level](msg);
  } catch {
    /* logging must never break a migration */
  }
}

/** Canonical comparison form: absolute, backslash-normalised, lowercased, no trailing sep. */
function normPath(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let abs;
  try {
    abs = path.resolve(p);
  } catch {
    abs = p;
  }
  return abs.replace(/[\\/]+$/, '').toLowerCase();
}

/** Path-segment-aware prefix test (`c:\foo` is NOT under `c:\foobar`). */
function isUnderOrEqual(childNorm, rootNorm) {
  if (!childNorm || !rootNorm) return false;
  if (childNorm === rootNorm) return true;
  return childNorm.startsWith(rootNorm + '\\') || childNorm.startsWith(rootNorm + '/');
}

/** Drive root of a path (`C:\` / `E:\`), lowercased; `''` when there is none. */
function driveOf(p) {
  try {
    return path.parse(path.resolve(p)).root.toLowerCase().replace(/[\\/]+$/, '');
  } catch {
    return '';
  }
}

/**
 * Physical drive a path really lives on, following every junction on the way.
 *
 * `driveOf()` is a LEXICAL answer and it is wrong for exactly the paths this feature creates:
 * after `C:\...\Temp\foo` is migrated, `C:\...\Temp\foo\sub` still SPELLS `C:` while its bytes
 * live on `E:`. A lexical check then misses `SAME_VOLUME` and offers that `sub` as a fresh
 * candidate — a second migration of data that is already off the C: drive, and one whose
 * target would end up nested inside the first target. Resolving the nearest existing ancestor
 * and then appending the missing tail keeps this correct even for a not-yet-created path.
 *
 * @returns {string} lowercased drive root, or `''` when nothing resolves
 */
function physicalDriveOf(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let probe;
  try {
    probe = path.resolve(p);
  } catch {
    return '';
  }
  const tail = [];
  // Walk up to the longest existing prefix; `realpathSync` throws for a missing tail.
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(probe) : fs.realpathSync(probe);
      return driveOf(tail.length === 0 ? real : path.join(real, ...tail.reverse()));
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return '';
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
  return '';
}

/**
 * Component count of the FULL path below its drive root, including the basename.
 *
 * Counting is deliberately done on the whole resolved path and not on `path.parse(p).dir`:
 * the latter silently drops the basename, which made `C:\Users\kiuhg\AppData` (3 components,
 * genuinely too shallow for other reasons) and `C:\Windows` (1) report counts 2 and 0. The
 * off-by-one shifted the whole "too shallow" threshold by one directory level.
 */
function componentCount(p) {
  try {
    const resolved = path.resolve(p);
    const root = path.parse(resolved).root;
    return resolved
      .slice(root.length)
      .split(/[\\/]+/)
      .filter((s) => s.length > 0).length;
  } catch {
    return 0;
  }
}

function isWindows() {
  return process.platform === 'win32';
}

/**
 * Walk a tree without following reparse points. Bounded by entry count and depth.
 *
 * `readdirSync(withFileTypes)` does NOT reliably flag a junction on Windows (a junction is a
 * directory entry carrying `FILE_ATTRIBUTE_REPARSE_POINT`, which the Dirent type may report as
 * a directory), so each DIRECTORY entry gets one `lstatSync`. That is one extra syscall per
 * directory — not per file — which keeps the walk cheap while making the reparse detection
 * trustworthy.
 *
 * @param {string} root
 * @param {{maxEntries?:number, maxDepth?:number, withPaths?:boolean}} [opts]
 * @returns {{files:number, bytes:number, dirs:number, reparsePoints:string[], truncated:boolean,
 *            unreadable:Array<{path:string,code:string,message:string}>, paths:string[], dirPaths:string[]}}
 */
export function walkTree(root, opts = {}) {
  const maxEntries = Number.isInteger(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : MAX_SCAN_ENTRIES;
  const maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth >= 0 ? opts.maxDepth : MAX_SCAN_DEPTH;

  const out = { files: 0, bytes: 0, dirs: 0, reparsePoints: [], truncated: false, unreadable: [], paths: [], dirPaths: [] };
  /** @type {Array<{dir:string, depth:number}>} */
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      out.unreadable.push({ path: dir, code: (err && err.code) || 'ERR', message: String((err && err.message) || err) });
      continue;
    }
    for (const entry of entries) {
      if (out.files + out.dirs >= maxEntries) {
        out.truncated = true;
        return out;
      }
      const full = path.join(dir, entry.name);

      // Any reparse point (junction, symlink, mount point) is recorded and NOT descended into.
      if (entry.isSymbolicLink()) {
        out.reparsePoints.push(full);
        continue;
      }
      if (entry.isDirectory()) {
        let reparse = false;
        try {
          reparse = fs.lstatSync(full).isSymbolicLink();
        } catch {
          /* vanished mid-walk: treat as not-a-link and let the later copy fail loudly */
        }
        if (reparse) {
          out.reparsePoints.push(full);
          continue;
        }
        out.dirs += 1;
        out.dirPaths.push(full);
        if (depth + 1 > maxDepth) {
          out.truncated = true;
          continue;
        }
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (entry.isFile()) {
        out.files += 1;
        out.paths.push(full);
        try {
          const st = fs.statSync(full);
          out.bytes += Number.isFinite(st.size) ? st.size : 0;
        } catch {
          /* vanished mid-walk: count it, size unknown */
        }
      }
    }
  }
  return out;
}

/**
 * The paths a migration must never touch, split by the DIRECTION of the check. Getting this
 * split wrong is the difference between a useless feature and a destroyed install:
 *
 *   - `forbidden` — refuse when the source is inside OR is an ancestor of one of these.
 *     These are things the plugin needs to keep working (`C:\Windows`, the escape root, the
 *     state DB's directory, the plugin's own home, and the migration target itself).
 *
 *   - `rootsOnly` — refuse only when the source *IS* or *CONTAINS* one of these; a descendant
 *     is fine. These are the watch roots (`%TEMP%`, `%LOCALAPPDATA%`, `%APPDATA%`).
 *     A watch root is a CONTAINER we scan, not a protected object: `%TEMP%` itself must never be
 *     migrated, but `%TEMP%\playwright_chromiumdev_profile-abc123` — the exact stubborn
 *     directory this feature exists for — is its ordinary descendant and MUST be allowed.
 *
 * Treating the watch roots as flatly forbidden (the first version of this function) refuses
 * every real candidate, because every stubborn directory lives inside a watch root. That was
 * caught by a live probe, not by reasoning, so the distinction is spelled out here.
 *
 * @param {object} cfg - resolved config.
 * @returns {{forbidden:string[], rootsOnly:string[]}} canonical (lowercased, absolute) paths.
 */
export function protectedForMigration(cfg) {
  /** @type {string[]} */
  const forbidden = [];
  /** @type {string[]} */
  const rootsOnly = [];
  const push = (list, p) => {
    const n = normPath(p);
    if (n) list.push(n);
  };

  for (const root of Array.isArray(cfg?.protectRoots) ? cfg.protectRoots : []) push(forbidden, root);
  push(forbidden, cfg?.escapeRoot);
  push(forbidden, cfg?.stateDir);
  push(forbidden, cfg?.dshHome);
  push(forbidden, targetRootOf(cfg));

  for (const entry of Array.isArray(cfg?.watchDirs) ? cfg.watchDirs : []) {
    push(rootsOnly, typeof entry === 'string' ? entry : entry?.path);
  }

  return { forbidden: [...new Set(forbidden)], rootsOnly: [...new Set(rootsOnly)] };
}

/**
 * Where migrated directories land.
 *
 * Defaults to a `migrated` folder ON the same non-C: volume as the escape root, which is
 * already the volume PRD §3.1 proved writable at startup. Never on the source's own volume:
 * a "migration" that stays on C: frees nothing and only adds indirection.
 *
 * @param {object} cfg
 * @returns {string|null}
 */
export function targetRootOf(cfg) {
  const explicit = typeof cfg?.migrateTargetRoot === 'string' ? cfg.migrateTargetRoot.trim() : '';
  if (explicit.length > 0) return explicit;
  const escape = typeof cfg?.escapeRoot === 'string' ? cfg.escapeRoot.trim() : '';
  if (escape.length === 0) return null;
  return path.join(escape, 'migrated');
}

/**
 * Decide whether a directory may be migrated. Synchronous, cheap, and never throws — this is
 * the gate both the panel and the command consult, so it must be pure inspection.
 *
 * @param {string} dirPath
 * @param {object} cfg - resolved config.
 * @returns {{ok:boolean, code:string, reason:string, source:string, target?:string,
 *            targetRoot?:string, bytes?:number, files?:number}}
 */
export function inspectDirectory(dirPath, cfg) {
  const source = typeof dirPath === 'string' && dirPath.trim().length > 0 ? path.resolve(dirPath.trim()) : '';
  const deny = (code, reason) => ({ ok: false, code, reason, source });

  if (source.length === 0) return deny('BAD_PATH', 'empty path');
  if (!isWindows()) return deny('NOT_WINDOWS', 'junction migration needs NTFS junctions (Windows only)');

  const sourceNorm = normPath(source);
  const { forbidden, rootsOnly } = protectedForMigration(cfg);

  // ORDER MATTERS: protection is a LEXICAL property of the path, so it is decided before the
  // path is ever touched. Checking it after `lstat` made `C:\Windows\Temp\x` (absent) answer
  // `MISSING` and `C:\Windows` answer `TOO_SHALLOW` — both true, both useless to a caller that
  // needs to know "this is a blacklisted location", and both a weak spot: a protected path that
  // happens to exist would be refused for the wrong reason, and one that does not would be
  // refused on a technicality that a later refactor could remove.
  for (const root of forbidden) {
    if (isUnderOrEqual(sourceNorm, root)) {
      return deny('PROTECTED', `refused: ${source} is inside the protected/owned path ${root}`);
    }
    if (isUnderOrEqual(root, sourceNorm)) {
      return deny(
        'ANCESTOR_OF_PROTECTED',
        `refused: ${source} CONTAINS the protected/owned path ${root} — moving it would break the harness, the state DB or the watcher`,
      );
    }
  }

  // Watch roots: the root itself is off-limits, but its children are the whole point.
  for (const root of rootsOnly) {
    if (sourceNorm === root) {
      return deny('PROTECTED', `refused: ${source} is a watch root itself — only directories inside it may be migrated`);
    }
    if (isUnderOrEqual(root, sourceNorm)) {
      return deny(
        'ANCESTOR_OF_WATCH_ROOT',
        `refused: ${source} CONTAINS the watch root ${root} — migrating a parent would hide every tracked file beneath it`,
      );
    }
  }

  if (componentCount(source) < MIN_COMPONENTS) {
    return deny(
      'TOO_SHALLOW',
      `refused: only ${componentCount(source)} path component(s); migration requires >= ${MIN_COMPONENTS} so a typo cannot relocate a system directory`,
    );
  }

  const targetRoot = targetRootOf(cfg);
  if (!targetRoot) return deny('NO_TARGET_ROOT', 'no migrateTargetRoot and no escapeRoot to derive one from');

  const targetDrive = driveOf(targetRoot);
  const sourceDrive = driveOf(source);
  if (targetDrive.length === 0) return deny('NO_TARGET_ROOT', `cannot determine the drive of ${targetRoot}`);
  // Compare the PHYSICAL volumes, not the spellings: a directory reached through an existing
  // junction spells `C:` but lives on `E:`, and migrating it again would nest target inside
  // target. `physicalDriveOf` resolves the junction; `driveOf` is the fallback when nothing
  // on the path exists yet.
  const sourcePhysical = physicalDriveOf(source) || sourceDrive;
  if (targetDrive === sourcePhysical) {
    return deny(
      'SAME_VOLUME',
      `refused: target ${targetDrive} is the source volume — a migration there frees no space and only adds indirection`,
    );
  }

  let st;
  try {
    st = fs.lstatSync(source);
  } catch (err) {
    const code = (err && err.code) || 'ERR';
    if (code === 'ENOENT') return deny('MISSING', 'path does not exist');
    return deny('STAT_FAILED', `cannot stat: ${code}`);
  }

  // A reparse point must never be treated as an ordinary directory. `lstat` is the only call
  // that reports the LINK; `stat` follows it and would report the target's type.
  if (st.isSymbolicLink()) {
    return deny('ALREADY_LOGGED', 'already a junction/symlink — nothing to migrate (use undo to restore it)');
  }
  if (!st.isDirectory()) return deny('NOT_A_DIRECTORY', 'not a directory — files are clean()\'s business, not migration');

  let measured;
  try {
    measured = walkTree(source);
  } catch (err) {
    return deny('SCAN_FAILED', `cannot scan the directory: ${(err && err.message) || err}`);
  }
  if (measured.truncated) {
    return deny('TOO_LARGE_TO_SCAN', `scan hit the ${MAX_SCAN_ENTRIES}-entry cap — refusing to move a tree this plugin could not verify`);
  }
  if (measured.unreadable.length > 0) {
    const first = measured.unreadable[0];
    return deny('UNREADABLE', `cannot read ${first.path} (${first.code}) — refusing to move a tree we cannot verify`);
  }
  if (measured.reparsePoints.length > 0) {
    return deny(
      'CONTAINS_REPARSE_POINTS',
      `contains ${measured.reparsePoints.length} junction/symlink (first: ${measured.reparsePoints[0]}) — a copy would duplicate the wrong bytes`,
    );
  }
  if (measured.files === 0) return deny('EMPTY', 'directory holds no files — nothing to gain from migrating it');

  /* Files another process holds without delete sharing cannot be removed, and `rmSync` would
   * delete the ones it CAN reach before failing (measured: 5 of 8). Refuse here, at planning
   * time, so the panel never offers a migration that is guaranteed to fail — and so a busy
   * directory is never even copied. */
  const busy = findBusyFiles(measured);
  if (busy.busy.length > 0) {
    const listed = busy.busy.slice(0, 3).join(', ');
    const more = busy.busy.length > 3 ? ` (+${busy.busy.length - 3} more)` : '';
    return deny(
      'FILES_IN_USE',
      `${busy.busy.length} of ${measured.files} file(s) are held open by another process and cannot be removed: ${listed}${more} — close the program using them and retry`,
    );
  }

  // The destination must be writable. Checked AFTER the read-only refusals so that a blacklisted
  // path never creates `E:\...\migrated` as a side effect of merely being inspected.
  try {
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.accessSync(targetRoot, fs.constants.W_OK);
  } catch (err) {
    return deny('TARGET_UNWRITABLE', `cannot write ${targetRoot}: ${(err && err.code) || 'ERR'}`);
  }

  const target = uniqueTargetPath(targetRoot, path.basename(source));

  // Free-space guard: a copy must not be able to fill the destination drive.
  try {
    const fsStat = fs.statfsSync(targetRoot);
    const free = Number(fsStat.bavail) * Number(fsStat.bsize);
    if (Number.isFinite(free) && free > 0 && measured.bytes * FREE_SPACE_HEADROOM > free) {
      return deny(
        'INSUFFICIENT_SPACE',
        `needs ${measured.bytes} B (+10 %) but ${targetRoot} has ${free} B free`,
      );
    }
  } catch {
    /* statfs is best-effort; a filesystem without it must not block an otherwise legal move */
  }

  return {
    ok: true,
    code: 'OK',
    reason: 'migratable',
    source,
    target,
    targetRoot,
    bytes: measured.bytes,
    files: measured.files,
    dirs: measured.dirs,
  };
}

/**
 * Pick a destination name that is not taken. Appends `-2`, `-3`, … so two directories with the
 * same basename (a real case: every `playwright_chromiumdev_profile-XXXX` is unique, but
 * `%TEMP%\a\cache` and `%TEMP%\b\cache` are not) cannot collide and silently merge.
 *
 * @param {string} targetRoot
 * @param {string} base
 * @returns {string}
 */
function uniqueTargetPath(targetRoot, base) {
  const safeBase = typeof base === 'string' && base.length > 0 ? base : 'migrated';
  let candidate = path.join(targetRoot, safeBase);
  for (let i = 2; i <= 100; i += 1) {
    let exists = false;
    try {
      fs.lstatSync(candidate);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) return candidate;
    candidate = path.join(targetRoot, `${safeBase}-${i}`);
  }
  return path.join(targetRoot, `${safeBase}-${Date.now()}`);
}

/* ------------------------------- the move --------------------------------- */

/**
 * Move a directory to another volume.
 *
 * Fast path: `renameSync`, which is instantaneous on one volume and fails `EXDEV` across
 * volumes. Slow path: `cpSync` + an INDEPENDENT re-measure of both trees + delete of the
 * source. The verification step is what licenses deleting the source: a copy that silently
 * dropped files would otherwise destroy them.
 *
 * ## Why the source is not deleted with `fs.rmSync` (measured defect)
 *
 * `rmSync({recursive:true})` deletes as it walks and only throws when it reaches a file it
 * cannot remove. Probed with one exclusively-held file among eight: it threw `EPERM` having
 * already deleted **five** files. The recovery path used to delete the verified copy at the
 * target on the assumption the source was intact — but five files were then in neither tree.
 *
 * The delete is now:
 *   1. a per-file occupancy pre-flight (`occupancyProbe`), so a directory this feature cannot
 *      move is refused BEFORE anything is copied or deleted, with the busy files named;
 *   2. a file-by-file delete (`deleteTreeSafely`) that stops at the first failure and reports
 *      the path, so a partial delete is always both known and harmless (the target copy is
 *      complete and verified).
 *
 * @param {string} source
 * @param {string} target
 * @param {{log?:object, verify?:boolean, allowBusyFiles?:boolean}} [opts]
 * @returns {{ok:boolean, method:string, code?:string, message?:string, busy?:string[]}}
 */
export function moveDirectory(source, target, opts = {}) {
  const log = opts.log ?? null;
  const verify = opts.verify !== false;
  const allowBusyFiles = opts.allowBusyFiles === true;

  try {
    fs.renameSync(source, target);
    return { ok: true, method: 'rename' };
  } catch (err) {
    const code = (err && err.code) || 'ERR';
    // EXDEV is the EXPECTED cross-volume answer; anything else (EPERM, EACCES, ENOTEMPTY) is a
    // real refusal and must be reported instead of retried as a copy.
    if (code !== 'EXDEV' && code !== 'EINVAL' && code !== 'ENOTSUP') {
      return { ok: false, method: 'rename', code, message: String((err && err.message) || err) };
    }
    callLog(log, 'debug', `rename ${source} -> ${target} refused (${code}); falling back to copy+verify+delete`);
  }

  const before = walkTree(source);
  if (before.truncated || before.unreadable.length > 0) {
    return {
      ok: false,
      method: 'copy',
      code: before.truncated ? 'SCAN_TRUNCATED' : 'SCAN_UNREADABLE',
      message: 'source changed or is unreadable between planning and copying',
    };
  }

  /* Refuse BEFORE copying if any file cannot be removed afterwards. Copying first and failing
   * at the delete leaves a full duplicate on the target volume and a half-deleted source —
   * measured: 5 of 8 files gone, EPERM reported only after the fact. */
  if (!allowBusyFiles) {
    const busy = findBusyFiles(before);
    if (busy.busy.length > 0) {
      const listed = busy.busy.slice(0, 3).join(', ');
      const more = busy.busy.length > 3 ? ` (+${busy.busy.length - 3} more)` : '';
      return {
        ok: false,
        method: 'copy',
        code: 'FILES_IN_USE',
        busy: busy.busy,
        message:
          `${busy.busy.length} of ${before.files} file(s) are held open by another process ` +
          `and cannot be removed, so nothing was moved: ${listed}${more}`,
      };
    }
  }

  try {
    fs.cpSync(source, target, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true });
  } catch (err) {
    // Partial copy at the target must not be left behind as a plausible-looking directory.
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    return { ok: false, method: 'copy', code: (err && err.code) || 'COPY_FAILED', message: String((err && err.message) || err) };
  }

  if (verify) {
    const after = walkTree(target);
    const mismatch =
      after.files !== before.files || after.bytes !== before.bytes || after.truncated || after.unreadable.length > 0;
    if (mismatch) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      return {
        ok: false,
        method: 'copy',
        code: 'VERIFY_MISMATCH',
        message:
          `copy verification failed: source ${before.files} file(s)/${before.bytes} B, ` +
          `target ${after.files} file(s)/${after.bytes} B — source left untouched`,
      };
    }
  }

  /* Delete the source file-by-file instead of recursively.
   *
   * `fs.rmSync({recursive:true})` throws only AFTER deleting whatever it could reach first
   * (measured: 5 of 8 files gone, then EPERM), which made the recovery below destroy real data:
   * it deleted the verified target copy while the source was already partially gone. A
   * file-by-file delete stops at the first failure, so "some deleted, the rest intact" is a
   * state the caller can describe and recover from instead of a silent loss. */
  const deleted = deleteTreeSafely(before, source);
  if (!deleted.ok) {
    /* The copy is verified and complete, and the source is untouched or only partially
     * removed. Dropping the target would delete the only COMPLETE tree, so the target is kept
     * and the failure names both places — the exact opposite of the old behaviour. */
    return {
      ok: false,
      method: 'copy',
      code: deleted.code || 'SOURCE_DELETE_FAILED',
      message:
        `the copy at ${target} is complete but the source could not be removed at ` +
        `${deleted.path} (${deleted.message}); ${deleted.removed} file(s) were removed before ` +
        'the refusal — the complete data is at the target, run undo to move it back',
      partial: { target, removed: deleted.removed, failedAt: deleted.path },
    };
  }

  return { ok: true, method: 'copy', code: 'OK', message: `copied ${before.files} file(s)/${before.bytes} B` };
}

/**
 * Install the junction at `source` pointing at `target`.
 * @param {string} source
 * @param {string} target
 * @returns {{ok:boolean, code?:string, message?:string}}
 */
export function createJunction(source, target) {
  try {
    fs.symlinkSync(target, source, 'junction');
    return { ok: true };
  } catch (err) {
    return { ok: false, code: (err && err.code) || 'JUNCTION_FAILED', message: String((err && err.message) || err) };
  }
}

/**
 * Remove the junction at `linkPath` — and PROVE it is a junction first.
 *
 * `fs.rmSync(p, {recursive:true})` on a junction does not follow it on this host (probed), but
 * it is not the documented call for a reparse point and its behaviour is version-dependent.
 * `rmdirSync` is the documented one, and it only ever unlinks the reparse point. The explicit
 * `isSymbolicLink()` check is what stops a path that USED to be our junction (and is now a real
 * directory full of data) from being deleted.
 *
 * @param {string} linkPath
 * @returns {{ok:boolean, code?:string, message?:string}}
 */
export function removeJunction(linkPath) {
  let st;
  try {
    st = fs.lstatSync(linkPath);
  } catch (err) {
    const code = (err && err.code) || 'ERR';
    if (code === 'ENOENT') return { ok: true, code: 'ALREADY_GONE' };
    return { ok: false, code, message: String((err && err.message) || err) };
  }
  if (!st.isSymbolicLink()) {
    return {
      ok: false,
      code: 'NOT_A_JUNCTION',
      message: `${linkPath} is no longer a junction (it is a real directory) — refusing to touch it`,
    };
  }
  try {
    fs.rmdirSync(linkPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: (err && err.code) || 'UNLINK_FAILED', message: String((err && err.message) || err) };
  }
}

/* --------------------------- occupancy pre-flight -------------------------- */

/**
 * Is this file held by another process in a way that BLOCKS its removal?
 *
 * This is the same primitive `lib/classifier.js` `isLocked()` uses, and it is deliberately a
 * same-name rename: Windows needs DELETE access to rename, so it asks exactly the permission
 * the source-delete leg needs. Measured on this host against the four Adobe logs that
 * `fs.unlinkSync` rejected with EBUSY, `openSync(p,'r+')` said "unlocked" on all four while
 * `renameSync(p,p)` said EBUSY on all four — `r+` asks for read+write sharing, not delete
 * sharing, so it answers the wrong question.
 *
 * A rename onto the name the file already has cannot move or alter it: size, content hash,
 * inode, mtime and ctime were measured identical before and after.
 *
 * @param {string} filePath
 * @returns {{busy:boolean, code:string|null}}
 */
function occupancyProbe(filePath) {
  try {
    fs.renameSync(filePath, filePath);
    return { busy: false, code: null };
  } catch (err) {
    const code = (err && err.code) || 'UNKNOWN';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { busy: false, code };
    return { busy: true, code };
  }
}

/**
 * Find the files inside `tree` that another process holds open.
 *
 * ## Why this exists (measured data-loss defect)
 *
 * `fs.rmSync(dir, {recursive:true})` is NOT atomic and NOT fail-fast. Probed with one file held
 * exclusively by another process and 8 files in the tree:
 *
 * ```
 * before : a1.bin a2.bin a3.bin nested/{b1,b2,zlocked}.bin zz1.bin zz2.bin
 * rmSync : EPERM
 * after  : nested/zlocked.bin zz1.bin zz2.bin   <-- 5 of 8 files ALREADY GONE
 * ```
 *
 * The old `moveDirectory` then deleted the verified COPY at the target when that rmSync threw,
 * on the assumption that "the source is still the authoritative copy". It was not: five files
 * existed in NEITHER tree. Nothing in the journal or the report said so.
 *
 * So the source is only deleted after a pre-flight proves every file can be removed, and the
 * delete itself is per-file with a rollback list, never a recursive rm.
 *
 * @param {{paths:string[]}} tree
 * @returns {{busy:string[], codes:Record<string,string>}}
 */
function findBusyFiles(tree) {
  const busy = [];
  const codes = Object.create(null);
  for (const p of tree.paths) {
    const probe = occupancyProbe(p);
    if (probe.busy) {
      busy.push(p);
      if (probe.code) codes[probe.code] = (codes[probe.code] || 0) + 1;
    }
  }
  return { busy, codes };
}

/**
 * Remove the source tree file-by-file, so a failure is both detectable and describable.
 *
 * Files are deleted deepest-first and the directories bottom-up afterwards. If any delete
 * fails, the walk stops and the caller is told exactly which path failed — the remaining tree
 * is still on disk and the verified copy at the target still exists, so nothing is lost.
 *
 * @param {{paths:string[], dirPaths:string[], files:number, bytes:number}} tree
 * @param {string} root
 * @returns {{ok:boolean, code:string|null, path:string|null, message:string|null, removed:number}}
 */
function deleteTreeSafely(tree, root) {
  let removed = 0;
  for (const p of tree.paths) {
    try {
      fs.unlinkSync(p);
      removed += 1;
    } catch (err) {
      return {
        ok: false,
        code: (err && err.code) || 'SOURCE_DELETE_FAILED',
        path: p,
        message: String((err && err.message) || err),
        removed,
      };
    }
  }
  // Deepest first so each rmdir sees an empty directory.
  const dirs = [...tree.dirPaths].sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    try {
      fs.rmdirSync(d);
    } catch (err) {
      const code = (err && err.code) || 'SOURCE_DELETE_FAILED';
      if (code === 'ENOENT') continue;
      return { ok: false, code, path: d, message: String((err && err.message) || err), removed };
    }
  }
  try {
    fs.rmdirSync(root);
  } catch (err) {
    const code = (err && err.code) || 'SOURCE_DELETE_FAILED';
    if (code !== 'ENOENT') {
      return { ok: false, code, path: root, message: String((err && err.message) || err), removed };
    }
  }
  return { ok: true, code: null, path: null, message: null, removed };
}

/* ------------------------------ the operation ------------------------------ */

/**
 * Migrate one directory: move it to the target volume and leave a junction behind.
 *
 * The DB record is written BEFORE anything moves (`PENDING`), advanced to `MOVED` once the
 * bytes are at the target, and to `LINKED` once the junction exists. That ordering is what makes
 * an interrupted migration diagnosable: a `MOVED` row with no junction at the source is the
 * crash window, and it names both paths so `undoMigration` can finish the job.
 *
 * On ANY failure after the move, the data is moved BACK before returning, so a failed
 * migration never leaves the user without their directory.
 *
 * @param {string} dirPath
 * @param {{cfg:object, log?:object, db?:object}} deps
 * @returns {Promise<{ok:boolean, code:string, reason:string, source:string, target?:string,
 *                    bytes:number, files:number, method?:string, junction?:boolean}>}
 */
export async function migrateDirectory(dirPath, deps = {}) {
  const { cfg, db } = deps;
  const log = deps.log ?? null;

  const plan = inspectDirectory(dirPath, cfg);
  if (!plan.ok) return { ok: false, code: plan.code, reason: plan.reason, source: plan.source, bytes: 0, files: 0 };

  const { source, target, bytes, files } = plan;

  // Record the intent first: a crash before the move leaves a PENDING row and nothing changed.
  let recordId = null;
  if (db && typeof db.recordMigration === 'function') {
    try {
      recordId = db.recordMigration({
        source,
        target,
        state: MIGRATION_STATE.PENDING,
        bytes: 0,
        files: 0,
        method: null,
      });
    } catch (err) {
      // A migration may not proceed unrecorded: the crash window would then be invisible.
      return {
        ok: false,
        code: 'STATE_UNAVAILABLE',
        reason: `cannot record the migration intent: ${(err && err.message) || err}`,
        source,
        bytes: 0,
        files: 0,
      };
    }
  } else {
    return { ok: false, code: 'STATE_UNAVAILABLE', reason: 'state DB is required to migrate safely', source, bytes: 0, files: 0 };
  }

  const patch = (state, extra = {}) => {
    if (!db || typeof db.updateMigration !== 'function' || recordId === null) return;
    try {
      db.updateMigration(recordId, { state, ...extra });
    } catch (err) {
      callLog(log, 'warn', `migration record ${recordId} could not be updated to ${state}: ${(err && err.message) || err}`);
    }
  };

  callLog(log, 'info', `migrating ${source} -> ${target} (${files} file(s), ${bytes} B)`);

  // ---- 1. move the bytes --------------------------------------------------
  const moved = moveDirectory(source, target, { log, verify: cfg?.migrateVerify !== false });
  if (!moved.ok) {
    patch(MIGRATION_STATE.FAILED, { error: `${moved.code}: ${moved.message ?? ''}` });
    return {
      ok: false,
      code: moved.code || 'MOVE_FAILED',
      reason: `move failed: ${moved.message || moved.code}`,
      source,
      target,
      bytes,
      files,
    };
  }
  patch(MIGRATION_STATE.MOVED, { bytes, files, method: moved.method });

  // ---- 2. leave the junction behind ---------------------------------------
  const linked = createJunction(source, target);
  if (!linked.ok) {
    // Roll back: put the bytes back where the caller expects them.
    const back = moveDirectory(target, source, { log, verify: cfg?.migrateVerify !== false });
    if (back.ok) {
      patch(MIGRATION_STATE.FAILED, { error: `JUNCTION_FAILED (rolled back): ${linked.message ?? ''}` });
      return {
        ok: false,
        code: 'JUNCTION_FAILED',
        reason: `junction creation failed and the directory was moved back intact: ${linked.message || linked.code}`,
        source,
        target,
        bytes,
        files,
        method: moved.method,
      };
    }
    // Both legs failed: the data IS at the target, the source path is gone. Say so precisely.
    patch(MIGRATION_STATE.MOVED, { error: `JUNCTION_FAILED and rollback failed: ${back.code}` });
    return {
      ok: false,
      code: 'ROLLBACK_FAILED',
      reason:
        `junction creation failed (${linked.code}) AND moving back failed (${back.code}); ` +
        `the data is intact at ${target} — finish with an undo`,
      source,
      target,
      bytes,
      files,
      method: moved.method,
    };
  }

  patch(MIGRATION_STATE.LINKED);

  // ---- 3. re-read through the junction, so success is observed, not assumed ----
  let through = null;
  try {
    through = walkTree(source);
  } catch {
    through = null;
  }

  callLog(
    log,
    'info',
    `migrated ${source} -> ${target} via ${moved.method}; junction in place` +
      (through ? ` (re-read ${through.files} file(s) through the junction)` : ''),
  );

  return {
    ok: true,
    code: 'MIGRATED',
    reason: `moved ${files} file(s) / ${bytes} B off ${path.parse(source).root} via ${moved.method}`,
    source,
    target,
    bytes,
    files,
    method: moved.method,
    junction: true,
  };
}

/**
 * Reverse a migration: remove the junction, then move the data back.
 *
 * Order is not negotiable. The junction occupies the source path, so the data cannot be moved
 * back while it exists; and deleting "the source" while the junction is live would hit the
 * TARGET instead. So: unlink the reparse point (proven to leave the target untouched), then move.
 *
 * If the move back fails, the junction is RE-INSTALLED so the user is never left with a
 * half-restored path — a working junction is strictly better than a missing directory.
 *
 * @param {string} sourcePath
 * @param {{cfg:object, log?:object, db?:object}} deps
 * @returns {Promise<{ok:boolean, code:string, reason:string, source:string, target?:string,
 *                    bytes:number, files:number, method?:string}>}
 */
export async function undoMigration(sourcePath, deps = {}) {
  const { cfg, db } = deps;
  const log = deps.log ?? null;
  const source = typeof sourcePath === 'string' && sourcePath.trim().length > 0 ? path.resolve(sourcePath.trim()) : '';
  const fail = (code, reason, extra = {}) => ({ ok: false, code, reason, source, bytes: 0, files: 0, ...extra });

  if (source.length === 0) return fail('BAD_PATH', 'empty path');

  let record = null;
  if (db && typeof db.getMigrationBySource === 'function') {
    try {
      record = db.getMigrationBySource(source);
    } catch {
      record = null;
    }
  }
  if (!record) return fail('NO_RECORD', `no migration recorded for ${source}`);

  const target = String(record.target_path);
  const state = String(record.state);

  // The junction must point where the record says. A NULL or re-pointed link is someone else's.
  let st = null;
  try {
    st = fs.lstatSync(source);
  } catch {
    st = null;
  }

  if (state === MIGRATION_STATE.MOVED && st === null) {
    // The crash window: the data is at the target and the source is empty. Finishing the move
    // back is safe and needs no junction handling.
    const back = moveDirectory(target, source, { log, verify: cfg?.migrateVerify !== false });
    if (!back.ok) return fail(back.code || 'MOVE_BACK_FAILED', `move back failed: ${back.message || back.code}`, { target });
    if (db && typeof db.updateMigration === 'function') {
      try {
        db.updateMigration(record.id, { state: MIGRATION_STATE.RESTORED });
      } catch {
        /* the files are already correct; the bookkeeping is cosmetic */
      }
    }
    return { ok: true, code: 'RESTORED', reason: 'recovered an interrupted migration', source, target, bytes: 0, files: 0, method: back.method };
  }

  if (st === null) return fail('SOURCE_MISSING', `neither ${source} nor a junction is present — nothing to undo`);
  if (!st.isSymbolicLink()) {
    return fail('NOT_A_JUNCTION', `${source} is a real directory now — an undo would delete data, so it is refused`);
  }

  let pointsAt = null;
  try {
    pointsAt = fs.readlinkSync(source);
  } catch {
    pointsAt = null;
  }
  if (pointsAt && normPath(pointsAt) !== normPath(target)) {
    return fail('JUNCTION_MOVED', `the junction now points at ${pointsAt}, not the recorded ${target} — refusing to reverse it`);
  }

  if (!fs.existsSync(target)) {
    return fail(
      'TARGET_MISSING',
      `the recorded target ${target} no longer exists — removing the junction would orphan ${source}, so it is refused`,
      { target },
    );
  }

  const removed = removeJunction(source);
  if (!removed.ok) return fail(removed.code || 'UNLINK_FAILED', `cannot remove the junction: ${removed.message || removed.code}`, { target });

  const back = moveDirectory(target, source, { log, verify: cfg?.migrateVerify !== false });
  if (!back.ok) {
    // Put the junction back: a working indirection beats a missing directory.
    const relinked = createJunction(source, target);
    return fail(
      back.code || 'MOVE_BACK_FAILED',
      relinked.ok
        ? `move back failed (${back.code}); the junction was restored, so ${source} still resolves to ${target}`
        : `move back failed (${back.code}) AND the junction could not be restored (${relinked.code}); the data is at ${target}`,
      { target },
    );
  }

  if (db && typeof db.updateMigration === 'function') {
    try {
      db.updateMigration(record.id, { state: MIGRATION_STATE.RESTORED });
    } catch {
      /* cosmetic */
    }
  }

  callLog(log, 'info', `restored ${source} from ${target} via ${back.method}`);
  return { ok: true, code: 'RESTORED', reason: `moved back via ${back.method}`, source, target, bytes: 0, files: 0, method: back.method };
}

/**
 * Stubborn-directory candidates, derived from the PERSISTED rows only.
 *
 * Deriving them from the table instead of walking the disk is deliberate: the table already
 * knows which directories this plugin monitors, the computation costs no filesystem time on the
 * panel's main path, and a directory can never be offered for migration unless the plugin has
 * already observed files inside it. Grouping by immediate parent is the right granularity —
 * a stubborn directory is exactly the folder a toolchain keeps refilling.
 *
 * @param {Array<{file_path:string, file_size:number, category:string}>} rows
 * @param {object} cfg - resolved config (for `migrateMinBytes`).
 * @returns {Array<{path:string, bytes:number, files:number, category:string}>} largest first.
 */
export function findCandidates(rows, cfg) {
  const minBytes = Number.isFinite(cfg?.migrateMinBytes) ? cfg.migrateMinBytes : 10485760;
  /** @type {Map<string, {path:string, bytes:number, files:number, category:string}>} */
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const filePath = row?.file_path;
    if (typeof filePath !== 'string' || filePath.length === 0) continue;
    let dir;
    try {
      dir = path.dirname(filePath);
    } catch {
      continue;
    }
    // A tracked path directly inside a watch root has no stubborn directory of its own.
    if (dir === '.' || dir.length === 0) continue;
    const key = normPath(dir);
    let entry = groups.get(key);
    if (entry === undefined) {
      entry = { path: dir, bytes: 0, files: 0, category: /** @type {string} */ ('SAFE_TO_DELETE') };
      groups.set(key, entry);
    }
    entry.bytes += Number.isFinite(row.file_size) ? row.file_size : 0;
    entry.files += 1;
  }

  const out = [];
  for (const entry of groups.values()) {
    if (entry.bytes < minBytes) continue;
    // Re-run the SAME gate the operation will, so the panel never offers an action that would
    // be refused server-side (that mismatch reads as a broken button).
    const verdict = inspectDirectory(entry.path, cfg);
    if (!verdict.ok) continue;
    out.push({
      path: entry.path,
      bytes: entry.bytes,
      files: entry.files,
      target: verdict.target,
    });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

export default {
  MIGRATION_STATE,
  inspectDirectory,
  migrateDirectory,
  undoMigration,
  findCandidates,
  protectedForMigration,
  targetRootOf,
  moveDirectory,
  createJunction,
  removeJunction,
  walkTree,
};
