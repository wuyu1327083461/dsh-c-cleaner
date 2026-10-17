# dsh-c-cleaner — PHASE 3 FROZEN CONTRACT (v1)

Binds the Phase 3 workstreams. `CONTRACTS.md` (Phase 1) and `CONTRACTS-PHASE2.md` stay in force;
this file ADDS to them. Where they conflict, this file wins for the scope it names.

Phase 3 scope is exactly two deliverables (PRD §7):

1. `mklink /J` 顽固目录一键迁移至 E 盘 — junction migration of stubborn directories.
2. 会话结束自动静默清理钩子 (`post_session_close`) — session-close silent clean.

Nothing else is in scope. Nothing here changes the PRD §5 `tracked_files` DDL, the Category
vocabulary, or any Phase 1 / Phase 2 signature.

## 0. Measured facts (do not re-litigate)

| Measurement | Value | Consequence |
|---|---|---|
| `fs.renameSync` C:\… → E:\… | **`EXDEV`** (syscall `rename`) | a cross-volume move is copy+delete; `rename` is same-volume only |
| `fs.symlinkSync(target, link, 'junction')` C: with target on E: | **works, no admin** | the PRD's `mklink /J` needs no shell and no elevation |
| `lstat(link).isSymbolicLink()` | `true`; `stat(link).isDirectory()` also `true` | `isSymbolicLink()` is the ONLY cheap junction discriminator |
| `fs.rmdirSync(link)` | link gone, **target + contents survive** | undo can drop the junction without risking the data |
| write through the junction | lands in the **target** | programs hard-coding the old C: path keep working |
| `robocopy /MOVE` | exit 1 = moved, 0 = nothing, ≥8 = failure | rejected: exit codes are unreliable under a lock, and it needs a shell |
| `session/disposed` vs `post_session_close` | the PRD name does not exist in `@deepseek-ai/*` | the hook binds `session/disposed`; see §2 |

**Decision recorded:** the move is `fs.cpSync` → independent re-measure of both trees →
`fs.rmSync(source)`, not `robocopy`. Rationale: no shell means no quoting/injection surface, and
the independent re-measure is the only verification that survives a partially-locked tree.

## 1. `lib/symlink-migrate.js`

Public surface (frozen):

```js
export const MIGRATION_STATE = { PENDING, MOVED, LINKED, FAILED, RESTORED }
export function walkTree(root, opts?)            // -> {files,bytes,dirs,reparsePoints,truncated,unreadable}
export function protectedForMigration(cfg)       // -> {forbidden: string[], rootsOnly: string[]}
export function targetRootOf(cfg)                // -> absolute path (cfg.migrateTargetRoot || <escapeRoot>/migrated)
export function inspectDirectory(dirPath, cfg)   // -> {ok:true, bytes,files,target,...} | {ok:false, code, reason}
export function moveDirectory(source, target, opts?)
export function createJunction(source, target)
export function removeJunction(linkPath)         // refuses a non-junction
export async function migrateDirectory(dirPath, deps)   // deps = {cfg, log, db}
export async function undoMigration(sourcePath, deps)
export function findCandidates(rows, cfg)        // -> [{path, bytes, files, ...}]
```

### 1.1 Refusal codes — decided by KIND, in this order

`inspectDirectory` answers a **code**, never a throw (PRD §6.3). Order is load-bearing: protection
is a LEXICAL property, so it is decided before the path is touched. Otherwise `C:\Windows\Temp\x`
(absent) answers `MISSING` and `C:\Windows` answers `TOO_SHALLOW` — both true, both useless to a
caller asking "may I move this?".

```
BAD_PATH → NOT_WINDOWS → PROTECTED / ANCESTOR_OF_PROTECTED
         → PROTECTED / ANCESTOR_OF_WATCH_ROOT → TOO_SHALLOW
         → NO_TARGET_ROOT → SAME_VOLUME
         → MISSING / STAT_FAILED → ALREADY_LOGGED → NOT_A_DIRECTORY
         → SCAN_FAILED / TOO_LARGE_TO_SCAN / UNREADABLE / CONTAINS_REPARSE_POINTS / EMPTY
         → TARGET_UNWRITABLE            (mkdir happens LAST: a blacklisted path must not create it)
         → INSUFFICIENT_SPACE
```

`migrateDirectory` / `undoMigration` additionally answer `STATE_UNAVAILABLE`, `NO_RECORD`,
`NOT_A_JUNCTION`, `JUNCTION_MOVED`, `TARGET_MISSING`, `MOVE_FAILED`, `LINK_FAILED`,
`ROLLBACK_FAILED`, `VERIFY_FAILED`.

### 1.2 The protection split (a design bug found by probe, do not regress)

A single "is it protected?" check cannot work for migration, because **every stubborn directory
lives inside a watch root**. Treating watch roots as flatly protected refused every real candidate
with `PROTECTED`. Hence:

- `forbidden` — `cfg.protectRoots`, `escapeRoot`, `stateDir`, `dshHome`, `targetRootOf(cfg)`.
  Refused when the source **is inside OR is an ancestor of** one of them.
- `rootsOnly` — `cfg.watchDirs`. Refused only when the source **is or contains** one; **descendants
  are allowed**, because that is exactly the target population.

`ANCESTOR_OF_PROTECTED` / `ANCESTOR_OF_WATCH_ROOT` name the ancestor case so the panel can explain
why `C:\Users` is not migratable.

### 1.3 Journal (the crash window)

State machine: `PENDING` (recorded, nothing moved) → `MOVED` (data at target, no junction) →
`LINKED` (junction in place). Failure paths: `FAILED` (rolled back, `error` populated) and
`ROLLBACK_FAILED` (data is at the target; the row names where). `RESTORED` closes an undo.

Ordering is mandatory: **record `PENDING` before touching the filesystem.** A crash before that
write leaves the disk untouched and no row — a clean state. A crash after it is recoverable by
`listInterruptedMigrations()`, which returns `PENDING` and `MOVED` rows.

`undoMigration` removes the junction FIRST (moving data back under a live junction is impossible),
then moves, and **re-installs the junction if the move back fails** so the user is never left with
data at the target and a dead path. It refuses:

- `NO_RECORD` — no journal row, so it will not guess what used to be there.
- `NOT_A_JUNCTION` — the source is a real directory again. Undoing would delete real content.
- `JUNCTION_MOVED` — `readlink` ≠ the recorded target, so the link was repointed by someone else.
- `TARGET_MISSING` — moving back is impossible and dropping the junction would orphan the path.

A `MOVED` row whose source is missing is **completed** (the move back), not refused: that is the
crash window itself.

### 1.4 Move verification

`moveDirectory` tries `renameSync` first (fast, same volume) and on `EXDEV`/`EINVAL`/`ENOTSUP`
falls back to `cpSync`. After the copy it re-measures both trees **independently**; any mismatch
deletes the partial target and leaves the source untouched. `cfg.migrateVerify` (default `true`)
is the switch, and turning it off forfeits the only evidence that deleting the source is safe —
documented as such, not hidden.

`walkTree` records reparse points and **does not descend into them**; `cpSync` would copy the
*target's* bytes into the new location.

### 1.5 `SAME_VOLUME` is decided by the PHYSICAL volume, not the path spelling

Regression found by the live API probe (`test/_lead-p3-api-live.mjs`), pinned by
`test/run.js` check `migrate.no-second-migration-through-a-junction`.

After `C:\…\Temp\foo` is migrated, `C:\…\Temp\foo\sub` **spells `C:` while its bytes live on
`E:`** — a lexical drive comparison answers "different volumes" and offers `sub` as a fresh
candidate. Acting on that offer migrates already-moved data a second time and nests the second
target inside the first. `inspectDirectory` therefore compares `driveOf(targetRoot)` against
`physicalDriveOf(source)`, which resolves the nearest existing ancestor with
`fs.realpathSync.native` and re-appends the missing tail; `driveOf(source)` is the fallback when
nothing on the path exists yet. Consequence, and the reason this is a contract rather than an
implementation detail: **a directory reachable through this plugin's own junction must answer
`SAME_VOLUME`** and must never appear in `findCandidates()`.

## 2. `lib/session-hook.js`

Public surface (frozen):

```js
export function installSessionHook(ctx, deps) // -> {dispose(), sweep(reason), isEnabled()}
// deps = {cfg, log, trackedRows, clean, refresh?}
```

### 2.1 The event mapping

The PRD's `post_session_close` does not exist in the host. The seam is the Cordis event
**`session/disposed`**:

- `@deepseek-ai/dsh-session/lib/index.js:1813` `emitDisposed(entry)` → `:1818` emits
  `"session/disposed"`, `:1821` `invokeContainedSessionObservers(...)`.
- Reached from `detachEntered(entry)` at `@deepseek-ai/dsh-session/lib/index.js:1780`.
- Subscriber shape `ctx.on('session/disposed', (session) => …)`, `session.id` present. Verified
  against `dsh-session-telemetry/lib/index.js:69`,
  `dsh-session-persistence-jsonl/lib/index.js:421`,
  `dsh-api-session-controller/lib/index.js:2876`,
  `dsh-session-projection-cache/lib/index.js:316`.

The PRD name survives in the config key (`sessionCloseClean`) and in the docs so the requirement
stays traceable to the code that satisfies it.

### 2.2 Rows must be CONVERTED before `clean()` — a defect this contract now forbids

`trackedRows()` returns persisted `TrackedRow`s, whose path column is `file_path` (PRD §5 DDL).
`clean()` reads `rec.path` (the `Classified` field) and refuses any record without it. Forwarding
rows unchanged therefore produced **a sweep that ran, logged "nothing removed", and deleted
nothing** — measured with three real `%TEMP%` files: `rows before: 3`, `removed 0`, all three
surviving. Fixed by `toClassified()` inside `installSessionHook`, mirroring `lib/web-api.js`.

Consequences for tests, both of which had hidden it:

- A probe that records `recs.map(r => r.file_path)` observes `undefined` and *looks* correct;
  it must assert `r.path` instead. Pinned by `test/run.js` check
  `sessionhook.arms-and-sweeps-on-dispose` and by `test/_lead-p3-session-hook.mjs`.
- Mutation-proven: reverting `toClassified` to a raw filter turns the harness RED with
  `disposing a session ran exactly one sweep: expected 1, got 0`.

### 2.3 Rules the implementation must keep

- **Off by default.** `sessionCloseClean` is `false` unless it is literally `true`. A silent
  cleaner that arms itself is not acceptable.
- **The listener never throws and never blocks teardown.** It returns immediately; the sweep runs
  detached and every failure is caught and logged. The host awaits listener promises, so a slow
  sweep would delay session disposal.
- **One sweep at a time** (a latch). Concurrent disposals must not multiply work.
- **`sessionCloseMinAgeMs`** (default 60 s) skips sessions shorter than the threshold, tracked via
  `session/created`. The host creates and disposes throwaway sessions routinely. A session with no
  observed start has no measurable age and is therefore **not** skipped.
- **Only `SAFE_TO_DELETE` rows**, and only through `clean()`. This module is a scheduler in front
  of the existing cleaner, never a second delete path: the §6.2 blacklist, the directory/reparse
  refusal and the instant revalidation all still run at delete time (PRD §6.2/§6.3).

## 3. Data model (additive only)

The PRD §5 `tracked_files` DDL is frozen. Phase 3 adds ONE table inside the existing idempotent
`migrate()`:

```sql
CREATE TABLE IF NOT EXISTS migrations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path  TEXT UNIQUE NOT NULL,
  target_path  TEXT NOT NULL,
  state        TEXT NOT NULL,
  file_count   INTEGER DEFAULT 0,
  byte_count   INTEGER DEFAULT 0,
  method       TEXT,
  error        TEXT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_migrations_state ON migrations(state);
```

`source_path UNIQUE` + upsert means a repeated migration of the same directory **supersedes** its
row rather than accumulating history that `getMigrationBySource` would then have to disambiguate.

New `StateDB` methods: `recordMigration({source,target,state,files,bytes,method,error})` → id,
`updateMigration(id, patch)` → boolean (clears `error` on `LINKED`/`RESTORED`),
`listMigrations(limit=100)`, `getMigrationBySource(sourcePath)`, `listInterruptedMigrations()`.

## 4. Config keys (additive, fail-soft)

| Key | Default | Meaning |
| --- | --- | --- |
| `migrateTargetRoot` | `null` → `<escapeRoot>/migrated` | migration destination |
| `migrateVerify` | `true` | re-measure both trees before deleting the source |
| `migrateMinBytes` | `10485760` | a directory below this total is not offered |
| `sessionCloseClean` | `false` | ⚠️ arms the `post_session_close` sweep |
| `sessionCloseMinAgeMs` | `60000` | skip sessions younger than this |

Every key must appear in **both** `FIELDS` and `Config.meta` in `lib/config-schema.js`
(with a Chinese description), or the settings UI silently omits it. `FIELDS` is exported for
introspection. Malformed input follows the existing convention: `safeNumber(raw.x, DEFAULT, MIN)`
returns the **fallback** below the floor, and only a literal `true` enables a boolean switch.

## 5. Wiring

`index.js`:

- `installSessionHook(ctx, {cfg, log, trackedRows, clean, refresh})` is called once per generation,
  immediately after the cleaner deps are bound, and `sessionHook.dispose()` runs in `cleanup()`.
- `webApiDeps` gains `migrationTargetRoot`, `migrationHistory`, `migrationRecordFor`, `migrate`,
  `undoMigration` (the latter two lazy-`import()` so `apply()` stays cheap on a cold boot).

`lib/web-api.js` gains two fenced routes:

- `POST /c-cleaner/api/migrate` `{path}` — **the candidate list is recomputed server-side** from
  persisted rows via `findCandidates`; a path that is not currently offered answers
  `NOT_A_CANDIDATE` with 200. A scripted caller therefore cannot name `C:\Windows` and have it
  moved. The directory's own gate runs again inside `migrateDirectory` (TOCTOU: the tree can change
  between the snapshot and the move).
- `POST /c-cleaner/api/unmigrate` `{path}` — **the journal is the authority**: only a `LINKED`
  record may be reversed, so the route can never aim at a directory the plugin did not move.

`lib/commands.js` gains `migrate` (no argument → list candidates, with argument → migrate) and
`unmigrate <path>`. Path is rejoined from the remaining tokens so a path with spaces survives.

`client.js` gains the PRD §4 hotkey **`[M]` 将选中目录软链接迁移至 E 盘** plus a migration strip
(per-candidate 迁移/撤销 buttons, interrupted-migration warning). Every new string needs **both**
`en` and `zh` entries with identical `{placeholder}` sets (`test/_lead-p3-locale.mjs` enforces it).

## 6. Acceptance

`node test/run.js` must stay GREEN and gains:

- `migrate.inspect-gate-refusals` — 12 refusal codes, no throws.
- `migrate.cross-volume-move-and-junction` — LIVE C:→E: move, junction, write-through, undo.
- `migrate.undo-refuses-to-eat-data` — `NO_RECORD` and `NOT_A_JUNCTION` with the data intact.
- `migrate.candidates-come-from-tracked-rows` — same gate as the operation; malformed rows → `[]`.
- `sessionhook.arms-and-sweeps-on-dispose` / `.off-by-default-and-min-age` /
  `.concurrency-and-disposal`.
- `config.phase3-keys` — defaults, fail-soft, and presence in `FIELDS` + `meta`.
- Probes `P1` (blacklist veto by path, not existence), `P2` (crash window recoverable),
  `P3` (junction without a shell ≡ `mklink /J`).

### 6.1 Field defects found after the first "complete" build

Three failures were reported by a user running the shipped panel (screenshot: a migration
refused with a bare `EPERM`, and a clean that appeared to do nothing). Each is now a pinned
check, because review and the original probes had all missed them.

| # | Symptom the user saw | Root cause | Fix | Check |
| --- | --- | --- | --- | --- |
| 1 | `已拒绝（EPERM）：move failed: EPERM, Permission denied: \\?\C:\…\com.adobe.dunamis` | `fs.rmSync(source)` cannot delete a directory whose files another process holds without delete sharing. `rmSync` removes what it can reach first, so a partial delete is possible. | Refuse at PLANNING time with `FILES_IN_USE`, before any copy. | `migrate.busy-directory-refused-before-any-copy` |
| 2 | 点击一键清理没啥反应 | 18 648 of 18 809 tracked rows pointed at files that no longer existed; `clean()` re-validated each ghost and reported `removed: 0`; rows were never dropped after a successful clean. | `CleanupReport.removedPaths`/`gonePaths`; `/clean` forgets those rows; startup prune; `/purge` drops dead rows. | `cleaner.reports-removed-and-gone-paths`, `webapi.findDeadRows-separates-missing-from-unreadable` |
| 3 | files selected as cleanable that then failed to delete | `isLocked()` used `openSync(p,'r+')`; a handle without delete sharing still allows `r+`. | Probe a self-rename, which needs the delete permission. | `cleaner.isLocked-matches-delete-permission` |

Measured after the fixes on the live profile: table 18 809 → 176 rows, `/state` payload
5 400 930 → 58 854 bytes, and a 24-path clean reported `removed=3 skipped=21 bytesFreed=3384`
with `forgotten=13` dead rows dropped (the 21 skips are Adobe-held files, verified
independently as `rename → EBUSY, open r+ → OK`).

Measured on this host: **`SUMMARY pass=42 fail=0 total=42 probes_failed=0 verdict=GREEN`**.
