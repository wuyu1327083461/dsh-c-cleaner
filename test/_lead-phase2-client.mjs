/**
 * Lead acceptance probe for the Phase 2 client half (`client.js`).
 *
 * Two things are proven here, and both matter:
 *
 *   1. **The panel actually renders.** A throwing component does not fail loudly — the
 *      host prints `slot entry crashed in '<slot>'` and leaves the slot blank. So the
 *      panel is rendered through a stub React that EXPANDS function components (calls
 *      them with their props) and evaluates every prop/handler. An error inside `Row`,
 *      `TierGroup` or `Panel` therefore surfaces here instead of as a blank page later.
 *   2. **Everything registered is disposed.** The locale service THROWS on a duplicate
 *      `(ns, locale)` registration, so a reload that leaked its previous registration
 *      would permanently break the panel for the rest of the session.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    fail += 1;
    failures.push(`${name}: ${err?.message}`);
    console.log(`  FAIL  ${name}\n        ${err?.message}`);
  }
}

// --- stub React ----------------------------------------------------------------
const hookState = { cursor: 0, slots: [], effects: [] };

const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    };
  },
  Fragment: 'Fragment',
  useState(initial) {
    const i = hookState.cursor++;
    if (!(i in hookState.slots)) hookState.slots[i] = typeof initial === 'function' ? initial() : initial;
    return [
      hookState.slots[i],
      (next) => {
        hookState.slots[i] = typeof next === 'function' ? next(hookState.slots[i]) : next;
      },
    ];
  },
  useRef(initial) {
    const i = hookState.cursor++;
    if (!(i in hookState.slots)) hookState.slots[i] = { current: initial };
    return hookState.slots[i];
  },
  useEffect(fn) {
    hookState.cursor++;
    hookState.effects.push(fn);
    return undefined;
  },
  useCallback(fn) {
    hookState.cursor++;
    return fn;
  },
  useMemo(fn) {
    hookState.cursor++;
    return fn();
  },
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
globalThis.HTMLInputElement = class HTMLInputElement {};

let fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value: LOADED }),
  };
};

const required = (spec) => {
  if (spec === 'react') return React;
  throw new Error(`unexpected require(${spec})`);
};

new Function('window', 'console', SRC)(globalThis.window, console);

// --- module shape ---------------------------------------------------------------
check('client.js calls __ModuleLoader__.load with the package name as id', () => {
  assert.ok(captured, 'load() was never called');
  assert.equal(captured.id, 'dsh-c-cleaner');
  assert.equal(typeof captured.factory, 'function');
});

const mod = captured.factory(required);

check('the module exports exactly { apply, inject }', () => {
  assert.deepEqual(Object.keys(mod).sort(), ['apply', 'inject']);
  assert.deepEqual(mod.inject, ['slots']);
  assert.equal(typeof mod.apply, 'function');
});

// --- drive apply() against a mock ctx -------------------------------------------
const registrations = [];
const localeDicts = new Map();
let localeDisposed = 0;

/** Faithful-ish Cordis ctx: `effect()` runs the callback and collects its disposer. */
const disposers = [];
const ctx = {
  effect(cb) {
    const off = cb();
    if (typeof off === 'function') disposers.push(off);
    return () => {};
  },
  get(name) {
    if (name !== 'locale') return undefined;
    return {
      register(ns, locale, dict) {
        const key = `${ns}/${locale}`;
        // The real service throws on a duplicate — reproduce that so a leaked
        // registration after a reload is caught here.
        if (localeDicts.has(key)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`);
        localeDicts.set(key, dict);
        return () => {
          localeDisposed += 1;
          localeDicts.delete(key);
        };
      },
      bind: () => tStub,
    };
  },
};

const slots = {
  inject(key, cb) {
    registrations.push({ kind: 'inject', key, cb });
    return () => {};
  },
  register(spec, component) {
    registrations.push({ kind: 'register', spec, component });
    return () => {};
  },
};

mod.apply({ ...ctx, slots });

/** Run one `inject` callback and return the `{spec, component}` it registered. */
function injected(key) {
  const before = registrations.length;
  const entry = registrations.find((r) => r.kind === 'inject' && r.key === key);
  assert.ok(entry, `nothing was injected into '${key}'`);
  entry.cb();
  const made = registrations.slice(before).find((r) => r.kind === 'register');
  assert.ok(made, `inject('${key}') registered nothing`);
  return made;
}

check('apply() registers the sidebar row and the main panel', () => {
  const keys = registrations.filter((r) => r.kind === 'inject').map((r) => r.key).sort();
  assert.deepEqual(keys, ['main', 'sidebar.panellist'], `injected into ${JSON.stringify(keys)}`);
});
check('the panellist id and the main key are the same value (or the row selects nothing)', () => {
  const panelSpec = injected('sidebar.panellist').spec;
  const mainSpec = injected('main').spec;
  assert.equal(panelSpec.name, 'sidebar.panellist');
  assert.equal(mainSpec.name, 'main');
  assert.equal(mainSpec.key, panelSpec.id, `main key ${mainSpec.key} != panellist id ${panelSpec.id}`);
  assert.equal(panelSpec.id, 'c-cleaner');
});
check('the panellist label is a thunk (so it follows the active locale)', () => {
  const spec = injected('sidebar.panellist').spec;
  assert.equal(typeof spec.label, 'function', 'label is not a function');
  assert.match(spec.label(), /C-Drive Escape Cleaner/, `label rendered as ${spec.label()}`);
});
check('the panellist declares an explicit order so its row position is deterministic', () => {
  assert.equal(typeof injected('sidebar.panellist').spec.order, 'number');
});
check('locale dictionaries registered for en and zh', () => {
  assert.deepEqual([...localeDicts.keys()].sort(), ['c-cleaner/en', 'c-cleaner/zh']);
});
check('the en and zh dictionaries declare the same key set', () => {
  const en = Object.keys(localeDicts.get('c-cleaner/en')).sort();
  const zh = Object.keys(localeDicts.get('c-cleaner/zh')).sort();
  assert.deepEqual(en, zh);
  assert.ok(en.length > 10, `suspiciously few keys: ${en.length}`);
});
check('no dictionary value is blank', () => {
  for (const [k, v] of Object.entries(localeDicts.get('c-cleaner/en'))) {
    assert.equal(typeof v, 'string', `${k} is not a string`);
    assert.ok(v.trim().length > 0, `${k} is blank`);
  }
});
check('every {placeholder} in en has a counterpart in zh', () => {
  const en = localeDicts.get('c-cleaner/en');
  const zh = localeDicts.get('c-cleaner/zh');
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [k, v] of Object.entries(en)) {
    assert.deepEqual(ph(v), ph(zh[k]), `placeholder mismatch in ${k}`);
  }
});
check('the panellist icon component renders an svg element', () => {
  const entry = injected('sidebar.panellist');
  if (typeof entry.component === 'function') {
    assert.equal(entry.component({ size: 20, active: false }).type, 'svg');
  } else {
    assert.equal(entry.component.type, 'svg');
  }
});

// --- render the panel -----------------------------------------------------------
const panelComponent = injected('main').component;
check('the panel entry point is a function', () => {
  assert.equal(typeof panelComponent, 'function');
});

/** Snapshot payload shaped exactly like `lib/web-api.js` answers with. */
const LOADED = {
  rows: [
    { file_path: 'C:\\Temp\\a.tmp', file_size: 1024, category: 'SAFE_TO_DELETE', is_locked: 0, locked_by_pid: null, source_process: null, last_checked_at: '2026-10-16 10:00:00' },
    { file_path: 'C:\\Temp\\big.cache', file_size: 1048576, category: 'CAUTION_CACHE', is_locked: 0, locked_by_pid: null, source_process: null, last_checked_at: '2026-10-16 10:00:01' },
    { file_path: 'C:\\Temp\\held.lock', file_size: 10, category: 'LOCKED_CRITICAL', is_locked: 1, locked_by_pid: 4242, source_process: 'node.exe', last_checked_at: '2026-10-16 10:00:02' },
  ],
  hijack: { installed: true, escapeRoot: 'E:\\dsh_escape_cache', entries: Array.from({ length: 9 }, (_, i) => ({ name: `V${i}`, ok: true })) },
  escapeRoot: 'E:\\dsh_escape_cache',
  useRecycleBin: true,
  escapeWritable: true,
};

/** The English dictionary, so assertions read real copy. */
function tStub(key, params) {
  const dict = localeDicts.get('c-cleaner/en') ?? {};
  const template = dict[key] ?? key;
  return params
    ? String(template).replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`))
    : String(template);
}

/**
 * Expand an element tree the way React would: an element whose `type` is a function is
 * CALLED with its props. Without this the assertions would inspect `<Row .../>` element
 * objects instead of the `<tr>` they render, and an error inside Row or TierGroup would
 * never surface.
 */
function expand(node) {
  let current = node;
  let guard = 0;
  while (current && typeof current === 'object' && typeof current.type === 'function' && guard++ < 200) {
    const saved = hookState.cursor;
    current = current.type(current.props ?? {});
    hookState.cursor = saved;
  }
  return current;
}

/** Walk an element tree, expanding function components as it goes. */
function walk(node, visit) {
  const resolved = expand(node);
  if (!resolved || typeof resolved !== 'object') return;
  visit(resolved);
  for (const child of resolved.children ?? []) walk(child, visit);
}

/** Render the panel the way the slot owner would, running mount effects. */
function renderPanel(props = { t: tStub }) {
  hookState.slots = [];
  hookState.cursor = 0;
  hookState.effects = [];
  const tree = expand(panelComponent(props));
  for (const fn of hookState.effects) fn();
  return tree;
}

/** Render with a pre-seeded snapshot (slot 0), which is what a finished load writes. */
function renderLoaded(snapshot = LOADED, props = { t: tStub }) {
  hookState.slots = [];
  renderPanel(props);
  hookState.slots[0] = snapshot;
  hookState.cursor = 0;
  hookState.effects = [];
  return expand(panelComponent(props));
}

check('the panel renders an empty (loading) state without throwing', () => {
  const tree = renderPanel();
  assert.equal(tree.type, 'div');
  let sawStyle = false;
  walk(tree, (n) => {
    if (n.type === 'style') sawStyle = true;
  });
  assert.ok(sawStyle, 'the stylesheet element is missing');
});
check('the initial mount asks the host for state exactly once', () => {
  fetchCalls = [];
  renderPanel();
  assert.equal(fetchCalls.length, 1, `expected 1 fetch, got ${fetchCalls.length}`);
  assert.match(fetchCalls[0].url, /c-cleaner\/api\/state$/);
  assert.equal(fetchCalls[0].init.cache, 'no-store');
  assert.equal(fetchCalls[0].init.credentials, 'same-origin');
});
check('the request URL is RELATIVE to the page directory (prefix-safe)', () => {
  // A leading slash pins the request to the origin root and 404s behind a proxy.
  assert.ok(!fetchCalls[0].url.startsWith('/'), `absolute URL: ${fetchCalls[0].url}`);
});

const loadedProbe = renderLoaded();

check('the panel renders a populated snapshot without throwing', () => {
  assert.equal(loadedProbe.type, 'div');
});
check('a populated snapshot renders one row per tracked file', () => {
  const paths = [];
  walk(loadedProbe, (n) => {
    if (n.type === 'td' && typeof n.props.className === 'string' && n.props.className.includes('ccl-path')) {
      paths.push(n.children[0]);
    }
  });
  assert.equal(paths.length, 3, `rendered ${paths.length} path cells: ${JSON.stringify(paths)}`);
});
check('the LOCKED row shows BOTH the holder name and its PID (PRD 3.3)', () => {
  let found = null;
  walk(loadedProbe, (n) => {
    if (n.type === 'td' && (n.children ?? []).some((c) => c === 'node.exe : 4242')) found = true;
  });
  assert.ok(found, 'the holder name+PID pair never appeared in the table');
});
check('the LOCKED row is rendered but its checkbox is disabled (never selectable)', () => {
  const boxes = [];
  walk(loadedProbe, (n) => {
    if (n.type === 'input' && n.props.type === 'checkbox' && n.props['aria-label']) boxes.push(n.props);
  });
  assert.equal(boxes.length, 3, `found ${boxes.length} row checkboxes`);
  const locked = boxes.find((b) => b['aria-label'] === 'C:\\Temp\\held.lock');
  const safe = boxes.find((b) => b['aria-label'] === 'C:\\Temp\\a.tmp');
  assert.ok(locked, 'no checkbox for the locked row');
  assert.equal(locked.disabled, true, 'the LOCKED row was selectable');
  assert.equal(safe.disabled, false, 'a SAFE row was not selectable');
});
check('the header shows the escape root', () => {
  const texts = [];
  walk(loadedProbe, (n) => {
    for (const c of n.children ?? []) if (typeof c === 'string') texts.push(c);
    if (typeof n.props?.className === 'string' && n.props.className.includes('ccl-mono') && typeof n.children?.[0] === 'string') {
      texts.push(n.children[0]);
    }
  });
  assert.ok(
    texts.some((t) => t.includes('E:\\dsh_escape_cache')),
    `escape root missing from the header: ${texts.join(' | ').slice(0, 300)}`,
  );
});
check('the summary strip reports bytes AND counts per tier', () => {
  const values = [];
  walk(loadedProbe, (n) => {
    if (typeof n.props?.className === 'string' && n.props.className.includes('ccl-stat-value')) values.push(n.children[0]);
  });
  assert.equal(values.length, 3, `rendered ${values.length} tier summaries`);
  assert.match(String(values[0]), /1 KB \(1\)/, `safe tier rendered as ${values[0]}`);
  assert.match(String(values[1]), /1\.0 MB \(1\)/, `caution tier rendered as ${values[1]}`);
});
check('every control has a handler and invoking it does not throw', () => {
  const controls = [];
  walk(loadedProbe, (n) => {
    if (n.type === 'button') controls.push(n.props);
    if (n.type === 'input' && n.props.type === 'checkbox' && !n.props['aria-label']) controls.push(n.props);
  });
  assert.ok(controls.length >= 4, `found ${controls.length} controls`);
  for (const c of controls) {
    if (typeof c.onClick === 'function') c.onClick({ preventDefault() {} });
    if (typeof c.onChange === 'function') c.onChange({ preventDefault() {}, target: { value: '' } });
  }
});
check('the root is keyboard-focusable and carries the key handler', () => {
  assert.equal(loadedProbe.props.tabIndex, -1);
  assert.equal(typeof loadedProbe.props.onKeyDown, 'function');
});
check('the panel shows the recycle-bin vs physical-delete distinction', () => {
  const texts = [];
  walk(loadedProbe, (n) => {
    for (const c of n.children ?? []) if (typeof c === 'string') texts.push(c);
  });
  assert.ok(
    texts.some((t) => /recycle|recycled/i.test(t)),
    `no recycle-bin hint found: ${texts.join(' | ').slice(0, 300)}`,
  );
});
check('an API error renders a message instead of blanking the panel', () => {
  hookState.slots = [];
  renderPanel();
  hookState.slots[1] = 'boom';
  hookState.cursor = 0;
  const tree = expand(panelComponent({ t: tStub }));
  let saw = false;
  walk(tree, (n) => {
    for (const c of n.children ?? []) if (typeof c === 'string' && c.includes('boom')) saw = true;
  });
  assert.ok(saw, 'the error string never appeared in the tree');
});
check('a category the plugin does not know cannot crash the grouping', () => {
  const tree = renderLoaded({ rows: [{ file_path: 'X:\\weird', file_size: 1, category: 'ALIEN_TIER', is_locked: 0 }] });
  assert.ok(tree, 'rendering an unknown category produced nothing');
});
check('null/undefined row fields are tolerated by the formatters', () => {
  const tree = renderLoaded({
    rows: [{ file_path: 'C:\\x', file_size: null, category: 'SAFE_TO_DELETE', is_locked: null, locked_by_pid: null, source_process: null, last_checked_at: null }],
    hijack: null,
    escapeRoot: null,
    escapeWritable: null,
  });
  assert.ok(tree);
});
check('a row with no category at all is tolerated', () => {
  assert.ok(renderLoaded({ rows: [{ file_path: 'C:\\y' }] }));
});
check('a non-array rows field is tolerated', () => {
  assert.ok(renderLoaded({ rows: 'not-an-array' }));
});
check('a hostile path cannot inject HTML (no dangerouslySetInnerHTML anywhere)', () => {
  assert.ok(!/dangerouslySetInnerHTML/.test(SRC), 'the client uses dangerouslySetInnerHTML');
});
check('the client never writes the DOM outside React', () => {
  assert.ok(!/document\.body/.test(SRC), 'the client touches document.body');
  assert.ok(!/\.innerHTML\s*=/.test(SRC), 'the client assigns innerHTML');
  assert.ok(!/appendChild|insertAdjacentHTML|createElementNS/.test(SRC), 'the client manipulates the DOM directly');
});
check('the client requires react and nothing else (practices.md: no Client packages)', () => {
  const requires = [...SRC.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(requires)], ['react'], `runtime imports: ${JSON.stringify(requires)}`);
});

// --- disposal -------------------------------------------------------------------
check('unloading the fiber removes the locale dictionaries', () => {
  assert.equal(localeDicts.size, 2, `before dispose: ${[...localeDicts.keys()]}`);
  for (const off of disposers) off();
  assert.equal(localeDicts.size, 0, `after dispose: ${[...localeDicts.keys()]}`);
  assert.equal(localeDisposed, 2);
});
check('a reload after disposal can register again (no duplicate-namespace throw)', () => {
  localeDicts.clear();
  const fresh = [];
  const ctx2 = {
    effect(cb) {
      const off = cb();
      if (typeof off === 'function') fresh.push(off);
      return () => {};
    },
    get: ctx.get,
  };
  mod.apply({ ...ctx2, slots });
  assert.equal(localeDicts.size, 2);
  for (const off of fresh) off();
  assert.equal(localeDicts.size, 0);
});

console.log(`\nSUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
if (fail > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
