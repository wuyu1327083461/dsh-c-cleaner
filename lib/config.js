/**
 * Configuration resolution for dsh-c-cleaner.
 *
 * Every path decision the plugin makes flows through {@link resolveConfig} so that
 * the runtime, the CLI command, and the test harness all agree on one shape.
 * Pure by design: no filesystem access, so it is trivially testable.
 *
 * @module dsh-c-cleaner/lib/config
 */

import os from 'node:os';
import path from 'node:path';

/** The three PRD §3.3 safety tiers. These strings are persisted in `tracked_files.category`. */
export const CATEGORY = Object.freeze({
  SAFE: 'SAFE_TO_DELETE',
  CAUTION: 'CAUTION_CACHE',
  LOCKED: 'LOCKED_CRITICAL',
});

/**
 * PRD §3.1 environment redirection map: `variable -> subdirectory under the escape root`.
 *
 * HARD CONSTRAINT: no key here may match /KEY|PASSWORD|SECRET|TOKEN/i. The harness
 * scrub layer (`dsh-subprocess/lib/index.js:32,52`) deletes any such variable from a
 * child's environment before it starts, so injecting one would silently do nothing.
 * {@link DEFAULT_ENV_MAP} is asserted against that pattern by the test harness.
 */
export const DEFAULT_ENV_MAP = Object.freeze({
  TEMP: 'temp',
  TMP: 'temp',
  TMPDIR: 'temp',
  PIP_CACHE_DIR: 'pip',
  UV_CACHE_DIR: 'uv',
  HF_HOME: 'huggingface',
  TORCH_HOME: 'torch',
  NPM_CONFIG_CACHE: 'npm',
  PLAYWRIGHT_BROWSERS_PATH: 'playwright',
});

/** The scrub pattern owned by the harness; mirrored here so we never inject a doomed name. */
export const SCRUB_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

/**
 * PRD §3.2 AI-toolchain signatures used by the session-window attribution heuristic:
 * a file whose name matches one of these, created while a dsh task was active, is
 * treated as a dsh escape even when handle-based attribution is unavailable.
 */
export const DEFAULT_AI_SIGNATURES = Object.freeze([
  'tmp*',
  'tmp-*',
  'pip-*',
  'uv-*',
  'playwright*',
  'node-*',
  'npm-*',
  'hf-*',
  'torch*',
  '*-cache',
  '*.pyc',
  '*.log',
  '*.tmp',
  '*.bak',
]);

/** PRD §6.2 hard-coded system protection blacklist. Duplicated in classifier.js as a second line of defence. */
const SYSTEM_PROTECT = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];

/** PRD §3.2 gate modes. Anything else resolves to `enforce` (fail-CLOSED, see resolveConfig). */
export const NOISE_GATE_MODES = Object.freeze(new Set(['enforce', 'audit', 'off']));

/** Minimal sink so every module can be exercised standalone, without a harness logger. */
export const NOOP_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/**
 * Strip a trailing separator while preserving a bare drive root (`E:` stays `E:`).
 * @param {string} p - path fragment.
 * @returns {string} the fragment without a trailing separator.
 */
function trimTrailingSep(p) {
  return p.length > 2 ? p.replace(/[\\/]+$/, '') : p;
}

/**
 * Accept only a usable path; anything else becomes `null` for the caller to drop.
 *
 * A malformed *configuration* must fail SOFT, not crash `resolveConfig`: this is a documented
 * public export whose own JSDoc promises untrusted input is tolerated (tests call it directly,
 * and the Cordis `Config` schema only guards the activation path). PRD §6.2 protection still
 * fails CLOSED elsewhere — the classifier keeps an independent hard-coded blacklist — so
 * repairing bad config here can never widen what may be deleted.
 *
 * @param {unknown} value - candidate path.
 * @returns {string|null} resolved absolute path, or null when unusable.
 */
function safePath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    return path.resolve(trimmed);
  } catch {
    return null;
  }
}

/**
 * Coerce a user-supplied list of paths into resolved, de-duplicated strings.
 * Non-strings and blanks are dropped; a non-array returns null so the caller can use defaults.
 * @param {unknown} value - candidate list.
 * @returns {string[]|null} resolved paths, or null when the input is not a list.
 */
function safePathList(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const p = safePath(item);
    if (p === null) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimTrailingSep(p));
  }
  return out.length > 0 ? out : null;
}

/**
 * Coerce a list of non-empty strings (glob patterns, directory names), dropping everything else.
 * @param {unknown} value - candidate list.
 * @returns {string[]|null} cleaned list, or null when nothing usable remains.
 */
function safeStringList(value) {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v) => typeof v === 'string' && v.trim().length > 0);
  return out.length > 0 ? out : null;
}

/**
 * Accept a finite number at or above `min`, else the fallback. Mirrors the floors the
 * Cordis `Config` schema documents, so a value the schema would reject cannot reach the
 * watcher as a negative timer or a zero-sized batch.
 * @param {unknown} value - candidate number.
 * @param {number} fallback - value to use when unusable.
 * @param {number} [min] - inclusive lower bound.
 * @returns {number} the value or the fallback.
 */
function safeNumber(value, fallback, min = 0) {
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * Accept a plain object of `string -> string`; anything else is ignored wholesale.
 *
 * Spreading an unvalidated value would inject junk: a string `"nope"` spreads to
 * `{0:'n',1:'o',2:'p',3:'e'}` — environment variables literally named `0`..`3`.
 * @param {unknown} value - candidate map.
 * @returns {Record<string,string>|null} cleaned map, or null when nothing usable remains.
 */
function safeEnvMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k === 'string' && k.length > 0 && typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Normalise one user-supplied watch entry into the full internal shape.
 *
 * Accepts the documented `{path, recursive, maxDepth}` object and ALSO a bare path string, because
 * a bare string is the natural mistake to make in a hand-written config and crashing the whole
 * plugin over it would be worse than accepting it.
 *
 * @param {{path?: string, recursive?: boolean, maxDepth?: number}|string} entry - raw entry.
 * @returns {{path: string, recursive: boolean, maxDepth: number}|null} normalised entry, or null.
 */
function normaliseWatchDir(entry) {
  const source = typeof entry === 'string' ? { path: entry } : entry;
  const resolved = source && typeof source === 'object' ? safePath(source.path) : null;
  if (resolved === null) return null;
  return {
    path: resolved,
    recursive: source.recursive === true,
    maxDepth: Number.isFinite(source.maxDepth) ? source.maxDepth : 1,
  };
}

/**
 * Resolve the effective configuration from user overrides and the ambient environment.
 *
 * @param {object} [raw] - user config (already validated by the Cordis `Config` schema at
 *   activation, but treated as untrusted here because tests call this directly).
 * @param {NodeJS.ProcessEnv} [env] - environment to read defaults from; injectable for tests.
 * @returns {object} the frozen ResolvedConfig described in CONTRACTS.md §3.
 */
export function resolveConfig(raw = {}, env = process.env) {
  // Fail soft on a wholly malformed argument rather than throwing a TypeError on property access.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  if (!env || typeof env !== 'object') env = process.env;

  const isWindows = process.platform === 'win32';
  const home =
    (typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim()) ||
    (typeof env.HOME === 'string' && env.HOME.trim()) ||
    os.homedir();

  const dshHome = safePath(raw.dshHome) || safePath(env.DSH_HOME) || path.join(home, '.dsh');

  // PRD §3.1: the escape root lives on the same drive as $DSH_HOME, so it never lands on C:.
  const driveRoot = path.parse(dshHome).root;
  const escapeRoot = safePath(raw.escapeRoot) || path.join(driveRoot, 'dsh_escape_cache');

  // PRD §5: state.db sits under $DSH_HOME/plugins/c_cleaner so it does not occupy C: either.
  const stateDir = safePath(raw.stateDir) || path.join(dshHome, 'plugins', 'c_cleaner');
  const dbPath = safePath(raw.dbPath) || path.join(stateDir, 'state.db');

  const localAppData = safePath(env.LOCALAPPDATA) || path.join(home, 'AppData', 'Local');
  const roamingAppData = safePath(env.APPDATA) || path.join(home, 'AppData', 'Roaming');

  // PRD §6.1 -- only `%LOCALAPPDATA%\Temp` is watched recursively. The AppData roots are
  // watched non-recursively (depth 1) purely to catch newly created toolchain folders;
  // a recursive watch there would burn CPU for no gain.
  //
  // `undefined`/`null` means "unset" -> defaults. An explicit array is honoured as given,
  // including an empty one: naming no watch directory is a deliberate and observable choice
  // (logged as "watching 0 director(ies)"), never a silent fallback to a surprising default.
  const watchDirs =
    raw.watchDirs === undefined || raw.watchDirs === null
      ? [
          { path: path.join(localAppData, 'Temp'), recursive: true, maxDepth: 3 },
          { path: localAppData, recursive: false, maxDepth: 1 },
          { path: roamingAppData, recursive: false, maxDepth: 1 },
        ]
          .map(normaliseWatchDir)
          .filter(Boolean)
      : (Array.isArray(raw.watchDirs) ? raw.watchDirs.map(normaliseWatchDir).filter(Boolean) : []);

  // PRD §6.2. Desktop/Documents are included because a mis-scoped rule could otherwise
  // wander into user data. The escape root and state dir are added so the cleaner can
  // never delete its own storage.
  const protectRoots =
    safePathList(raw.protectRoots) ||
    [
      ...SYSTEM_PROTECT,
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      path.join(home, 'OneDrive', 'Desktop'),
      path.join(home, 'OneDrive', 'Documents'),
      escapeRoot,
      stateDir,
    ]
      .map((p) => safePath(p))
      .filter(Boolean)
      .map(trimTrailingSep);

  const envMap = { ...DEFAULT_ENV_MAP, ...(safeEnvMap(raw.envMap) || {}) };
  const signatureGlobs = safeStringList(raw.aiSignatureGlobs) || [...DEFAULT_AI_SIGNATURES];

  // PRD §3.2 noise gate (Phase 2). Fail-CLOSED: anything that is not a recognised mode keeps
  // the gate on, because silently reverting to "record every file in %TEMP%" is the defect
  // this phase exists to fix.
  const noiseGate = NOISE_GATE_MODES.has(raw.noiseGate) ? raw.noiseGate : 'enforce';

  return Object.freeze({
    enabled: raw.enabled !== false,
    isWindows,
    dshHome,
    escapeRoot,
    stateDir,
    dbPath,
    envMap,
    watchDirs,
    protectRoots,
    // PRD §3.2: dsh's own home must never be reported as an escape, wherever it lives.
    excludeNames: safeStringList(raw.excludeNames) || ['.dsh'],
    aiSignatureGlobs: signatureGlobs,
    /** Alias kept so either name resolves to the same list (see CONTRACTS.md §3). */
    excludeGlobs: signatureGlobs,
    debounceMs: safeNumber(raw.debounceMs, 3000, 0),
    pollIntervalMs: safeNumber(raw.pollIntervalMs, 5000, 250),
    sessionWindowMs: safeNumber(raw.sessionWindowMs, 30 * 60 * 1000, 0),
    /** PRD §3.4: recycle bin is the default disposition; `--force` overrides per invocation. */
    useRecycleBin: raw.useRecycleBin !== false,
    maxBatch: safeNumber(raw.maxBatch, 50, 1),
    /**
     * PRD §7 Phase 3: silent clean when a session ends (the `post_session_close` hook).
     * OFF by default — it deletes files without any user action, so it must be an explicit
     * opt-in, never a default a user discovers by losing data.
     */
    autoClean: raw.autoClean === true,

    /* ----------------------- Phase 3: junction migration ---------------------- */

    /**
     * Where `mklink /J` migrations land. `null` derives `E:\dsh_escape_cache\migrated` from the
     * escape root, i.e. the same non-C: volume PRD §3.1 already proved writable at startup.
     * Must be on a DIFFERENT volume from the source or the migration is refused as pointless.
     */
    migrateTargetRoot: safePath(raw.migrateTargetRoot) || null,
    /**
     * Re-measure the copied tree before deleting the source. Kept on: it is the only thing that
     * licenses deleting the original after a cross-volume copy, and it costs one `stat` per file
     * on a path the user invoked deliberately. Only an operator who trusts their volume shadowing
     * should turn it off (`migrateVerify: false`).
     */
    migrateVerify: raw.migrateVerify !== false,
    /** Stubborn directories smaller than this are not offered for migration (default 10 MB). */
    migrateMinBytes: safeNumber(raw.migrateMinBytes, 10 * 1024 * 1024, 0),

    /* ------------------- Phase 3: post_session_close hook -------------------- */

    /**
     * The `post_session_close` silent clean. Runs `clean()` against SAFE_TO_DELETE rows when a
     * dsh session is disposed. Deliberately slow-gated: it is a background sweep, not a
     * responsive action, and PRD §6.1 caps peak CPU.
     */
    sessionCloseClean: raw.sessionCloseClean === true,
    /** Ignore a session that was alive for less than this (avoids sweeping on every probe). */
    sessionCloseMinAgeMs: safeNumber(raw.sessionCloseMinAgeMs, 60000, 0),
    /**
     * PRD §3.3 asks the 🔴 tier to name the holding process. Resolving that needs the Windows
     * Restart Manager (see lib/lock-owner.js); it costs nothing until a file is genuinely
     * locked, so it is on by default and switched off here if that ever proves wrong.
     */
    resolveLockOwner: raw.resolveLockOwner !== false,
    /** PRD §3.2: `enforce` drops non-attributable files, `audit` only counts them, `off` disables. */
    noiseGate,
    /**
     * PRD §3.2 vs §3.3: a basename that looks like a credential/store (`.db`, `auth`, `token`,
     * `config`, `.lock`, …) is ALWAYS admitted, so the gate can never noise-filter away an
     * artifact §3.3 orders us to surface as 🔴. Safety beats noise reduction.
     */
    admitCriticalNames: raw.admitCriticalNames !== false,
    /**
     * PRD rule #1 (handle reverse-lookup) is implemented in lib/handle-index.js through the
     * optional `handleProbe` seam. It is OFF by default: a measured sweep of the dsh tree
     * (11 members, `open_files()` each) costs ~2.0 s of CPU, which alone would blow the
     * PRD §6.1 marginal-CPU budget (< 2 %) when repeated. Rule #2 carries the gate instead.
     */
    handleIndex: raw.handleIndex === true,
    handleSweepMs: safeNumber(raw.handleSweepMs, 60000, 15000),
    /** `null` = resolve `python` from PATH (measured: E:\conda\python.exe, psutil 7.0.0). */
    pythonPath: safePath(raw.pythonPath) || null,
    /**
     * `dsh-client-modules` caches the parsed `dsh.client` declaration forever, so a manifest
     * that gained one after boot never reaches the browser bundle graph. lib/client-graph.js
     * recovers it in-process; set false to require a restart instead.
     */
    recoverClientGraph: raw.recoverClientGraph !== false,
    /**
     * Windows directory-buffer OVERFLOW recovery. `ReadDirectoryChangesW` uses a finite buffer:
     * measured on this host, a 600-file burst into one directory delivered only ~418 named
     * events to a BARE `fs.watch`, so the loss is below us and cannot be fixed by any filtering
     * change. libuv announces the overflow as a change event with a NULL filename; lib/watcher.js
     * turns that into one bounded, cooled-down directory rescan.
     */
    rescanOnOverflow: raw.rescanOnOverflow !== false,
    /** Minimum gap between overflow rescans of the SAME directory, so a storm of null events
     *  cannot become a storm of scans. `safeNumber(value, fallback, min=0)` returns the FALLBACK
     *  below the floor -- it does not clamp up. */
    rescanCooldownMs: safeNumber(raw.rescanCooldownMs, 10000, 0),
    /** Quiet period before an overflow rescan runs. Must exceed the write burst, otherwise the
     *  walk sees a half-populated directory (measured: 120 of 600 files) and the cooldown then
     *  blocks every later overflow signal, losing the rest. */
    rescanSettleMs: safeNumber(raw.rescanSettleMs, 5000, 0),
    /** Hard cap on files examined by one rescan, so a huge tree cannot stall the walk. */
    rescanMaxFiles: safeNumber(raw.rescanMaxFiles, 5000, 1),
  });
}

/**
 * Humanise a byte count for terminal output (PRD §4 `status` line).
 * @param {number} bytes - size in bytes.
 * @returns {string} e.g. `342.0 MB`, `1.2 GB`, `0 B`.
 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
