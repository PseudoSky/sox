# Temporal TS SDK Modularity Research Trace

## Quantitative Metrics
| Metric | Baseline | Result | Delta | Target |
|--------|----------|--------|-------|--------|
| Search terms executed | 0 | 18 | +18 | >=9 |
| Phases completed | 0 | 6 | +6 | 6 |
| Memory episodes written | 0 | 8 | +8 | >=3 |
| Rate limit events | 0 | 0 | 0 | <=2 |

**Promotion gate:** ✅ PASSED

## What Worked Well
- Parallel npm view calls across all @temporalio/* packages immediately revealed the dependency map
- Reading the actual source code (worker-interface.ts, internals.ts, vm.ts) confirmed architectural understanding
- Combined web search + npm registry + GitHub source -> comprehensive multi-angle analysis

## Search Failures
- GitHub search with `repo: qualifier` returned HTTP 422 (route not found for `type:code` without explicit repo prefix)
- No existing standalone extraction projects found (this is a valid negative result)

## Corrections to Initial Assumptions
- Prior: "The replay engine is in @temporalio/worker" — Actually: it IS accessed through the worker, but lives in the Rust Core SDK (@temporalio/core-bridge native addon)
- Prior: "proxyActivities needs no server" — Correct, BUT the resulting functions DO require an Activator
- Prior: "V8 sandbox is in @temporalio/workflow" — Actually: the sandbox is in @temporalio/worker, the activator/state machine is in @temporalio/workflow

## Classified Failures
None.

## Actionable Improvement
Next time: Check the `exports` field of each package.json earlier (reveals internal vs public API boundaries)
