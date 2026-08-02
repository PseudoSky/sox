# BL-327 handoff — stopped for usage budget, no code written yet

Status: **not started** (research-only, out of budget before any edit). Do not treat anything
below as done — it is orientation for the next agent only.

## Confirmed: `memory_invalidate`'s actual implementation path

The packet was uncertain of the path — resolved:

- **`memoryInvalidate` is implemented in `libs/memory-core/src/write.ts`**, not `invalidate.ts`
  (there is no `invalidate.ts` in `libs/memory-core/src/` — that was a wrong guess in the packet).
  Function starts at `write.ts:726`. The `t_invalid` mutation on the episode node is at
  `write.ts:768` (`UPDATE node SET t_invalid = ? WHERE uid = ?`), inside a transaction, guarded by
  a live-row lookup at `write.ts:734`.
- Re-exported (not re-implemented) from `libs/memory-core/src/index.ts:98`.
- The MCP tool `memory_invalidate` in
  `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:1702-1723` just calls
  `memoryInvalidate(writeDb, {...})` inside `wq.enqueue(...)` — thin wrapper, no logic of its own.
- There's a `libs/memory-core/src/invalidate.spec.ts` (test file) that presumably targets
  `memoryInvalidate` from `write.ts` — worth checking first, it may already assert the current
  (broken) behavior and need updating alongside the fix.

## `cluster.ts` — NOT touched

Zero edits made to `cluster.ts`. Did not get as far as reading the retirement logic at
`cluster.ts:274-296` in detail — only located it via BACKLOG.md citation, did not open the file
this session. **PKT-29/PKT-30 should have a clean, untouched `cluster.ts` to land on from this
agent's side.**

## What's left (for the next agent, not done here)

1. Open `libs/memory-core/src/cluster.ts:274-296` and understand `materializeClusters`'s
   retirement logic well enough to extract/share it (a helper function both `write.ts` and
   `cluster.ts` can call) — the packet explicitly warns against copy-pasting a second
   implementation of the retirement rule.
2. Wire that shared retirement check into `memoryInvalidate` in `write.ts`, most likely right
   after (or as part of) the transaction that sets `t_invalid` at `write.ts:768` — check the
   node's communities via `MEMBER_OF` edges, and if a community's live member count just hit
   zero, invalidate the community node too.
3. Write the red→green test named BL-327: invalidate every member of a community and assert the
   community node is no longer live, without a full pass. Also assert the converse (partial
   invalidation leaves the community live) per the packet's acceptance criteria.
4. Only after watching red→green: move BL-327 from BACKLOG.md to CHANGELOG.md, regenerate header
   counts, run `check-backlog-markers`, `check-plan-packets`, `check-bl-id-integrity`.

## Anything contradicting the packet's framing

Nothing found yet — didn't get far enough into `cluster.ts` or the invalidate spec to hit
contradictions. The one correction is the file path (`write.ts`, not `invalidate.ts`), already
flagged above.

## Touched / committed this session

- No source files edited.
- This handoff file only.
- No commits yet from this agent prior to this one.

## Worktree

Safe to discard — nothing but this handoff and research (no code changes) happened here. If kept,
it's just a normal fresh worktree off `wip/turso-live-metrics` with no extra state.
