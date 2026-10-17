/**
 * Client half of the c-cleaner bundle (PRD 4, `dsh c-clean ui`).
 *
 * The PRD asked for a Textual TUI. A slash command cannot take over the terminal, so the
 * panel lives where the harness actually renders UI: the Harness Web UI sidebar. This file
 * registers two things and nothing else:
 *
 *   1. `sidebar.panellist` — the sidebar row (icon + label) whose id addresses a main panel.
 *   2. `main` (keyed by the same id) — the full central panel: the env-hijack status line,
 *      the three-tier table, and the one-click clean buttons.
 *
 * Everything the panel needs from the host comes over one fenced JSON route
 * (`/c-cleaner/api/*`, see `lib/web-api.js`). The plugin deliberately does NOT require
 * `@deepseek-ai/dsh-client-ui-primitives`: a plain-JS plugin has no type check, those
 * packages change without notice, and a throwing component would blank the slot entry. The
 * controls below are written locally and styled only with `--dsw-alias-*` theme tokens, so a
 * renamed token degrades appearance instead of breaking rendering.
 *
 * Kept free of side effects at factory time: every registration happens inside `apply`.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-c-cleaner',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    /** Sidebar/dock id; the `main` panel key must match it or the row selects nothing. */
    const PANEL_ID = 'c-cleaner';

    // --- prefix-safe host routes ------------------------------------------------
    // Copied from the recipe in `dsh-better-sidebar/lib/client.js` (host-route-url):
    // a leading slash pins the URL to the ORIGIN ROOT, which breaks a GUI served
    // under a reverse-proxy directory. Resolving a RELATIVE path against the PAGE's
    // own base keeps the request under the page's own prefix — and in the Electron
    // shell it is also what keeps the request same-origin (the shell's protocol
    // handler forwards non-static `dsh-app://app` paths to the Host, while the
    // injected `streamBaseUrl` is a DIFFERENT origin and the routes answer no CORS
    // headers, so a cross-origin fetch would fail outright).
    const PLACEHOLDER_ORIGIN = 'http://dsh.internal/';

    function hostTransportBase() {
      const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl;
      if (base !== undefined && base !== '') return base;
      return typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : '';
    }

    function hostHttpBase() {
      const base = typeof document !== 'undefined' ? document.baseURI : undefined;
      if (typeof base === 'string' && base !== '') return base;
      return hostTransportBase();
    }

    function directoryBase(baseUrl) {
      const url = new URL(baseUrl === '' ? PLACEHOLDER_ORIGIN : baseUrl, PLACEHOLDER_ORIGIN);
      url.search = '';
      url.hash = '';
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return url.href;
    }

    function hostRouteUrl(path, baseUrl = hostHttpBase()) {
      return new URL(path.replace(/^\/+/, ''), directoryBase(baseUrl));
    }

    const API = 'c-cleaner/api';

    // --- copy -------------------------------------------------------------------
    // Registered through the Client locale service, so visible text follows the active
    // locale without re-registering. The static tables are the fallback for a locale
    // service that is absent or has no dictionary (never for a missing key).
    const NS = 'c-cleaner';
    const DICTS = {
      en: {
        'panel.title': 'C-Drive Escape Cleaner',
        'panel.subtitle': 'Keeps AI toolchain cache and temp writes off the C: drive',
        'hijack.active': 'Env hijack active',
        'hijack.inactive': 'Env hijack inactive',
        'hijack.vars': '{n} variable(s) redirected',
        'hijack.escapeRoot': 'Escape root',
        'hijack.unwritable': 'escape root is NOT writable',
        'summary.safe': 'Safe to delete',
        'summary.caution': 'Cache residing',
        'summary.locked': 'In use',
        'action.refresh': 'Refresh lock state',
        'action.purge': 'Forget stale entries',
        'purge.hint': 'Rows recorded before the noise filter existed (other software in %TEMP%). Bookkeeping only — no file is deleted.',
        'action.cleanSelected': 'Clean selected',
        'action.cleanSafe': 'Clean all safe',
        'action.selectSafe': 'Select all safe',
        'action.clear': 'Clear selection',
        'action.deleteForever': 'Delete permanently (skip Recycle Bin)',
        'migrate.title': 'Junction migration (PRD 3.4)',
        'migrate.sub': 'Move a stubborn directory to {root} and leave a junction behind: writes keep working, but land off C:.',
        'migrate.none': 'No directory qualifies yet. A candidate needs at least {min} of tracked files, must sit outside the protected list, and needs a target disk other than C:.',
        'migrate.button': 'Migrate to E:',
        'migrate.undo': 'Undo',
        'migrate.running': 'Migrating…',
        'migrate.ok': 'Migrated {path} → {target} ({size}); the original path is now a junction.',
        'migrate.refused': 'Refused ({code}): {reason}',
        'migrate.undone': 'Restored {path} onto C:.',
        'migrate.interrupted': '{n} migration(s) never finished — Undo recovers them.',
        'migrate.hint': 'A moved directory comes back only through Undo, and any process holding a file inside blocks the move.',
        'col.select': 'Select',
        'col.path': 'Path',
        'col.size': 'Size',
        'col.modified': 'Modified',
        'col.holder': 'Held by',
        'table.empty': 'No tracked files yet. The watcher records writes under the C: temp and app-data directories as they happen.',
        'table.none': 'Nothing in this tier.',
        'table.more': 'Show {n} more',
        'loading': 'Loading…',
        'hint.keys': 'Keys: [Space] toggle row · [Enter] clean selected · [M] migrate the selected folder to E: · [R] refresh · [Q] close panel',
        'hint.recycle': 'Deletions go to the Recycle Bin.',
        'hint.physical': 'Deletions are PERMANENT (useRecycleBin is off).',
        'result.removed': 'Removed {n} file(s), freed {size}.',
        'result.skipped': '{n} skipped (locked, protected, or gone).',
        'result.rejected': '{n} path(s) ignored: not tracked by this plugin.',
        'result.purged': 'Forgot {n} stale tracking row(s); no file was deleted.',
        'result.none': 'Nothing was removed — every selected file was locked, gone, or protected.',
        'error.prefix': 'Panel error:',
        'tier.safe': 'safe',
        'tier.caution': 'cache',
        'tier.locked': 'locked',
      },
      zh: {
        'panel.title': 'C 盘逃逸清理',
        'panel.subtitle': '阻止 AI 工具链把缓存与临时文件写进 C 盘',
        'hijack.active': '环境变量劫持已生效',
        'hijack.inactive': '环境变量劫持未生效',
        'hijack.vars': '已重定向 {n} 个变量',
        'hijack.escapeRoot': '逃逸根目录',
        'hijack.unwritable': '逃逸根目录不可写',
        'summary.safe': '可清理',
        'summary.caution': '缓存驻留',
        'summary.locked': '正在占用',
        'action.refresh': '刷新占用状态',
        'action.purge': '清理过期条目',
        'purge.hint': '这些是噪音过滤生效前记录的条目（%TEMP% 中其他软件的文件）。仅从列表移除，不会删除任何文件。',
        'action.cleanSelected': '一键清理已选',
        'action.cleanSafe': '清理全部可清理',
        'action.selectSafe': '全选可清理项',
        'action.clear': '清空勾选',
        'action.deleteForever': '彻底删除（不进回收站）',
        'migrate.title': '软链接迁移（PRD 3.4）',
        'migrate.sub': '把顽固目录整体搬到 {root} 并在原路径留下目录联接：程序照旧写入，但物理落盘在目标盘。',
        'migrate.none': '暂无可迁移目录。候选需要累计至少 {min} 的跟踪文件、不在保护名单内，且目标盘不是 C 盘。',
        'migrate.button': '迁移到 E 盘',
        'migrate.undo': '撤销',
        'migrate.running': '迁移中…',
        'migrate.ok': '已迁移 {path} → {target}（{size}）；原路径现在是目录联接。',
        'migrate.refused': '已拒绝（{code}）：{reason}',
        'migrate.undone': '已把 {path} 搬回 C 盘。',
        'migrate.interrupted': '有 {n} 个迁移未完成 — 可用「撤销」恢复。',
        'migrate.hint': '目录搬走后只能通过「撤销」搬回，且目录内有进程占用时会阻塞搬运。',
        'col.select': '选择',
        'col.path': '路径',
        'col.size': '大小',
        'col.modified': '修改时间',
        'col.holder': '占用进程',
        'table.empty': '暂无记录。监测器会实时记录写入 C 盘临时目录与 AppData 的文件。',
        'table.none': '此分级下暂无文件。',
        'table.more': '再显示 {n} 条',
        'loading': '加载中…',
        'hint.keys': '快捷键：[空格] 切换勾选 · [Enter] 清理已选 · [M] 将选中目录迁移到 E 盘 · [R] 刷新 · [Q] 关闭面板',
        'hint.recycle': '删除将进入回收站。',
        'hint.physical': '删除为永久删除（useRecycleBin 已关闭）。',
        'result.removed': '已删除 {n} 个文件，释放 {size}。',
        'result.skipped': '跳过 {n} 个（被占用、受保护或已不存在）。',
        'result.rejected': '忽略 {n} 个路径：本插件未跟踪。',
        'result.purged': '已移除 {n} 条过期条目，未删除任何文件。',
        'result.none': '未删除任何文件——所选文件全部被占用、已不存在或受保护。',
        'error.prefix': '面板错误：',
        'tier.safe': '可清理',
        'tier.caution': '缓存',
        'tier.locked': '占用',
      },
    };

    /** Which static table answers when the locale service cannot bind. */
    function fallbackDict() {
      try {
        const lang = (typeof navigator !== 'undefined' && navigator.language) || '';
        return /^zh/i.test(lang) ? DICTS.zh : DICTS.en;
      } catch {
        return DICTS.en;
      }
    }

    /**
     * Resolve visible text: the bound Client translation first, then the static table.
     * A thunk is not needed here because every call happens during render, and the
     * locale service republishes on change — the component re-renders with the new text.
     */
    function makeText(bound) {
      const fb = fallbackDict();
      return (key, params) => {
        let text;
        if (typeof bound === 'function') {
          try {
            const value = bound(key, params);
            // A binding returns the KEY itself when the dictionary misses.
            if (typeof value === 'string' && value !== key) text = value;
          } catch {
            /* fall through to the static table */
          }
        }
        if (text === undefined) text = fb[key] ?? DICTS.en[key] ?? key;
        if (params) {
          for (const [name, value] of Object.entries(params)) {
            text = text.split(`{${name}}`).join(String(value));
          }
        }
        return text;
      };
    }

    // --- formatting -------------------------------------------------------------
    /** Byte ladder matching the host's own habit: B and KB whole, MB and up one decimal. */
    function formatBytes(bytes) {
      const n = Number(bytes) || 0;
      if (n < 1024) return `${n} B`;
      const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
      let value = n / 1024;
      let i = 0;
      while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i += 1;
      }
      return i === 0 ? `${Math.round(value)} KB` : `${value.toFixed(1)} ${units[i]}`;
    }

    /**
     * Render a persisted timestamp. SQLite's `CURRENT_TIMESTAMP` writes
     * `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker, so that exact shape is
     * tagged `Z` before parsing; anything else is handed to `Date.parse` as-is.
     */
    function formatTime(value) {
      if (value === null || value === undefined || value === '') return '—';
      let numeric;
      if (typeof value === 'number') {
        numeric = value;
      } else {
        const text = String(value);
        const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text);
        numeric = Date.parse(sqliteUtc ? `${text.replace(' ', 'T')}Z` : text);
      }
      if (!Number.isFinite(numeric)) return String(value);
      try {
        return new Date(numeric).toLocaleString();
      } catch {
        return String(value);
      }
    }

    // --- data -------------------------------------------------------------------
    /**
     * One panel round trip. Never throws: the panel renders the error instead of
     * blanking the slot.
     * @returns {Promise<{ok: boolean, value?: object, error?: string}>}
     */
    async function apiFetch(verb, init) {
      try {
        const res = await fetch(hostRouteUrl(`${API}/${verb}`).href, {
          credentials: 'same-origin',
          cache: 'no-store',
          ...init,
          headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        });
        let payload = null;
        try {
          payload = await res.json();
        } catch {
          return { ok: false, error: `HTTP ${res.status} (no JSON body)` };
        }
        if (!res.ok || payload?.ok !== true) {
          return { ok: false, error: payload?.error?.message ?? `HTTP ${res.status}` };
        }
        return { ok: true, value: payload.value };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    }

    const CATEGORY_ORDER = ['SAFE_TO_DELETE', 'CAUTION_CACHE', 'LOCKED_CRITICAL'];
    const TIER_CLASS = {
      SAFE_TO_DELETE: 'ccl-tier-safe',
      CAUTION_CACHE: 'ccl-tier-caution',
      LOCKED_CRITICAL: 'ccl-tier-locked',
    };
    const TIER_KEY = {
      SAFE_TO_DELETE: 'summary.safe',
      CAUTION_CACHE: 'summary.caution',
      LOCKED_CRITICAL: 'summary.locked',
    };
    /* Rows rendered per tier before the user asks for more. A real profile measured 18 809
     * rows; mounting a `<tr>` for each froze the panel, and every busy toggle re-rendered the
     * lot. The window only limits what is DRAWN — 全选可清理项 / one-click clean still act on
     * the whole tier, so paging can never make a clean less complete. */
    const TIER_PAGE = 200;

    // --- styles -----------------------------------------------------------------
    // Rendered as a React element so unmounting removes them, and every colour is a
    // theme token, so light/dark switching needs no work from this plugin.
    const CSS = `
.ccl-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.ccl-head{padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.ccl-title{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ccl-sub{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.ccl-status{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}
.ccl-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.ccl-pill-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.ccl-pill-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.ccl-pill-err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ccl-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.ccl-summary{display:flex;flex-wrap:wrap;gap:16px;padding:10px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.ccl-stat{display:flex;align-items:baseline;gap:6px}
.ccl-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.ccl-dot-safe{background:var(--dsw-alias-state-success-primary)}
.ccl-dot-caution{background:var(--dsw-alias-state-warn-primary)}
.ccl-dot-locked{background:var(--dsw-alias-state-error-primary)}
.ccl-stat-label{color:var(--dsw-alias-label-secondary)}
.ccl-stat-value{font-weight:600;color:var(--dsw-alias-label-primary)}
.ccl-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 20px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ccl-btn{appearance:none;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit}
.ccl-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l4)}
.ccl-btn:disabled{opacity:.5;cursor:default}
.ccl-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.ccl-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover);filter:none}
.ccl-spacer{flex:1 1 auto}
.ccl-check{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.ccl-body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 0 8px}
.ccl-group{margin-top:12px}
.ccl-group-head{display:flex;align-items:center;gap:8px;padding:6px 20px;position:sticky;top:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ccl-group-note{margin-left:auto;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.ccl-table{width:100%;border-collapse:collapse;table-layout:fixed}
.ccl-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);font-size:11px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ccl-table td{padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ccl-row:hover td{background:var(--dsw-alias-bg-layer-1)}
.ccl-row-locked td{color:var(--dsw-alias-label-tertiary)}
.ccl-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;direction:rtl;text-align:left}
.ccl-num{text-align:right;font-variant-numeric:tabular-nums}
.ccl-note{padding:12px 20px;color:var(--dsw-alias-label-tertiary)}
.ccl-btn-more{margin:8px 0 12px 20px;font-size:11px}
.ccl-foot{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 20px;color:var(--dsw-alias-label-tertiary);font-size:11px;display:flex;gap:12px;flex-wrap:wrap}
.ccl-result{margin-left:auto;color:var(--dsw-alias-label-secondary)}
.ccl-migrate{border-bottom:1px solid var(--dsw-alias-border-l1);padding:10px 20px 12px;background:var(--dsw-alias-bg-layer-1)}
.ccl-migrate-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.ccl-migrate-sub{margin:2px 0 8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ccl-migrate-warn{margin:6px 0;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);font-size:11px}
.ccl-migrate-row{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:11px}
.ccl-migrate-note{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%}
.ccl-migrate-ok{color:var(--dsw-alias-state-success-primary)}
.ccl-migrate-hint{margin-top:8px;font-size:10px;color:var(--dsw-alias-label-tertiary)}
`;

    // --- icon -------------------------------------------------------------------
    /**
     * Sidebar glyph: a drive platter with an escape arrow and a delete tick, echoing
     * the bundle icon. `currentColor` lets the sidebar own the active/idle colour.
     */
    function CcleanerIcon(props) {
      const size = Number(props?.size) || 20;
      const stroke = 'currentColor';
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke,
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 3, y: 4, width: 12, height: 12, rx: 2.5 }),
        h('circle', { cx: 9, cy: 10, r: 2.4 }),
        h('path', { d: 'M15.5 6.5h4M19.5 4.5v4' }),
        h('path', { d: 'M15 15.5l3.6 3.6M18.6 15.5L15 19.1' }),
      );
    }

    // --- panel ------------------------------------------------------------------
    /** One selectable table row. Locked rows render but refuse selection (PRD 3.3). */
    function Row(props) {
      const { row, checked, onToggle, selectable, t } = props;
      const locked = row.category === 'LOCKED_CRITICAL';
      const holder = row.locked_by_pid
        ? `${row.source_process || '?'} : ${row.locked_by_pid}`
        : locked
          ? t('tier.locked')
          : '—';
      return h(
        'tr',
        { className: `ccl-row${locked ? ' ccl-row-locked' : ''}` },
        h(
          'td',
          { style: { width: '34px' } },
          h('input', {
            type: 'checkbox',
            checked: !!checked,
            disabled: !selectable,
            'aria-label': row.file_path,
            onChange: () => onToggle(row.file_path),
          }),
        ),
        h('td', { className: 'ccl-path', title: row.file_path }, row.file_path),
        h('td', { className: 'ccl-num', style: { width: '80px' } }, formatBytes(row.file_size)),
        h('td', { style: { width: '150px', color: 'var(--dsw-alias-label-tertiary)' } }, formatTime(row.last_checked_at)),
        h('td', { style: { width: '160px' } }, holder),
      );
    }

    function TierGroup(props) {
      const { category, rows, selected, onToggle, t } = props;
      const total = rows.reduce((sum, r) => sum + (Number(r.file_size) || 0), 0);
      const locked = category === 'LOCKED_CRITICAL';
      /* Rendering every row is not viable: a real profile measured 18 809 tracked rows, and a
       * `<tr>` per row (~5 cells, a checkbox each) froze the panel on every click because each
       * `setBusy(true)` re-rendered all of them. Show a window and let the user ask for more —
       * the selection buttons still act on the WHOLE tier, not just what is visible. */
      const [shown, setShown] = useState(TIER_PAGE);
      const visible = rows.length > shown ? rows.slice(0, shown) : rows;
      const hidden = rows.length - visible.length;
      const note = locked
        ? 'PRD 3.3 — never deleted; the holding process is shown'
        : category === 'CAUTION_CACHE'
          ? 'PRD 3.3 — deleting is safe but requires a re-download'
          : 'PRD 3.3 — not locked and provably disposable';
      return h(
        'div',
        { className: 'ccl-group' },
        h(
          'div',
          { className: 'ccl-group-head' },
          h('span', { className: `ccl-dot ccl-dot-${locked ? 'locked' : category === 'CAUTION_CACHE' ? 'caution' : 'safe'}` }),
          h('span', null, `${t(TIER_KEY[category])} · ${rows.length} · ${formatBytes(total)}`),
          h('span', { className: 'ccl-group-note' }, note),
        ),
        rows.length === 0
          ? h('div', { className: 'ccl-note' }, t('table.none'))
          : h(
              'table',
              { className: 'ccl-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { style: { width: '34px' } }, ''),
                  h('th', null, t('col.path')),
                  h('th', { className: 'ccl-num', style: { width: '80px' } }, t('col.size')),
                  h('th', { style: { width: '150px' } }, t('col.modified')),
                  h('th', { style: { width: '160px' } }, t('col.holder')),
                ),
              ),
              h(
                'tbody',
                null,
                visible.map((row) =>
                  h(Row, {
                    key: row.file_path,
                    row,
                    checked: selected.has(row.file_path),
                    onToggle,
                    selectable: !locked,
                    t,
                  }),
                ),
              ),
            ),
        hidden > 0
          ? h(
              'div',
              { className: 'ccl-note' },
              h(
                'button',
                {
                  className: 'ccl-btn ccl-btn-more',
                  onClick: () => setShown((n) => n + TIER_PAGE),
                },
                t('table.more', { n: hidden }),
              ),
            )
          : null,
      );
    }

    /**
     * PRD §3.4 / §4 — the junction-migration section.
     *
     * Two things are shown, in the order the user acts on them:
     *   1. candidate directories the SERVER says are eligible right now (it runs the same gate
     *      the POST does, so nothing here can be refused on click);
     *   2. migrations that never finished (`PENDING`/`MOVED`), which are the only rows that need
     *      attention — a crash mid-move leaves the data at the target and no junction behind.
     *
     * Every action goes through the API; this component never touches a path itself.
     */
    function MigrateSection(props) {
      const { migrations, candidateCount, targetRoot, busy, migration, onMigrate, onUndo, minBytes, t } = props;
      const candidates = Array.isArray(migrations?.candidates) ? migrations.candidates : [];
      const interrupted = Array.isArray(migrations?.interrupted) ? migrations.interrupted : [];
      const history = Array.isArray(migrations?.history) ? migrations.history : [];
      const empty = candidateCount === 0 && interrupted.length === 0;

      return h(
        'div',
        { className: 'ccl-migrate' },
        h('div', { className: 'ccl-migrate-head' }, `🧷 ${t('migrate.title')}`),
        h('div', { className: 'ccl-migrate-sub' }, t('migrate.sub', { root: targetRoot ?? '—' })),
        interrupted.length > 0
          ? h(
              'div',
              { className: 'ccl-migrate-warn' },
              t('migrate.interrupted', { n: interrupted.length }),
              interrupted.map((m) =>
                h(
                  'div',
                  { key: `i${m.id}`, className: 'ccl-migrate-row' },
                  h('span', { className: 'ccl-path', title: m.source_path }, m.source_path),
                  h('span', { className: 'ccl-migrate-note' }, `${m.state} → ${m.target_path}`),
                  h(
                    'button',
                    { className: 'ccl-btn', disabled: busy, onClick: () => void onUndo(m.source_path) },
                    t('migrate.undo'),
                  ),
                ),
              ),
            )
          : null,
        empty
          ? h('div', { className: 'ccl-note' }, t('migrate.none', { min: formatBytes(minBytes) }))
          : h(
              'table',
              { className: 'ccl-table' },
              h(
                'tbody',
                null,
                candidates.slice(0, 8).map((c) =>
                  h(
                    'tr',
                    { key: c.path, className: 'ccl-row' },
                    h('td', { className: 'ccl-path', title: c.path }, c.path),
                    h('td', { className: 'ccl-num', style: { width: '90px' } }, formatBytes(c.bytes)),
                    h('td', { style: { width: '120px' } }, `${c.files} 个文件`),
                    h(
                      'td',
                      { style: { width: '110px' } },
                      h(
                        'button',
                        { className: 'ccl-btn', disabled: busy, onClick: () => void onMigrate(c.path) },
                        busy ? t('migrate.running') : t('migrate.button'),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        // Links that are already in place: the only useful action is the undo.
        history.some((m) => m.state === 'LINKED')
          ? h(
              'div',
              { className: 'ccl-migrate-links' },
              history
                .filter((m) => m.state === 'LINKED')
                .slice(0, 5)
                .map((m) =>
                  h(
                    'div',
                    { key: `l${m.id}`, className: 'ccl-migrate-row' },
                    h('span', { className: 'ccl-migrate-ok' }, '✅'),
                    h('span', { className: 'ccl-path', title: m.source_path }, m.source_path),
                    h('span', { className: 'ccl-migrate-note' }, `→ ${m.target_path}`),
                    h(
                      'button',
                      { className: 'ccl-btn', disabled: busy, onClick: () => void onUndo(m.source_path) },
                      t('migrate.undo'),
                    ),
                  ),
                ),
            )
          : null,
        h('div', { className: 'ccl-migrate-hint' }, t('migrate.hint')),
      );
    }

    function Panel(props) {
      const { t } = props;
      const [snapshot, setSnapshot] = useState(null);
      const [error, setError] = useState(null);
      const [selected, setSelected] = useState(() => new Set());
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);
      const [force, setForce] = useState(false);
      const [purged, setPurged] = useState(null);
      /** PRD 3.4: the last migration outcome, and whether one is in flight. */
      const [migration, setMigration] = useState(null);
      const alive = useRef(true);
      const rootRef = useRef(null);

      const load = useCallback(async (verb) => {
        const res = verb === 'refresh' ? await apiFetch('refresh', { method: 'POST' }) : await apiFetch('state');
        if (!alive.current) return;
        if (res.ok) {
          setSnapshot(res.value);
          setError(null);
          // Keep only selections that still exist, so a clean run cannot act on a
          // path the plugin has since forgotten.
          setSelected((prev) => {
            if (prev.size === 0) return prev;
            const live = new Set((res.value.rows ?? []).map((r) => r.file_path));
            const next = new Set([...prev].filter((p) => live.has(p)));
            return next.size === prev.size ? prev : next;
          });
        } else {
          setError(res.error);
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        void load('state');
        return () => {
          alive.current = false;
        };
      }, [load]);

      const rows = snapshot?.rows ?? [];
      const byTier = { SAFE_TO_DELETE: [], CAUTION_CACHE: [], LOCKED_CRITICAL: [] };
      for (const row of rows) {
        (byTier[row.category] ?? byTier.SAFE_TO_DELETE).push(row);
      }
      for (const list of Object.values(byTier)) {
        list.sort((a, b) => (Number(b.file_size) || 0) - (Number(a.file_size) || 0));
      }

      const totals = {};
      for (const category of CATEGORY_ORDER) {
        totals[category] = {
          count: byTier[category].length,
          bytes: byTier[category].reduce((sum, r) => sum + (Number(r.file_size) || 0), 0),
        };
      }

      const toggle = useCallback((path) => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      }, []);

      const selectAllSafe = useCallback(() => {
        setSelected(new Set(byTier.SAFE_TO_DELETE.map((r) => r.file_path)));
      }, [rows]);

      /**
       * Drop tracking rows the PRD 3.2 gate would reject today. These are rows recorded
       * before the filter existed, so the table is dominated by other software's Temp
       * churn (measured live: 1079 of 2205 green rows, ~1.09 GB). They are not dangerous
       * to delete — they are unlocked files in %TEMP% — but they bury the dsh-authored
       * rows the PRD actually asks this panel to show, and 全选可清理项 / 清理全部可清理
       * would act on all of them. This only forgets rows; no file on disk is touched.
       */
      const runPurge = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        setResult(null);
        const res = await apiFetch('purge', { method: 'POST' });
        if (!alive.current) return;
        setBusy(false);
        if (res.ok) {
          setSelected(new Set());
          if (res.value.rows) setSnapshot((prev) => ({ ...(prev ?? {}), rows: res.value.rows }));
          else void load('state');
          setPurged(res.value.forgotten ?? 0);
        } else {
          setError(res.error);
        }
      }, [busy, load]);

      const runClean = useCallback(
        async (paths, deep) => {
          if (busy || paths.length === 0) return;
          setBusy(true);
          setResult(null);
          const res = await apiFetch('clean', {
            method: 'POST',
            body: JSON.stringify({ paths, deep: deep === true, force }),
          });
          if (!alive.current) return;
          setBusy(false);
          if (res.ok) {
            const report = res.value.report ?? {};
            setResult({
              removed: report.removed ?? 0,
              bytesFreed: report.bytesFreed ?? 0,
              skipped: report.skipped ?? 0,
              rejected: (res.value.rejected ?? []).length,
              errors: (report.errors ?? []).length,
            });
            setSelected(new Set());
            if (res.value.rows) setSnapshot((prev) => ({ ...(prev ?? {}), rows: res.value.rows }));
            else void load('state');
          } else {
            setError(res.error);
          }
        },
        [busy, force, load],
      );

      /**
       * PRD 3.4 — the folder behind the current selection.
       *
       * The table selects FILES but the operation moves a DIRECTORY, so the folder is derived:
       * every selected path contributes its immediate parent, and a selection spanning more
       * than one folder has no single answer. Returning null there (instead of silently
       * migrating the first folder) keeps `[M]` from moving something the user did not point at.
       */
      const selectedDir = useCallback(() => {
        const dirs = new Map();
        for (const p of selected) {
          const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
          if (cut > 0) dirs.set(p.slice(0, cut).toLowerCase(), p.slice(0, cut));
        }
        return dirs.size === 1 ? [...dirs.values()][0] : null;
      }, [selected]);

      /** POST one migration. The server re-derives the candidate list, so a refusal is normal. */
      const runMigrate = useCallback(
        async (dirPath) => {
          if (busy || !dirPath) return;
          setBusy(true);
          setMigration(null);
          const res = await apiFetch('migrate', {
            method: 'POST',
            body: JSON.stringify({ path: dirPath }),
          });
          if (!alive.current) return;
          setBusy(false);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          const outcome = res.value.result ?? {};
          setMigration({ ok: outcome.ok === true, path: outcome.source ?? dirPath, target: outcome.target, code: outcome.code, reason: outcome.reason, bytes: outcome.bytes });
          if (res.value.rows) setSnapshot((prev) => ({ ...(prev ?? {}), rows: res.value.rows, migrations: res.value.migrations ?? prev?.migrations }));
          else void load('state');
          if (outcome.ok === true) setSelected(new Set());
        },
        [busy, load],
      );

      /** POST one undo. Only the server's own migration record can be reversed. */
      const runUnmigrate = useCallback(
        async (dirPath) => {
          if (busy || !dirPath) return;
          setBusy(true);
          setMigration(null);
          const res = await apiFetch('unmigrate', {
            method: 'POST',
            body: JSON.stringify({ path: dirPath }),
          });
          if (!alive.current) return;
          setBusy(false);
          if (!res.ok) {
            setError(res.error);
            return;
          }
          const outcome = res.value.result ?? {};
          setMigration({ ok: outcome.ok === true, path: outcome.source ?? dirPath, target: outcome.target, code: outcome.code, reason: outcome.reason, undone: true });
          if (res.value.rows) setSnapshot((prev) => ({ ...(prev ?? {}), rows: res.value.rows, migrations: res.value.migrations ?? prev?.migrations }));
          else void load('state');
        },
        [busy, load],
      );

      const migrations = snapshot?.migrations ?? null;
      const migrateCandidates = Array.isArray(migrations?.candidates) ? migrations.candidates : [];
      const migrateTargetRoot = migrations?.targetRoot ?? null;

      // Keys are scoped to the panel root, so they never fight the composer or the
      // shell's own shortcuts unless the panel is genuinely the focused surface.
      const onKeyDown = useCallback(
        (event) => {
          if (event.target instanceof HTMLInputElement && event.key !== 'Enter') return;
          if (event.key === 'Enter') {
            event.preventDefault();
            void runClean([...selected], false);
          } else if (event.key === 'r' || event.key === 'R') {
            event.preventDefault();
            void load('refresh');
          } else if (event.key === 'm' || event.key === 'M') {
            // PRD §4 hotkey bar: [M] migrates the SELECTED directory to E: via mklink /J.
            event.preventDefault();
            void runMigrate(selectedDir());
          } else if (event.key === ' ') {
            event.preventDefault();
            const first = byTier.SAFE_TO_DELETE[0] ?? byTier.CAUTION_CACHE[0];
            if (first) toggle(first.file_path);
          }
        },
        [selected, runClean, load, byTier, toggle],
      );

      const hijack = snapshot?.hijack ?? null;
      const hijackOk = hijack?.installed === true;
      const entries = Array.isArray(hijack?.entries) ? hijack.entries : [];
      const okCount = entries.filter((e) => e.ok).length;

      return h(
        'div',
        { className: 'ccl-root', ref: rootRef, tabIndex: -1, onKeyDown },
        h('style', null, CSS),
        h(
          'div',
          { className: 'ccl-head' },
          h('h1', { className: 'ccl-title' }, t('panel.title')),
          h('p', { className: 'ccl-sub' }, t('panel.subtitle')),
          h(
            'div',
            { className: 'ccl-status' },
            h(
              'span',
              { className: `ccl-pill ${hijackOk ? 'ccl-pill-ok' : 'ccl-pill-err'}` },
              hijackOk ? '✅' : '⚠️',
              hijackOk ? t('hijack.active') : t('hijack.inactive'),
              entries.length > 0 ? ` · ${t('hijack.vars', { n: okCount })}` : '',
            ),
            snapshot?.escapeRoot
              ? h(
                  'span',
                  { className: 'ccl-pill' },
                  `${t('hijack.escapeRoot')}: `,
                  h('span', { className: 'ccl-mono' }, snapshot.escapeRoot),
                )
              : null,
            snapshot?.escapeWritable === false
              ? h('span', { className: 'ccl-pill ccl-pill-err' }, t('hijack.unwritable'))
              : null,
          ),
        ),
        h(
          'div',
          { className: 'ccl-summary' },
          ...CATEGORY_ORDER.map((category) =>
            h(
              'div',
              { key: category, className: 'ccl-stat' },
              h('span', {
                className: `ccl-dot ccl-dot-${category === 'SAFE_TO_DELETE' ? 'safe' : category === 'CAUTION_CACHE' ? 'caution' : 'locked'}`,
              }),
              h('span', { className: 'ccl-stat-label' }, t(TIER_KEY[category])),
              h(
                'span',
                { className: 'ccl-stat-value' },
                `${formatBytes(totals[category].bytes)} (${totals[category].count})`,
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ccl-bar' },
          h(
            'button',
            { className: 'ccl-btn ccl-btn-primary', disabled: busy || selected.size === 0, onClick: () => void runClean([...selected], false) },
            t('action.cleanSelected'),
            selected.size > 0 ? ` (${selected.size})` : '',
          ),
          h(
            'button',
            { className: 'ccl-btn', disabled: busy || byTier.SAFE_TO_DELETE.length === 0, onClick: () => void runClean(byTier.SAFE_TO_DELETE.map((r) => r.file_path), false) },
            t('action.cleanSafe'),
          ),
          h('button', { className: 'ccl-btn', onClick: selectAllSafe }, t('action.selectSafe')),
          h('button', { className: 'ccl-btn', disabled: busy, onClick: () => void load('refresh') }, t('action.refresh')),
          h(
            'button',
            { className: 'ccl-btn', disabled: busy, title: t('purge.hint'), onClick: () => void runPurge() },
            t('action.purge'),
          ),
          h(
            'button',
            {
              className: 'ccl-btn',
              // PRD §4 hotkey bar: [M] 将选中目录软链接迁移至E盘. Disabled unless the whole
              // selection sits in ONE folder — see `selectedDir()`.
              disabled: busy || selectedDir() === null,
              title: t('migrate.hint'),
              onClick: () => void runMigrate(selectedDir()),
            },
            `[M] ${t('migrate.button')}`,
          ),
          h('div', { className: 'ccl-spacer' }),
          h(
            'label',
            { className: 'ccl-check', title: t('action.deleteForever') },
            h('input', { type: 'checkbox', checked: force, onChange: () => setForce((v) => !v) }),
            t('action.deleteForever'),
          ),
        ),
        h(
          'div',
          { className: 'ccl-body' },
          error
            ? h('div', { className: 'ccl-note', style: { color: 'var(--dsw-alias-state-error-primary)' } }, `${t('error.prefix')} ${error}`)
            : null,
          snapshot === null
            ? h('div', { className: 'ccl-note' }, t('loading'))
            : h(
                'div',
                null,
                h(MigrateSection, {
                  migrations,
                  candidateCount: migrateCandidates.length,
                  targetRoot: migrateTargetRoot,
                  busy,
                  migration,
                  onMigrate: runMigrate,
                  onUndo: runUnmigrate,
                  minBytes: 10 * 1024 * 1024,
                  t,
                }),
                rows.length === 0
                  ? h('div', { className: 'ccl-note' }, t('table.empty'))
                  : CATEGORY_ORDER.map((category) =>
                      h(TierGroup, {
                        key: category,
                        category,
                        rows: byTier[category],
                        selected,
                        onToggle: toggle,
                        t,
                      }),
                    ),
              ),
        ),
        h(
          'div',
          { className: 'ccl-foot' },
          h('span', null, t('hint.keys')),
          h('span', null, snapshot?.useRecycleBin === false ? t('hint.physical') : t('hint.recycle')),
          purged !== null
            ? h('span', { className: 'ccl-result' }, t('result.purged', { n: purged }))
            : null,
          result
            ? h(
                'span',
                {
                  className: 'ccl-result',
                  /* A run that removed NOTHING must say so loudly. It used to render an empty
                   * string (every part was gated on `> 0`), so a click on a 99 %-stale table
                   * looked like a dead button. */
                  style: result.removed === 0 ? { color: 'var(--dsw-alias-state-error-primary)' } : null,
                },
                result.removed > 0 || result.skipped > 0 || result.rejected > 0
                  ? [
                      result.removed > 0 ? t('result.removed', { n: result.removed, size: formatBytes(result.bytesFreed) }) : null,
                      result.skipped > 0 ? t('result.skipped', { n: result.skipped }) : null,
                      result.rejected > 0 ? t('result.rejected', { n: result.rejected }) : null,
                    ]
                      .filter(Boolean)
                      .join(' ')
                  : t('result.none'),
              )
            : null,
          migration
            ? h(
                'span',
                { className: 'ccl-result', style: migration.ok ? null : { color: 'var(--dsw-alias-state-error-primary)' } },
                migration.ok
                  ? migration.undone
                    ? t('migrate.undone', { path: migration.path })
                    : t('migrate.ok', { path: migration.path, target: migration.target ?? '—', size: formatBytes(migration.bytes ?? 0) })
                  : t('migrate.refused', { code: migration.code ?? 'UNKNOWN', reason: migration.reason ?? '' }),
              )
            : null,
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Every registration below is an effect: the locale dictionaries are removed
        // and the two slot entries are unregistered when this fiber unloads. Without
        // that, an HMR reload would hit `locale namespace already has locale` on the
        // second `register` and the panel would vanish for the rest of the session.
        const effect = typeof ctx.effect === 'function' ? ctx.effect : (cb) => cb();

        // Visible text through the Client locale service; a missing service or a
        // dictionary that refuses to register degrades to the static tables above.
        let bound = null;
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (locale && typeof locale.register === 'function') {
          effect(() => {
            const offs = [];
            for (const [id, dict] of Object.entries(DICTS)) {
              try {
                const off = locale.register(NS, id, dict);
                if (typeof off === 'function') offs.push(off);
              } catch (err) {
                console.warn('[c-cleaner] locale registration failed', id, err);
              }
            }
            return () => {
              for (const off of offs) {
                try {
                  off();
                } catch {
                  /* a dictionary already gone is not an error */
                }
              }
            };
          }, 'c-cleaner: locale dictionaries');
          try {
            if (typeof locale.bind === 'function') bound = locale.bind(NS);
          } catch {
            bound = null;
          }
        }
        const t = makeText(bound);

        // The sidebar row and the panel it selects are two registrations sharing one
        // id: the row owns the button and reads its label from list metadata, the
        // `main` keyed entry owns the body. The label is a thunk so it follows the
        // active locale without re-registering.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('panel.title') },
            CcleanerIcon,
          ),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, (props) => h(Panel, { ...props, t })),
        );
      },
    };
  },
});
