# SPEC — BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001

Architect: sonnet, stage 1 of architect → implementer → reviewer → implementer → reviewer.
Worktree: `/Users/nix/dev/ai/sox-ecosystem/.worktrees/embed-warmup-cold-retry`, branch `feat/embed-warmup-cold-retry`.
Toolchain verified working in this worktree (`pnpm install` clean; `npx nx test embedding-provider -- src/bl376-warmup-timeout-split.spec.ts` → 4/4 pass) before this spec was written.

BL-376 is correctly RESOLVED. Do not reopen or revert `warmupTimeoutMs(cacheHit)` (8s cache-hit / 180s
cache-miss split). This item is a successor, not a fix to that split's arithmetic.

---

## 1. Root cause (three separate defects, all read personally, all required)

### 1a. The factory discards real progress on a cache-hit timeout

`libs/data/embed/embedding-provider/src/index.ts:214-229` (`createFastembedProvider`):

```ts
const provider = new FastembedProvider(modelId, cfg.dim, cacheDir);
const cacheHit = isModelCached(cacheDir, cfg.hfRepoId);
await withTimeout(provider.embedSingle('warmup'), warmupTimeoutMs(cacheHit), 'fastembed warmup');
return provider;
```

`withTimeout` (index.ts:297-314) races the real call against a `setTimeout` and rejects on timeout
without cancelling or awaiting the real call. `provider.embedSingle('warmup')` → `ensureReady()` →
`initModel()` (`fastembed.ts:259-289`) sends an `{type:'init'}` IPC request to the **process-wide
singleton** shared fastembed child (`getSharedFastembedProcess()`, `sharedFastembedProcess.ts:374-377`
— one child process for the life of the parent, `.unref()`'d, outlives any single init attempt). That
IPC request has its own matching timeout inside `SharedFastembedProcessClient.request()`
(`sharedFastembedProcess.ts:276-287`), which on expiry does `this.pending.delete(id); reject(...)` —
it does **not** tell the child to stop. The child's own request queue (`fastembedProcessHost.ts:279-283`,
`enqueue`/`_queue`) keeps running `loadModel()` to completion in the background. When it finishes and
calls `send({id, initOk:true, ...})` (`fastembedProcessHost.ts:311-319`), the parent's
`c.on('message', ...)` handler (`sharedFastembedProcess.ts:142-152`) finds `this.pending.get(msg.id)`
already deleted and drops the reply silently. This is the exact orphan shape from the live repro: a
child alive at 0% CPU holding a fully loaded model, with a parent that gave up and forgot it ever asked.

Because `createFastembedProvider()` throws on the outer timeout, the `FastembedProvider` instance that
was mid-`initModel()` is discarded — nothing in the process retains a reference to it, so even the
*next* line of JS can't observe that its background load eventually succeeded.

### 1b. `getOrCreateProvider()` caches the rejected promise forever — this is "no retry"

`libs/memory-core/src/embed.ts:186-200`:

```ts
async function getOrCreateProvider(): Promise<EmbeddingProvider> {
  if (_testProvider !== null) return _testProvider;
  if (_provider) return _provider;
  if (_providerPromise) return _providerPromise;
  _providerPromise = resolveProvider().then((p) => {
    _provider = p;
    _providerPromise = null;
    return p;
  });
  return _providerPromise;
}
```

`.then()` only runs on **fulfillment**. When `resolveProvider()` rejects, `_providerPromise` is never
reset to `null` — it stays pointing at the same rejected promise for the rest of the process's life.
Every subsequent `embed()` call (`embed.ts:228-262`, `_embedWork` at :264-300) calls
`getOrCreateProvider()` again, hits `if (_providerPromise) return _providerPromise;`, and gets back the
**same already-rejected promise** — no new attempt is ever made, no matter how many recalls/writes
happen or how much time passes. `_resetEmbedSingleton()` (embed.ts:383-390) is the only code that ever
clears `_providerPromise`, and it is `_`-prefixed test-only, never called from a production path. This
is the literal, sole reason the live incident "did not lazily recover across ~5 minutes and multiple
recall calls" — the promise doing the caching was permanently poisoned at the first failure, and
nothing in production ever un-poisons it.

Confirmed independently: `sharedFastembedProcess.ts`'s child-process singleton persists at module scope
for the parent's lifetime regardless of how many `FastembedProvider` instances come and go. A *second*
`FastembedProvider` sending a fresh `{type:'init'}` after the first backgrounded load finishes routes to
`fastembedProcessHost.ts:226-231`'s fast path (`if (_embedder && _currentModel === model && ...) return
cached info`) — near-instant. So once §1b's caching bug is fixed, a subsequent natural `embed()` call
made minutes later is very likely to succeed fast, because the original cold read has long since
finished in the background. This matches the observed repro shape precisely.

### 1c. The top-level health verdict is a hardcoded literal, not a computed one

`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:1084-1107` (the `memory_ping`
response):

```ts
return {
  content: [{
    type: 'text',
    text: JSON.stringify({
      ok: true,               // ← literal, unconditional
      id: addr.id,
      ...
      embed: embedBlock,      // ships embedHealth.state further down, unread by `ok`
      ...
      embed_state: embedHealth.state,
      last_embed_error: embedHealth.last_error,
    }),
  }],
};
```

`ok: true` is written on line 1088 with no reference to `embedHealth` at all. The truthful state
(`embedHealth.state`, sourced from `getEmbedHealth()` at line 852, itself from
`libs/memory-core/src/embed.ts:147-158`) is present in the payload but nothing elevates it to the
field an operator glances at first. This is the exact shape of BL-167/BL-319/BL-469: a true fact buried
under a false-looking summary.

---

## 2. The change, file by file

### OWNED — edit these

**`libs/data/embed/embedding-provider/src/index.ts`**
- Add `export const WARMUP_CACHE_HIT_ATTEMPTS = 2;` next to `warmupTimeoutMs` — the single source of
  truth for how many attempts a cache-hit warmup gets. Document why: a second attempt's IPC request
  queues behind the first attempt's still-running background load in the shared child
  (`fastembedProcessHost.ts`'s serialized `_queue`), so it resolves once that load finishes rather than
  restarting from zero — see §1a/§3 for why this is expected to work, not merely hoped to.
- Add `export function warmupOuterBudgetMs(cacheHit: boolean): number` = `(cacheHit ?
  WARMUP_CACHE_HIT_ATTEMPTS : 1) * warmupTimeoutMs(cacheHit)`. This is the **outer** factory-level
  guard around the whole (possibly-retried) warmup; it must never drift from the inner per-attempt
  budget × attempt count, which is why it's derived from `warmupTimeoutMs` and
  `WARMUP_CACHE_HIT_ATTEMPTS` rather than hand-typed — BL-376's own postmortem is literally about two
  hand-typed copies disagreeing (SOX-BUG-001 in the existing doc comment at :253-261). Do not repeat
  that mistake here with a third hand-typed number.
- `createFastembedProvider()` (:196-230): replace `warmupTimeoutMs(cacheHit)` at the `withTimeout(...)`
  call with `warmupOuterBudgetMs(cacheHit)`. Nothing else in this function changes — the retry logic
  itself lives in `fastembed.ts`, not here (§3 explains why).
- Cache-miss (`cacheHit === false`) path is **unchanged**: `warmupOuterBudgetMs(false) ===
  warmupTimeoutMs(false) === 180_000`, one attempt, exactly like today. The bug is specifically about
  the cache-hit branch being miscalibrated for a cold-but-present file; a genuine cache-miss download
  already gets a generous single budget and retrying a stuck download is a different, unvalidated
  problem this item does not take on (§3, decision 3).

**`libs/data/embed/embedding-provider/src/fastembed.ts`**
- `initModel()` (:267-289): wrap the existing single `this.shared.request(...)` call in a loop bounded
  by `cacheHit ? WARMUP_CACHE_HIT_ATTEMPTS : 1` iterations, each attempt using
  `warmupTimeoutMs(cacheHit)` (per-attempt budget, unchanged from BL-376). On success at any attempt,
  set `ready`/`_lastError`/`_executionProvider` exactly as today and return. On failure of an
  intermediate attempt, log (see §6, no new logging package — reuse whatever this file already has
  available, i.e. nothing; this file currently has no `log` import, don't add one carrying a new
  dependency — a comment is sufficient, this is not a telemetry requirement) and loop. On failure of
  the **final** attempt, preserve exactly today's behavior: set `this._lastError`, set
  `this.readyPromise = null` (already present, keep it — it is what lets a *caller who holds this same
  `FastembedProvider` instance* retry later), and rethrow.
- Import `WARMUP_CACHE_HIT_ATTEMPTS` from `./index.js` alongside the existing `warmupTimeoutMs,
  isModelCached` import at :1.
- Do not change `ensureReady()` (:259-265) — its idempotency/dedup-in-flight contract is correct and
  orthogonal to this change.

**`libs/memory-core/src/embed.ts`** — see §3 decision 1 for why this file, not excluded from your
scope, is the necessary and sufficient location for the "lazy retry across the process's life" half.
- `getOrCreateProvider()` (:186-200): the `_providerPromise` assignment must clear itself on
  **rejection**, not just resolution. Change:
  ```ts
  _providerPromise = resolveProvider().then((p) => {
    _provider = p;
    _providerPromise = null;
    return p;
  });
  ```
  to attach a rejection handler that also clears `_providerPromise`, e.g.:
  ```ts
  _providerPromise = resolveProvider().then(
    (p) => {
      _provider = p;
      _providerPromise = null;
      return p;
    },
    (err) => {
      _providerPromise = null;
      throw err;
    },
  );
  ```
  This is the entire fix for §1b. Do not touch `resolveProvider()`, `_resolvedBackend`,
  `_lastEmbedError`, or any other function in this file — the bug is exactly this one un-cleared
  variable on one path.

**`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`** — `memory_ping` handler
only (:850-1108). See §3 decision 2 for the `ok` vs `status` ruling.
- Add a computed `status: 'ok' | 'degraded'` field to the top-level JSON object returned at
  :1087-1106, derived as `embedHealth.state === 'real' ? 'ok' : 'degraded'`.
- Do **not** change `ok: true` (:1088) — it keeps meaning "this MCP call itself succeeded / the server
  answered," identical to every other tool's `{isError: true}`-vs-absent contract described in this
  extension's own `CLAUDE.md` ("Tools return `{isError: true, ...}` on error"). `status` is the new,
  additive field an operator/dashboard is meant to read as the actual verdict — see §3 decision 2 for
  the full argument.
- Place `status` immediately after `ok` in the object literal (readability only, no functional
  requirement).
- This is the **only** functional change to this file. Everything else in the `memory_ping` block —
  `instanceBlock`, `storeBlock` construction, `integrityView`, all the SQL reads — is untouched.

### OUT OF BOUNDS — do not edit

- **`libs/data/store/store-adapter/src/**`** (including `integrity-status.ts`) — owned by the sibling
  packet working `BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001`/adjacent store-adapter work concurrently.
  Confirmed by reading `integrity-status.ts` in full: `IntegrityStatusView.overall` is an unrelated,
  already-correct "never infer health" verdict for store *integrity* (BL-334/BL-347), not embed state.
  No change there is needed or wanted for this item.
- **`libs/memory-core/src/telemetry.ts`** — explicitly excluded by the dispatch. Not touched, not read
  for anything beyond what was already necessary to trace `log.info`/`log.warn` call shapes used
  elsewhere in files you *do* own (`sharedFastembedProcess.ts` already imports `log` from
  `@adhd/sox-telemetry` — reference only, no edit).
- **`libs/memory-core/src/stats.ts`** — `memory_stats`'s `embed_state` field (stats.ts:92,349) is
  read-only reportage of the same `getEmbedHealth()` state; it has no top-level `ok`/`status` verdict
  to correct (confirmed by reading the `memory_stats` handler in index.ts:1946-1989 — no `ok` field
  exists in that response at all, only the raw stats object plus `integrity`/`telemetry_self_check`/
  `ontology`). Nothing to change here for this item.
- **Any other `memory_ping`/`memory_stats` field not named above** — `storeBlock`, `integrityView`,
  `enrichmentHealth`, `embed_backlog`, etc. all stay exactly as they are.

---

## 3. Every decision, ruled

**Decision 1 — where does the "no retry" fix live: `embedding-provider` (owned) or
`libs/memory-core/src/embed.ts` (not on the excluded list, but also not on the explicitly-named
"you own" list)?**

Ruling: **both**, doing different jobs, and `embed.ts` is in scope.

- The dispatch names two files/dirs as explicitly forbidden — `libs/data/store/store-adapter/` and
  `libs/memory-core/src/telemetry.ts`. `libs/memory-core/src/embed.ts` is not one of them.
- §1b shows the caching-forever-rejected-promise bug is the *sole* mechanism by which the live
  incident's "did not recover across ~5 minutes and multiple recall calls" happened — every one of
  those recall calls called `embed()` → `getOrCreateProvider()` and got back the same dead promise. No
  change inside `embedding-provider` alone can fix that: even a perfect in-factory retry only bounds
  the *first* attempt's startup window (§3 decision 3's ~16s), and the acceptance criterion requires
  the provider not stay "permanently uninitialized" — permanently is a claim about the rest of the
  process's life, which only `embed.ts`'s singleton-caching layer controls.
- Losing alternative: fix only inside `embedding-provider` (retry-in-factory only, leave `embed.ts`
  untouched). This satisfies the "single retry would have succeeded" framing for the common ~16s-window
  case but leaves the literal "permanently uninitialized… did not recover across 5 minutes" defect
  fully alive for any cold load slower than the in-factory retry budget — which is exactly the boundary
  condition an operator hits on a slow disk/degraded machine, i.e. precisely when the fix matters most.
  Rejected: it would ship a fix that passes the acceptance criterion's easy case and fails its literal
  wording on the hard case.
- Losing alternative: fix only inside `embed.ts` (no in-factory retry). This would work for the "next
  natural embed() call retries" mechanism, but does nothing for the ~16s window at *startup* — a fresh
  `warmupEmbed()`/first-recall call still fails outright on a cold-but-present model with no automatic
  recovery until *something else* calls `embed()` again, which may not happen promptly (or at all, if
  the server sits idle after boot). Both layers are needed; neither alone satisfies "must either
  complete or retry."

**Decision 2 — does `embed_state !== 'real'` flip `memory_ping`'s `ok` to `false`, or land as a new
field?**

Ruling: **new additive `status` field; `ok` keeps its existing "RPC succeeded" meaning.**

- Argument for flipping `ok`: it is the single field named in the item's own acceptance text ("the
  top-level health verdict must not read `ok`"), and it is the very first thing an operator's eye
  lands on.
- Argument against, and the one that wins: `ok`/`isError` is the *entire MCP tool-call contract* for
  all 20 tools in this server (documented in this extension's own `CLAUDE.md`: "Tools return
  `{isError: true, ...}` on error" — the absence of `isError`, paired with a truthy `ok`, is what every
  other tool in this file means by "the call itself worked"). A process supervisor, smoke test, or
  automated health poller that treats `memory_ping`'s `ok` as liveness — "the server answered, is not
  crashed, is not hung" — is a reasonable and likely consumer given that contract, and repurposing `ok`
  specifically on this one tool to also mean "and every subsystem is fully healthy" breaks that
  consumer's assumption silently, exactly the kind of blast-radius change the item's own text flags as
  a real risk ("may trip alarms that expect it to mean process alive"). The dispatch asks me to rule on
  this explicitly rather than dodge it — this is that ruling, not a dodge: `ok` stays untouched, a new
  field carries the real verdict.
- `status: 'ok' | 'degraded'` is additive (HF-3, the rule already followed at :1039's own comment "never
  rename/remove the fields above" for the store block) and mirrors an existing, already-proven pattern
  in this exact file: `integrity.overall` (from `summarizeIntegrityForStatus`,
  `integrity-status.ts:53`, "The single field an operator or a gate should branch on") is precisely
  this shape — a dedicated verdict field distinct from the RPC-success boolean. `status` at the top
  level of `memory_ping` is the same idea applied one level up, for the same reason.
- This satisfies the acceptance criterion's actual intent — "an operator glancing at the health verdict
  saw a healthy server [that was not]" — because `status` *is* the verdict field going forward, it is
  just not spelled `ok`. A reviewer/implementer must not weaken this back to touching `ok` to make a
  test "read better"; that is the losing alternative above, not a stylistic choice.
- Scope of `degraded`: **embed-state only** (`embedHealth.state !== 'real'`) for this item. `storeBlock`
  already carries its own `integrity`/`enrichment` verdicts nobody has asked to fold into `status` here,
  and doing so would touch fields owned by the sibling packet's area (`integrity-status.ts`) or expand
  scope well past "the health/embed-state surface" the dispatch fenced. If a future item wants `status`
  to also reflect store integrity or enrichment stall, that is an additive OR onto this same field, not
  a reason to block this one.

**Decision 3 — retry attempt count and budget for the cache-hit branch: how many attempts, and does a
retry use a fresh `FastembedProvider` or the same instance?**

Ruling: **exactly 2 attempts, same tight per-attempt budget (`warmupTimeoutMs(true)`, default 8s each,
16s total default), same `FastembedProvider` instance, loop lives inside `initModel()` not the outer
factory.**

- Why 2, not more: §1a's mechanism — a retry's IPC request queues behind the still-running first
  attempt in the child's serialized `_queue` (`fastembedProcessHost.ts:279-283`) and resolves once that
  finishes — means a second attempt only needs to *wait long enough for the background load to finish*,
  not redo any work. A third attempt buys nothing a second attempt didn't already have the chance to
  catch, and every additional attempt linearly extends the worst-case fully-hung-load failure time
  (§3 decision 3's own bound below). 2 is the minimum that turns "single retry would have succeeded"
  (the item's own words) into code.
- Why the same tight budget per attempt, not an escalating one (e.g. attempt 2 gets the 180s
  cache-miss budget): an escalating budget defeats BL-376's whole point — "a hang here must surface
  fast instead of silently eating three minutes" — for the one case that actually matters, a
  genuinely-hung/corrupt cached model. With two tight attempts, a truly hung load still fails loud in a
  bounded ~16s (default), preserving BL-376's fail-fast guarantee; escalating to 180s on retry would
  let a hung cache-hit silently eat three minutes again, which is the exact regression BL-376 was
  written to prevent. Losing.
- Why the same instance, not a fresh `FastembedProvider`: a fresh instance would still route through
  the same `getSharedFastembedProcess()` singleton (verified: it's module-scoped in
  `sharedFastembedProcess.ts:374-377`, one per parent process regardless of caller), so it costs nothing
  functionally — but it does cost a second, pointless object allocation and constructor call for no
  behavioral difference. Reusing `provider.embedSingle('warmup')` (which internally re-invokes
  `ensureReady()` → `initModel()` since `this.readyPromise` was cleared to `null` by the prior failed
  attempt, per the *already-existing* comment at fastembed.ts:284-286) is simpler and is why the retry
  loop belongs **inside** `initModel()`, not as an outer wrapper reconstructing the provider.
- Total worst-case bound if genuinely hung/corrupt: `warmupOuterBudgetMs(true)` = 2 × 8_000ms = 16_000ms
  default, fully configurable via the existing `SOX_EMBED_WARMUP_CACHED_TIMEOUT_MS` env var (unchanged
  — it still controls the *per-attempt* budget; two attempts at whatever value the operator sets it to).
  This is the answer to the dispatch's "say what happens when the retry also fails": `initModel()`
  throws exactly as it does today (`this._lastError` set, `this.readyPromise = null`, rethrow),
  `createFastembedProvider()`'s catch wraps it in `ResolutionError` exactly as today, and — because of
  Decision 1's `embed.ts` fix — the *next* natural `embed()` call (on whatever cadence the caller
  happens to make one; not actively scheduled by this item) gets a fresh `resolveProvider()` attempt
  instead of the permanently-poisoned promise. Nothing about this item introduces an unbounded startup
  hang: startup itself is still bounded to `warmupOuterBudgetMs(cacheHit)`; only the *lifetime* recovery
  (Decision 1) is unbounded in wall-clock terms, and it was already effectively that way before this
  bug (an operator restart is itself an unbounded-in-time manual recovery) — this item makes recovery
  automatic instead of manual, it does not remove a bound that existed before.
- Cache-miss branch gets no retry (1 attempt, 180s, unchanged) — a stuck *download* is a materially
  different failure mode than a stuck *local read*, fastembed's own download path may have its own
  retry/resume semantics this item has not audited, and the item's own reproduction and "suggested
  directions" are entirely about the cache-hit branch. Extending retry to cache-miss is out of scope;
  note it as a candidate follow-up, do not implement it.

**Decision 4 — does the retry loop log anything, and via what mechanism?**

Ruling: **a plain inline comment marking the retry boundary is sufficient; do not add a `log`
import/dependency to `fastembed.ts`.** `fastembed.ts` currently imports nothing from
`@adhd/sox-telemetry` and has no existing logging surface — introducing one for this alone is a new,
undeclared-in-package.json dependency edge into a file that today has zero I/O side effects beyond the
IPC calls it already makes, and adding telemetry there is unrelated scope. `sharedFastembedProcess.ts`
(a sibling file in the same package) already logs `fastembed_process.request.error`/`.finish` around
every request including the retried ones — an operator inspecting logs already sees two distinct
`fastembed_process.request.error` (or `.finish`) lines for the two attempts, with `queue_depth` visible
on each. That is sufficient observability without adding a new log line at the `initModel()` level.

**Decision 5 — is `EmbeddingHealth.state` (`'uninitialized'|'warming'|'real'|'error'`, index.ts:24) or
`EmbedHealth.state` (memory-core `'real'|'uninitialized'`, embed.ts:127) the one gating `memory_ping`'s
new `status` field?**

Ruling: **`EmbedHealth.state` from `getEmbedHealth()`** (already what `memory_ping` reads at index.ts:852
into `embedHealth`) — it is the field the memory-server handler already has in scope, already flows into
the existing `embed_state` legacy key, and is definitionally "is the vec channel usable" for this
server's purposes (it collapses the finer-grained provider-level `'warming'`/`'error'` states, which
memory-core's `getEmbedState()` — embed.ts:128-132 — already does deliberately: "warming" and "error"
both count as not-yet-`'real'`, i.e. not-yet-serving-vectors, which is exactly the condition `status`
needs to detect). No new state derivation logic is needed; `embedHealth.state === 'real'` is the entire
predicate.

---

## 4. Acceptance criteria, each naming BL-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001

All four are RED today (no fix present) and must be shown RED-then-GREEN per BL-225 — watch each fail
without the fix, then pass with it. `bl376-warmup-timeout-split.spec.ts`'s `makeDelayedClient` pattern
(injected `SharedFastembedProcessClient`, `vi.useFakeTimers()`) is the proven harness for AC-1/AC-2;
reuse its shape rather than re-inventing fake-timer plumbing.

**AC-1 (embedding-provider, §1a/§3 decision 3) — a cold-but-cached load that exceeds one tight budget
but completes before the second recovers via the in-process retry.**
- Setup: model file present on disk (`isModelCached` → true). Inject a fake
  `SharedFastembedProcessClient` whose `'init'` handler, on its FIRST invocation, resolves only after a
  delay longer than `warmupTimeoutMs(true)` but shorter than `warmupOuterBudgetMs(true)` (e.g. delay =
  `warmupTimeoutMs(true) + 2000` with 2 attempts of 8s each — the delayed resolution lands during the
  *second* attempt's window because the fake client's single in-flight promise is what both attempts
  await, mirroring the real child's serialized queue) — OR, more directly: model the fake client so its
  FIRST call rejects/never-resolves within budget while its SECOND call resolves immediately, since
  that is the literal, simpler shape of "the second attempt catches what the first missed" and does not
  require reasoning about the fake's internal queuing to match the real child's.
- RED (today): `provider.embedSingle('warmup')` rejects after exactly one `warmupTimeoutMs(true)` window
  and `createFastembedProvider()`/the outer call rejects — there is no second attempt, so a client whose
  second call would have succeeded never gets asked.
- GREEN (after fix): the outer call succeeds within `warmupOuterBudgetMs(true)`, and
  `provider.health().state === 'real'`.

**AC-2 (embedding-provider, §3 decision 3's bound) — a genuinely hung load still fails within the
bounded total, not the old single-attempt time and not unboundedly.**
- Setup: fake client's `'init'` handler never resolves (mirrors `bl376`'s existing `makeDelayedClient(15_000)`
  pattern, extended so BOTH attempts hang).
- RED (today): irrelevant as a regression per se (today's single-attempt already fails at 8s) — the RED
  arm here is specifically that **the total bound is untested and unenforced before this fix**: assert
  the rejection happens at `warmupOuterBudgetMs(true)` (~16s default) and not later — before the fix,
  `warmupOuterBudgetMs` does not exist, so this assertion cannot even be written, which IS the red state
  (a compile/import failure until the export exists is an acceptable red arm for a new export).
- GREEN: rejects at ≈`warmupOuterBudgetMs(true)`, `provider.health().state === 'error'`,
  `provider.health().last_error` is populated.

**AC-3 (memory-core, §1b/§3 decision 1) — a failed provider resolution does not permanently poison
subsequent `embed()`/`getOrCreateProvider()` calls.**
- Use `_setEmbedProviderForTest`/module-level test seams already in `embed.ts`, OR inject a resolution
  failure by pointing `SOX_EMBED_CACHE_DIR`/model config at a state that makes `createEmbeddingProvider`
  reject deterministically without touching the real fastembed path (the reviewer/implementer must find
  a way to make `resolveProvider()` reject once, then succeed, without forking a real child process —
  e.g. a test-only override hook may need to be added to `embed.ts` if none exists; check
  `_setEmbedProviderForTest` first since it bypasses `resolveProvider()` entirely and may not be
  suitable for testing `resolveProvider()`'s own retry-ability. If no clean seam exists, add one
  `_`-prefixed test-only override (mirroring `_setEmbedProviderForTest`'s existing pattern exactly) —
  this is within the owned file and is exactly the kind of test seam this codebase already uses
  throughout `embed.ts`).
- RED (today): call `getOrCreateProvider()` (indirectly via `embed()`/`warmupEmbed()`) once and observe
  it reject; make the underlying condition that caused the rejection now resolvable (e.g. flip whatever
  test seam was used to now succeed); call `embed()`/`warmupEmbed()` again — **today it rejects again
  with the exact same cached failure**, provably the same rejected promise (assert via `getEmbedState()`
  staying `'uninitialized'` and/or a call counter on the injected resolver showing it was invoked only
  once across both attempts).
- GREEN (after fix): the second call attempts resolution again (the injected resolver's call counter
  shows 2 invocations) and, once the underlying condition is fixed, succeeds — `getEmbedState()` becomes
  `'real'`.

**AC-4 (memory-server health surface, §1c/§3 decision 2) — `memory_ping`'s top-level verdict is not
`ok`-shaped while the vec channel is absent.**
- Use the existing `_setEmbedProviderForTest`/`_resetEmbedSingleton` seams (already proven in
  `embed.spec.ts`) or the existing `embed-health-surface.spec.ts` harness (`handleToolCall`,
  `parseResult`) to force `getEmbedHealth().state !== 'real'` (e.g. leave the test provider unset and
  the backend unresolved — `getEmbedState()` returns `'uninitialized'` by default with no provider set,
  per embed.ts:128-132) while calling `memory_ping`.
- RED (today): `body.status` does not exist (or, if written naively as a smoke check, `body.ok === true`
  while `body.embed_state !== 'real'` — assert the field the fix adds is absent today:
  `expect(Object.prototype.hasOwnProperty.call(body, 'status')).toBe(false)` is the literal, mechanical
  RED arm since the field genuinely does not exist pre-fix).
- GREEN (after fix): `body.status === 'degraded'` when `embed_state !== 'real'`, and `body.status ===
  'ok'` when a real/test provider makes `embed_state === 'real'` (second assertion using
  `_setEmbedProviderForTest(new DeterministicTestProvider())`, matching the existing pattern in
  `embed.spec.ts`'s `afterEach`). Also assert `body.ok === true` is unchanged in both cases (Decision 2:
  `ok` never flips).

---

## 5. Risks

- **No `nx build`/`nx test` risk beyond the standing repo-wide ones** (BL-235 destructive build, BL-456
  build-via-test) — already covered by §6's gate. No new destructive operation is introduced by this
  spec.
- **`~/.memory/*` is never touched.** All new/modified tests use `fs.mkdtempSync(join(tmpdir(), ...))`
  (the existing pattern throughout `embed-health-surface.spec.ts`/`embed.spec.ts`) or pure in-memory
  fake clients (the `bl376` pattern) — no test in this spec opens a path under `~/.memory/`.
- **Real risk: getting Decision 1's `embed.ts` edit wrong in a way that reintroduces unbounded
  concurrency.** `getOrCreateProvider()` is called from every `embed()`/`warmupEmbed()` invocation, and
  the existing `if (_providerPromise) return _providerPromise;` line is also what **deduplicates
  concurrent in-flight resolution attempts** while one is genuinely still pending (not yet
  settled) — that dedup behavior must survive. The fix in §2 only changes what happens *after*
  rejection; while `_providerPromise` is pending (unsettled), the exact current behavior — every
  concurrent caller awaits the same in-flight promise — must be unchanged. Verify this with a
  concurrency assertion in AC-3: two concurrent `embed()` calls issued before the injected resolver
  settles must result in only ONE call to the underlying resolver, not two.
- **Real risk: `warmupOuterBudgetMs` drifting from the per-attempt loop's actual attempt count** if a
  future edit changes `WARMUP_CACHE_HIT_ATTEMPTS` in one file (`fastembed.ts`'s loop bound) without the
  other (`index.ts`'s outer budget) recomputing. Mitigated structurally by making both consume the same
  exported constant (§2) rather than duplicating the number — do not let the implementer hand-type `2`
  in `fastembed.ts`'s loop condition; it must reference `WARMUP_CACHE_HIT_ATTEMPTS`.
- **Changeset required.** `@adhd/sox-embedding-provider@0.2.0` is published; `WARMUP_CACHE_HIT_ATTEMPTS`
  and `warmupOuterBudgetMs` are new public exports from `src/index.ts` (the package's `main`/`types`
  entry). This is additive (minor, non-breaking — no existing export changes signature or behavior:
  `warmupTimeoutMs`'s per-attempt semantics are untouched, `isModelCached` is untouched). Run `pnpm
  changeset` from the repo root (or hand-write `.changeset/<slug>.md` in the standard frontmatter
  format: `---\n"@adhd/sox-embedding-provider": minor\n---\n\n<description>`) before merge. Do not skip
  this — `.changeset/config.json` in this repo has `access: public`, confirming this package is
  genuinely published and drift here is a real published-API risk, not a formality.

---

## 6. The gate — exactly which nx targets, in this order

Run each with a plain `npx nx <target> <project>` — **no `--skip-nx-cache`** (owner instruction).

1. `npx nx lint embedding-provider`
2. `npx nx lint memory-core`
3. `npx nx lint memory-server`
4. `npx nx build embedding-provider` — accept the BL-235 destructive-build risk consciously: this
   project's source is what you just edited, so a failed rebuild here is expected to reflect your own
   in-progress edit, not another agent's; do not run this speculatively "just to see."
5. `npx nx test embedding-provider -- src/bl376-warmup-timeout-split.spec.ts` — must still be 4/4 green;
   this is the regression guard that BL-376's split itself is not touched.
6. `npx nx test embedding-provider -- src/<new-spec-file-for-AC-1-and-AC-2>.spec.ts`
7. `npx nx test memory-core -- src/embed.spec.ts` (existing suite, must stay green) and the new/extended
   spec covering AC-3 (either a new file `libs/memory-core/src/embed-retry-bl-<successor-id>.spec.ts` or
   an added `describe` block inside `embed.spec.ts` — implementer's call, name it after this item's
   family, not a bare "retry.spec.ts").
8. `npx nx test memory-server -- src/embed-health-surface.spec.ts` (existing suite, must stay green,
   extend it in place with the AC-4 cases rather than forking a new file — it is already the canonical
   home for `memory_ping`'s embed-block regression coverage, per its own file-header doc comment).
9. `npx nx typecheck embedding-provider`, `npx nx typecheck memory-core` (if a target exists; if not,
   note that in the report — do not add one speculatively unless a build genuinely needs it),
   `npx nx typecheck memory-server`.
10. Before any suite result is reported as evidence: `node tools/check-suite-tree-state.mjs --project
    embedding-provider`, `... --project memory-core`, `... --project memory-server` — quote each
    alongside its suite result per the house rule (BL-456). If any reports dirt outside the files this
    spec names as owned, say so explicitly rather than silently attributing a result to a clean tree.
11. Do **not** run `npx nx run-many -t build,lint,test,typecheck` speculatively across the whole repo
    from inside this worktree unless every step above is green first — it is a much larger blast radius
    for a destructive build (BL-235) than this task needs, and this task's owned files are a small,
    well-fenced subset of the monorepo.

No `registry/index.json` sync is needed — `embedding-provider` and `memory-core` are data/composer
libraries, not registered extensions (per `libs/data/CLAUDE.md`). `memory-server` **is** a registered
extension with a bundled `dist/` — if step 4's build of `embedding-provider` changes its compiled
output in a way that matters to `memory-server`'s own bundle, the implementer must additionally run
`npx nx build memory-server` (same BL-235 caution) and `npx nx run registry:sync-index`, then commit the
regenerated `registry/index.json` alongside source, per this repo's `CLAUDE.md` "AGENT SEQUENCE" section.
Only do this if `memory-server`'s bundle actually needs rebuilding to exercise AC-4 — if the AC-4 test
runs directly against `src/index.ts` via `nx test` (as `embed-health-surface.spec.ts` already does,
importing `handleToolCall` from `./index.js` — i.e. from source, not from the bundled `dist/`), a bundle
rebuild is not required to prove the fix, only to ship it. State explicitly in the handoff report which
of these you did and why.

---

## 7. Commit discipline

Commit by explicit pathspec, incrementally, per file/logical unit — not one giant commit:

```
git commit libs/data/embed/embedding-provider/src/index.ts libs/data/embed/embedding-provider/src/fastembed.ts -m "fix(memory-core): bound cache-hit warmup to a 2-attempt retry, not a single 8s shot (BL-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001)"
git commit libs/memory-core/src/embed.ts -m "fix(memory-core): getOrCreateProvider() no longer caches a rejected promise forever (BL-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001)"
git commit extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts -m "fix(extensions): memory_ping reports status:degraded when the embed vec channel is absent (BL-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001)"
```

Adjust scope names to whatever this item's actual assigned family/BL-id becomes once filed
(`sox-ecosystem` `backlog_create_item`/existing family — the architect did not file a new backlog item
for this since the dispatch's own text is BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001 already; cite
that id, not a fabricated BL-number). Never `git add -A`/`.`/bare `git commit`. Add the changeset file
(§5) in its own commit alongside the `embedding-provider` source commit, not separately.
