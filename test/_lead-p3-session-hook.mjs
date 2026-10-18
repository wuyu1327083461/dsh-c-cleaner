/**
 * Lead probe: the session-close hook must be inert when off, contained when broken, and must
 * never throw into the host (the host awaits listener promises and warns on rejection, but a
 * plugin that relies on that is a plugin that breaks session teardown).
 *
 * Also pins the seam itself: the hook must subscribe to `session/disposed` — the event that
 * actually exists — because the PRD's `post_session_close` is a conceptual name with no
 * implementation anywhere in the dsh tree.
 */
import { installSessionHook } from '../lib/session-hook.js';

let pass = 0;
let fail = 0;

const ok = (cond, what, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS ${what}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL ${what}${extra ? ' :: ' + extra : ''}`);
  }
};

/** A fake Cordis ctx that records subscriptions and can fire them. */
function fakeCtx() {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return () => {
        const list = handlers.get(event) ?? [];
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    fire(event, arg) {
      for (const fn of [...(handlers.get(event) ?? [])]) fn(arg);
    },
    count(event) {
      return (handlers.get(event) ?? []).length;
    },
    events() {
      return [...handlers.keys()];
    },
  };
}

const quietLog = { info() {}, warn() {}, debug() {}, error() {} };

async function main() {
  // ---- 1. the seam: subscribes to the real event names ----
  {
    const ctx = fakeCtx();
    const hook = installSessionHook(ctx, {
      cfg: { sessionCloseClean: true, sessionCloseMinAgeMs: 0 },
      log: quietLog,
      trackedRows: async () => [],
      clean: async () => ({ removed: 0, skipped: 0, bytesFreed: 0, errors: [] }),
    });
    const events = ctx.events().sort();
    ok(
      events.includes('session/disposed'),
      'subscribes to session/disposed (the PRD post_session_close seam)',
      events.join(','),
    );
    ok(events.includes('session/created'), 'subscribes to session/created (for the min-age rule)');
    hook.dispose();
  }

  // ---- 2. off by default: no sweep ever runs ----
  {
    const ctx = fakeCtx();
    let cleaned = 0;
    const hook = installSessionHook(ctx, {
      cfg: { sessionCloseClean: false },
      log: quietLog,
      trackedRows: async () => [{ file_path: 'C:\\x\\a.log', category: 'SAFE_TO_DELETE' }],
      clean: async () => {
        cleaned += 1;
        return { removed: 1, skipped: 0, bytesFreed: 1, errors: [] };
      },
    });
    ok(hook.isEnabled() === false, 'sessionCloseClean=false -> hook reports disabled');
    ctx.fire('session/disposed', { id: 's1' });
    await new Promise((r) => setTimeout(r, 30));
    ok(cleaned === 0, 'sessionCloseClean=false -> disposed fires nothing', `clean calls=${cleaned}`);
    ok((await hook.sweep('manual')) === null, 'sessionCloseClean=false -> manual sweep() is a no-op');
    hook.dispose();
  }

  // ---- 3. on: a disposed session sweeps exactly the SAFE rows ----
  {
    const ctx = fakeCtx();
    const calls = [];
    const hook = installSessionHook(ctx, {
      cfg: { sessionCloseClean: true, sessionCloseMinAgeMs: 0 },
      log: quietLog,
      trackedRows: async () => [
        { file_path: 'C:\\x\\a.log', category: 'SAFE_TO_DELETE' },
        { file_path: 'C:\\x\\b.bin', category: 'CAUTION_CACHE' },
        { file_path: 'C:\\x\\c.db', category: 'LOCKED_CRITICAL' },
      ],
      clean: async (rows, opts) => {
        // `clean()` reads `rec.path` (a Classified field). Mapping `file_path` here would hide a
        // sweep that forwards raw TrackedRows and therefore cleans nothing.
        ok(rows.every((r) => typeof r.path === 'string' && r.path.length > 0), 'every record handed to clean() carries a path', JSON.stringify(rows));
        calls.push({ paths: rows.map((r) => r.path), opts });
        return { removed: 1, skipped: 0, bytesFreed: 10, errors: [] };
      },
    });
    ok(hook.isEnabled() === true, 'sessionCloseClean=true -> hook armed');
    ctx.fire('session/disposed', { id: 's2' });
    await new Promise((r) => setTimeout(r, 50));
    ok(calls.length === 1, 'one disposed event -> exactly one clean() call', `calls=${calls.length}`);
    if (calls.length > 0) {
      ok(calls[0].paths.length === 1 && calls[0].paths[0].endsWith('a.log'), 'only SAFE_TO_DELETE rows are passed to clean()', JSON.stringify(calls[0].paths));
      ok(calls[0].opts.deep === false && calls[0].opts.force === false, 'silent clean is never deep and never forced', JSON.stringify({ deep: calls[0].opts.deep, force: calls[0].opts.force }));
    }
    hook.dispose();
  }

  // ---- 4. the listener is fire-and-forget: it returns before the sweep finishes ----
  {
    const ctx = fakeCtx();
    let finished = false;
    const hook = installSessionHook(ctx, {
      cfg: { sessionCloseClean: true, sessionCloseMinAgeMs: 0 },
      log: quietLog,
      trackedRows: async () => [{ file_path: 'C:\\x\\a.log', category: 'SAFE_TO_DELETE' }],
      clean: async () => {
        await new Promise((r) => setTimeout(r, 120));
        finished = true;
        return { removed: 1, skipped: 0, bytesFreed: 1, errors: [] };
      },
    });
    const t0 = Date.now();
    ctx.fire('session/disposed', { id: 's3' });
    const elapsed = Date.now() - t0;
    ok(elapsed < 60, 'the listener returns immediately (does not block session teardown)', `${elapsed}ms`);
    ok(finished === false, 'the sweep is still running when the listener returns');
    await new Promise((r) => setTimeout(r, 250));
    ok(finished === true, 'the detached sweep does complete');
    hook.dispose();
  }

  // ---- 5. min age: a session that barely existed does not trigger a sweep ----
  {
    const ctx = fakeCtx();
    let cleaned = 0;
    const hook = installSessionHook(ctx, {
      cfg: { sessionCloseClean: true, sessionCloseMinAgeMs: 60000 },
      log: quietLog,
      trackedRows: async () => [{ file_path: 'C:\\x\\a.log', category: 'SAFE_TO_DELETE' }],
      clean: async () => {
        cleaned += 1;
        return { removed: 1, skipped: 0, bytesFreed: 1, errors: [] };
      },
    });
    ctx.fire('session/created', { id: 'young' });
    ctx.fire('session/disposed', { id: 'young' });
    await new Promise((r) => setTimeout(r, 40));
    ok(cleaned === 0, 'session younger than sessionCloseMinAgeMs -> no sweep', `clean calls=${cleaned}`);
    // A session disposed without ever being seen at created has no age, so it is cleaned —
    // the host may restart and lose the created event, and missing it must not disable the hook.
    ctx.fire('session/disposed', { id: 'never-seen' });
    await new Promise((r) => setTimeout(r, 40));
    ok(cleaned === 1, 'session never seen at created -> still cleaned (fail-open on age)', `clean calls=${cleaned}`);
    hook.dispose();
  }

  // ---- 6. a broken clean() is contained: no unhandled rejection, no throw ----
  {
    const ctx = fakeCtx();
    const warns = [];
    const hook = installSessionHook(ctx, {
      cfg: { sessionCloseClean: true, sessionCloseMinAgeMs: 0 },
      log: { ...quietLog, warn: (m) => warns.push(m) },
      trackedRows: async () => [{ file_path: 'C:\\x\\a.log', category: 'SAFE_TO_DELETE' }],
      clean: async () => {
        throw new Error('cleaner exploded');
      },
    });
    let threw = false;
    try {
      ctx.fire('session/disposed', { id: 's4' });
    } catch {
      threw = true;
    }
    ok(threw === false, 'a throwing clean() does not throw out of the listener');
    await new Promise((r) => setTimeout(r, 60));
    ok(warns.some((m) => m.includes('cleaner exploded')), 'the failure is logged as a warning', JSON.stringify(warns));
    hook.dispose();
  }

  // ---- 7. broken deps (throwing trackedRows, throwing refresh) stay contained ----
  {
    const ctx = fakeCtx();
    const hook = installSessionHook(ctx, {
      cfg: { sessionCloseClean: true, sessionCloseMinAgeMs: 0 },
      log: quietLog,
      refresh: async () => {
        throw new Error('refresh exploded');
      },
      trackedRows: async () => {
        throw new Error('db exploded');
      },
      clean: async () => ({ removed: 0, skipped: 0, bytesFreed: 0, errors: [] }),
    });
    let threw = false;
    try {
      ctx.fire('session/disposed', { id: 's5' });
    } catch {
      threw = true;
    }
    ok(threw === false, 'throwing refresh/trackedRows do not throw out of the listener');
    ok((await hook.sweep('manual')) === null, 'sweep() returns null instead of rejecting', 'contained');
    hook.dispose();
  }

  // ---- 8. a ctx with no `on` (host without the sessions service) does not break install ----
  {
    let threw = false;
    let hook = null;
    try {
      hook = installSessionHook({}, {
        cfg: { sessionCloseClean: true },
        log: quietLog,
        trackedRows: async () => [],
        clean: async () => ({ removed: 0 }),
      });
    } catch {
      threw = true;
    }
    ok(threw === false && hook !== null, 'installs without throwing when ctx.on is missing');
    ok(hook.isEnabled() === true, 'the hook still reports itself enabled (sweep() remains callable)');
    hook.dispose();
  }

  // ---- 9. dispose() unsubscribes and is idempotent ----
  {
    const ctx = fakeCtx();
    const hook = installSessionHook(ctx, {
      cfg: { sessionCloseClean: true, sessionCloseMinAgeMs: 0 },
      log: quietLog,
      trackedRows: async () => [{ file_path: 'C:\\x\\a.log', category: 'SAFE_TO_DELETE' }],
      clean: async () => ({ removed: 1, skipped: 0, bytesFreed: 1, errors: [] }),
    });
    ok(ctx.count('session/disposed') === 1, 'one disposed subscriber while installed');
    hook.dispose();
    ok(ctx.count('session/disposed') === 0, 'dispose() removes the disposed subscriber');
    ok(ctx.count('session/created') === 0, 'dispose() removes the created subscriber');
    let threw = false;
    try {
      hook.dispose();
    } catch {
      threw = true;
    }
    ok(threw === false, 'dispose() is idempotent');
  }

  // ---- 10. concurrent disposals never run two sweeps at once ----
  {
    const ctx = fakeCtx();
    let concurrent = 0;
    let maxConcurrent = 0;
    const hook = installSessionHook(ctx, {
      cfg: { sessionCloseClean: true, sessionCloseMinAgeMs: 0 },
      log: quietLog,
      trackedRows: async () => [{ file_path: 'C:\\x\\a.log', category: 'SAFE_TO_DELETE' }],
      clean: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 60));
        concurrent -= 1;
        return { removed: 1, skipped: 0, bytesFreed: 1, errors: [] };
      },
    });
    ctx.fire('session/disposed', { id: 'a' });
    ctx.fire('session/disposed', { id: 'b' });
    ctx.fire('session/disposed', { id: 'c' });
    await new Promise((r) => setTimeout(r, 220));
    ok(maxConcurrent === 1, 'three simultaneous disposals serialise into one sweep at a time', `max concurrent=${maxConcurrent}`);
    hook.dispose();
  }

  // ---- 11. an empty SAFE set does not call clean() at all ----
  {
    const ctx = fakeCtx();
    let cleaned = 0;
    const hook = installSessionHook(ctx, {
      cfg: { sessionCloseClean: true, sessionCloseMinAgeMs: 0 },
      log: quietLog,
      trackedRows: async () => [{ file_path: 'C:\\x\\b.bin', category: 'CAUTION_CACHE' }],
      clean: async () => {
        cleaned += 1;
        return { removed: 0, skipped: 0, bytesFreed: 0, errors: [] };
      },
    });
    ctx.fire('session/disposed', { id: 's6' });
    await new Promise((r) => setTimeout(r, 40));
    ok(cleaned === 0, 'nothing SAFE to delete -> clean() is not called at all', `clean calls=${cleaned}`);
    hook.dispose();
  }

  console.log(`\nSUMMARY pass=${pass} fail=${fail} verdict=${fail === 0 ? 'GREEN' : 'RED'}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
