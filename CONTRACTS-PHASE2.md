# dsh-c-cleaner — PHASE 2 FROZEN CONTRACT (v1)

Binds three parallel workstreams. Do not change a signature here without telling the Lead.
Phase 1 contract (`CONTRACTS.md`) stays in force; this file ADDS to it. Where they conflict,
this file wins for the scope it names.

## 0. Measured facts (do not re-litigate)

| Measurement | Value | Consequence |
|---|---|---|
| `psutil.Process(root).children(recursive=True)`, 11 members | **9.0 ms**, denied=0 | tree refresh is cheap |
| `open_files()` over those 11 members | **2062–2112 ms wall, 2016–2094 ms CPU** (3 reps) | handle→PID enumeration is ~2 s of pure CPU |
| Same, so a per-event handle probe is impossible | — | handle attribution MUST be a cached, opt-in index |
| PRD §6.1 budget | marginal CPU < 2 % | a 60 s sweep alone is ≈3.4 % → **`handleIndex` defaults OFF** |
| `hashlib`-free full sweep earlier measured | 3335 ms / 392 procs | same conclusion |

**Honest position to encode in code comments and README:** rule #1 (handle reverse-lookup)
is implemented and injectable, but cannot run inside the §6.1 budget at a useful interval,
so it ships **opt-in and off by default**. Rule #2 (session window + AI signature) is the gate
that actually runs in production.

## 1. PRD §3.2 gate — the semantics being implemented

PRD: a file is admitted **only if it satisfies at least one condition**:
1. handle reverse-lookup attributes it to a PID in the dsh process tree, **or**
2. its mtime is inside the dsh session window **and** its path/basename matches an AI-toolchain
   signature (`tmp*`, `pip-*`, `playwright*`, `node-*`, `*.pyc`, `*.log`, …).

**Safety valve (Lead decision, must be implemented):** a basename matching
`LOCKED_BASENAME_RE` (`\.lock$|\.sqlite3?$|\.db$|auth|config|token|credential`) is ALWAYS
admitted. Rationale: PRD §3.3 orders a dsh-authored `credentials.json` in Temp to surface as
🔴; a pure signature gate would silently noise-filter a credential file away. Safety beats
noise reduction. Configurable via `admitCriticalNames` (default `true`).

`cfg.noiseGate`:
- `'enforce'` (default) — drop non-admitted files, count them.
- `'audit'` — count them in `stats().gated` but still deliver (diagnostic mode).
- `'off'` — no gate, legacy passthrough.

## 2. `lib/watcher.js` (owner: watch-tracker)

Internal only; `CWatcher` public API is unchanged (`constructor({cfg,tree,log,onCandidate,now})`,
`start()`, `stop()`, `stats()`).

New / changed internals:
- `this._signatureGlobs` — compiled from, in order: `cfg.aiSignatureGlobs`, `cfg.excludeGlobs`,
  else `DEFAULT_AI_SIGNATURES` imported from `./config.js`. **`excludeGlobs` is an INCLUDE
  signature list** (misnamed in Phase 1; CONTRACTS.md §6 already describes it that way). It was
  compiled but never applied, so wiring it as an include is not a behaviour regression.
  `this._excludeNames` (segment list, default `['.dsh']`) remains a real EXCLUDE — keep it.
- `this._noiseGate` ∈ `{'enforce','audit','off'}`, default `'enforce'` when `cfg.noiseGate` is absent.
- `this._admitCritical` boolean, default `true` when `cfg.admitCriticalNames` is absent.

The admission decision (single point, in `_emit`, after attribution resolves):

```js
const inWindow = st.mtimeMs >= this._now() - this.sessionWindowMs;      // already computed
const signatureMatch = inWindow && matchesAnyGlob(candidate.path, this._signatureGlobs);
const criticalName   = this._admitCritical && LOCKED_BASENAME_RE.test(basename(candidate.path));
const rule1          = Number.isInteger(pid) && isMember === true;      // handle-attributed tree member
const admit          = rule1 || signatureMatch || criticalName;
```

Rules:
- Must be applied AFTER attribution so rule #1 keeps working whenever a handle backend exists.
- `noiseGate === 'off'` → always admit, never increment `gated`.
- `noiseGate === 'audit'` → always admit, increment `gated` when `!admit`.
- `noiseGate === 'enforce'` → drop when `!admit`: increment BOTH `this._counters.filtered`
  and `this._counters.gated`, `log.debug` the reason once, and do **not** call `_deliver`.
- `isMember` must be computed before the decision (today it is computed only inside the
  owner-found branch and only reported).
- `LOCKED_BASENAME_RE`: import from `./classifier.js` if that introduces no import cycle
  (verify by loading the module); otherwise define a local copy with a comment pointing at
  `classifier.js:49`. Do not silently diverge the pattern.

New counter: `stats().gated` (integer) — files dropped (or, in `audit`, that would be dropped)
by the §3.2 gate. `stats()` keeps every existing key, exact.

Optional fast path (recommended): in `_settle`, when rule #1 is **provably impossible** —
`!this.tree || typeof this.tree.ownerOf !== 'function' || this.tree.hasHandleBackend === false`
— and `!signatureMatch && !criticalName`, drop before attribution. This is only an optimisation;
the post-attribution decision point must still exist for the general case.

Also add to `lib/process-tree.js` (same owner): a `hasHandleBackend` accessor returning
`this.handleProbe !== null`, so the fast path can be taken honestly. Purely additive.

## 3. `lib/handle-index.js` (owner: handle-backend) — NEW FILE

```js
export class HandleIndex {
  /**
   * @param {{log?:object, pythonPath?:string|null, sweepMs?:number, timeoutMs?:number,
   *          budgetMs?:number, maxConsecutiveSlow?:number}} [opts]
   */
  constructor(opts = {})
  async start(): Promise<boolean>   // false (never throws) when python/psutil/bridge unavailable
  stop(): void
  lookup(filePath: string): {pid:number, name:string}|null   // SYNC, cache-only, never spawns
  async probe(filePath: string): Promise<{pid:number, name:string}|null>  // ProcessTree.handleProbe seam, never throws
  async sweep(): Promise<{ok:boolean, members:number, files:number, denied:number, ms:number, error?:string}>
  stats(): {available:boolean, sweeps:number, files:number, denied:number,
            lastMs:number, lastAt:number, avgMs:number, disabled:boolean}
}
```

Requirements:
- **ONE long-lived child process**, started with `spawn(python, ['-u', '-c', BRIDGE])`, speaking
  newline-delimited JSON: parent writes `sweep\n` / `quit\n`; the child answers exactly one JSON
  line per command. Never one spawn per file, never one spawn per sweep.
- The Python bridge is an EMBEDDED STRING in this file (no extra `.py` in the bundle). It must:
  `psutil.Process(root).children(recursive=True)` + the root itself, `open_files()` per member
  guarded by `except Exception` (count `denied`), rebuild the whole map every sweep (no stale
  entries), emit `json.dumps({...})` with default `ensure_ascii=True`, and never raise.
- `root` pid is passed via a CLI arg or the first stdin line — document which.
- `sweep()` is idempotent and never concurrent: coalesce with an in-flight promise.
- **Auto-disable:** when `lastMs > budgetMs` for `maxConsecutiveSlow` consecutive sweeps, set
  `disabled = true`, log once, and stop sweeping. `lookup()` keeps serving the last good cache.
- `lookup()` normalises with `String(p).replace(/\//g,'\\').toLowerCase()`; the map is keyed that way.
- `probe()` returns `lookup()`; if the cache is cold and `!disabled`, await one in-flight sweep first.
- Every failure path logs via `log.warn`/`log.debug` and returns a falsy value. **Never throw.**

## 4. Config keys (owner: Lead) — `lib/config.js` + `lib/config-schema.js`

Resolved config gains, all with fail-soft parsing like the existing keys:

| Key | Type / default | Meaning |
|---|---|---|
| `noiseGate` | `'enforce'` \| `'audit'` \| `'off'`, default `'enforce'` | PRD §3.2 gate mode |
| `admitCriticalNames` | boolean, default `true` | §3.3 safety valve (never noise-filter a credential-looking name) |
| `handleIndex` | boolean, default `false` | opt-in psutil handle backend (measured ~2 s CPU/sweep) |
| `handleSweepMs` | number, default `60000`, floor `15000` | sweep interval when `handleIndex` is on. Below the floor it falls back to `60000` (the `safeNumber` convention shared by every numeric key here — it does not clamp up to the floor) |
| `pythonPath` | string \| null, default `null` | explicit interpreter; `null` = resolve `python` from PATH |
| `recoverClientGraph` | boolean, default `true` | see §5 |

Any value not in the enum for `noiseGate` falls back to `'enforce'` (fail-CLOSED: the gate stays on).

## 5. `lib/client-graph.js` (owner: Lead) — NEW FILE, documented workaround

`clientModules` caches the parsed `dsh.client` declaration per `sourceKey` and NEVER invalidates
it (`@deepseek-ai/dsh-client-modules/lib/index.js:510,703,707,715,729` — no delete anywhere), so a
package whose manifest gained `dsh.client` after the process started stays out of the boot graph
until a restart. `export function recoverClientGraph(ctx, log)` feature-detects everything it
touches, no-ops on the first doubt, and logs which path it took. It may only run when the manifest
on disk declares `dsh.client`, the package's `./client` export exists, and `clientModules.graph()`
has no entry for our id. Never throws.

## 6. Verification bar (owner: verifier)

1. `node test/run.js` must stay **GREEN** (`verdict=GREEN`, exit 0) — the Phase 1 suite is the
   regression floor. Fixture names in the existing suites are gate-compatible (`*.tmp`, `*.log`,
   `pip-*`), but that must be ASSERTED by running it, never assumed.
2. Every new claim needs captured literal output (CONTRACTS.md §12: "A claim without captured
   output is not evidence").
3. New adversarial probes must include at least: an other-software Temp file (e.g.
   `Win11SDK_...msi`, `ScopedDir_...`) being REJECTED while a `pip-*` file in the same directory
   and second is ADMITTED; a credential-name file admitted by the §3.3 valve; `audit` and `off`
   modes behaving exactly as specified; `stats().gated` exactness; `HandleIndex` degrading to
   `available:false` with a bogus `pythonPath`; `lookup()` on an empty cache; the API fence refusing
   a foreign Origin; and `/clean` refusing a client-supplied category.
4. Mutation-test at least the gate's `admit` condition and the §3.3 valve on throwaway copies.
5. State the verdict as BOUND to the md5 set of `index.js`, `client.js`, `lib/*.js`.

## 7. Write scopes (disjoint)

| Task | Owner | Files |
|---|---|---|
| task-10 | watch-tracker | `lib/watcher.js`, `lib/process-tree.js`, `test/_dev-noise-gate.mjs` |
| task-11 | handle-backend | `lib/handle-index.js`, `test/_dev-handle-index.mjs` |
| task-12 | Lead | `lib/config.js`, `lib/config-schema.js`, `lib/client-graph.js`, `index.js`, `package.json`, `README.md` |
| task-13 | verifier | `test/adversarial-p2-*.mjs`, `test/run.js` |

Nobody edits another owner's file. Need a change there → message the owner.
