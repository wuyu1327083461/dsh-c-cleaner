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
  id: 'dsh-c-cleaner',
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

    // --- panel ------------------------------------------------------------------
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

    /*
     * The panel is the glass UI (`ui/index.html`, served by this plugin's own `/c-cleaner/ui`
     * route) rendered in an iframe — deliberately NOT a React re-implementation of it.
     *
     * That document is ~2 500 lines of hand-tuned glass styling: aurora blobs, backdrop blur,
     * tier pills, the one-click clean cascade, the live-slide-in animation, the mklink state
     * machine. It was verified row by row in a browser. A React port would drift visually and
     * would have to re-implement every animation, so the document is shipped as-is and framed.
     *
     * Same-origin by construction: `hostRouteUrl` resolves against `document.baseURI`, so the
     * framed document shares this page's origin. Its relative `fetch('api/<verb>')` calls
     * therefore land on `/c-cleaner/ui/api/<verb>` — the adapter in `lib/panel-ui.js`, which
     * speaks the document's flat dialect and translates it onto this plugin's `{ok, value}` API.
     * Same origin also means no `frame-ancestors`/CSP obstacle and the request passes the fence.
     */
    const PANEL_UI_SRC = 'c-cleaner/ui/index.html';

    /*
     * The height the document was designed around. `.app-shell` is a 1120x740 design baseline but
     * now stretches to fill its viewport, and `body` adds 16px of padding. This floor keeps the
     * dock and the list usable when the host gives the panel less room than the baseline; the
     * wrapper scrolls instead of squashing the layout. When the host gives more, the frame grows.
     */
    const PANEL_UI_MIN_HEIGHT = 772;

    function Panel(props) {
      const { t } = props;
      const src = hostRouteUrl(PANEL_UI_SRC).href;
      return h(
        'div',
        {
          className: 'ccl-frame-wrap',
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: '0',
            overflow: 'auto',
          },
        },
        h('iframe', {
          className: 'ccl-frame',
          src,
          title: t('panel.title'),
          /* No `sandbox` attribute on purpose: the document must reach this plugin's route, and
           * `allow-scripts` + `allow-same-origin` together would grant it nothing it does not
           * already have at the same origin. */
          style: {
            display: 'block',
            flex: '1 1 auto',
            width: '100%',
            minHeight: PANEL_UI_MIN_HEIGHT + 'px',
            border: '0',
            background: 'transparent',
            colorScheme: 'dark',
          },
        }),
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
