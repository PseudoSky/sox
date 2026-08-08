# SPEC — BUG-MEMORY-002 + BUG-MEMORY-004

Architect: this stage. Implementer: next stage, build exactly this. Reviewer after.

Worktree: `/Users/nix/dev/ai/sox-ecosystem/.worktrees/bug-memory-002-004-error-and-doc-surface`
Branch: `feat/bug-memory-002-004-error-and-doc-surface`

---

## 0. ⛔ Verification performed before writing this spec (per the dispatch's "stop and report" gate)

The dispatch required checking whether the three `E_NOT_FOUND` probe uids
(`01KZHA5CMFKBTACXGNRD4042V0`, `01KZHA7B897N1GG6FDTZMPBXAQ`, `01KZHA7DDA7NNWRE735K85MY6Z`) actually
exist in the live store before building on the item's own race theory. I copied `~/.memory/memory.db`
(+ `-wal`) read-only to scratch and queried them directly (never opened the live file for writing, per
constraints):

```
01KZHA5CMFKBTACXGNRD4042V0  kind=episode  t_created=2026-08-08T18:29:01.199Z  t_invalid=2026-08-08T18:29:04.030Z
01KZHA7B897N1GG6FDTZMPBXAQ  kind=episode  t_created=2026-08-08T18:30:05.321Z  t_invalid=2026-08-08T18:30:08.021Z
01KZHA7DDA7NNWRE735K85MY6Z  kind=episode  t_created=2026-08-08T18:30:07.530Z  t_invalid=2026-08-08T18:30:18.311Z
```

**All three exist. None were lost.** Write loss is ruled out — the catastrophic scenario the dispatch
told me to stop and report on did not occur; I am proceeding.

But the item's own explanation for *why* they 404'd is also wrong, and this changes the fix. Read on.

---

## 1. Root cause (BUG-MEMORY-002), in my own words, with citations I personally opened

### 1a. The item's theory ("claims are derived from episodes by async enrichment") does not describe this codebase

I grepped every `INSERT INTO node` in `libs/memory-core/src/*.ts` and `libs/data/graph/graph-store/src/index.ts`
(`libs/memory-core/src/write.ts:336`, `curate.ts:251`, `session.ts:55`, `cluster.ts:348,399`,
`extensions.ts:299,646,870`). `memory_write`'s own insert hardcodes `kind = 'episode'`
(`libs/memory-core/src/write.ts:336-337`, literal `'episode'` in the VALUES list). No code path anywhere in
`enrich.ts` or `embed-pipeline.ts` (grepped both files for `"claim"` — zero hits) turns an episode into a
separate `kind='claim'` node. The only place `kind='claim'` is ever produced is
`libs/memory-core/src/extensions.ts:715-720`'s `_mapGraphifyType`, used by the external graphify/import path
— **not** by `memory_write`. There is no "claim extraction" enrichment step. The dispatch's own
theory — a caller's `memory_write` uid isn't invalidatable yet because the async pipeline hasn't turned it
into a claim — describes a mechanism that does not exist in this repo.

Corollary: `memoryInvalidate`'s own lookup query never filtered on `kind` either
(`libs/memory-core/src/write.ts:734-737`, `SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL` — no
`kind` predicate). So an episode uid was **always** a valid `claim_uid` argument, mechanically. The tool's
own name and description (`"Invalidate a claim"`, `memory-server/src/index.ts:502-503`) is just imprecise
labeling of what is really "invalidate any live episode/claim node" — it is not a second, gated namespace the
way the item assumed.

### 1b. The real mechanism: an async pipeline DOES race the caller — just a different one

`libs/memory-core/src/enrich.ts:89-127`, `applyNearDupResult` (shared by the synchronous E8 pass and the
deferred Phase-B pass in `embed-pipeline.ts`): when a newly-embedded episode is a near-duplicate
(cosine ≥ `NEARDUP_THRESHOLD = 0.95`, `enrich.ts:83`) of an existing live episode, it **automatically sets
`t_invalid` on the OLDER episode** (`enrich.ts:118-123`) as part of the async embed pipeline — with no
caller action. This *is* asynchronous, it *does* run moments after write, and it *is* invisible to the
caller (the item's `enrichment.near_dup` is `null` in the write response per BUG-MEMORY-004 — the caller has
no synchronous signal this happened).

The store data I pulled confirms this exactly: each of the three failing uids has `t_invalid` set **2–11
seconds after** `t_created` — before the caller could plausibly have reached them in a manual invalidate
loop that also touched the other 9 successfully. The probe content itself (`"CONCURRENCY PROBE X
(disposable, safe to delete). Reproducing a ca..."` — near-identical templated wording across all 12
probes) is exactly the shape of content that clears a 0.95 cosine threshold against its siblings.

**Corrected root cause:** the caller's manual `memory_invalidate` call lost a race against the *automatic
near-dup auto-invalidation* pipeline, not against a nonexistent claim-extraction step. By the time the
caller's call ran, the node was already invalid — which is exactly the item's own **state 2** ("already
invalidated — the caller's intent is already satisfied"), not a new, undocumented state 3.

### 1c. What this means for the fix

The item asked for three distinguishable states. There are really only **two** reachable through the
`memory_write` → `memory_invalidate` flow, plus one genuinely-new one I found by re-deriving from the code
rather than the item's assumption:

1. **uid never existed / was hard-deleted** — `E_NOT_FOUND`, unchanged in meaning, but the query must now
   prove absence rather than "absence or already-invalid" (see §2).
2. **uid exists, already invalid** (by manual double-invalidate, by curate's `merge_duplicates`, or — the
   dominant real-world case per the evidence above — by the async near-dup auto-invalidation pipeline) —
   **idempotent success**, not an error. The three probe failures are all this state.
3. **uid resolves to a live node of the WRONG KIND** — this is real, but not the one the item described. It
   is reachable today (silently, with no error at all) by passing an `entity`, `community`, or `session` uid
   to `memory_invalidate`: the current query has no `kind` filter, so it would silently set `t_invalid` on a
   structural node it was never meant to touch. That is the actual "wrong kind of id, no signal whatsoever"
   gap — it is just triggered by passing the wrong *tool's* uid (e.g. a `community_uid` from
   `memory_get_community`), not by an episode racing its own claim extraction.

I am replacing item's requested case (c) — "freshly-written episode uid before enrichment has produced a
claim" — with the state that is actually reachable and actually reproducible: **a live node already
auto-invalidated by the near-dup pipeline before the caller's own call lands.** This is strictly the correct
scope reduction: building a "claim still pending extraction" detector would be effort spent modeling a
mechanism that does not exist, and would not have fixed the observed 3/12 failures anyway (all three uids
were already `kind='episode'` and already invalid — a pending-claim detector would never have fired for
them).

## 2. Root cause (BUG-MEMORY-004), confirmed

- `memory_write`'s own tool description in **this** repo (`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:334`)
  already says the correct thing: *"`enrichment.near_dup` is null in the response ... set `SOX_SYNC_EMBED=1`
  ... to restore fully synchronous behaviour."* **No change needed here** — I checked the exact line the item
  flagged as "the tool description is the correct one" and confirmed it is already correct, present-tense,
  and unambiguous. Nothing in sox-ecosystem's `memory_write` description needs editing.
- The **contradicting** text is confirmed at `/Users/nix/dev/ai/claude-agents/tools/skills/reflection/SKILL.md`
  — I opened it: lines 180-192 (the item cited ~185-190; the actual instructive paragraph runs 180-192),
  containing *"A successful write returns `{episode_uid, enrichment:{topic, project_path, summary, tags,
  near_dup}}`. If your wording is similar but not identical to an existing node ... the memory system flags
  `enrichment.near_dup` + adds an async `SAME_AS` edge."* This is the file to fix, in the other repo.
- `extensions/bundles/sox-memory-bundle/members/memory-usage/SKILL.md:230-231` (the item said ~229-233; I
  confirmed the actual line range) lists `near_dup` in the response-shape summary
  (`` `memory_write` returns `{ episode_uid, enrichment: { topic, project_path, summary, tags, near_dup} }` ``)
  with no null caveat. Milder than the reflection skill (doesn't instruct anyone to read it as a signal) but
  still needs the caveat.
- `memory_near_duplicates` (`libs/memory-core/src/near-duplicates.ts`) **is a real, working mechanism** that
  answers "did this get a `SAME_AS` edge" — I read its full implementation. It queries all live `SAME_AS`
  edges, joins node content, and supports `project_path`/`topic`/`threshold` filters
  (`near-duplicates.ts:34-142`). **It has no `uid` parameter** — it is not a direct "check this one episode"
  lookup; the caller pages through the pair list (optionally scoped by `project_path`/`topic` to keep it
  small) and looks for their episode's uid in `uid_a`/`uid_b`. This is a real limitation but a real, working
  answer to the item's question — confirmed by reading the query, not asserted. **Ruling: document the scan
  workflow, do not add a `uid` filter parameter to `memory_near_duplicates`.** Adding a parameter is a
  behavior change to a shipped, tested tool for ergonomics only; the item's own note 1 already concluded
  "this makes option 1 (fix the docs) clearly cheaper than option 2 (add a sync verdict)" — extending
  `memory_near_duplicates`'s surface is a third option nobody asked for and is out of scope for a doc-fix
  packet. The reviewer should reject a PR that touches `near-duplicates.ts`.

## 3. The change, file by file

### 3.1 `libs/memory-core/src/write.ts` — the only functional code change in either bug

**Change `InvalidateResult`** (currently line 539-542):
```ts
export interface InvalidateResult {
  ok: boolean;
  supersedes_edge_uid?: string;
  /** True when the target was ALREADY invalid before this call — the caller's
   *  intent (uid is not live) was already satisfied. Distinguishes idempotent
   *  success from a fresh invalidation for callers that care (e.g. audit logging). */
  already_invalid?: boolean;
  /** Present only when already_invalid is true — the ORIGINAL t_invalid timestamp,
   *  so a caller can tell whether it was invalidated moments ago (consistent with
   *  the async near-dup pipeline racing them) or long ago (a stale uid they reused). */
  t_invalid?: string;
}
```

**Change `InvalidateError`** (currently line 544-557) — add one new variant:
```ts
export type InvalidateError =
  | { code: 'E_NOT_FOUND'; message: string }
  | { code: 'E_SCOPE_RO'; message: string }
  | { code: 'E_REPLACEMENT_NOT_FOUND'; message: string }
  /**
   * BUG-MEMORY-002: raised when claim_uid resolves to a LIVE node whose `kind`
   * is not one this operation is meant to invalidate (episode/claim). The
   * lookup previously had no `kind` predicate at all, so e.g. a community_uid
   * or entity uid from another tool's response would silently succeed and
   * set t_invalid on a structural node it was never meant to touch. Naming the
   * actual kind lets the caller see they passed the wrong tool's uid.
   */
  | { code: 'E_WRONG_KIND'; message: string; kind: string };
```

**Rewrite the lookup + branching in `memoryInvalidate`** (currently lines 734-741). Replace:
```ts
const claim = await adapter.executeGet<{ rowid: number }>(
  `SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`,
  [claim_uid],
);

if (!claim) {
  return { code: 'E_NOT_FOUND', message: `Claim not found or already invalidated: ${claim_uid}` };
}
```
with:
```ts
const claim = await adapter.executeGet<{ rowid: number; kind: string; t_invalid: string | null }>(
  `SELECT rowid, kind, t_invalid FROM node WHERE uid = ?`,
  [claim_uid],
);

if (!claim) {
  return { code: 'E_NOT_FOUND', message: `No node found for uid: ${claim_uid}` };
}

// BUG-MEMORY-002: already-invalid is the caller's intent already satisfied —
// idempotent success, not an error. This is the dominant real-world case: the
// async near-dup pipeline (enrich.ts applyNearDupResult / embed-pipeline.ts's
// deferred pass) can auto-invalidate an episode seconds after write, racing a
// caller who invalidates it manually moments later.
if (claim.t_invalid !== null) {
  return { ok: true, already_invalid: true, t_invalid: claim.t_invalid };
}

// BUG-MEMORY-002: reject the wrong KIND of uid rather than silently
// invalidating a structural node (entity/community/session) this operation
// was never meant to touch. memory_write only ever produces kind='episode';
// kind='claim' is produced only by the extensions/graphify import path
// (extensions.ts _mapGraphifyType) — both are legitimate invalidate targets.
if (claim.kind !== 'episode' && claim.kind !== 'claim') {
  return {
    code: 'E_WRONG_KIND',
    message: `uid ${claim_uid} is a live '${claim.kind}' node, not an episode or claim. memory_invalidate only operates on episode/claim uids.`,
    kind: claim.kind,
  };
}
```

Everything from `// BL-247: resolve (and validate) replacement_uid...` (current line 743) onward is
**unchanged** — the `replacement_uid` validation, the transaction, the `SUPERSEDES` edge, and
`gcOrphanedCommunityState` all still run exactly as today, gated behind reaching that point (i.e. only for a
live episode/claim node, exactly as before — the new early returns just make the two skipped cases explicit
instead of both falling into `E_NOT_FOUND`).

**Ruled decision — `replacement_uid` is NOT processed on the already-invalid fast path.** If a caller passes
both a `claim_uid` that's already invalid AND a `replacement_uid`, the call returns the idempotent-success
shape immediately and never looks at `replacement_uid` at all — no `SUPERSEDES` edge is written, even if
`replacement_uid` is itself valid. **Why:** the claim's target state (invalid) is already satisfied; adding a
supersession edge is a *second*, separable intent the item never asked this fix to address, and silently
writing an edge as a side effect of an idempotency short-circuit is a bigger surprise than declining to.
A caller who genuinely needs a `SUPERSEDES` edge on an already-invalid claim has no tool for that today (not
this item's scope) — document it as a known gap in the changeset, do not build it.
**Losing alternative:** run replacement_uid validation even on the idempotent path and attach the edge —
rejected because it means "idempotent success" is no longer actually idempotent (repeated calls with
different `replacement_uid` values would produce different side effects), which defeats the point of calling
it idempotent.

### 3.2 `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` — tool description only

Region: the `memory_invalidate` schema block, currently lines 501-516. **Only the `description` string on
line 503 changes** — the `inputSchema` (properties, required) is unchanged, this is not a parameter
contract change:

Replace:
```ts
description: 'Invalidate a claim (bi-temporal: sets t_invalid, never deletes).',
```
with:
```ts
description: 'Bi-temporally invalidate a live episode or claim node (sets t_invalid, never deletes). ' +
  'claim_uid accepts either kind: memory_write always returns an episode_uid (kind=\'episode\'), which is ' +
  'valid here directly — there is no separate "claim extraction" step that must run first. ' +
  'Invalidating an already-invalid uid is IDEMPOTENT SUCCESS: {ok:true, already_invalid:true, t_invalid} ' +
  '— this commonly happens when the async near-dup pipeline auto-invalidates a near-duplicate episode ' +
  'moments after write, before you get to it. A uid from a different kind of node (e.g. a community_uid or ' +
  'entity uid from another tool) returns {code:\'E_WRONG_KIND\', kind}.',
```

**Do NOT touch** the `memory_write` description at line 334 — confirmed correct in §2, editing it would be
an unrequested, unreviewed change to a live, correct contract string.
**Do NOT touch** the dispatch handler at lines 1756-1777 (`case 'memory_invalidate':`) — it already does
`if ('code' in result) return {isError:true, ...}` generically; `E_WRONG_KIND` and the unchanged
`E_NOT_FOUND`/`E_REPLACEMENT_NOT_FOUND` all route through that same branch with zero handler changes, and
the new `{ok:true, already_invalid:true, ...}` shape already falls through the existing success branch
unmodified.

### 3.3 `extensions/bundles/sox-memory-bundle/members/memory-server/CLAUDE.md` — doc only

Two edits, both under the existing `### memory_invalidate (v1 — MODIFIED 2026-07-10)` section (find it by
that heading — it's the last tool section before `## Error handling`):

1. Add a paragraph documenting the BUG-MEMORY-002 behavior change (idempotent-already-invalid,
   `E_WRONG_KIND`), in the same style as the existing BL-247 paragraph above it (breaking-change note +
   "previously ... now ..." framing, consistent with how BL-247 was documented in this same section).
2. In the `## Error handling` section's bullet list (`` `E_NOT_FOUND` — episode, entity, or community not
   found `` etc.), add: `` `E_WRONG_KIND` — memory_invalidate: uid resolves to a live node whose kind is not
   episode/claim ``.

### 3.4 `extensions/bundles/sox-memory-bundle/members/memory-usage/SKILL.md` — doc only, two separate spots

**Spot A — near `:106`** (the supersession-workflow line: `` memory_write the new claim +
memory_invalidate({ claim_uid, reason, replacement_uid }) the old one``). Reword "the new claim" /
"the old one" to say explicitly these are episode uids (what `memory_write` actually returns), e.g.:
`memory_write` the replacement episode + `memory_invalidate({ claim_uid: <old episode_uid>, reason,
replacement_uid: <new episode_uid> })` the old one — `claim_uid` accepts the plain `episode_uid` from
`memory_write` directly.

**Spot B — near `:230-231`** (response-shape line: `` `memory_write` returns `{ episode_uid,
enrichment: { topic, project_path, summary, tags, near_dup } }` ``). Append, in the same sentence or the
next one: `near_dup` is always `null` in this response (near-dup detection is asynchronous — see
`memory_write`'s own tool description); to check after the fact whether a written episode picked up a
`SAME_AS` edge, call `memory_near_duplicates` scoped by that episode's `project_path`/`topic` and look for
its uid in the returned `uid_a`/`uid_b` pairs.

### 3.5 `/Users/nix/dev/ai/claude-agents/tools/skills/reflection/SKILL.md` — DIFFERENT REPO, doc only

Lines 180-192 (verified by reading; the item said ~185-190). Rewrite the two-bullet "Two ways it lands"
block. **Ruled fix direction: option 1 (make the skill correct), per item's own note 1 and my §2 confirmation
that `memory_near_duplicates` already answers the question.**

Replace the first bullet (currently instructing the caller to read `enrichment.near_dup` off the write
response) with text that:
- States plainly that `enrichment.near_dup` is **always `null`** in the write response — near-dup detection
  is asynchronous (typically <1s, up to a few seconds) and cannot be observed synchronously at write time.
- States what corroboration still means structurally (near-dups are still linked via an async `SAME_AS`
  edge, not refused) — keep this framing, it isn't wrong, only the "read it off the response" instruction is.
- Names the actual verification mechanism: call `memory_near_duplicates({ project_path: <your
  project_path>, topic: <your topic if set> })` sometime after the write, and check whether your episode's
  uid appears in `uid_a`/`uid_b` of any returned pair. Note there is no direct per-uid lookup — the caller
  scopes by `project_path`/`topic` to keep the pair list small, then scans it.

Do not touch anything else in this file, and do not touch any other file in `claude-agents` — that repo is
dirty with unrelated changes (`git status` shows modified `.claude/settings.json`, `.mcp.json`,
`tools/cli/doctor.js`, etc., and several untracked directories); commit **only**
`tools/skills/reflection/SKILL.md` by explicit pathspec, in that repo, with its own commit.

### 3.6 Explicitly OUT OF BOUNDS (sibling packets, do not touch)

- `libs/data/store/store-adapter/` and `libs/memory-core/src/telemetry.ts` — BUG-MEMORY-001's packet. (A
  stray `libs/data/store/store-adapter/check-probe-uids.mjs` is sitting untracked in this worktree, left by
  that sibling's investigation or a prior architect pass — it is not part of this packet's deliverable; leave
  it alone, do not commit it, do not delete it.)
- `libs/memory-core/src/recall.ts` and the `memory_recall` handler region (~1440-1505 in
  `memory-server/src/index.ts`) — BUG-MEMORY-003's packet.
- `libs/memory-core/src/near-duplicates.ts` — ruled in §2: no code change, doc-only fix.
- `libs/memory-core/src/curate.ts` — has its own independent raw-SQL invalidate logic for
  `merge_duplicates` (`curate.ts:354`) and `drop-episodes` (hard delete, `curate.ts:467-491`). Neither calls
  `memoryInvalidate()` — confirmed by grep, zero references to `memoryInvalidate` in `curate.ts`. Not
  affected by this change and not to be touched.
- `docs/plan/memory-enrichment/CONTRACTS.md` — historical planning doc, does not document
  `memory_invalidate`'s error codes today (only `memory_update`'s, at different lines). Not required reading
  for any live consumer; leave it as-is rather than partially updating a doc that isn't the source of truth
  (per the repo's own routing: `docs/reporting/memory/` is where memory-subsystem findings go, not this).

## 4. Every decision, ruled

1. **Idempotent-already-invalid is `ok:true`, not a new error code.** Losing alternative: a distinct
   `E_ALREADY_INVALID` error code. Rejected — the item itself says "should not read as an error at all"; a
   caller writing a cleanup loop that calls `memory_invalidate` on possibly-already-gone uids should not have
   to catch a new error class to treat it as success. `already_invalid: true` is enough signal.
2. **`E_WRONG_KIND` scope is `kind NOT IN ('episode','claim')`, not `kind !== 'claim'`.** Losing alternative:
   require strictly `kind='claim'` (matching the tool's literal name). Rejected — `memory_write` (the
   overwhelmingly dominant write path) only ever produces `kind='episode'`, and every existing test and the
   entire observed failure population in the dispatch's evidence are episode uids. A strict claim-only
   restriction would make `memory_invalidate` newly reject the vast majority of its real traffic — that is
   not a bug fix, it's a new outage.
3. **`replacement_uid` is skipped entirely on the idempotent path** — ruled and justified in §3.1. Losing
   alternative rejected there (breaks the idempotency guarantee itself).
4. **No `uid` filter added to `memory_near_duplicates`.** Ruled in §2 — out of scope for a doc-fix packet,
   the item's own economics conclusion (option 1 cheaper than option 2) already argued against extending the
   tool surface.
5. **`memory_write`'s tool description (index.ts:334) is not touched.** Ruled in §2 — verified already
   correct; editing a correct, live, tested string with no fix attached to it is pure risk.
6. **No change to `StorageErrorCode` in `libs/memory-core/src/errors.ts`.** `E_WRONG_KIND` (like the
   existing `E_REPLACEMENT_NOT_FOUND`) is scoped to `InvalidateError`, a local discriminated union, not the
   generic driver-exception taxonomy `wrapDbError` produces. Precedent: `E_REPLACEMENT_NOT_FOUND` was added
   the same way (BL-247) without touching `errors.ts`. Adding it to the generic taxonomy would imply
   `wrapDbError` can produce it from a raw driver exception, which it never will (it's a domain decision, not
   a storage-driver error).
7. **`E_NOT_FOUND`'s message text changes** (`"Claim not found or already invalidated: <uid>"` →
   `"No node found for uid: <uid>"`) **but its `code` does not.** The existing test
   `invalidate.spec.ts:148-155` ("negative control: claim_uid not found returns E_NOT_FOUND (pre-existing
   behaviour, unchanged)") asserts on `.code`, never on `.message` — confirmed by reading it — so this is
   safe. The message change is necessary: the old message is a lie once "or already invalidated" is no
   longer a case this branch can reach.
8. **Package consumers of `E_NOT_FOUND`:** grepped every hit across the repo (§ "Contract check" below).
   Every other `E_NOT_FOUND` producer (`entity-episodes.ts`, `related.ts`, `update.ts`, `extensions.ts`,
   `curate.ts`) is a **different** function with its own independent `E_NOT_FOUND` semantics for its own
   resource (entity not found, community not found, node-to-update not found, etc.) — none of them call
   `memoryInvalidate` and none of their meanings change. `@adhd/sox-memory-core@0.6.0` is published; this is
   a **narrowing** of `memoryInvalidate`'s `E_NOT_FOUND` (fewer cases now return it — previously
   already-invalid uids did, now they don't) plus one **new** error code (`E_WRONG_KIND`) and one **new**
   success field (`already_invalid`). A consumer that treated any `E_NOT_FOUND` from `memoryInvalidate` as
   "give up" will now see some of those calls silently succeed instead — strictly more forgiving, not a
   breaking narrowing of a contract anyone could have relied on being an error. This needs a changeset (see
   §6).

## 5. Acceptance criteria — named to each BL item, each with a RED arm

All new tests live in `libs/memory-core/src/invalidate.spec.ts` (unit level, exercises `memoryInvalidate`
directly against a real `StoreAdapter`) **and** a new MCP-level block in
`extensions/bundles/sox-memory-bundle/members/memory-server/src/memory-tools.spec.ts` (drives the real seam
via `handleToolCall('memory_invalidate', ...)`, per the dispatch's explicit "drive the real MCP seam"
instruction). Name every test with the BL id in its `it()` string.

### BUG-MEMORY-002

**(a) Non-existent uid → distinct code, unchanged.**
- Test: `memoryInvalidate(db, { claim_uid: 'nonexistent-...', reason: 'n/a' })` → `code === 'E_NOT_FOUND'`.
- This test already exists (`invalidate.spec.ts:148-155`) — it is the negative control and must keep
  passing unmodified; do not weaken it.
- RED arm: not applicable (pre-existing, already green) — but assert the **new** message text
  (`"No node found for uid:"`) as part of confirming the rewritten query still reaches this branch.

**(b) Invalidate the same claim twice → second call is idempotent success.**
- Test: write an episode, invalidate it once (`ok:true`, `already_invalid` absent/false), invalidate it
  again with the same uid → `ok:true`, `already_invalid === true`, `t_invalid` present and equal to the
  first call's transition time (not a new timestamp — confirms the SECOND call did not touch the row).
- RED arm: **before the fix**, the second call returns `{code:'E_NOT_FOUND'}` — assert that this is what the
  *current* `write.ts:739-741` code produces first (comment it in the test, or run it against `git stash`-free
  pre-fix behavior mentally: the existing query filters `t_invalid IS NULL`, so a second call finds zero rows
  and hits the exact same `E_NOT_FOUND` branch as a genuinely-nonexistent uid — this is directly
  demonstrable by temporarily reverting the query to its `libs/memory-core/src/write.ts:734-741` current form
  and observing the test fail).

**(c) The reproduction case — an episode auto-invalidated by the near-dup pipeline before the caller's own
`memory_invalidate` call, exactly matching the dispatch's observed 3/12 split.**
- Test: write an episode, then write a byte-different but near-duplicate episode with a cosine similarity
  ≥ `NEARDUP_THRESHOLD` (0.95) against it using `SOX_SYNC_EMBED=1` composition (or directly calling
  `enrichOnWrite`/`applyNearDupResult` with a synthetic embedding pair at cosine 0.96+, whichever the
  existing near-dup spec fixtures in `libs/memory-core/src/near-duplicates-bl386-cosine.spec.ts` already use
  — reuse that fixture pattern rather than inventing a new one) so the OLDER episode is auto-invalidated.
  Confirm via direct SQL that `t_invalid IS NOT NULL` on the older uid. THEN call `memoryInvalidate` on that
  same (already auto-invalidated) uid → `ok:true`, `already_invalid: true`.
- RED arm: before the fix, this returns `E_NOT_FOUND` — this is the literal repro of the dispatch's 3 failing
  probe uids; run it against the current code first and confirm it fails with `E_NOT_FOUND`, then apply the
  fix and confirm it passes.
- **[ARCHITECT AMENDMENT, 2026-08-08, ratified post-implementation]** The construction method above
  (`SOX_SYNC_EMBED=1` / hand-seeded `enrichOnWrite`/`applyNearDupResult` fixture) is **superseded**. The
  implementer found it collides with a `UNIQUE constraint failed: vec_node.node_id` — `memoryWrite` (the
  wrapper this suite's own `writeEpisode()` helper already used) always awaits `embed()` +
  `applyEmbedding()` synchronously before returning (`write.ts:505-526`), regardless of `SOX_SYNC_EMBED`
  (that env var affects a different composition path), and `applyEmbedding` (`embed-pipeline.ts:456-487`)
  already inserts the `vec_node` row and runs the real E8 near-dup detection automatically. **Sanctioned
  construction going forward:** write two near-duplicate episodes back-to-back via `memoryWrite` directly
  (no manual fixture, no synthetic embedding pair) — this drives the actual production near-dup pipeline
  end-to-end rather than a synthetic stand-in, and is a strictly stronger test than the one originally
  specified, not a weaker one. Confirmed implemented exactly this way in
  `libs/memory-core/src/invalidate.spec.ts` (BUG-MEMORY-002 (c), commit `da9ad478`).

**(d) Wrong-kind uid → `E_WRONG_KIND`, node NOT touched.**
- Test: seed a `kind='community'` node directly (the existing pattern in `invalidate.spec.ts:207-211` already
  does this for the orphaned-community-GC test — reuse it), then call `memoryInvalidate({ claim_uid:
  '<that community uid>', reason: '...' })` → `code === 'E_WRONG_KIND'`, `kind === 'community'`. Then assert
  the community's `t_invalid` is STILL `NULL` — the call must not have mutated it.
- RED arm: before the fix, this call succeeds (`ok:true`) and silently sets `t_invalid` on the community —
  assert this is what happens on unpatched code (no `kind` predicate at all in the current query), i.e. the
  RED run must show `ok:true` AND the community `t_invalid` non-null; both flip under the fix.

**(e) MCP-seam level — `memory_tools.spec.ts`, `handleToolCall('memory_invalidate', ...)`.**
- Repeat (b) at the MCP boundary: write via `handleToolCall('memory_write', ...)`, invalidate via
  `handleToolCall('memory_invalidate', ...)` twice, assert the second response is NOT `isError`, and its
  parsed body has `already_invalid: true`.
- This is the "drive the real MCP seam" requirement — the unit-level tests in `invalidate.spec.ts` call
  `memoryInvalidate` directly and are necessary but not sufficient; this test proves the description-string
  change and the dispatch handler's generic `'code' in result` branch both still compose correctly end to
  end.

### BUG-MEMORY-004

**(f) `memory_near_duplicates` genuinely answers "did my just-written episode near-dup?" — demonstrated, not
asserted.**
- Test (in `memory-tools.spec.ts` or a new small spec near `near-duplicates.ts`'s existing coverage): write
  two near-duplicate episodes sharing a `project_path`, wait for/force the async near-dup pass (reuse the
  `SOX_SYNC_EMBED=1` or fixture pattern from (c) above), then call `handleToolCall('memory_near_duplicates',
  { project_path: <that path> })` and assert the response's `pairs` array contains an entry whose
  `uid_a`/`uid_b` includes the older episode's uid.
- RED arm: not a regression test (the tool already works) — this is the dispatch's required "demonstrate the
  mechanism working against a real store, do not merely assert it." If it fails, that is a **new** finding
  (the tool doesn't do what §2 concluded from reading its source) and must be reported, not worked around.

**(g) Docs no longer contradict — text-level check, not a runtime assertion.**
- Not a vitest assertion (there's no code to run against prose). Acceptance is: `git diff` in
  `claude-agents` shows the reflection skill's "Two ways it lands" bullet no longer instructs reading
  `enrichment.near_dup` from the write response, and instead names `memory_near_duplicates` with the
  `project_path`/`topic` scan workflow proven in (f). `git diff` in sox-ecosystem shows
  `memory-usage/SKILL.md`'s response-shape line carries the null caveat. Reviewer verifies by reading both
  diffs, not by running a test — record this in the reviewer's writeup explicitly since it's the one
  acceptance item with no red/green test to point to.

## 6. Risks and sequencing

- **No `dist/` rebuild is required to validate this spec's tests** — `libs/memory-core` and
  `memory-server` tests run against `src/` via vitest/tsx path mapping (per `libs/data/CLAUDE.md`'s own
  warning: "`tsx`/`vitest` resolve workspace packages via `tsconfig.base.json` paths straight to source").
  **Do not run `npx nx build memory-server` or `npx nx build memory-core` merely to check this compiles** —
  per BL-235, that's a destructive diagnostic build. Run `npx nx typecheck memory-core` and
  `npx nx typecheck memory-server` instead to catch type errors without touching `dist/`. Only run
  `npx nx build <pkg>` once the source is believed correct and you're building for the registry-sync step
  the house rules already require for any `dist`-shipping change.
- **`node tools/check-suite-tree-state.mjs --project memory-server`** must be run and its output quoted
  alongside any `nx test memory-server` result, per the house rules — the worktree is currently clean per
  the `git status --porcelain` I ran at the start of this session, but confirm again before the implementer's
  own test run since sibling packets are live in the shared main checkout (not this worktree, but state the
  check regardless — it's cheap and it's the rule).
- **The stray `check-probe-uids.mjs`** (§3.6) is untracked in this worktree. It is not part of any commit in
  this packet. If it is still present when the implementer commits, it must NOT be swept in by any
  non-pathspec commit — commit only the files named in §3.1-3.5.
- **The scratch copy of `~/.memory/memory.db`** used for §0's verification lives at
  `/private/tmp/claude-502/.../scratchpad/verify.db` (+ `-wal`) and the throwaway query script at
  `/private/tmp/claude-502/.../scratchpad/check-uids.mjs`. Both are outside the repo and outside `~/.memory/`
  — nothing to clean up in-repo, nothing was written to the live store.
- **Publish surface**: `@adhd/sox-memory-core@0.6.0` is published. `InvalidateResult` gaining two optional
  fields and `InvalidateError` gaining one new discriminant are both additive at the TypeScript level (no
  existing field removed or retyped) but ARE a runtime behavior change (some previously-error calls now
  succeed). **A changeset is required** — add one under this package's changeset convention (check
  `libs/memory-core/` for an existing `.changeset/` directory or however this monorepo already versions it;
  I did not find a changeset tool invocation in this session's reads, so the implementer must locate the
  actual mechanism before writing one — do not guess a format).

## 7. The gate — exact nx targets

Run, in this order, only for the two projects this packet touches:

```
npx nx typecheck memory-core
npx nx typecheck memory-server
npx nx lint memory-core
npx nx lint memory-server
npx nx test memory-core -- invalidate.spec.ts
npx nx test memory-server -- memory-tools.spec.ts
node tools/check-suite-tree-state.mjs --project memory-server        # quote this with the test result
node tools/check-suite-tree-state.mjs --project memory-core          # and this
```

Do **not** run `npx nx build memory-core` / `npx nx build memory-server` as a diagnostic step (BL-235). Only
build once, at the very end, if this change needs to ship in the bundled `dist/` artifact for a live
verification pass (per `CONTRIBUTING.md`'s live-ship-verification gate) — and if so, immediately follow with
`npx nx run registry:sync-index` and commit the regenerated `registry/index.json` alongside source, per the
repo's standing `⛔ AGENT SEQUENCE` rule.

**Never** run `npx nx test memory-core` or `npx nx test memory-server` with `--skip-nx-cache` (owner
instruction) — plain `npx nx test <project> -- <file>` as shown above.

Do not touch `docs/plan/memory-enrichment/CONTRACTS.md`, `libs/data/store/store-adapter/`,
`libs/memory-core/src/telemetry.ts`, `libs/memory-core/src/recall.ts`, or the `memory_recall` handler region
of `memory-server/src/index.ts` — all out of bounds per §3.6.

Commit by explicit pathspec, split across the two repos:

```
# sox-ecosystem (this worktree)
git commit \
  libs/memory-core/src/write.ts \
  libs/memory-core/src/invalidate.spec.ts \
  extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts \
  extensions/bundles/sox-memory-bundle/members/memory-server/src/memory-tools.spec.ts \
  extensions/bundles/sox-memory-bundle/members/memory-server/CLAUDE.md \
  extensions/bundles/sox-memory-bundle/members/memory-usage/SKILL.md \
  -m "fix(memory-core): memory_invalidate distinguishes not-found/already-invalid/wrong-kind (BUG-MEMORY-002, BUG-MEMORY-004)"

# claude-agents (separate repo, separate commit, pathspec only the one file)
cd /Users/nix/dev/ai/claude-agents
git commit tools/skills/reflection/SKILL.md \
  -m "docs(reflection): near_dup is async-only, not readable from the write response (BUG-MEMORY-004)"
```
