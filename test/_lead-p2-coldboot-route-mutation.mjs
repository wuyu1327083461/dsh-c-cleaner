/**
 * Mutation test for `_lead-p2-coldboot-route.mjs`.
 *
 * A probe that passes is worthless until a mutation makes it FAIL. This harness copies the
 * plugin into a throwaway tree, applies ONE mutation to `index.js`, `node --check`s the mutant
 * (so a broken mutation is never mistaken for a killed probe), then re-runs the probe and
 * requires it to fail.
 *
 * Mutations:
 *   M1  the ORIGINAL COLD-BOOT BUG: replace the scoped `ctx.inject(['webServer'], ...)` wiring
 *       with a bare `registerWebApi(ctx, ...)`. On a fresh boot `ctx.get('webServer')` is
 *       undefined, so the route never registers and the panel 404s.
 *   M2  remove the ownership check from the generation-level teardown, so a late stale teardown
 *       deletes the new generation's route.
 *   M3  neuter `releaseStaleRoute()`, so a stale route blocks the new generation's registration.
 *
 * M1 must break the probe; M2 and M3 must break section D.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROBE = path.join('test', '_lead-p2-coldboot-route.mjs');

/** Copy the plugin (skipping heavy/irrelevant dirs) into a temp tree. */
function copyTree(dest) {
  const skip = new Set(['.git', 'node_modules', 'docs']);
  const walk = (src, out) => {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const from = path.join(src, entry.name);
      const to = path.join(out, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        walk(from, to);
      } else {
        fs.copyFileSync(from, to);
      }
    }
  };
  fs.mkdirSync(dest, { recursive: true });
  walk(ROOT, dest);
}

/** The exact scoped-inject block, so M1 replaces a whole self-contained statement. */
const SCOPED_BLOCK = `  try {
    if (typeof ctx.inject !== 'function') throw new TypeError('ctx.inject is not available');
    ctx.inject(['webServer'], (webCtx) => {`;

const MUTATIONS = [
  {
    name: 'M1 bare ctx.get instead of scoped ctx.inject (THE ORIGINAL COLD-BOOT BUG)',
    expectSection: 'B',
    apply(source) {
      const start = source.indexOf(SCOPED_BLOCK);
      assert.ok(start > -1, 'M1 anchor (the scoped-inject block) not found');
      // Find the end of the whole try/catch: the line `  } catch (err) {` that follows, then its
      // closing brace. Including the WHOLE catch avoids leaving a dangling `} catch` that would
      // make `node --check` fail — a broken mutation, not a killed probe.
      const catchStart = source.indexOf('  } catch (err) {\n    log.warn(`panel api wiring failed', start);
      assert.ok(catchStart > start, 'M1 catch anchor not found');
      const catchClose = source.indexOf('\n  }\n', catchStart);
      assert.ok(catchClose > catchStart, 'M1 catch-close anchor not found');
      const end = catchClose + '\n  }\n'.length;
      const replacement = `  // MUTATED: the pre-fix wiring. A bare ctx.get returns undefined on a cold boot, so
  // registerWebApi degrades to a no-op and NO route is registered.
  {
    const claimMut = { stamp: routeStamp, dispose: null };
    webApiClaim = claimMut;
    try {
      claimMut.dispose = registerWebApi(ctx, webApiDeps);
      globalThis[WEB_API_ROUTE] = claimMut;
      log.info('panel api registered at /c-cleaner/api');
    } catch (err) {
      log.warn(\`panel api registration failed: \${err?.message || String(err)}\`);
    }
  }
`;
      return { source: source.slice(0, start) + replacement + source.slice(end) };
    },
  },
  {
    name: 'M2 generation teardown drops the ownership check',
    expectSection: 'D',
    apply(source) {
      const anchor =
        '      if (globalThis[WEB_API_ROUTE] === webApiClaim) {\n        webApiClaim?.dispose?.();\n        globalThis[WEB_API_ROUTE] = null;\n      }';
      assert.ok(source.includes(anchor), 'M2 anchor not found');
      return {
        source: source.replace(
          anchor,
          '      // MUTATED: unconditional dispose — deletes by PATH, so it kills the NEW route too.\n      webApiClaim?.dispose?.();\n      globalThis[WEB_API_ROUTE] = null;',
        ),
      };
    },
  },
  {
    name: 'M3 releaseStaleRoute neutered AND the reclaim disabled (both reclaim paths off)',
    expectSection: 'D',
    // Two INDEPENDENT mechanisms can clear a stale route: `releaseStaleRoute()` (via the
    // process-global claim slot) and `reclaimOwnRoute()` (via the web server's prefix table).
    // Disabling only one leaves the other working, so the probe still passes and the mutation
    // "survives" — a false gap. A mutation test must disable ALL redundant guards; verified: with
    // only `releaseStaleRoute` neutered this SURVIVED, with both disabled it is KILLED.
    apply(source) {
      const marker = '  const releaseStaleRoute = () => {';
      assert.ok(source.includes(marker), 'M3 anchor not found');
      return {
        source: source.replace(marker, '  const releaseStaleRoute = () => { return; /* MUTATED */'),
      };
    },
    also: [
      {
        file: 'lib/web-api.js',
        marker: '  reclaimOwnRoute();',
        replacement: '  // MUTATED: reclaim disabled too (see M3).\n',
      },
    ],
  },
  {
    name: 'M4 stale-route reclaim disabled (THE MEASURED LIVE 500)',
    expectSection: 'E',
    apply(source) {
      // `reclaimOwnRoute` lives in `lib/web-api.js`, not in `index.js`, so the mutation has to
      // target that file. It is applied to the copied tree's `lib/web-api.js` by `applyTo`.
      const marker = '  reclaimOwnRoute();';
      assert.ok(source.includes(marker), 'M4 anchor not found');
      return {
        source: source.replace(
          marker,
          '  // MUTATED: skip the reclaim, so a phantom route keeps the path and `register` throws\n  // `webserver: duplicate prefix route`, leaving the DEAD generation handler serving 500s.\n',
        ),
      };
    },
    file: 'lib/web-api.js',
  },
];

let allKilled = true;
for (const mutation of MUTATIONS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-coldboot-mut-'));
  try {
    copyTree(dir);
    // The target file defaults to `index.js`; M4 mutates `lib/web-api.js` (where `reclaimOwnRoute`
    // lives), so honour `mutation.file` — a mutation applied to the wrong file would "survive" and
    // look like a probe gap when it is really a mutation-authoring mistake.
    const targetRel = mutation.file ?? 'index.js';
    const targetPath = path.join(dir, targetRel);
    const original = fs.readFileSync(targetPath, 'utf8');
    const { source: mutated } = mutation.apply(original);
    assert.notEqual(mutated, original, `${mutation.name}: mutation did not change the source`);
    fs.writeFileSync(targetPath, mutated);

    // A mutation that does not parse is not a killed probe.
    try {
      execFileSync(process.execPath, ['--check', targetPath], { stdio: 'pipe' });
    } catch (err) {
      throw new Error(
        `${mutation.name}: mutant does not parse (broken mutation, not a killed probe): ${err.stderr ?? ''}`,
      );
    }

    // Secondary mutations, for guards that are REDUNDANT with the primary one. Disabling only one
    // of two independent mechanisms lets the probe pass for the wrong reason and the mutation
    // "survive" (verified for M3: neutering `releaseStaleRoute` alone SURVIVED, because
    // `reclaimOwnRoute` still cleared the path).
    for (const extra of mutation.also ?? []) {
      const extraPath = path.join(dir, extra.file);
      const extraSrc = fs.readFileSync(extraPath, 'utf8');
      assert.ok(extraSrc.includes(extra.marker), `${mutation.name}: secondary anchor not found in ${extra.file}`);
      fs.writeFileSync(extraPath, extraSrc.replace(extra.marker, extra.replacement));
      try {
        execFileSync(process.execPath, ['--check', extraPath], { stdio: 'pipe' });
      } catch (err) {
        throw new Error(`${mutation.name}: secondary mutant does not parse: ${err.stderr ?? ''}`);
      }
    }

    let output = '';
    let exitCode = 0;
    try {
      output = execFileSync(process.execPath, [PROBE], {
        cwd: dir,
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 180000,
      });
    } catch (err) {
      exitCode = err.status ?? 1;
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }

    const verdictLine = output.split('\n').find((l) => l.startsWith('verdict=')) ?? '(no verdict)';
    const killed = exitCode !== 0 && !verdictLine.includes('COLD-BOOT-ROUTE-OK');
    const failedChecks = output
      .split('\n')
      .filter((l) => l.trim().startsWith('FAIL'))
      .map((l) => l.trim().slice(0, 120));

    if (killed) {
      console.log(`KILLED   ${mutation.name}`);
      console.log(`         ${verdictLine}`);
      for (const f of failedChecks.slice(0, 3)) console.log(`         ${f}`);
    } else {
      allKilled = false;
      console.log(`SURVIVED ${mutation.name}  <-- THE PROBE DOES NOT TEST THIS`);
      console.log(`         ${verdictLine}`);
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log('');
if (allKilled) {
  console.log('MUTATION TEST PASSED: every mutation makes the probe fail');
  process.exitCode = 0;
} else {
  console.log('MUTATION TEST FAILED: a mutation survived, so the probe proves less than claimed');
  process.exitCode = 1;
}
