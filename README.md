# dsh-c-cleaner

C 盘逃逸缓存清理插件 — a C-drive escape monitor and safe cleaner for DeepSeek Harness.

Implements `产品需求与技术规格文档 (PRD).md` as a **native Cordis host plugin** (Node.js, zero
runtime dependencies beyond Node built-ins).

| PRD | Module | Status |
| --- | --- | --- |
| 3.1 事前拦截 — environment hijack | `lib/env-hijack.js` | implemented, live-proof captured |
| 3.2 事中监控 — C-drive watcher | `lib/watcher.js`, `lib/process-tree.js` | implemented |
| 3.3 三级分类 — three-tier classification | `lib/classifier.js` | implemented |
| 3.4 事后清理 — safe cleaner | `lib/cleaner.js` | implemented |
| 4 CLI/TUI — `c-clean` command | `lib/commands.js` | `status` + `now` implemented, `ui` not |
| 5 持久化 — SQLite state | `lib/state-db.js` | implemented (`node:sqlite`) |

Scope note: this is **Phase 1 + Phase 2** of the PRD's milestone plan. The Phase 3 items
(`mklink /J` symlink migration, `post_session_close` silent auto-clean) are **not** implemented;
`ui` is parsed as a known-but-unimplemented verb and returns a clear error rather than a crash.

## Install

From a workspace checkout, install the bundle by pointing `plugin_manager` at this directory:

```
plugin_manager { action: "install_bundle", target: "<abs path to this directory>" }
```

Do not hand-edit the profile's `package.json` or `cordis.patch.yml`, and do not create packages
under `$DSH_HOME`. Replacing an already-installed copy of this package requires a harness
**restart** to load a fresh JS module generation; a first-time install can activate via HMR.

## Usage

```
c-clean status                      # read-only summary, no disk walk
c-clean now                         # clean all 🟢 SAFE_TO_DELETE to the recycle bin
c-clean now --deep                  # also clean 🟡 CAUTION_CACHE
c-clean now --force                 # physical delete instead of the recycle bin
c-clean now --deep --force
```

`status` output, first line is the PRD §4 contract format:

```
🟢 可清理: 342.0 MB (128个文件) | 🟡 缓存驻留: 1.2 GB | 🔴 正在占用: 3个文件
环境变量劫持: ✅ 已生效 (9/9 变量) → E:\dsh_escape_cache
```

## How the env hijack actually works (the load-bearing detail)

The PRD's premise is "`$DSH_HOME` already moved to E:, so only C-drive *escape* writes remain".
Module 3.1 is what stops new ones.

There are two ways to feed a child process an environment variable in this harness, and only one
of them can carry `TEMP`/`PIP_CACHE_DIR`:

- `ctx.shellEnv.register()` contributes **`DSH_*`-namespaced** keys only
  (`dsh-subprocess/lib/index.js:13` → `const DSH_ENV_PREFIX = "DSH_"`). It cannot carry `TEMP`.
- Mutating `process.env` works, because every harness child is spawned from a **live** read of the
  parent environment: `dsh-subprocess/lib/index.js:50-56` `scrubbedParentEnv()` builds the child
  env from `Object.entries(process.env)`, filtering only names matching `/KEY|PASSWORD|SECRET|TOKEN/i`
  and names starting with `DSH_`.

So the plugin mutates `process.env` and nothing else. Verified against the real installed
`scrubbedParentEnv`, with negative controls:

```
=== scrubbedParentEnv() AFTER hijack (what every harness child inherits) ===
  PASS  TEMP                     = E:\dsh_escape_cache\temp
  PASS  PIP_CACHE_DIR            = E:\dsh_escape_cache\pip_cache_dir
  ... 9/9 hijacked variables survive the harness env scrub
--- negative control (proves the scrub is live) ---
  MY_FAKE_API_KEY present       : false (expect false — matches KEY)
  DSH_SHOULD_BE_STRIPPED present: false (expect false — DSH_ prefix)
--- end-to-end: real child process ---
  child cmd.exe saw TEMP = E:\dsh_escape_cache\temp
```

Reproduce with `node test/_env-propagation.mjs`.

Variables redirected (`lib/config.js` → `DEFAULT_ENV_MAP`): `TEMP`, `TMP`, `TMPDIR` → `temp`;
`PIP_CACHE_DIR` → `pip`; `UV_CACHE_DIR` → `uv`; `HF_HOME` → `huggingface`; `TORCH_HOME` → `torch`;
`NPM_CONFIG_CACHE` → `npm`; `PLAYWRIGHT_BROWSERS_PATH` → `playwright` — all under `escapeRoot`,
which is derived from the **drive of `$DSH_HOME`** (`path.parse(dshHome).root`), so with
`DSH_HOME=E:\dsh\.dsh` the escape root is `E:\dsh_escape_cache`. Nothing is hardcoded to `E:`.

Two deliberate properties:

- **The OS environment is never touched.** Only this process's `process.env` is mutated; nothing is
  written to the registry or to a user/system-wide environment block.
- **`restore()` puts back exactly what was there.** A variable that did not previously exist is
  *deleted* on restore, not set to the string `"undefined"`. The prior value is captured, never
  hardcoded. `SCRUB_PATTERN` (`/KEY|PASSWORD|SECRET|TOKEN/i`) is checked before assigning, so a
  user who adds e.g. `MY_API_KEY` to `envMap` gets it skipped with a reason instead of a credential
  silently relocated.

## Three-tier classification (PRD 3.3)

| Tier | Condition | Default |
| --- | --- | --- |
| 🟢 `SAFE_TO_DELETE` | not locked **and** (in a Temp dir **or** suffix `.tmp`/`.log`/`.pyc`/`.bak` **or** known one-time unzip cache) | checked |
| 🟡 `CAUTION_CACHE` | not locked **and** AppData toolchain cache / model weights / browser kernel / precompiled pkg | unchecked |
| 🔴 `LOCKED_CRITICAL` | locked (WinError 32 / `PermissionError`) **or** a persistence-shaped name (`.lock`, `.sqlite`, `.db`, `auth`, `config`, `token`) | locked, non-selectable |

The conditions are AND-ed. Lock detection is a real Windows exclusive-open probe
(`openSync(path, 'r+')` → `EBUSY`/`EPERM` means locked; `ENOENT` means not locked).

For a 🔴 file, **who holds it** is then resolved out-of-band through the Windows Restart Manager
(`lib/lock-owner.js`), which yields a real holder PID and process name; that name is what gets
displayed alongside the PID. This is asynchronous and cached, because a synchronous
`classify()` cannot block on a ~140 ms PowerShell round trip. See limitation 2 below.

## Safety properties

These are the properties that make automatic deletion defensible, and each is backed by a test:

1. **Hardcoded protected-path blacklist** (PRD 6.2) — `C:\Windows`, `C:\Program Files*`,
   Desktop, Documents. `clean()` applies its **own** veto, independent of what `classify()`
   returned, so a classification bug cannot widen the delete set. Demonstrated: a file under
   `C:\Windows\Temp` classified `SAFE_TO_DELETE` is still refused by `clean()` with reason
   `protected path (PRD 6.2 hardcoded blacklist) — refused`.
2. **Instant re-validation** — lock state is re-checked immediately before each unlink. A file that
   becomes locked between classification and deletion is skipped, not deleted.
3. **`clean()` never throws** — a vanished file, a locked file, an empty record set, or a
   `PermissionError` mid-run all resolve to a report entry; the run continues (PRD 6.3).
4. **Recycle bin by default** — deletion goes through
   `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(..., RecycleOption.SendToRecycleBin)`,
   batched ≤50 paths per invocation. `--force` / `useRecycleBin: false` opts into physical removal.
5. **No recursive C: scan** (PRD 6.1) — `fs.watch({recursive:true})` is permitted **only** under
   `%LOCALAPPDATA%\Temp`. The watcher refuses recursion on drive roots, `%USERPROFILE%`,
   `C:\Users`, `C:\Windows*`, `C:\Program Files*`, `C:\ProgramData`, and reports the refusal in
   `stats().recursiveForcedOff`.

## Configuration

Every field is optional; all have defaults. Set them in the bundle row's `config`:

```yaml
- insert:
    - id: dsh-c-cleaner
      name: '@local/dsh-c-cleaner'
      config:
        debounceMs: 3000
        useRecycleBin: true
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `dshHome` | `$DSH_HOME` | escape root drive is derived from this |
| `escapeRoot` | `<dshHome drive>:\dsh_escape_cache` | hijack destination |
| `stateDir` | `$DSH_HOME/plugins/c_cleaner` | state directory |
| `dbPath` | `<stateDir>/state.db` | SQLite file |
| `envMap` | see above | variable → subdirectory |
| `watchDirs` | `%LOCALAPPDATA%\Temp` (recursive), AppData Local + Roaming (depth 1) | monitored roots |
| `protectRoots` | `C:\Windows`, `C:\Program Files*`, Desktop, Documents | never deleted |
| `excludeNames` | `[".dsh"]` | path segments excluded (`.dsh` itself is never monitored) |
| `aiSignatureGlobs` | AI toolchain name patterns | session-window attribution |
| `debounceMs` | `3000` | coalesce streaming writes |
| `pollIntervalMs` | `5000` | process-tree poll |
| `sessionWindowMs` | `1800000` | session window |
| `useRecycleBin` | `true` | recycle bin vs physical delete |
| `maxBatch` | `50` | paths per recycle-bin invocation |
| `resolveLockOwner` | `true` | resolve a 🔴 file's holder PID via the Windows Restart Manager (PRD 3.3) |
| `autoClean` | `false` | ⚠️ auto-clean 🟢 at session end (Phase 3 hook) |

Config is validated by a **hand-rolled Standard Schema** (`lib/config-schema.js`). Cordis only
requires `{ '~standard': { version, vendor, validate } }`
(`cordis/lib/index.js:956-962`), and implementing it directly avoids statically importing
`schemastery`, which resolves from `$DSH_PROFILE_DIR/node_modules` — a plugin that fails that
resolution fails to load *entirely*, which is too high a price for an optional convenience.

## Layout

```
index.js                  plugin entry: apply(ctx, config), wiring + teardown
lib/config.js             resolveConfig, DEFAULT_ENV_MAP, formatBytes
lib/config-schema.js      Standard Schema `Config`
lib/env-hijack.js         EnvHijacker: install / status / restore
lib/process-tree.js       ProcessTree: dsh child-PID set via Win32_Process
lib/watcher.js            CWatcher: fs.watch + debounce + AI-signature filter
lib/classifier.js         isLocked / isProtectedPath / classify
lib/cleaner.js            toRecycleBin / hardDelete / clean (never throws)
lib/lock-owner.js         LockOwnerResolver: Restart Manager → holder PID + name (PRD 3.3)
lib/state-db.js           StateDB over node:sqlite
lib/commands.js           registerCommands: c-clean status|now
test/run.js               dependency-free acceptance + adversarial harness
test/_env-propagation.mjs proves the hijack reaches real children
CONTRACTS.md              frozen interface contract the modules were built against
```

## Known limitations

Stated plainly, because each one bounds what this plugin can promise:

1. **`ProcessTree.ownerOf()` returns `null` by design.** Node exposes no cheap handle→PID mapping on
   Windows; doing it per file needs ETW (`Microsoft-Windows-Kernel-File`) or Sysinternals
   `handle64.exe`, the latter spawning a process *per file*, which contradicts the PRD's own ≤2% CPU
   budget. It never fabricates a PID and exposes a `handleProbe` injection seam for a future real
   backend. The watcher's fallback — "created inside the dsh active window **and** matching an
   AI-toolchain name pattern" — is what actually populates candidates.
2. **Who holds a locked file is resolved by a different route: the Windows Restart Manager**
   (`lib/lock-owner.js`, PRD §3.3). `classify()` is synchronous and cannot wait ~140 ms for a
   PowerShell round trip, so `locked_by_pid` is filled in *after* the row is persisted and patched
   back in. Because PRD §5's DDL is fixed and has no holder-name column, the holding process name
   rides in `source_process`, and only when nothing better already claimed that column. Batched
   (one spawn per 250 ms window), cached (30 s for a hit, 5 s for a miss), and reached only for rows
   that are genuinely locked — a rare event — so the PRD §6.1 budget is untouched by construction.
   Set `resolveLockOwner: false` to disable. Practical consequence: `source_process` for a
   *non-locked* file stays `null`; only 🔴 rows acquire a holder name.
3. **Attribution is best-effort**, so a foreign process writing to `%TEMP%` during a dsh session can
   be mis-attributed. `%TEMP%` is a shared directory; the AI-signature filter narrows this but does
   not eliminate it. This is why the default action is recycle-bin deletion of 🟢 items only.
4. **Protection is canonicalized, but no normalization is perfect.** `isProtectedPath()` now resolves
   `\\?\`/`\\.\` device prefixes, UNC and admin-share spellings, repeated separators, trailing
   dots/spaces per path segment, 8.3 short names (`C:\PROGRA~1`), junctions/reparse points, and a
   case-insensitive comparison — and the delete-time check re-resolves *fresh* rather than trusting
   the classify-time cache. This closed four real PRD §6.2 bypasses found by adversarial testing
   (see `test/run.js` probes A1/A6/A9/A10). It is still a denylist of known-good normalizations, not
   a proof; a filesystem form nobody has thought of yet is not covered.
5. **`ui` (PRD 4) is not implemented.** Only `status` and `now` exist; the `ui` verb is recognized
   and returns an explicit "not implemented" error.
6. **Phase 3 is not implemented**: no `mklink /J` symlink migration, no `post_session_close` hook.
7. **The plugin only redirects variables it knows about.** A toolchain that honors none of the nine
   variables (or hardcodes a C: path) still escapes; that residue is exactly what Modules 3.2–3.4
   exist to catch.

## Verification

```
node test/run.js                 # acceptance + adversarial harness
node test/_env-propagation.mjs   # proves the hijack reaches real child processes
node test/_wire.mjs              # apply() wiring + teardown against a mock ctx
node test/_perf-cpu.mjs          # PRD 6.1 CPU, isolated from harness I/O
node test/_perf.mjs              # PRD 6.1 RSS + the recursion guard
```

### Live proof, captured on this host

Installed via `plugin_manager { action: "install_bundle", target: "F:\\work\\dsh-c-cleaner" }`
→ `{"changed":true,"application":"applied","warnings":[]}`.

**(a) The hijack reaches real children.** A plain harness `bash` call after installation:

```
$ node -e "console.log(process.env.TEMP, '|', process.env.PIP_CACHE_DIR)"
E:\dsh_escape_cache\temp | E:\dsh_escape_cache\pip

$ cmd //c "echo TEMP=%TEMP%"
TEMP=E:\dsh_escape_cache\temp
```

Git Bash prints `/tmp` for `$TEMP`, which looks like a failure but is not: MSYS *aliases* `/tmp`
to `$TEMP`, and `cd /tmp && pwd -W` reports `E:/dsh_escape_cache/temp`. The native `cmd` and the
native `node` runtime both confirm the redirected value. `E:\dsh_escape_cache\` now contains
`temp/ pip/ uv/ huggingface/ torch/ npm/ playwright/`.

**(b) The watcher records real C: writes into SQLite.** Writing one file into the *real*
C-drive `%TEMP%` (`C:\Users\kiuhg\AppData\Local\Temp\lead-live-proof-1837.tmp`) and waiting out
the debounce produced, in the live `state.db`:

```
{"file_path":"C:\\Users\\kiuhg\\AppData\\Local\\Temp\\lead-live-proof-1837.tmp",
 "category":"SAFE_TO_DELETE","file_size":10,"is_locked":0}
```

**(c) The schema is the PRD §5 schema**, created by the running plugin at
`E:\dsh\.dsh\plugins\c_cleaner\state.db`: `CREATE TABLE tracked_files (...)` with all nine PRD
columns, plus `idx_tracked_files_category` and `idx_tracked_files_checked`. The only deviation is
`CREATE TABLE IF NOT EXISTS`, required for `migrate()` idempotency.

**(d) PRD §6.1 is met.** Running the identical 10-second, ~92-file churn workload twice — once
with no watcher, once with the watcher attached — gives the plugin's marginal cost:

```
baseline : 10028ms, cpu 63.0ms => 0.63%
watcher  : 10025ms, cpu 156.0ms => 1.56%
PLUGIN MARGINAL CPU : 93.0ms over 10025ms = 0.93 %   (PRD <= 2%) -> PASS
RSS delta (plugin)  : 2.7 MB                          (PRD <= 30MB) -> PASS
```

The naive measurement (whole process, including the harness's own `fs.writeFileSync` calls)
reads 2.65% and would look like a failure; the plugin's own share is 0.93%. The recursion guard
also refuses `recursive:true` on `C:\` and `C:\Users\kiuhg` — `recursiveForcedOff: 2`.

### Live-plugin caveat for the test harness

Once the plugin is installed it is *running in the harness process*, so its hijack is already
applied before any test starts. A test that asserts `process.env.TEMP !== <ambient prior>` will
therefore fail spuriously. Set a sentinel value for `TEMP`/`TMP`/`TMPDIR` *before* constructing
the hijacker to test the real property independently of installation state.

Relatedly, `os.tmpdir()` returns the **hijacked** escape root once the plugin is live. A test that
creates its fixture directory with `os.tmpdir()` is writing into a `protectRoot`, where the watcher
correctly refuses to emit — so such a test measures the protection, not the watcher. Fixtures that
are meant to be *observed* must be created under the real C: `%TEMP%`.

### Editing the plugin while the harness is running

The installed package is a **symlink** to this working directory
(`$DSH_PROFILE_DIR/node_modules/@local/dsh-c-cleaner -> F:/work/dsh-c-cleaner`), so an edit is
immediately visible on disk — but the running harness keeps the module generation it already
imported. Verified on this host, not assumed: with a file held under a real `FileShare.None` handle
(positive control: `openSync(p,'r+')` threw `EBUSY`), the live watcher persisted the row as
`LOCKED_CRITICAL` with `is_locked=1` and yet left `locked_by_pid`/`source_process` **null** — i.e.
the running process was still executing the pre-change `index.js`, which did not yet wire
`LockOwnerResolver`. The same file against the current modules resolves the holder.

The harness ships HMR with **module roots empty** (`@deepseek-ai/dsh-hmr`, `config.root: []` in
`@deepseek-ai/dsh-base/cordis.patch.yml`) — profile *configuration* hot-reloads, module *code* does
not. So: **restart the harness after editing `lib/` or `index.js`** for the change to take effect in
the live process. A fresh first-time install can still activate via HMR because there is no stale
generation to replace.
