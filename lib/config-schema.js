/**
 * `Config` — the Standard Schema the Cordis loader validates user config against.
 *
 * WHY HAND-ROLLED INSTEAD OF SCHEMASTRY
 * -------------------------------------
 * `cordis/lib/index.js:956-962` (`resolveConfig`) only requires an object shaped like
 * Standard Schema v1:
 *
 *     if (!runtime.Config) return config;
 *     const result = runtime.Config['~standard'].validate(config);
 *     if ('then' in result) throw new TypeError('Async config validation is not supported');
 *     if (result.issues) throw new ValidationError(result.issues);
 *     else return result.value;
 *
 * Verified against the installed schemastery: `S['~standard'].validate({b:'hi'})` returns
 * `{ value: { a: true, b: 'hi' } }` — a plain synchronous `{value}` / `{issues}` union.
 * That is the entire contract, so this module implements it directly.
 *
 * The reason is load-order resilience, not NIH: a plugin that statically imports a package
 * which is hoisted inconsistently (schemastery lives under `@deepseek-ai/`, resolved from
 * `$DSH_PROFILE_DIR/node_modules`, and the install target is not fixed at authoring time)
 * fails to load *entirely* — the whole plugin disappears over a missing optional nicety.
 * A zero-dependency validator cannot fail that way, and it still gives exact, typed errors.
 *
 * @module dsh-c-cleaner/lib/config-schema
 */

import { DEFAULT_ENV_MAP } from './config.js';

/**
 * @typedef {{ ok:true, value:any } | { ok:false, issues:Array<{message:string, path?:Array<string|number>}> }} ValidationResult
 */

/**
 * Validate `value` against one field description and return the parsed value.
 * @param {*} value - raw input.
 * @param {object} spec - `{ type, default, items, values, enum, min }`.
 * @param {string} key - field name, used in the error path.
 * @param {Array<{message:string, path?:Array<string|number>}>} issues - collector.
 * @returns {*} the parsed value (or `undefined`, with an issue appended).
 */
function parseField(value, spec, key, issues) {
  if (value === undefined || value === null) {
    if (spec.default !== undefined) return spec.default;
    return undefined; // optional: resolveConfig() supplies the real default
  }

  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        issues.push({ message: `expected boolean, got ${typeof value}`, path: [key] });
        return undefined;
      }
      return value;

    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ message: `expected a finite number, got ${typeof value}`, path: [key] });
        return undefined;
      }
      if (spec.min !== undefined && value < spec.min) {
        issues.push({ message: `expected >= ${spec.min}, got ${value}`, path: [key] });
        return undefined;
      }
      return value;

    case 'string':
      if (typeof value !== 'string') {
        issues.push({ message: `expected string, got ${typeof value}`, path: [key] });
        return undefined;
      }
      return value;

    case 'enum':
      // A recognised key carrying an unrecognised value is refused LOUDLY rather than
      // silently downgraded: a typo in `noiseGate` must not decide on its own whether the
      // PRD §3.2 gate runs. (resolveConfig separately fails CLOSED for programmatic callers.)
      if (!Array.isArray(spec.enum) || !spec.enum.includes(value)) {
        issues.push({
          message: `expected one of ${Array.isArray(spec.enum) ? spec.enum.join(' | ') : '(none)'}, got ${JSON.stringify(value)}`,
          path: [key],
        });
        return undefined;
      }
      return value;

    case 'array': {
      if (!Array.isArray(value)) {
        issues.push({ message: `expected an array, got ${typeof value}`, path: [key] });
        return undefined;
      }
      if (!spec.items) return value;
      const out = [];
      for (let i = 0; i < value.length; i += 1) {
        const parsed = parseField(value[i], spec.items, String(i), issues);
        // Two distinct outcomes here, both measured against the current code:
        //   - `null` / `undefined` element -> parsed is undefined with NO issue, so it is
        //     simply dropped. A YAML `- ` artifact must not cost the user their config.
        //   - element of the wrong TYPE -> `parseField` records an issue, and `validate`
        //     below returns `{issues}`, which makes cordis refuse the whole row. That is
        //     the intended, fail-CLOSED outcome: a typo'd `watchDirs` entry stops the
        //     plugin from loading at all, so it cannot delete anything either. Loud beats
        //     silently watching fewer directories than the user believes.
        // `resolveConfig` separately tolerates these shapes for direct programmatic
        // callers (see lib/config.js), which is why the two layers differ.
        if (parsed !== undefined) out.push(parsed);
      }
      return out;
    }

    case 'record': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ message: `expected an object, got ${Array.isArray(value) ? 'array' : typeof value}`, path: [key] });
        return undefined;
      }
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const parsed = spec.values ? parseField(v, spec.values, k, issues) : v;
        if (parsed !== undefined) out[k] = parsed;
      }
      return out;
    }

    default:
      return value;
  }
}

/** Field definitions. `default` here mirrors `resolveConfig`; `undefined` means "derived at runtime". */
export const FIELDS = Object.freeze({
  enabled: { type: 'boolean', default: true },
  dshHome: { type: 'string' },
  escapeRoot: { type: 'string' },
  stateDir: { type: 'string' },
  dbPath: { type: 'string' },
  envMap: { type: 'record', values: { type: 'string' } },
  watchDirs: {
    type: 'array',
    items: { type: 'record' },
  },
  protectRoots: { type: 'array', items: { type: 'string' } },
  excludeNames: { type: 'array', items: { type: 'string' } },
  aiSignatureGlobs: { type: 'array', items: { type: 'string' } },
  debounceMs: { type: 'number', default: 3000, min: 0 },
  pollIntervalMs: { type: 'number', default: 5000, min: 250 },
  sessionWindowMs: { type: 'number', default: 30 * 60 * 1000, min: 0 },
  useRecycleBin: { type: 'boolean', default: true },
  maxBatch: { type: 'number', default: 50, min: 1 },
  autoClean: { type: 'boolean', default: false },
  resolveLockOwner: { type: 'boolean', default: true },
  noiseGate: { type: 'enum', enum: ['enforce', 'audit', 'off'], default: 'enforce' },
  admitCriticalNames: { type: 'boolean', default: true },
  handleIndex: { type: 'boolean', default: false },
  handleSweepMs: { type: 'number', default: 60000, min: 15000 },
  pythonPath: { type: 'string' },
  recoverClientGraph: { type: 'boolean', default: true },
  rescanOnOverflow: { type: 'boolean', default: true },
  rescanCooldownMs: { type: 'number', default: 10000, min: 0 },
  rescanSettleMs: { type: 'number', default: 5000, min: 0 },
  rescanMaxFiles: { type: 'number', default: 5000, min: 1 },
  migrateTargetRoot: { type: 'string' },
  migrateVerify: { type: 'boolean', default: true },
  migrateMinBytes: { type: 'number', default: 10 * 1024 * 1024, min: 0 },
  sessionCloseClean: { type: 'boolean', default: false },
  sessionCloseMinAgeMs: { type: 'number', default: 60000, min: 0 },
});

/**
 * The config schema handed to Cordis. Shaped as Standard Schema v1 so
 * `cordis/lib/index.js:956` can validate it without any dependency of ours.
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-c-cleaner',
    /**
     * Synchronous validation. Unknown keys are passed through untouched (see the loop below);
     * a recognised key of the wrong type produces `{issues}` and makes cordis refuse the row.
     * @param {*} value - raw user config from the profile's cordis patch.
     * @returns {ValidationResult}
     */
    validate(value) {
      if (value === undefined || value === null) return { value: {} };
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: `c-cleaner config must be an object, got ${Array.isArray(value) ? 'array' : typeof value}` }] };
      }

      /** @type {Array<{message:string, path?:Array<string|number>}>} */
      const issues = [];
      /** @type {Record<string, *>} */
      const out = {};

      for (const [key, raw] of Object.entries(value)) {
        const spec = FIELDS[key];
        if (!spec) {
          // Unknown key: keep it. `resolveConfig` ignores what it does not read, and
          // silently discarding a user's typo'd-but-meaningful key would be worse than
          // passing it through.
          out[key] = raw;
          continue;
        }
        const parsed = parseField(raw, spec, key, issues);
        if (parsed !== undefined) out[key] = parsed;
      }

      if (issues.length > 0) return { issues };
      return { value: out };
    },
  }),
  /** Human-facing field metadata; also what a profile UI would render. */
  meta: Object.freeze({
    enabled: { description: '总开关 (false 时插件不劫持环境变量、不启动监测)' },
    dshHome: { description: '覆盖 $DSH_HOME；逃逸根目录所在盘由此推导' },
    escapeRoot: { description: '逃逸缓存根目录，默认 "<DSH_HOME 所在盘>:\\dsh_escape_cache"' },
    stateDir: { description: '状态目录，默认 "$DSH_HOME/plugins/c_cleaner"' },
    dbPath: { description: 'SQLite 路径，默认 "<stateDir>/state.db"' },
    envMap: { description: `环境变量 -> 逃逸根下的子目录；默认 ${Object.keys(DEFAULT_ENV_MAP).join(', ')}` },
    watchDirs: { description: '监测目录 [{path,recursive,maxDepth}]；默认 %LOCALAPPDATA%\\Temp (递归) + 两个 AppData 根 (深度 1)' },
    protectRoots: { description: '保护根目录，永不被删除；默认 C:\\Windows、Program Files、Desktop、Documents' },
    excludeNames: { description: '路径中出现的排除段名，默认 [".dsh"]' },
    aiSignatureGlobs: { description: 'AI 工具链文件名特征，用于会话窗口归属判定' },
    debounceMs: { description: '监测防抖毫秒数，默认 3000' },
    pollIntervalMs: { description: '进程树轮询间隔毫秒数，默认 5000' },
    sessionWindowMs: { description: '会话窗口毫秒数，默认 1800000 (30 分钟)' },
    useRecycleBin: { description: '默认走回收站而非物理删除，默认 true' },
    maxBatch: { description: '单次 PowerShell 回收站调用上限，默认 50' },
    autoClean: { description: '⚠️ 自动清理 SAFE_TO_DELETE 项，默认 false' },
    resolveLockOwner: { description: '用 Windows 重启管理器解析占用进程名+PID (PRD 3.3)，默认 true' },
    noiseGate: { description: 'PRD 3.2 噪音过滤：enforce 丢弃非 dsh 归属文件（默认），audit 只计数，off 关闭' },
    admitCriticalNames: { description: '凭证/库文件名（auth、token、config、.db、.lock…）永远收录，绝不会被噪音过滤掉，默认 true' },
    handleIndex: { description: '⚠️ 启用 psutil 句柄反查（PRD 3.2 规则 1）；实测每轮约 2 秒 CPU，默认 false' },
    handleSweepMs: { description: '句柄索引扫描间隔毫秒数，默认 60000' },
    pythonPath: { description: 'python 解释器路径；留空则从 PATH 解析（实测 E:\\conda\\python.exe）' },
    recoverClientGraph: { description: '在进程内恢复 dsh-client-modules 缓存的客户端 bundle（Phase 2 面板），默认 true' },
    rescanOnOverflow: { description: 'Windows 目录缓冲区溢出时触发一次有界重扫以找回漏掉的文件，默认 true' },
    rescanCooldownMs: { description: '同一目录两次溢出重扫的最小间隔毫秒数，默认 10000' },
    rescanSettleMs: { description: '溢出后等待目录静默多久才重扫，默认 5000（须长于写入突发）' },
    rescanMaxFiles: { description: '单次溢出重扫最多检查的文件数，默认 5000' },
    migrateTargetRoot: { description: 'PRD Phase 3 软链接迁移目标目录；留空则由逃逸根推导 <escapeRoot>\\migrated（必须在非 C 盘）' },
    migrateVerify: { description: '跨卷复制后逐文件复核再删除源目录，默认 true（关掉会失去删除源目录的依据）' },
    migrateMinBytes: { description: '低于该大小的目录不提供迁移，默认 10 MB' },
    sessionCloseClean: { description: '⚠️ PRD Phase 3 会话结束自动静默清理 (post_session_close)，默认 false' },
    sessionCloseMinAgeMs: { description: '会话存活时长低于该值则跳过自动清理，默认 60000' },
  }),
});

export default Config;
