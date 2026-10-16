/**
 * PRD §3.1 — environment variable hijack (the migration seam).
 *
 * dsh spawns every model `bash`/`pwsh` tool call as a child of the harness process.
 * `dsh-subprocess/lib/index.js:50-53` re-reads `process.env` on **every** spawn and
 * builds the child environment from it (see CONTRACTS.md §0). Therefore mutating
 * `process.env` from inside `apply()` is sufficient — and is the only seam available,
 * because `ctx.shellEnv` is typed to accept `DSH_*` names exclusively.
 *
 * The user's system-wide environment is never written to (PRD 3.1 requirement).
 *
 * @module dsh-c-cleaner/lib/env-hijack
 */

import fs from 'node:fs';
import path from 'node:path';

import { SCRUB_PATTERN, NOOP_LOG } from './config.js';

/**
 * Redirects a configured set of cache/temp variables into a non-C: escape root for the
 * lifetime of the harness process, and can put them back exactly as they were.
 */
export class EnvHijacker {
  /**
   * @param {object} cfg - resolved config from {@link resolveConfig}.
   * @param {{debug:Function,info:Function,warn:Function,error:Function}} [log] - harness logger.
   */
  constructor(cfg, log = NOOP_LOG) {
    this.cfg = cfg;
    this.log = log;
    /** @type {Map<string, string|undefined>} exact pre-install values, for restore(). */
    this.previous = new Map();
    /** @type {boolean} */
    this.installed = false;
  }

  /**
   * Create every target directory and point the configured variables at them.
   *
   * Never throws: a failure to create one directory degrades that single entry.
   *
   * @returns {{ok:boolean, applied:Array<{name:string,value:string,previous:string|null}>,
   *            createdDirs:string[], skipped:Array<{name:string,reason:string}>, errors:string[]}}
   */
  install() {
    const applied = [];
    const createdDirs = [];
    const skipped = [];
    const errors = [];

    if (!this.cfg.enabled) {
      return { ok: false, applied, createdDirs, skipped, errors: ['plugin disabled by config'] };
    }

    if (!this.cfg.isWindows) {
      // PRD 6.4: the C-drive premise does not exist elsewhere. Refuse loudly, do not throw.
      this.log?.warn?.('[c-cleaner] non-Windows host: environment hijack skipped');
      return { ok: false, applied, createdDirs, skipped, errors: ['host is not Windows'] };
    }

    for (const [name, subdir] of Object.entries(this.cfg.envMap)) {
      // HARD RULE (CONTRACTS §0): the harness scrub layer deletes any variable matching
      // /KEY|PASSWORD|SECRET|TOKEN/i from the child env before it starts, so injecting one
      // would look like success while having zero effect. Report it instead of lying.
      if (SCRUB_PATTERN.test(name)) {
        skipped.push({ name, reason: 'name matches harness scrub pattern; child would not receive it' });
        continue;
      }

      const target = path.join(this.cfg.escapeRoot, subdir);
      try {
        fs.mkdirSync(target, { recursive: true });
      } catch (err) {
        errors.push(`${name}: mkdir ${target} failed: ${err?.code || err?.message || String(err)}`);
        continue;
      }
      if (!createdDirs.includes(target)) createdDirs.push(target);

      // Record once, from the first install — a second install() must not overwrite the
      // saved original with our own hijacked value.
      if (!this.previous.has(name)) this.previous.set(name, process.env[name]);

      const before = process.env[name] ?? null;
      process.env[name] = target;
      applied.push({ name, value: target, previous: before });
    }

    this.installed = applied.length > 0;
    if (applied.length) {
      this.log?.info?.(
        `[c-cleaner] redirected ${applied.length} env var(s) to ${this.cfg.escapeRoot} (PRD 3.1)`,
      );
    }
    for (const e of errors) this.log?.warn?.(`[c-cleaner] ${e}`);

    return { ok: errors.length === 0 && applied.length > 0, applied, createdDirs, skipped, errors };
  }

  /**
   * Re-read `process.env` and report, per variable, whether the redirect is still in force.
   * Cheap and side-effect free — `c-clean status` calls this on every invocation.
   *
   * @returns {{installed:boolean, escapeRoot:string,
   *            entries:Array<{name:string,expected:string,actual:string|null,ok:boolean}>}}
   */
  status() {
    const entries = Object.entries(this.cfg.envMap)
      .filter(([name]) => !SCRUB_PATTERN.test(name))
      .map(([name, subdir]) => {
        const expected = path.join(this.cfg.escapeRoot, subdir);
        const actual = process.env[name] ?? null;
        return { name, expected, actual, ok: actual === expected };
      });

    return {
      installed: entries.length > 0 && entries.every((e) => e.ok),
      escapeRoot: this.cfg.escapeRoot,
      entries,
    };
  }

  /**
   * Put every touched variable back to the exact value it had before {@link install}.
   * Variables that did not exist are deleted again rather than set to the string "undefined".
   */
  restore() {
    for (const [name, previous] of this.previous) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    this.previous.clear();
    this.installed = false;
  }
}
