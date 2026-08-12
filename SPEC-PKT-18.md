# SPEC — PKT-18 / BL-215: operator surface for `healStaleVectors`

Architect deliverable. Implementer builds strictly from this document; any judgement call not
ruled here is a bug in this spec — stop and escalate rather than deciding it yourself.

Worktree: `/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt18-reheal-stale`, branch `feat/pkt18-reheal-stale`.
Verified working before writing this spec: `npx nx test memory-core -- bl434-heal-trace-id.spec.ts`
→ 5 passed (2026-08-07, worktree freshly `pnpm install`ed).

> **SUPERSEDED-ANNOTATION (2026-08-11, strip branch `fix/bl373-sidecar-staleness`):**
> the `SOX_HEAL_STALE_VECTORS=1` env gate and the `disabled` result field this spec MANDATES are
> DELETED. ADR-0013 (feature switches are typed config, never env toggles) + the owner directive
> deleted the gate: `memory_curate reheal_stale` now ALWAYS works when invoked, with no env var and
> no `disabled` field in the result (the type carries no disabled state at all). An implementer
> reading this spec must treat every `SOX_HEAL_STALE_VECTORS` / `disabled` reference below as
> historical — do NOT re-introduce the gate or the field. Sections annotated inline where they
> would otherwise mislead.

---

## 1. Root cause

`healStaleVectors` (the BL-88 re-embed pass for model-swap-stale vectors) is fully implemented,
exported, and dead:

- Implementation: `libs/memory-core/src/embed-pipeline.ts:857-975`. Scans live episodes with a
  non-null `embed_model` that differs from the currently active model and a `vec_node` row
  (embed-pipeline.ts:892-904), and re-embeds them, `wq.enqueue`-ing the delete and the apply as two
  short 'apply'-kind tasks per row (embed-pipeline.ts:921-946).
- Gated default-off behind `SOX_HEAL_STALE_VECTORS=1` (embed-pipeline.ts:831-833, checked at
  embed-pipeline.ts:863-866) — "a full-store re-embed on model swap must be explicit," per its own
  header (embed-pipeline.ts:854-856): *"The integrator MUST decide tick wiring at merge. Do NOT
  wire this into memory-server without an explicit operator opt-in surface."*
- Exported from the package root at `libs/memory-core/src/index.ts:127-130`, with the export
  comment itself recording the gap: *"NOT wired in memory-server yet."*

I confirmed the gap is total, not partial:

- `grep -n healStaleVectors extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`
  — zero matches. Nothing in the server, including the periodic enrich tick
  (`runEnrichPassOnDb`/the `healMissingVectors` backstop at index.ts:2290-2304, 2723) calls it.
- `libs/memory-core/src/curate.ts:141-168` — the `memory_curate` op switch has no `reheal_stale`
  case; an unrecognized op falls through to `default: return { code: 'E_UNKNOWN_OP', op };`
  (curate.ts:166-167).
- `grep -rn healStaleVectors extensions/bundles/sox-memory-bundle/members/memory-cli/` — zero
  matches.

So today there is no code path — MCP tool, CLI verb, or tick — an operator can invoke to trigger a
re-heal. The only way to run it is to import `healStaleVectors` from a throwaway script. That is the
defect BL-215 names: *"BL-88 shipped `healStaleVectors`... but no operator entry point."*

`stats.ts`'s `stamped_without_vector` field (referenced in the packet body as the live symptom,
`stats.ts:49-59, 289-296, 304`) is a **different** row shape — `embed_model IS NOT NULL AND NOT
EXISTS (vec_node)` — and its own comment (stats.ts:54-57) says it is already covered by
`embedBacklogStats()`/`healMissingVectors` (tick-wired, no operator gate, already fires
automatically). The packet cites it only as evidence that model-swap-era rows are currently
unaddressable by an operator; the actual target of BL-88/BL-215 is `stale_vector_count`
(`stats.ts:31-36` — `embed_model IS NOT NULL AND embed_model != active AND EXISTS (vec_node)`),
the exact predicate `healStaleVectors`'s own SELECT uses (embed-pipeline.ts:892-904). Do not build
against `stamped_without_vector` — it is not this pass's target set and is already self-healing.

---

## 2. The change, file by file

### 2.1 `libs/memory-core/src/curate.ts` — OWNED, primary change

1. New imports: `type { WriteQueue } from './write-queue.js'`, `{ healStaleVectors } from
   './embed-pipeline.js'`, `{ getActiveEmbedModel } from './embed.js'`.
2. `memoryCurate`'s signature gains a third, **optional** parameter:
   `wq?: WriteQueue` — additive, so all 8 existing 2-arg call sites (extensions.spec.ts,
   memory-server/src/index.ts's other `memory_curate` cases you are not touching) keep compiling
   unmodified.
3. New case in the op switch: `case 'reheal_stale': return await curateRehealStale(adapter, args, wq);`
4. New function `curateRehealStale` (full body in §2.1.1) and new exported result type
   `CurateRehealStaleResult` (full shape in §2.1.2), added to the `CurateResult` union.

#### 2.1.1 `curateRehealStale` — exact implementation

```ts
const REHEAL_DEFAULT_LIMIT = 50;
const REHEAL_MAX_LIMIT = 2000;

async function curateRehealStale(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  wq: WriteQueue | undefined,
): Promise<CurateRehealStaleResult | { code: string; message?: string }> {
  if (args['dry_run'] === true) {
    return {
      code: 'E_UNSUPPORTED',
      message:
        'reheal_stale does not support dry_run — it always performs the heal when enabled. ' +
        'Preview the candidate count via memory_stats.embed_provenance.stale_vector_count first.',
    };
  }
  if (!wq) {
    return {
      code: 'E_MISSING',
      message: 'reheal_stale requires an active WriteQueue (internal wiring error — the ' +
        'memory_curate MCP handler must pass one; see index.ts case memory_curate).',
    };
  }

  const rawLimit = args['limit'];
  const numericLimit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : REHEAL_DEFAULT_LIMIT;
  const limit = Math.min(REHEAL_MAX_LIMIT, Math.max(1, Math.floor(numericLimit)));

  const pass = await healStaleVectors(adapter, wq, { limit });

  const activeModel = getActiveEmbedModel() ?? 'unknown';
  const remainingRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM node n
     WHERE n.kind = 'episode'
       AND n.t_invalid IS NULL
       AND n.embed_model IS NOT NULL
       AND n.embed_model != ?
       AND EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)`,
    [activeModel],
  );

  return {
    op: 'reheal_stale',
    scanned: pass.scanned,
    healed: pass.healed,
    remaining: remainingRow?.cnt ?? 0,
    gone: pass.gone,
    failed: pass.failed,
    active_model: activeModel,
  };
}
```
> SUPERSEDED: the `disabled: pass.disabled` field is GONE — the result carries no disabled state
> (heal always runs; ADR-0013).

The `remaining` query is deliberately the exact same predicate `healStaleVectors` scans against
(embed-pipeline.ts:892-904) and `stats.ts`'s `stale_vector_count` uses (stats.ts:266-275) — re-run
fresh AFTER the pass, not computed algebraically (`initial - healed`). A fresh count is honest under
partial failure (some rows `gone`, some `failed`) where arithmetic would drift; it is also honest
when the pass is `disabled` (see decision D5).

#### 2.1.2 `CurateRehealStaleResult`

```ts
export interface CurateRehealStaleResult {
  op: 'reheal_stale';
  /** Rows the pass examined this call (bounded by `limit`). */
  scanned: number;
  /** Rows successfully re-embedded and committed. */
  healed: number;
  /** Fresh COUNT of still-stale rows AFTER this pass — run it again while > 0. */
  remaining: number;
  /** Rows whose rowid no longer resolved to the scanned uid (benign race). */
  gone: number;
  /** Rows whose embed or apply threw. */
  failed: number;
  /** The active embed model resolved for this call. */
  active_model: string;
}
> SUPERSEDED: the `disabled` field is GONE (ADR-0013) — the pass always runs when invoked; there is
> no env-gated disabled state to report.
```

Superset of the `{scanned, healed, remaining}` the acceptance clause names — additive fields never
violate an acceptance clause that only requires those three be present and correct.

### 2.2 `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` — OWNED, scope amendment (see D1)

**The packet's file list names only `curate.ts` (+ optionally memory-cli). This file is not on that
list. I am overriding that and requiring this edit anyway — see Decision D1 for why the acceptance
criterion is unmeetable without it, and why the alternative that stays in-list is worse.**

Two changes, both inside the existing `case 'memory_curate':` block (index.ts:1911-1922) and the
`TOOLS` array entry for `memory_curate` (index.ts:685-713). No other line in this file changes.

**2.2.1 — dispatch (index.ts:1911-1922), replace the whole case with:**

```ts
case 'memory_curate': {
  const wq = await WriteQueue.forPath(dbPath);
  // BL-215: reheal_stale is dispatched OUTSIDE the generic wq.enqueue('memory_curate', ...)
  // wrapper every other op uses below. Two independent reasons, both load-bearing:
  //   1. Re-entrancy (BL-154): healStaleVectors calls wq.enqueue() per row internally — the
  //      exact same shape healMissingVectors uses from the periodic tick, which the codebase
  //      only ever calls from OUTSIDE a queue task. write-queue.ts has no reentrancy guard;
  //      nesting a wq.enqueue call inside a task already running on that same queue hangs the
  //      queue forever, not just this call.
  //   2. Slot-holding: an embed pass over up to REHEAL_MAX_LIMIT rows can run from milliseconds
  //      to minutes. Wrapping it in the outer enqueue would hold the WriteQueue's single serial
  //      slot for that whole duration, fast-failing every other write behind it with E_BUSY —
  //      the exact anti-pattern the two-phase write design (embed-pipeline.ts header, BL-154)
  //      exists to prevent. curateRehealStale/healStaleVectors already do their actual mutation
  //      through short per-row wq 'apply' tasks, so this call only ever blocks the caller, never
  //      the shared slot.
  if (args['op'] === 'reheal_stale') {
    const result = await memoryCurate(adapter, args, wq);
    if ('code' in result) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
  return wq.enqueue('memory_curate', async (writeDb) => {
    const result = await memoryCurate(writeDb, args);
    if ('code' in result) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  });
}
```

Note `memoryCurate(adapter, args, wq)` — the plain `adapter`, not `writeDb` — for the `reheal_stale`
branch, matching exactly how `healMissingVectors(adapter, wq, {...})` is called from the tick
(index.ts:2291, 2304, 2723). Every other op keeps calling `memoryCurate(writeDb, args)` with no `wq`
argument, unchanged.

**2.2.2 — tool schema (index.ts:685-713), two edits:**

- `op.enum`: append `'reheal_stale'` → `['retag', 'set_topic', 'set_importance',
  'merge_duplicates', 'recluster', 'drop_lens', 'drop-episodes', 'list_lenses', 'reheal_stale']`.
- `op.description`: append `" reheal_stale re-embeds live episodes whose vector was stamped by a
  model that is no longer the active one (BL-88/BL-215) — a bounded, operator-invoked pass; it is
  never run automatically, and it always works when invoked (SOX_HEAL_STALE_VECTORS was an
  anti-feature and is gone, ADR-0013)."`
- add a new top-level property: `limit: { type: 'number', description: '(reheal_stale) Max rows to
  re-embed this call. Default 50, capped at 2000 — small enough that a single MCP call does not
  risk the client-side tool-call timeout. Run again while the response\'s remaining > 0.' }`.

No other file changes. `libs/memory-core/src/index.ts` needs one additive export edit (§2.3); no
other project is touched.

### 2.3 `libs/memory-core/src/index.ts` — OWNED, additive export

Add `CurateRehealStaleResult` to the existing `export type { CurateResult, CurateRetagResult, ...
} from './curate.js';` block (index.ts:329-340). One line added inside that block; nothing removed
or reordered.

### 2.4 Files that must NOT change

- **`libs/memory-core/src/export.spec.ts`, `libs/memory-core/src/concurrency-harness.spec.ts`, and
  the shared per-suite store fixture they use** — owned by PKT-55, running concurrently. If your
  reheal_stale spec needs anything from that fixture, it needs its OWN local fixture (mirror, don't
  import/modify) — the bl434-heal-trace-id.spec.ts pattern in §4 is entirely self-contained
  (`beforeEach`/`afterEach` with `fs.mkdtempSync`) and does not touch PKT-55's files at all. Copy
  that shape.
- **`libs/memory-core/src/embed-pipeline.ts`** — `healStaleVectors` is reused verbatim, not
  modified. SUPERSEDED: there is no `SOX_HEAL_STALE_VECTORS` gate inside it anymore (deleted,
  ADR-0013) — do not re-add one; and do not add a `dry_run` concept to it (see D4) — it stays in
  `curate.ts` only.
- **`libs/memory-core/src/stats.ts`** — the `remaining` query in `curateRehealStale` duplicates
  `stats.ts`'s `staleVecRow` predicate rather than importing/refactoring it. See D6.
- **`extensions/bundles/sox-memory-bundle/members/memory-cli/`** — per the packet, only touch this
  if the curate op alone cannot satisfy the acceptance clause. It can (see D1's ruling) — do not
  add a `soxe memory reembed` loop for this packet.

---

## 3. Every decision, ruled

**D1 — Does wiring `reheal_stale` require editing `memory-server/src/index.ts`, despite it not
being on the packet's file list?**
Ruling: **yes, edit it**, narrowly, as specified in §2.2. Two alternatives considered and rejected:
- *(a) Reject the packet's boundary and stay in curate.ts only, letting the existing generic
  `wq.enqueue('memory_curate', async (writeDb) => memoryCurate(writeDb, args))` wrapper carry
  `reheal_stale` transparently* (no server edit needed since the MCP tool schema's `op` enum is
  documentation-only — no ajv/zod validator gates it before dispatch, confirmed: no validation
  import found in index.ts's tool-call path). This is the option that superficially satisfies "you
  own curate.ts" — and it deadlocks. `memoryCurate` would need `wq` to call `healStaleVectors`, but
  the only `wq` available inside that closure is the same one whose slot the closure is currently
  occupying; `healStaleVectors` immediately calls `wq.enqueue()` on it (embed-pipeline.ts:921,
  938), and `write-queue.ts` has no reentrancy guard (confirmed by grep — no `_activeTask`/"already
  running" check), so the second enqueue's promise never resolves and the whole queue hangs. This
  is not a hypothetical: it is the literal shape the BL-154 header exists to name, and the module
  comment on `healStaleVectors` says explicitly the safe pattern is "call it from an interval
  callback... OUTSIDE any queue task" (embed-pipeline.ts:842-845) — an MCP tool handler's queue
  task is not that.
- *(b) Reimplement the per-row scan/embed/apply loop directly inside `curateRehealStale`, running it
  against the already-open `writeDb` inside the existing wrapper, using only direct SQL +
  `applyEmbedding` (already exported, itself `wq`-free) instead of calling `healStaleVectors`.* This
  avoids both the deadlock and the file-list violation. It is rejected because it reintroduces a
  worse problem: it would hold the WriteQueue's single serial slot synchronously for the entire
  embed pass (up to `REHEAL_MAX_LIMIT` rows), fast-failing every concurrent write behind it with
  `E_BUSY` for the whole duration — exactly the anti-pattern the two-phase write design was built to
  eliminate (embed-pipeline.ts:1-63 header), and it duplicates `healStaleVectors`'s row-loop logic
  wholesale, which is a DRY violation against the CLAUDE.md instruction and a maintenance hazard the
  first time BL-88's per-row logic changes and this copy silently doesn't.
- The chosen option (§2.2) reuses `healStaleVectors` completely unmodified (matches the module's own
  intended call shape, byte-for-byte the same as the tick's `healMissingVectors` call), never nests
  a queue call, and never holds the slot for the pass duration — the only cost is one `if` branch and
  one schema edit in a file not on the original list, which is a smaller and better-understood risk
  than either alternative.

> SUPERSEDED (ADR-0013, 2026-08-11): the gate is DELETED — invoking the op IS the opt-in; there is
> no env gate to keep or bypass.

**D2 — Does `reheal_stale` need `SOX_HEAL_STALE_VECTORS=1` set, or does invoking the MCP op count as
the explicit opt-in and bypass the gate?**
Ruling (historical): **keep the gate, do not bypass it.** `healStaleVectors` stays untouched (§2.4). Two
independent reasons this env gate is not redundant with "op is explicit": (1) it is defense in
depth — per the packet's own citation of BL-345 (no background work starving foreground reads) and
BL-413 (the enrichment tick's history of wedging), a second, orthogonal safety check costs nothing
and catches a future regression where something DOES wire this into a tick without removing the
`op`-level check; (2) the existing test suite (`embed-provenance.spec.ts:360-376`,
`bl434-heal-trace-id.spec.ts`) already encoded "set `SOX_HEAL_STALE_VECTORS=1` before expecting
(SUPERSEDED: that env-set line is gone — the spec now asserts the pass runs without any env var)
a real pass" as the established contract for this function — silently overriding it inside
`curateRehealStale` would make those tests' documented behavior lie about what the function now
does when called from curate. The cost is two-step operator activation (env var + MCP call) instead
of one; acceptable for a rare, deliberate, model-swap-triggered operation, and it is what `disabled:
true` + honest `remaining` (D5) exists to make discoverable rather than mysterious.

**D3 — What is the default/max `limit`?**
Ruling: **default 50, hard cap 2000**, both enforced in `curateRehealStale`, NOT reusing
`healStaleVectors`'s own internal default of 500 (embed-pipeline.ts:883). `healStaleVectors`'s 500
default is calibrated for the periodic tick's 240s-of-a-300s-interval budget
(`embedHealTimeBudgetMs`, embed-pipeline.ts:196-208) — a background caller with no client waiting
synchronously. `memory_curate` is a single, synchronously-awaited MCP tool call (§2.2.1: it is
deliberately NOT enqueued, so the caller is blocked on it directly) with no equivalent time-budget
mechanism, and MCP clients enforce their own tool-call timeouts. 50 rows at the documented ~335ms
CoreML inference time (embed-pipeline.ts:186) is on the order of ~17s worst case, well inside a
typical client timeout; 2000 is a hard ceiling against a operator fat-fingering a value that would
hang the connection for many minutes. An operator wanting a full-store heal runs the op repeatedly
(explicitly licensed by "bounded... an operator needs to be able to run it twice" in the packet) —
each call returns fast and `remaining` tells them when to stop.

**D4 — Does `reheal_stale` support `dry_run`?**
Ruling: **no — reject it explicitly with `E_UNSUPPORTED`, don't silently ignore it.**
`healStaleVectors` has no dry-run concept (it always writes when enabled) and adding one would mean
editing embed-pipeline.ts, which is out of bounds (§2.4). Silently accepting `dry_run: true` and
running the heal anyway — the behavior you'd get by doing nothing — is the worse failure mode: a
caller who reasonably expects `dry_run` to mean "preview, no writes" (every other `memory_curate` op
respects it) would get real mutations with no warning. An explicit `E_UNSUPPORTED` is honest and
fails loud; `memory_stats.embed_provenance.stale_vector_count` is named in the error message as the
existing read-only preview.

> SUPERSEDED (ADR-0013, 2026-08-11): there is no `disabled` state anymore — the pass always runs
> when invoked, so `remaining` is simply the honest post-pass count. The `disabled` early-return
> shape this decision reasoned about no longer exists.

**D5 — What does `remaining` report when the pass is `disabled` (env gate unset)?**
Ruling (historical): **the real, freshly-queried count of still-stale rows — never 0, never omitted.** An
implementation that just forwards `healStaleVectors`'s early-return shape
(`{scanned:0,healed:0,gone:0,failed:0,disabled:true}`) would report `remaining: 0` by construction
(there is nothing else to derive it from in that shape), which is a false "nothing to do" signal on
a store that may have hundreds of stale rows waiting on an operator to flip the env var. §2.1.1
always runs the `remaining` COUNT query regardless of `pass.disabled`, specifically to prevent this.

**D6 — Should the `remaining` query be extracted into a shared helper with `stats.ts`'s
`staleVecRow` query instead of duplicated?**
Ruling: **duplicate it, do not extract.** The two queries are already byte-for-byte independent
duplicates of a third copy inside `healStaleVectors`'s own SELECT (embed-pipeline.ts:892-904) — this
codebase's established convention for this exact predicate is "each caller owns its own copy of a
five-line COUNT query," not a shared helper (no such helper exists today across the three existing
sites). Introducing one now is an unscoped refactor of `stats.ts` for a one-packet feature, and
`stats.ts` is explicitly a file that must not change (§2.4) — a shared helper would need to live
somewhere and be imported by both, which either creates that new shared module (scope creep beyond
this packet) or forces a `stats.ts` edit (against the constraint). Keep it local to `curate.ts`.

**D7 — Should `memoryCurate`'s new third parameter be required or optional?**
Ruling: **optional (`wq?: WriteQueue`).** Required would be a breaking signature change hitting
every existing call site same-day: `extensions.spec.ts` (curate.spec-equivalent, 8 call sites) and
every other `case` in `memory-server/src/index.ts`'s `memory_curate` block that calls
`memoryCurate(writeDb, args)` with two arguments. None of those ops need `wq`. Optional keeps this
strictly additive — the single new call site (§2.2.1) is the only one that supplies it.

---

## 4. Acceptance criteria (each names BL-215; each states its RED arm)

Write these as a new file `libs/memory-core/src/bl215-reheal-stale.spec.ts`, self-contained per §2.4
(copy the `beforeEach`/`afterEach`/`insertStale`-style fixture shape from
`bl434-heal-trace-id.spec.ts:61-121` — do not import PKT-55's fixture).

**AC1 — the op exists and is reachable through the real dispatcher.**
GREEN: `memoryCurate(db, { op: 'reheal_stale' }, wq)` returns an object with `op: 'reheal_stale'`
and numeric `scanned`/`healed`/`remaining` fields (not a `code` error).
RED (must literally fail before the fix): on unmodified `main`, the same call hits the `default`
branch of the switch (curate.ts:166-167) and returns `{ code: 'E_UNKNOWN_OP', op: 'reheal_stale' }`
— assert `result.op === 'reheal_stale' && typeof result.scanned === 'number'`, which throws/fails
against that shape today.

**AC2 — a model-swap-stale row actually gets healed.**
Setup: `SOX_HEAL_STALE_VECTORS='1'`; insert one episode with `embed_model = 'some-other-model'` and
a `vec_node` row (the `insertStale` helper, bl434-heal-trace-id.spec.ts:110-121), active model
resolved via the `DeterministicTestProvider` (same as bl434's `_setEmbedProviderForTest`).
GREEN: `{ op:'reheal_stale', scanned: 1, healed: 1, remaining: 0, gone: 0, failed: 0, disabled:
false }`. Also assert directly via SQL that the row's `vec_node.embedding` changed and
`node.embed_model` now equals the active model (do not trust the return value alone — read the DB,
same standard `applyEmbedding`'s own tests use).
RED: before the fix, `E_UNKNOWN_OP` (AC1's RED) — no heal occurs, the row's `embed_model` stays
`'some-other-model'` in the DB.

**AC3 — bounded, and rerunnable ("operator needs to be able to run it twice").**
Setup: insert 3 stale rows (same shape as AC2), `SOX_HEAL_STALE_VECTORS='1'`.
GREEN: call #1 with `{ op: 'reheal_stale', limit: 1 }` → `{ scanned: 1, healed: 1, remaining: 2 }`;
call #2 with the same args → `{ scanned: 1, healed: 1, remaining: 1 }`; call #3 → `{ scanned: 1,
healed: 1, remaining: 0 }`. Assert `remaining` is monotonically decreasing and reaches 0, and that
each call only ever touched one row (`scanned === 1` every time, proving the `limit` bound is real,
not advisory).
RED: pre-fix `E_UNKNOWN_OP` on every call — no `scanned`/`remaining` fields to assert against.

**AC4 — disabled state is honest, not silent (D5).**
Setup: insert 1 stale row exactly as AC2, but leave `SOX_HEAL_STALE_VECTORS` **unset**.
GREEN: `{ op: 'reheal_stale', scanned: 0, healed: 0, remaining: 1, disabled: true }` — `remaining`
is 1 even though the pass did not run.
RED: an implementation that forwards `healStaleVectors`'s early-return object directly as the curate
result (skipping the `remaining` COUNT query) produces `remaining: undefined` or `0` here — assert
`result.remaining === 1` specifically, which distinguishes "computed honestly" from "forwarded
verbatim."

**AC5 — `dry_run: true` is rejected, not silently ignored (D4).**
Setup: 1 stale row, `SOX_HEAL_STALE_VECTORS='1'`.
GREEN: `memoryCurate(db, { op: 'reheal_stale', dry_run: true }, wq)` returns `{ code:
'E_UNSUPPORTED', ... }`, and a direct SQL read afterward shows the row's `embed_model` is UNCHANGED
(`'some-other-model'`) — no partial/accidental write happened before the rejection.
RED: an implementation missing the `dry_run` check (§2.1.1's first `if`) runs the pass for real
despite `dry_run: true` — the row's `embed_model` WOULD be healed, which is precisely the silent
behavior this criterion exists to catch. (Write this test to fail loudly, not vacuously: assert on
the DB row state, not just the response shape, per the BL-167 lesson in CLAUDE.md.)

**AC6 — no `wq` supplied fails structured, not thrown (D7 defensive path).**
GREEN: `memoryCurate(db, { op: 'reheal_stale' })` (2-arg call, no `wq`) returns `{ code: 'E_MISSING',
... }`, awaited without throwing.
RED: without the `if (!wq)` guard, the same call throws a `TypeError` (`Cannot read properties of
undefined (reading 'enqueue')`) inside `healStaleVectors`'s first `wq.enqueue` call — assert the
call resolves (doesn't reject) and inspect `result.code`.

**AC7 (review-gate, not a unit test) — never tick-wired.**
Verification method: `grep -n "healStaleVectors" extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`
must show exactly one call site, inside the `case 'memory_curate':` block added in §2.2.1, and zero
occurrences inside any function reachable from the periodic enrich tick (`runEnrichPassOnDb` and
its callers — grep those function bodies directly). The reviewer stage runs this grep and reports
the match list verbatim in their notes; a second match anywhere outside `case 'memory_curate'` fails
this criterion regardless of what the unit tests report.

---

## 5. Risks

- **Deadlock (data/process availability, not data loss) if D1's ruling is not followed exactly.**
  Any implementation that calls `memoryCurate(writeDb, args, wq)` — i.e. passes `wq` while ALSO
  being inside `wq.enqueue('memory_curate', ...)` — reintroduces the BL-154 hang. §2.2.1's code is
  exact; do not "simplify" it by merging the `reheal_stale` branch back into the generic
  `wq.enqueue` wrapper as a shortcut. If this regresses, the symptom is every subsequent MCP call
  against that server process hanging forever (the queue never drains) — not a clean error. There is
  no automated test in this spec that exercises the real MCP server process end-to-end (that would
  require `soxe serve` + a live client, out of scope for a `libs/memory-core` unit spec) — this is a
  **code-review-only** risk, which is why AC7 exists as an explicit review gate rather than a test.
- **No `~/.memory/*` risk in this packet** — all specs use `fs.mkdtempSync` scratch DBs
  (bl434-heal-trace-id.spec.ts pattern), never a real store. Do not add a fixture that touches
  `~/.memory/`.
- **`nx build`/`nx test` are destructive/rebuild hazards (BL-235/BL-456)** — this packet does not
  require a manual `nx build memory-core` at any point; `nx test memory-core` alone rebuilds
  `memory-core`'s own `dist` via its `dependsOn`, which is expected and safe (it is this project's
  own build, not another agent's). Do not run `nx build memory-server` or `nx build memory-cli` from
  this worktree — nothing in this packet changes their published `dist/`, and per BL-235 a diagnostic
  build is destructive with no `--dry-run` escape hatch. If `memory-server`'s dist ever needs
  rebuilding for smoke verification, that is the reviewer/implementer's live-verification step
  (CONTRIBUTING.md §2), run deliberately, not incidentally.
- **Turso adapter concurrency** — nothing in this change touches
  `needsWriteSerialization`/`concurrentTransactions`/`multiprocessWrite`. `healStaleVectors` is
  reused unmodified; its own concurrency contract (whatever it already is) is unaffected by this
  packet.

---

## 6. The gate — exactly which nx targets to run

1. `npx nx test memory-core` (plain, no `--skip-nx-cache`) — must show the new
   `bl215-reheal-stale.spec.ts` file passing, plus zero regressions in the full suite (in particular
   `bl434-heal-trace-id.spec.ts`, `embed-provenance.spec.ts`, and `extensions.spec.ts`'s existing
   `memoryCurate` describes — those exercise the 2-arg call sites your optional `wq` param must not
   break).
   - Scope narrower while iterating: `npx nx test memory-core -- bl215-reheal-stale.spec.ts`.
   - Report `node tools/check-suite-tree-state.mjs --project memory-core` alongside every suite
     result you cite (BL-456) — state whether the dependency tree was clean.
2. `npx nx typecheck memory-core` — the new `wq?: WriteQueue` param, the new `CurateRehealStaleResult`
   type, and its addition to the `CurateResult` union must typecheck clean (not just build-strip
   clean — BL-248's lesson).
3. `npx nx lint memory-core`.
4. `npx nx typecheck memory-server` and `npx nx lint memory-server` — the §2.2 edits (new case
   branch, new schema fields) must typecheck/lint clean against the real `memoryCurate` signature
   from `memory-core`. **Do not run `npx nx build memory-server`** unless you are deliberately doing
   the live-verification step described in the risk above — typecheck/lint do not touch `dist/`.
5. Before handing off: `git status` in the worktree and confirm only `libs/memory-core/src/curate.ts`,
   `libs/memory-core/src/index.ts`,
   `libs/memory-core/src/bl215-reheal-stale.spec.ts`, and
   `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` are modified/added —
   nothing under PKT-55's `export.spec.ts`/`concurrency-harness.spec.ts`, nothing in `dist/`.
6. Commit by explicit pathspec, one commit, conventional-commit format, scope `memory-core` (the
   `index.ts` edit rides with it — same feature, same review unit — or split into a second
   `extensions`-scoped commit if you prefer; either is fine, just never `git add -A`/bare `git
   commit`).

This is the full gate. No `nx build` of any project is required to satisfy this packet's acceptance
criteria — typecheck + lint + test cover everything a spec-conformant implementer needs.
