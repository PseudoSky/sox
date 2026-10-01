# s7-backlog-binding — backlog binding (CROSS-REPO)

**Phase:** binding · **Deps:** s1 · **Tier:** hard · **Est:** cross-repo · **⛔ BLOCKER B1**
Target repo: `/Users/nix/dev/node/adhd` (package `@adhd/backlog` v1.0.6, `entrypoint/backlog/`).

## Goal

Bind the reclaim engine to the backlog store (`~/.adhd/backlog/production/data/backlog-v2.db`), plus the
expiry pass against the backlog backup dir. Topology per DESIGN P7 / §4.2 — the store is **not** reached
through the service-proxy funnel today.

## File ownership (in the adhd repo)

- **creates:** `/Users/nix/dev/node/adhd/entrypoint/backlog/src/store/reclaim.ts`
- **mutates:** `src/env.ts` (typed `store.maintenance.*`), `src/cli.ts` (`store-reclaim` verb beside
  `store-check` `:633`), `src/serve.ts`/`src/server.ts:792` (opportunistic obligation consume)
- **read_only:** `src/store/graph-backlog-store.ts`

## Contract

`adhd-backlog store-reclaim [--dry-run]` → prints a `StoreReclaimReport`; refuses `not_quiescent` with pids
when any `adhd-backlog serve`/CLI process holds the store. Obligation consumed by whichever process finds
the store quiesced. When ADR-0015 lands, the consumer becomes the backend (see DESIGN §4.2).

## Acceptance criteria

1. `adhd-backlog store-reclaim --dry-run` against a seeded leaked store reports a would-reclaim result; the
   store's live-node counter matches the backlog schema's live-issue count.
2. With a live `serve` process holding the store, the verb returns `refused/not_quiescent` with pids and
   mutates nothing.
3. The backlog `StoreGrowthConfig` alarm is **calibrated** from a first `--dry-run` rebuild (DESIGN §6.2) —
   the `24576` constant is **not** assumed.
4. Backlog test suite green; confirm published-bytes vs workspace resolution for the new
   `@adhd/sox-store-adapter` engine.

## Commit points

- Commit in the **adhd** repo by explicit pathspec; do not touch sox-ecosystem from this segment.

## Notes

- This is the only segment that runs outside sox-ecosystem. Its guard cannot be exercised from the
  sox-ecosystem worktree — say so explicitly rather than marking it green from here.
