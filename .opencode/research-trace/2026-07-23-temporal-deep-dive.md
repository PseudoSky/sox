# Research Trace: Temporal Deep Dive

Date: 2026-07-23
Agent: Researcher Agent

## Quantitative Metrics

| Metric | Baseline | Result | Delta | Target | Status |
|--------|----------|--------|-------|--------|--------|
| Search terms executed | 0 | 17 | +17 | >=9 | PASS |
| Phases completed (1-6) | 0 | 6 | +6 | 6 | PASS |
| Tools approved/blocked | 0 | 8 | +8 | >=3 | PASS |
| Confidence-labeled claims | 0 | 3 | +3 | >=1 | PASS |
| Sources verified per tool | 0 | 2-4 per tool | +2-4 | >=2 per approved | PASS |
| Rate limit / block events | 0 | 1 (duckduckgo HITL) | +1 | <=2 | PASS |

## Promotion Gate

- <3 search terms with useful results? NO (17 searches, most returned good results)
- <2 tools found? NO (8 tools documented)
- >3 rate limits/blocks? NO (1 HITL event, switched to google cleanly)

**Result: PASS** — Run is COMPLETE.

## What Worked Well

1. **Parallel search strategy** — Running all discovery searches in one batch was efficient
2. **Google as duckduckgo fallback** — When duckduckgo hit a captcha on the first query, switching to google for that specific search worked immediately
3. **Deep-fetch focus** — Going directly to GitHub READMEs gave the most authoritative data. The blog post on isolated-vm and the deep-dive architecture article were gold mines.
4. **npm/bash queries** for version, description, and license data provided verified metrics
5. **Reflow-ts README** was exceptionally detailed — contained everything needed for a thorough comparison

## What Searches Failed / Why

1. `site:temporal.io OR site:github.com/temporalio temporal typescript sdk how intercept await workflow` — duckduckgo returned HITL (captcha). This was the very first search. Switched to google for subsequent targeted searches.
2. The duckduckgo HITL might have been triggered by the `site:temporal.io OR site:github.com/temporalio` qualifier. Subsequent duckduckgo searches without complex qualifiers all succeeded.

## Corrections to Initial Assumptions

1. **Temporal does NOT intercept `await` via Promise substitution or Proxy.** I initially assumed there was a JS-level interception mechanism. The actual mechanism is a V8 isolate sandbox that re-executes the entire workflow function on replay and matches commands against event history. There is no `Promise` overriding.
2. **SDK-core is NOT a standalone runtime.** It's a Rust library that each language SDK embeds via FFI. It doesn't run user code — it handles gRPC comms and state machines.
3. **Effection is NOT a durable execution engine.** It came up in searches for "durable execution" but it's actually a structured concurrency library with no persistence.
4. **The closest "Temporal without server" is Reflow-ts, not Restate.** Restate is a lightweight server (single binary), not a library. Reflow-ts is a library that uses SQLite with zero infrastructure.

## Process Failure Classifications

None significant. One minor process issue:
- **Search formulation (Phase 2/4)**: The very first search was too complex with `site:` qualifiers, which triggered duckduckgo's captcha. Simpler searches without qualifiers succeeded. Improvement: start with simple queries, add qualifiers only after initial results.

## Actionable Improvement for Next Run

Always start searches without `site:` qualifiers when using duckduckgo. Use google for `site:`-style searches from the start, and save duckduckgo for broad queries.
