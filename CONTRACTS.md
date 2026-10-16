# dsh-c-cleaner — FROZEN INTERFACE CONTRACT (v1)

Do not change any signature below without telling the Lead. This file is the single
source of truth binding four parallel workstreams.

## 0. Runtime facts (verified, do not re-litigate)

| Fact | Evidence |
|---|---|
| dsh loads **Cordis / Node.js ESM** plugins only. No Python loader. | `plugin_manager` skill; profile bundles are npm packages |
| Node v24.19.0, `node:sqlite` `DatabaseSync` works with no flag | `node -e` probe |
| Child processes inherit the **harness process's live `process.env`** at spawn time | `dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js:1035` and `:1521` call `childEnv(spec.env)` → `:694 childEnv()` → `scrubbedParentEnv()` |
| `scrubbedParentEnv()` re-reads `process.env` on **every** spawn | `dsh-subprocess/lib/index.js:50-53` |
| Scrub drops vars matching `/KEY\|PASSWORD\|SECRET\|TOKEN/i` and any `DSH_*` | `dsh-subprocess/lib/index.js:32,52` |
| `ctx.shellEnv` **cannot** carry our vars (typed to `DSH_*` only) | `DshEnvironmentKey = \`${typeof DSH_ENV_PREFIX}${string}\`` |
| `fs.watch(dir,{recursive:true})` works on this host | probe |
| `openSync(p,'r+')` throws on locked/inaccessible file | probe (`EPERM` on hosts file) |
| Recycle bin reachable via PowerShell `Microsoft.VisualBasic.FileIO.FileSystem` | probe |
| Process list via `Get-CimInstance Win32_Process` JSON | probe |
| `$DSH_HOME = E:\dsh\.dsh`, `$DSH_PROFILE_DIR = E:\dsh\.dsh\profiles\tauri` | env |

### Consequence — the env-hijack seam
Mutating `process.env` inside the plugin's `apply()` **is** the hijack: every later
model `bash`/`pwsh` spawn re-reads it. System-wide env is untouched (PRD 3.1 ✓).

**HARD RULE:** never inject a variable whose name matches
`/KEY|PASSWORD|SECRET|TOKEN/i` — the scrub layer deletes it before the child starts.

## 1. File ownership (disjoint write scopes)

| Owner | Files |
|---|---|
| Lead | `package.json`, `cordis.patch.yml`, `index.js`, `lib/config.js`, `lib/env-hijack.js`, `icon.svg`, `locale/*.json` |
| watch-tracker | `lib/process-tree.js`, `lib/watcher.js` |
| classify-clean | `lib/classifier.js`, `lib/cleaner.js` |
| store-cmd | `lib/state-db.js`, `lib/commands.js` |
| verifier | `test/**` (owns no `lib/` file) |

Nobody edits another owner's file. Need a change there → message the owner.

## 2. Shared vocabulary

```js
/** @typedef {{ path:string, size:number, mtimeMs:number, sourceProcess:string|null }} Candidate */
/** @typedef {{ path:string, size:number, category:string, isLocked:boolean,
 *              lockedByPid:number|null, lockedByProcess:string|null,
 *              reason:string, sourceProcess:string|null, mtimeMs:number }} Classified */
```

## 3. `lib/config.js` (Lead)

```js
export const CATEGORY; // { SAFE:'SAFE_TO_DELETE', CAUTION:'CAUTION_CACHE', LOCKED:'LOCKED_CRITICAL' }
export const DEFAULT_ENV_MAP; // { TEMP:'temp', TMP:'temp', TMPDIR:'temp', PIP_CACHE_DIR:'pip',
                              //   UV_CACHE_DIR:'uv', HF_HOME:'huggingface', TORCH_HOME:'torch',
                              //   NPM_CONFIG_CACHE:'npm', PLAYWRIGHT_BROWSERS_PATH:'playwright' }
export function resolveConfig(raw, env = process.env): ResolvedConfig;
```

`ResolvedConfig`:
```js
{
  enabled: boolean,
  escapeRoot: string,       // default 'E:\\dsh_escape_cache' (derived from $DSH_HOME drive)
  stateDir: string,
  dbPath: string,           // default `<stateDir>/state.db`
  envMap: Record<string,string>,       // varName -> subdir name under escapeRoot
  watchDirs: Array<{ path:string, recursive:boolean, maxDepth:number }>,
  protectRoots: string[],   // absolute, lowercased compare
  excludeNames: string[],   // e.g. ['.dsh']
  excludeGlobs: string[],   // AI-toolchain noise filter
  debounceMs: number,       // default 3000
  pollIntervalMs: number,   // default 5000
  sessionWindowMs: number,  // default 30*60*1000
  isWindows: boolean,
}
```

## 4. `lib/env-hijack.js` (Lead)

```js
export class EnvHijacker {
  constructor(cfg, log)
  install(): { ok:boolean, applied:Array<{name:string,value:string,previous:string|null}>,
               createdDirs:string[], skipped:Array<{name:string,reason:string}>, errors:string[] }
  status():  { installed:boolean, escapeRoot:string,
               entries:Array<{name:string,expected:string,actual:string|null,ok:boolean}> }
  restore(): void
}
```
`install()` must (a) `mkdirSync(...,{recursive:true})` every target dir, (b) record the
previous value for `restore()`, (c) skip names matching the scrub pattern into `skipped`.
`log` is `{debug,info,warn,error}(msg,...)`.

## 5. `lib/process-tree.js` (watch-tracker)

```js
export class ProcessTree {
  constructor({ rootPid = process.pid, pollIntervalMs = 5000, log })
  async refresh(): Promise<{ count:number, total:number }>
  pids(): Set<number>
  isTreeMember(pid: number): boolean
  nameOf(pid: number): string | null
  snapshot(): Array<{ pid:number, ppid:number, name:string }>
  start(): void
  stop(): void
  async ownerOf(filePath: string): Promise<{ pid:number, name:string } | null>
}
```
- Enumerate with `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name`
  via `execFile('powershell.exe', ['-NoProfile','-NonInteractive','-Command', ...])`.
- `ownerOf` is **best-effort**: return `null` when undeterminable; never throw.
- `start()` polls on `pollIntervalMs` via `setInterval` (`.unref()` it).
- Must never spawn a shell per file — cache the snapshot.

## 6. `lib/watcher.js` (watch-tracker)

```js
export class CWatcher {
  constructor({ cfg, tree, log, onCandidate })   // onCandidate(Candidate) => void
  start(): { watching: string[] }
  stop(): void
  stats(): { events:number, candidates:number, filtered:number, watching:string[] }
}
```
- `start()` opens one `fs.watch` per `cfg.watchDirs` entry using its `recursive` flag.
- **Perf rule (PRD 6.1):** never recursive on `C:\Users\<u>` or `%LOCALAPPDATA%` root.
  Only `%LOCALAPPDATA%\Temp` is recursive.
- Debounce per path for `cfg.debounceMs`; emit only after quiescence (PRD 3.2).
- Drop paths under `protectRoots`, under any `excludeNames` segment, and non-files.
- Best-effort attribution: `tree.ownerOf(path)`; if the pid is not a tree member but the
  path matches `excludeGlobs` inside the session window, still emit with
  `sourceProcess` = matched process name or `null`.
- `stats()` counters are exact and must be asserted by the verifier.

## 7. `lib/classifier.js` (classify-clean)

```js
export function isLocked(filePath: string): { locked:boolean, code:string|null, pid:number|null, process:string|null }
export function isProtectedPath(filePath: string, protectRoots: string[]): boolean
export function classify(candidate: Candidate, opts: { cfg, tree }): Classified
```

Rules (PRD 3.3 table — all three conditions are AND-ed):
- `LOCKED_CRITICAL` if `isLocked().locked` **or** the basename matches
  `/\.lock$|\.sqlite3?$|\.db$|auth|config|token|credential/i`.
- `SAFE_TO_DELETE` if not locked **and** (under a `Temp` dir **or** ext in
  `.tmp/.log/.pyc/.bak`).
- `CAUTION_CACHE` otherwise (toolchain caches, model weights, browser kernels).
- `isProtectedPath` must return `true` for anything under `C:\Windows`,
  `C:\Program Files*`, Desktop, Documents — belt-and-braces (PRD 6.2).
- `isLocked` maps a failed `openSync(p,'r+')` to `locked:true`; `ENOENT` → `locked:false`.

## 8. `lib/cleaner.js` (classify-clean)

```js
export async function toRecycleBin(paths: string[], log): Promise<CleanupReport>
export async function hardDelete(paths: string[], log): Promise<CleanupReport>
export async function clean(records: Classified[], opts: { deep:boolean, force:boolean, cfg, log }): Promise<CleanupReport>
```
```js
/** @typedef {{ removed:number, skipped:number, bytesFreed:number,
 *              errors:Array<{path:string,code:string,message:string}>,
 *              skippedList:Array<{path:string,reason:string}> }} CleanupReport */
```
- `clean()` selects `SAFE_TO_DELETE`, plus `CAUTION_CACHE` when `deep`.
  **Never** touches `LOCKED_CRITICAL` or `isProtectedPath`.
- **Instant re-validation** immediately before each delete (PRD 3.4): re-run
  `isLocked`; on lock, push to `skippedList` and continue.
- **Never throw out of `clean()`**: a `PermissionError`/`WinError 32` equivalent
  (`EPERM`/`EACCES`/`EBUSY`) demotes that file and the loop continues (PRD 6.3).
- `toRecycleBin` uses PowerShell `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile`
  with `RecycleOption.SendToRecycleBin`; `hardDelete` uses `fs.rmSync(p,{recursive:true,force:false})`.
- Batch recycle-bin calls (one PowerShell invocation per chunk of ≤50 paths).

## 9. `lib/state-db.js` (store-cmd)

```js
export class StateDB {
  constructor(dbPath: string)                      // node:sqlite DatabaseSync
  migrate(): void
  upsert(rec: Classified): void
  upsertMany(recs: Classified[]): void
  list(opts?: { category?: string, limit?: number }): TrackedRow[]
  summary(): { SAFE:{count:number,bytes:number}, CAUTION:{count:number,bytes:number},
               LOCKED:{count:number,bytes:number}, total:{count:number,bytes:number} }
  removeByPath(paths: string[]): number
  close(): void
}
```
`TrackedRow` = the PRD §5 column names **exactly**:
`id, file_path, file_size, category, is_locked, locked_by_pid, source_process, created_at, last_checked_at`.
Use the PRD §5 `CREATE TABLE` verbatim; `migrate()` is idempotent
(`CREATE TABLE IF NOT EXISTS`). `upsert` keys on `file_path`.
`summary()` sizes are **bytes**; formatting to MB/GB happens in `commands.js`.

## 10. `lib/commands.js` (store-cmd)

```js
export function registerCommands(ctx, deps): () => void   // returns the disposer
// deps = { cfg, log, db, hijacker, tree, watcher, refresh():Promise<void>,
//          collect():Promise<Classified[]> }
```
Registers exactly one command, `c-clean`, on `ctx.commands`.
Before coding, call `cordis_inspect_query` with `platform:'host'`, provider as listed by
`cordis_inspect_list`, `method:'Service'` and read `CommandRuntime.register` to confirm the
`CommandDefinition` field names (`name`, `description`, `handler`, `input`). Use only
documented fields.

Argument grammar parsed from the invocation's raw text:
- `status` → one-line summary: `🟢 可清理: <size> (<n>个文件) | 🟡 缓存驻留: <size> | 🔴 正在占用: <n>个文件`
- `now` → clean `SAFE_TO_DELETE` (recycle bin)
- `now --deep` → also `CAUTION_CACHE`
- `now --force` → physical delete instead of recycle bin
- unknown → usage text listing the three forms

`status` must be **read-only and cheap** (no PowerShell, no disk walk) — it reads
`db.summary()` plus `hijacker.status()`.

## 11. `index.js` (Lead)

```js
export const name = 'c-cleaner';
export const inject = ['commands'];
export function apply(ctx, config) { /* wires all modules, ctx.effect cleanup */ }
export const Config = /* schemastery schema mirroring lib/config.js */;
```
Wiring order: `resolveConfig` → `EnvHijacker.install()` → `StateDB.migrate()` →
`ProcessTree.start()` → `CWatcher.start()` → `registerCommands()`.
`onCandidate` → `classify()` → `db.upsert()`.
Must degrade gracefully off-Windows (`cfg.isWindows === false` ⇒ env hijack and watcher
report `ok:false` with a reason instead of throwing).

## 12. Verification bar (verifier owns)

Acceptance is **observed behaviour**, not "the file exists":
1. `node --check` every `.js` file.
2. `node test/run.js` — a dependency-free harness that imports each module and asserts:
   `resolveConfig` defaults on this host; `EnvHijacker.install()` actually changes
   `process.env` and `restore()` puts it back; `classify()` on synthesised fixtures hits
   all three categories; `StateDB` round-trips and `summary()` byte totals are right;
   `cleaner.clean()` skips a locked file and keeps going (create a real locked fixture);
   `ProcessTree.refresh()` returns `process.pid` in `pids()`.
3. **Live proof of the hijack**: after install, `node -e "console.log(process.env.TEMP)"`
   run as a real child via the harness `bash` tool must print the E: path — this is the
   end-to-end evidence that the seam works. Record the exact command and output.
4. Report each check as PASS/FAIL with the literal command and literal output.
   A claim without captured output is not evidence.
