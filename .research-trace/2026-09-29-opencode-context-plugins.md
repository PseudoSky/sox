# Research trace — 2026-09-29 — "best proven money-saving OpenCode context plugin"

## Task
Find the best proven money-saving OpenCode plugin to optimize context.

## Metrics (baseline -> result, target)

| Metric | Baseline | Result | Delta | Target | Pass |
|---|---|---|---|---|---|
| Search terms executed | 0 | 16 | +16 | >=9 | Y |
| Phases completed (0-7) | 0 | 8 | +8 | 8 | Y |
| Tools approved/blocked | 0 | 7 (4 approved / 3 blocked) | +7 | >=3 | Y |
| Confidence-labeled claims | 0 | 6 | +6 | >=1 | Y |
| Sources verified per approved tool | 0 | DCP 2, openslimedit 2, snip 1.5, nocreep 2 | — | >=2 | ~ (snip stars MEDIUM) |
| Rate limit / block events | 0 | 0 | 0 | <=2 | Y |

Promotion gate: **PASS** (>=3 terms useful, >=2 tools found, 0 rate limits).

## Outcome
- Winner: **@tarquinen/opencode-dcp** (npm 18,948 wk, GitHub 4.3k stars, 1,426 commits, v3.2.0, AGPL-3.0).
- Complementary layers: **openslimedit** (MIT, tool-description compression, 11-45%), **opencode-snip** (MIT, bash output, external Go binary).
- Blocked: **billion-context** (proxy, OpenCode adapter deprecated), **Sleev** (commercial proxy, DCP's successor), **opencode-plugin-context** (display only).

## Friction / tool events
- Memory MCP (`memory-server`) dropped mid-session with `MCP error -32001: proxy closed` on the post-write validation recall. All 10 `memory_write_batch` items had already returned `ok:true` + episode_uid, so findings landed; the extra field-integrity recall could not run. Not retried (fail-fast policy; write receipts already prove persistence).
- No provider rate limits, captchas, tripwires, or bans.

## What worked
- Parallel breadth scan (9 calls, one message) surfaced the whole ecosystem immediately.
- `github` **repo** search (not code search) returned stars/forks/language/updated — the highest-signal single call. The `type:code` variant returned empty.
- Registry downloads API (`api.npmjs.org/downloads/point/last-week`) + `npm view` gave the verified metric spine.
- Fetching the Upsun blog delivered the only independent benchmark + the layer taxonomy.
- Fetching the DCP README delivered the prompt-cache trade-off and short-session caveat that no snippet carried.

## What failed / weak
- GitHub `type:code` search for `opencode plugin context optimization` -> empty. Reformulated to repo search; minor.
- `opencode-snip` star count was only available from a third-party aggregator (opendock.net) at MEDIUM confidence — no direct GitHub fetch made.
- openslimedit benchmark is author-published, single-source (MEDIUM confidence), not independently replicated.

## Corrections to Phase 0 priors
- I expected the landscape to be thin ("no mature plugin exists"). **Contradicted** — DCP is a 4.3k-star, 18.9k-download, 1,426-commit project. The space is real and active.
- I did not anticipate a *commercial successor proxy* (Sleev) absorbing the leader's R&D, nor the prompt-cache invalidation being the dominant real-cost caveat. Both were discovered, not assumed.

## Process failure classifications
- None material. One **source-selection** soft-spot: snip stars from an aggregator rather than a direct fetch.

## Actionable improvement for next run
- When a candidate's own npm `repository` field exists, always deep-fetch its GitHub README directly rather than accepting aggregator star counts — one fetch would have upgraded snip from MEDIUM to verified.
