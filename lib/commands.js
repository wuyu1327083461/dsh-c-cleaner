/**
 * lib/commands.js — the `c-clean` slash command for dsh-c-cleaner.
 *
 * Implements CONTRACTS.md §10 (frozen signature).
 *
 * Registration contract read from the LIVE host runtime via
 * `cordis_inspect_query` (platform:'host', provider:'Service', method:'listService',
 * input {service:'commands'}) and from the installed declarations at
 * `@deepseek-ai/dsh-commands/lib/types/index.d.ts`:
 *
 *   CommandRuntime.register(definition: CommandDefinition): () => void
 *     -> "the exact effect disposer that unregisters this definition."
 *
 *   CommandDefinition = {
 *     readonly definitionId?: CommandDefinitionId;
 *     readonly name: string;             // lowercase, without the leading slash
 *     readonly description: string;
 *     readonly input?: CommandInputDescriptor;   // { hint: string, attachments?: boolean }
 *     readonly recordInput?: boolean;
 *     readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
 *   }
 *   CommandInvocation = { commandId, agent, rawInput, attachments, signal }
 *   CommandResult = { kind:'success', text?, sourceEventSeq? } | { kind:'error', text:string }
 *
 * Only those documented fields are used below: `name`, `description`, `input.hint`,
 * `handler`. No `definitionId` (this command has no identity-based client behavior)
 * and no `recordInput` (the default `true` is what we want — the invocation text is
 * the command's whole payload).
 */

/** Usage text shown for unknown or malformed input. */
export const USAGE = [
  'c-clean — C 盘逃逸缓存清理',
  '',
  '用法:',
  '  /c-clean status            查看监控摘要（只读，不扫描磁盘）',
  '  /c-clean now               清理 🟢 可安全删除（移入回收站）',
  '  /c-clean now --deep        同时清理 🟡 需确认/缓存',
  '  /c-clean now --force       不经过回收站，直接物理删除',
  '',
  '  --deep 与 --force 可组合: /c-clean now --deep --force',
].join('\n');

const STATUS_USAGE = '用法: /c-clean status | /c-clean now [--deep] [--force]';

/**
 * Humanise a byte count. Bytes and KB are integers; MB and above carry one
 * decimal, matching the PRD §4 sample line (`342 MB`, `1.2 GB`).
 * @param {number} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';

  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const TB = GB * 1024;

  if (n < KB) return `${Math.round(n)} B`;
  if (n < MB) return `${Math.round(n / KB)} KB`;
  if (n < GB) return `${(n / MB).toFixed(1)} MB`;
  if (n < TB) return `${(n / GB).toFixed(1)} GB`;
  return `${(n / TB).toFixed(1)} TB`;
}

/**
 * The exact one-line status format from CONTRACTS §10 / PRD §4.
 * @param {{SAFE:{count:number,bytes:number}, CAUTION:{count:number,bytes:number},
 *          LOCKED:{count:number,bytes:number}}} summary
 * @returns {string}
 */
export function renderStatusLine(summary) {
  const safe = summary?.SAFE ?? { count: 0, bytes: 0 };
  const caution = summary?.CAUTION ?? { count: 0, bytes: 0 };
  const locked = summary?.LOCKED ?? { count: 0, bytes: 0 };
  return (
    `🟢 可清理: ${formatSize(safe.bytes)} (${safe.count}个文件)` +
    ` | 🟡 缓存驻留: ${formatSize(caution.bytes)}` +
    ` | 🔴 正在占用: ${locked.count}个文件`
  );
}

/**
 * Parse the invocation's raw text against the frozen grammar:
 * `status` | `now` | `now --deep` | `now --force` | `now --deep --force`.
 * @param {string} rawInput exact text following the command name
 * @returns {{ ok:true, verb:'status'|'now', deep:boolean, force:boolean }
 *          | { ok:false, code:string }}
 */
export function parseArgs(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : '';
  const tokens = text.length === 0 ? [] : text.split(/\s+/);
  if (tokens.length === 0) return { ok: false, code: 'EMPTY' };

  const verb = tokens[0].toLowerCase();

  if (verb === 'status') {
    if (tokens.length !== 1) return { ok: false, code: 'STATUS_EXTRA_ARGS' };
    return { ok: true, verb: 'status', deep: false, force: false };
  }

  if (verb === 'now') {
    let deep = false;
    let force = false;
    for (const token of tokens.slice(1)) {
      const flag = token.toLowerCase();
      if (flag === '--deep') {
        if (deep) return { ok: false, code: 'DUPLICATE_FLAG' };
        deep = true;
      } else if (flag === '--force') {
        if (force) return { ok: false, code: 'DUPLICATE_FLAG' };
        force = true;
      } else {
        return { ok: false, code: 'UNKNOWN_FLAG' };
      }
    }
    return { ok: true, verb: 'now', deep, force };
  }

  return { ok: false, code: 'UNKNOWN_VERB' };
}

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Register the single `c-clean` command.
 * @param {{ commands: { register(def:object): () => void } }} ctx
 * @param {object} deps
 * @param {object} [deps.cfg]        ResolvedConfig (CONTRACTS §3)
 * @param {object} [deps.log]        { debug, info, warn, error }
 * @param {object} deps.db           StateDB (CONTRACTS §9) — used by `status`
 * @param {object} [deps.hijacker]   EnvHijacker (CONTRACTS §4) — used by `status`
 * @param {object} [deps.tree]       ProcessTree (CONTRACTS §5)
 * @param {object} [deps.watcher]    CWatcher (CONTRACTS §6)
 * @param {() => Promise<void>} [deps.refresh]  re-stat / refresh process tree
 * @param {() => Promise<Array>} [deps.collect] returns Classified[] (CONTRACTS §2)
 * @param {Function} [deps.clean]    test seam: overrides the lazy `./cleaner.js` import
 * @returns {() => void} the disposer that unregisters the command
 */
export function registerCommands(ctx, deps = {}) {
  if (!ctx || !ctx.commands || typeof ctx.commands.register !== 'function') {
    throw new TypeError('registerCommands: ctx.commands.register is required');
  }

  const log = deps.log ?? noopLog;
  /** @type {Promise<any>|null} */
  let cleanerPromise = null;
  let busy = false;

  /** Lazy, cached `./cleaner.js` import so status stays cheap and load order stays free. */
  function loadCleaner() {
    if (deps.clean) return Promise.resolve({ clean: deps.clean });
    if (cleanerPromise === null) {
      cleanerPromise = import('./cleaner.js').catch((error) => {
        cleanerPromise = null; // allow a retry on the next invocation
        throw error;
      });
    }
    return cleanerPromise;
  }

  /** status: read-only and cheap — db.summary() + hijacker.status(), nothing else. */
  function runStatus() {
    const summary = deps.db.summary();
    const line = renderStatusLine(summary);

    let hijack = null;
    if (deps.hijacker && typeof deps.hijacker.status === 'function') {
      try {
        hijack = deps.hijacker.status();
      } catch (error) {
        log.warn?.(`c-clean status: hijacker.status() failed: ${error?.message ?? error}`);
      }
    }

    if (!hijack) return { kind: 'success', text: line };

    const applied = Array.isArray(hijack.entries) ? hijack.entries.filter((e) => e.ok).length : 0;
    const total = Array.isArray(hijack.entries) ? hijack.entries.length : 0;
    const state = hijack.installed ? `✅ 已生效 (${applied}/${total} 变量)` : '⚠️ 未生效';
    return { kind: 'success', text: `${line}\n环境变量劫持: ${state} → ${hijack.escapeRoot ?? 'n/a'}` };
  }

  /** now: re-stat, collect, clean. */
  async function runNow({ deep, force }) {
    const cfg = deps.cfg ?? {};

    if (typeof deps.refresh === 'function') {
      try {
        await deps.refresh();
      } catch (error) {
        log.warn?.(`c-clean: refresh() failed: ${error?.message ?? error}`);
      }
    }

    if (typeof deps.collect !== 'function') {
      return { kind: 'error', text: 'c-clean now: deps.collect() is not wired yet.\n\n' + STATUS_USAGE };
    }

    const records = (await deps.collect()) ?? [];
    const { clean } = await loadCleaner();
    if (typeof clean !== 'function') {
      throw new TypeError('c-clean now: ./cleaner.js does not export clean()');
    }

    const report = await clean(records, { deep, force, cfg, log });
    const removed = Number(report?.removed ?? 0);
    const skipped = Number(report?.skipped ?? 0);
    const freed = Number(report?.bytesFreed ?? 0);
    const errors = Array.isArray(report?.errors) ? report.errors : [];
    const target = force ? '物理删除' : '移入回收站';

    const header =
      `🧹 c-clean now ${deep ? '--deep ' : ''}${force ? '--force' : ''}`.trimEnd() +
      ` (${target})`;
    const body =
      `释放: ${formatSize(freed)} | 已删除: ${removed} | 跳过: ${skipped} | 错误: ${errors.length}`;
    const detail = errors
      .slice(0, 5)
      .map((e) => `  ⚠️ ${e?.path ?? '?'} — ${e?.code ?? 'ERROR'}`)
      .join('\n');

    return {
      kind: 'success',
      text: detail.length > 0 ? `${header}\n${body}\n${detail}` : `${header}\n${body}`,
    };
  }

  /** The handler never throws into the command runtime. */
  async function handler(invocation) {
    try {
      if (invocation?.signal?.aborted) {
        return { kind: 'error', text: 'c-clean: 已取消' };
      }

      const parsed = parseArgs(invocation?.rawInput);
      if (!parsed.ok) {
        return { kind: 'error', text: `未知参数 (${parsed.code})\n\n${USAGE}` };
      }

      if (parsed.verb === 'status') {
        return runStatus();
      }

      if (busy) {
        return { kind: 'error', text: 'c-clean now: 上一次清理仍在进行中，请稍后重试。' };
      }
      busy = true;
      try {
        return await runNow(parsed);
      } finally {
        busy = false;
      }
    } catch (error) {
      const message = error?.stack ?? error?.message ?? String(error);
      log.error?.(`c-clean handler failed: ${message}`);
      return { kind: 'error', text: `c-clean 执行失败: ${error?.message ?? message}` };
    }
  }

  const disposer = ctx.commands.register({
    name: 'c-clean',
    description: 'C 盘逃逸缓存清理：status 查看摘要，now [--deep] [--force] 执行清理',
    input: { hint: 'status | now [--deep] [--force]' },
    handler,
  });

  log.info?.('c-clean command registered');

  if (typeof disposer !== 'function') {
    throw new TypeError('registerCommands: ctx.commands.register() did not return a disposer');
  }
  return disposer;
}

export default registerCommands;
