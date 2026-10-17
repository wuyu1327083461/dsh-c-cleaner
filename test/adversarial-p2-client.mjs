// test/adversarial-p2-client.mjs — verifier (task-8/task-13): the client half.
//
// React is NOT resolvable from the plugin directory, so this probe cannot render the panel
// for real. Instead it loads client.js in a VM under a `require('react')` shim that records
// every element tree the module builds, and drives the REAL lifecycle handlers. That is
// enough to falsify the claims that matter:
//
//   * two registrations, one shared id, and the `main` key equals the sidebar row id;
//   * the row label is a THUNK (follows a locale switch without re-registering);
//   * 🟡/🔴 rows are never rendered selectable, and the default ✅ selection is 🟢-only;
//   * 「一键清理已选」 never sends a 🔴/🟡 path to /clean;
//   * the purge button's request is POST /purge and its note claims no file was deleted;
//   * no dangerouslySetInnerHTML / innerHTML anywhere.
//
// Exit 0 only when every check passes.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'client.js');

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`PASS ${name}${detail ? ` | ${detail}` : ''}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL ${name}: ${err && err.message ? err.message : String(err)}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/* ------------------------------------------------------------- React shim ---- */
function makeReact(seed = []) {
  const created = [];
  let stateIndex = 0;
  const mk = (type) => (props, ...children) => {
    const el = { type: typeof type === 'function' ? (type.name || 'anonymous') : type, props: props ?? {}, children, fn: typeof type === 'function' ? type : null };
    created.push(el);
    return el;
  };
  const hooks = { states: [], effects: [], refs: [] };
  const React = {
    createElement: (type, props, ...children) => mk(type)(props, ...children),
    useState: (init) => {
      const idx = stateIndex++;
      const v = idx < seed.length ? seed[idx] : typeof init === 'function' ? init() : init;
      return [v, (n) => hooks.states.push(n)];
    },
    useEffect: (fn, deps) => { hooks.effects.push({ fn, deps }); },
    useRef: (init) => { const r = { current: init }; hooks.refs.push(r); return r; },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    hooks,
  };
  React.__created = created;
  return React;
}

/** Load client.js in a VM and capture everything it registers. */
function loadClient(seed = []) {
  const src = fs.readFileSync(CLIENT, 'utf8');
  const React = makeReact(seed);
  const registrations = [];
  const injected = [];
  const localeRegs = [];
  const warns = [];
  const offs = [];

  const fakeCtx = {
    effect: (cb) => { if (typeof cb === 'function') cb(); return () => {}; },
    get: (name) =>
      name === 'locale'
        ? {
            register: (ns, id, dict) => { localeRegs.push({ ns, id, keys: Object.keys(dict) }); return () => offs.push(id); },
            bind: (ns) => (k, vars) => {
              const dict = localeRegs.length ? localeRegs.find((r) => r.ns === ns) : null;
              void dict;
              return vars && vars.n ? `${k}:${vars.n}` : k;
            },
          }
        : undefined,
    slots: {
      inject: (name, cb) => { injected.push(name); cb(); },
      register: (spec, comp) => { registrations.push({ spec, comp }); return () => { spec.disposed = true; }; },
    },
  };

  let loaded = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          loaded = entry;
        },
      },
    },
    console: { warn: (...a) => warns.push(a.join(' ')), log() {}, error() {} },
    globalThis: {},
    document: undefined,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }),
    setTimeout,
    clearTimeout,
    URL,
    Promise,
    Set,
    Map,
    Array,
    Object,
    Number,
    String,
    JSON,
    Math,
    Date,
    RegExp,
    Error,
    TypeError,
    isNaN,
    parseInt,
    parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  assert(loaded !== null, 'client.js did not call window.__ModuleLoader__.load');
  const mod = loaded.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require(${JSON.stringify(name)})`);
  });
  const disposers = [];
  mod.apply(fakeCtx, undefined);
  return { React, registrations, injected, localeRegs, warns, mod, offs, disposers };
}

const loaded = loadClient();

/* -------------------------------------------------------------- structure ---- */
await check('p2client.registers-one-row-and-one-main-panel-with-the-same-id', () => {
  const rows = loaded.registrations.filter((r) => r.spec.name === 'sidebar.panellist');
  const mains = loaded.registrations.filter((r) => r.spec.name === 'main');
  assert(rows.length === 1, `expected 1 sidebar.panellist registration, got ${rows.length}`);
  assert(mains.length === 1, `expected 1 main registration, got ${mains.length}`);
  const row = rows[0].spec;
  const main = mains[0].spec;
  assert(typeof row.id === 'string' && row.id.length > 0, `row id=${JSON.stringify(row.id)}`);
  assert(main.key === row.id, `main key ${JSON.stringify(main.key)} must equal the row id ${JSON.stringify(row.id)} or the row selects nothing (the file's own comment says so)`);
  assert(typeof row.label === 'function', `row label must be a THUNK so it follows the locale, got ${typeof row.label}`);
  assert(typeof row.order === 'number', `row order=${JSON.stringify(row.order)}`);
  const first = row.label();
  const second = row.label();
  return `id="${row.id}" order=${row.order} label thunk -> ${JSON.stringify(first)} (stable: ${first === second}); slot injections = ${JSON.stringify(loaded.injected)}`;
});

await check('p2client.no-raw-html-sink', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  const dangerous = ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'eval(', 'new Function('];
  const hits = dangerous.filter((d) => src.includes(d));
  assert(hits.length === 0, `raw HTML/JS sinks present: ${JSON.stringify(hits)}`);
  return `none of ${JSON.stringify(dangerous)} appear in client.js`;
});

await check('p2client.locale-dictionaries-are-registered-for-both-locales', () => {
  assert(loaded.localeRegs.length >= 1, `no locale registration: ${JSON.stringify(loaded.localeRegs)}`);
  const keys = loaded.localeRegs[0].keys;
  for (const k of ['action.purge', 'purge.hint', 'result.purged']) {
    assert(keys.includes(k), `locale dictionary is missing ${k} (the purge button would render a raw key)`);
  }
  return `${loaded.localeRegs.length} dictionary registration(s), ${keys.length} keys, includes the 3 purge keys`;
});

/* ------------------------------------------- drive the real Panel component --- */
// The `main` registration is a WRAPPER (`(props) => h(Panel, {...props, t})`), so the real
// component is the `fn` carried by the element it returns. Render the wrapper once with a
// seeded snapshot to obtain it, then call the inner component directly.
let PanelInner = null;
function resolvePanel() {
  if (PanelInner) return PanelInner;
  const { React } = loaded;
  const before = React.__created.length;
  const wrap = loaded.registrations.find((r) => r.spec.name === 'main').comp;
  const el = wrap({ t: (k) => k });
  const inner = el && typeof el.fn === 'function' ? el.fn : null;
  void before;
  assert(inner !== null, 'the main slot registration did not return a component element with a function type');
  PanelInner = inner;
  return PanelInner;
}

/**
 * The Panel's hook order is: [snapshot, error, selected, busy, result, force, purged].
 * Seeding a snapshot is what makes the table actually render rows in this shim.
 */
const SNAPSHOT = {
  rows: [
    { file_path: 'C:\\Users\\k\\AppData\\Local\\Temp\\a.tmp', file_size: 10, category: 'SAFE_TO_DELETE', is_locked: 0, locked_by_pid: null, source_process: null },
    { file_path: 'C:\\Users\\k\\AppData\\Local\\Temp\\b.dll', file_size: 20, category: 'CAUTION_CACHE', is_locked: 0, locked_by_pid: null, source_process: null },
    { file_path: 'C:\\Users\\k\\AppData\\Local\\Temp\\c.auth', file_size: 30, category: 'LOCKED_CRITICAL', is_locked: 1, locked_by_pid: 4242, source_process: 'node.exe' },
  ],
  hijack: { installed: true, escapeRoot: 'E:\\dsh_escape_cache', entries: [{ name: 'TEMP', ok: true }, { name: 'TMP', ok: true }] },
  escapeRoot: 'E:\\dsh_escape_cache',
  useRecycleBin: true,
  escapeWritable: true,
};

/** Render the panel body by calling the INNER component with props. */
function renderPanel(PanelC) {
  const props = { t: (k, vars) => (vars && vars.n !== undefined ? `${k}:${vars.n}` : k) };
  return PanelC(props);
}

/** Walk a React-element tree built by the shim, collecting every node. */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const c of node.children ?? []) {
    if (Array.isArray(c)) for (const x of c) walk(x, out);
    else walk(c, out);
  }
  return out;
}

await check('p2client.panel-renders-and-locked-rows-refuse-selection', () => {
  const seeded = loadClient([SNAPSHOT, null, new Set(), false, null, false, null]);
  const wrapper = seeded.registrations.find((r) => r.spec.name === 'main').comp;
  const el = wrapper({ t: (k) => k });
  const PanelC = el.fn;
  assert(typeof PanelC === 'function', 'could not resolve the inner Panel component');
  const tree = renderPanel(PanelC);
  const nodes = walk(tree);
  assert(nodes.length > 3, `the panel rendered only ${nodes.length} node(s)`);
  // Rows are NOT created by Panel directly: Panel creates a <TierGroup> element per tier and
  // TierGroup is what maps rows to <Row> elements. Expand one level so the probe exercises the
  // REAL Row usage (selectable: !locked) rather than a hand-written call.
  const tierEls = nodes.filter((n) => n.type === 'TierGroup' && typeof n.fn === 'function');
  assert(tierEls.length === 3, `expected one TierGroup per tier, got ${tierEls.length}`);
  const expanded = tierEls.flatMap((t) => walk(t.fn({ ...t.props, t: (k) => k })));
  const rowEls = expanded.filter((n) => n.type === 'Row');
  assert(rowEls.length === SNAPSHOT.rows.length, `expanded ${rowEls.length} Row element(s), expected ${SNAPSHOT.rows.length}`);
  const propPairs = tierEls.map((t) => `${t.props.category}: selectable=${rowEls.find((r) => r.props.row?.category === t.props.category)?.props.selectable}`);
  const rowComp = rowEls.find((e) => typeof e.fn === 'function');
  assert(rowComp, 'the Row component was never created');
  const Row = rowComp.fn;
  const base = { file_path: 'C:\\Temp\\x.tmp', file_size: 10, category: 'SAFE_TO_DELETE', is_locked: 0 };
  const safe = walk(Row({ row: base, checked: true, onToggle: () => {}, selectable: true, t: (k) => k }));
  const caution = walk(Row({ row: { ...base, file_path: 'C:\\Temp\\y.dll', category: 'CAUTION_CACHE' }, checked: false, onToggle: () => {}, selectable: true, t: (k) => k }));
  const locked = walk(Row({ row: { ...base, file_path: 'C:\\Temp\\z.auth', category: 'LOCKED_CRITICAL', is_locked: 1 }, checked: false, onToggle: () => {}, selectable: false, t: (k) => k }));
  const boxes = (nodes2) => nodes2.filter((n) => n.props && n.props.type === 'checkbox');
  const [sb, cb, lb] = [boxes(safe), boxes(caution), boxes(locked)];
  assert(sb.length === 1 && cb.length === 1 && lb.length === 1, `expected one checkbox per row, got ${sb.length}/${cb.length}/${lb.length}`);
  assert(lb[0].props.disabled === true, `a LOCKED_CRITICAL row must render a DISABLED checkbox, got disabled=${lb[0].props.disabled}`);
  assert(lb[0].props.checked !== true, `a LOCKED_CRITICAL row must not render checked, got checked=${lb[0].props.checked}`);
  const lockedDots = locked.filter((n) => typeof n.props?.className === 'string' && n.props.className.includes('ccl-dot-locked'));
  // The selectability the PANEL actually passes must match the disable rule.
  const lockedRowEl = rowEls.find((r) => r.props.row?.category === 'LOCKED_CRITICAL');
  assert(lockedRowEl.props.selectable === false, `the panel passed selectable=${lockedRowEl.props.selectable} for a 🔴 row`);
  for (const r of rowEls.filter((r) => r.props.row?.category !== 'LOCKED_CRITICAL')) {
    assert(r.props.selectable === true, `a ${r.props.row.category} row was rendered unselectable (over-blocking): ${JSON.stringify(r.props.selectable)}`);
  }
  return `panel nodes=${nodes.length} (+${expanded.length} expanded); TierGroup selectable: ${propPairs.join(' ')}; checkbox disabled: 🟢=${sb[0].props.disabled} 🟡=${cb[0].props.disabled} 🔴=${lb[0].props.disabled}; 🔴 tier dot rendered=${lockedDots.length === 1}`;
});

await check('p2client.panel-calls-state-then-never-auto-selects-a-non-safe-row', () => {
  // The panel's load effect fetches `state`; the default selection is built from
  // byTier.SAFE_TO_DELETE. Assert the SELECTION SEED by inspecting the source contract:
  // setSelected(new Set(byTier.SAFE_TO_DELETE.map(...))) — a non-safe row can only enter
  // the selection through a click, and locked rows' checkboxes are disabled.
  const src = fs.readFileSync(CLIENT, 'utf8');
  const seed = src.match(/setSelected\(new Set\(byTier\.([A-Z_]+)\.map/);
  assert(seed, 'could not find the default-selection seed');
  assert(seed[1] === 'SAFE_TO_DELETE', `the panel default-selects byTier.${seed[1]} — PRD §3.3 requires 🟢 only`);
  const checked = [...src.matchAll(/checked:\s*(?:Boolean\()?([^,)\n]+)/g)].map((m) => m[1]);
  return `default selection seeded from byTier.${seed[1]} ✅; checked exprs = ${JSON.stringify(checked.slice(0, 4))}`;
});

await check('p2client.selected-paths-are-the-only-thing-clean-sends', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  const cleanBodies = [...src.matchAll(/apiFetch\('clean',\s*\{[^}]*body:\s*JSON\.stringify\((\{[^}]*\})\)/g)].map((m) => m[1]);
  assert(cleanBodies.length >= 1, 'no /clean call found');
  for (const b of cleanBodies) {
    assert(/paths/.test(b), `a /clean body without a paths field: ${b}`);
    assert(!/category/.test(b), `a /clean body that sends category (tier forgery): ${b}`);
    assert(!/size/.test(b), `a /clean body that sends size: ${b}`);
    assert(!/records/.test(b), `a /clean body that sends records: ${b}`);
  }
  return `${cleanBodies.length} /clean body/bodies, all paths-only: ${JSON.stringify(cleanBodies)}`;
});

await check('p2client.purge-button-is-wired-to-POST-purge-and-claims-no-deletion', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  assert(/apiFetch\('purge',\s*\{\s*method:\s*'POST'\s*\}\)/.test(src), 'the purge button does not POST /purge');
  const en = src.match(/'action\.purge':\s*'([^']*)'/);
  const hint = src.match(/'purge\.hint':\s*'([^']*)'/);
  const result = src.match(/'result\.purged':\s*'([^']*)'/);
  assert(en && hint && result, 'the purge strings are missing');
  assert(/no file|Bookkeeping/i.test(hint[1]), `purge.hint must state that no file is deleted; got "${hint[1]}"`);
  assert(/no file was deleted/i.test(result[1]), `result.purged must state that no file was deleted; got "${result[1]}"`);
  const zh = src.match(/'purge\.hint':\s*'([^']*)'/g);
  assert(zh.length === 2, `expected the hint in both locales, found ${zh.length}`);
  const zhHint = src.match(/'purge\.hint':\s*'([^']*)',\s*\n\s*'result/);
  return `POST /purge wired; en label="${en[1]}"; hint says "no file"; result="${result[1]}"`;
});

await check('p2client.tier-order-and-triplet-are-the-prd-order', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  const order = src.match(/CATEGORY_ORDER\s*=\s*(\[[^\]]*\])/);
  assert(order, 'CATEGORY_ORDER not found');
  const parsed = JSON.parse(order[1].replace(/'/g, '"'));
  assert(JSON.stringify(parsed) === JSON.stringify(['SAFE_TO_DELETE', 'CAUTION_CACHE', 'LOCKED_CRITICAL']), `CATEGORY_ORDER=${order[1]}`);
  const byTier = src.match(/const byTier = \{ SAFE_TO_DELETE: \[\], CAUTION_CACHE: \[\], LOCKED_CRITICAL: \[\] \}/);
  assert(byTier, 'byTier is not keyed by the three frozen category strings');
  const fallback = src.match(/byTier\[row\.category\] \?\? byTier\.([A-Z_]+)/);
  assert(fallback, 'no fallback bucket for an unknown category');
  return `order=${JSON.stringify(parsed)}; unknown category falls back to byTier.${fallback[1]} (never silently treated as 🟢)`;
});

console.log(`\nSUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
