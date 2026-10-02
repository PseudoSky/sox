---
name: A/B cost measurement for OpenCode context plugins via the scratch metadata stack
topic: tool-catalog
tags: [pattern:recommended, opencode, cost-measurement, ab-testing, agent-dashboard, agent-schema]
importance: 7
data_quality: verified
status: NOT-YET-IN-MEMORY (memory-server MCP transport down this session; see backlog 03d79058-e685-40d0-8f90-d6b14a7d9b11)
summary: >
  The scratch agent-metadata stack (opencode-metadata + agent-schema + agent-dashboard) is
  the right substrate for A/B-measuring OpenCode context-plugin cost savings, because cost_usd
  is the REAL billed figure and cache_read/cache_write + avg_prompt are tracked. What it lacks is
  any statistical machinery — the dashboard is a viewer, so "delta confidence" must be computed
  outside it from the exported JSON feed. Attribute experiment arm via the cwd/cwd_leaf dimension
  (no code change). Guard against the two known confounds: prompt-cache invalidation (cost != tokens)
  and the <15-20-turn DCP regression (so use long sessions).
---

# Finding: how to actually test whether a context plugin saves money

## Verdict
**Yes — feasible, and the existing infrastructure is unusually well-suited.** But "delta
confidence metric lift" is NOT a built-in: the dashboard aggregates and visualizes, it does not
compute confidence intervals or run significance tests. That layer must sit on top of the
exported JSON feed.

## What the substrate already provides (verified against the tools' own docs)

- **`cost_usd` is REAL billed cost** — opencode stamps `message.cost` per assistant message, and
  the exporter carries it through. This is the ground-truth response variable; do not substitute
  token counts (see Confounds).
- **Cache economics are tracked**: `tokens_cache_read`, `tokens_cache_write`, and derived
  `cache_hit_rate = cache_read / (tokens_in + cache_read)`. This is what surfaces the fixed
  prompt cost and the cache confound.
- **Prompt volume per call is tracked**: derived `avg_prompt = (tokens_in + cache_read)/steps`,
  and the CLI's `ctx/step` + `peak` columns. This is exactly the quantity a context-pruning plugin
  targets.
- **Attribution dimensions**: `client, project, cwd, cwd_leaf, agent, model, model_id, is_sub,
  task, tool, tool_kind`. Enough to isolate an experiment arm without schema changes.
- **Windows + bucketing**: `pivot --since/--until --bucket 1h/1d --groupby <dims> --metric cost,tokens,cache_read,steps,cache_hit_rate,avg_prompt` — exact per-window totals, conservation-tested
  (`Σ cost_usd over visible == window total`).
- Source of truth: `~/.local/share/opencode/opencode.db`, consumed by `opencode-metadata`
  (Python, stdlib only). The claude equivalent feeds the same schema with `client:"claude"`.

## What is MISSING (the gap to close for a real experiment)

1. **No experiment-arm dimension.** A row has no "plugin config" field. Encode the arm in a
   controllable existing dimension — the cleanest is a **distinct working directory per arm**
   (`cwd` / `cwd_leaf` is already a dimension), e.g. run arm B in `.../ab-plugin-on/` and arm A in
   `.../ab-plugin-off/`. Then `pivot --groupby cwd_leaf,task --metric cost,cache_hit_rate,avg_prompt`
   separates them with zero code change. (Alternative: distinct `project` or `agent` naming.)
2. **No statistics.** No CI, no paired test, no significance in the dashboard or the CLI. Compute
   the delta confidence externally from the exported JSON (bootstrap 95% CI on the per-session
   `cost_usd` delta, or a paired sign test / paired t-test).
3. **Task variance is unmodeled.** Mitigate with a **paired, interleaved block design**: a fixed
   task suite (K tasks), each executed N times per arm, order alternated ABBA to cancel drift;
   compare within-task pairs.

## Recommended experiment design (feasibility level)

- **Design**: paired block. K fixed tasks, each ≥20 turns, N repeats per arm, arms
  A=baseline / B=plugin (or the full 3-plugin stack) interleaved. Same `model`/`model_id`, same
  starting repo commit, prompt held constant.
- **Primary metric**: `cost_usd` per session (billed). **Secondary**: `avg_prompt`, `cache_hit_rate`,
  `steps`, `active_ms`, and context-share (input+cache_read) to attribute the saving to context.
- **Attribution**: arm via `cwd_leaf`. Then
  `opencode-metadata pivot --groupby cwd_leaf --metric cost,cache_hit_rate,avg_prompt`.
- **Inference**: export the feed (`opencode-metadata export --full`), then per-(task,pair)
  deltas of `cost_usd`; bootstrap 95% CI + paired sign test. Report the CI, not a point estimate.
  n per arm ~10-20 minimum given the noise.
- **Accept/reject**: reject if the `cost_usd` delta CI includes 0; reject if `cache_hit_rate`
  collapses toward 0 (cache-write premium eats the saving); reject if a short-session arm regresses.

## Confounds the design must respect (both documented, both real)

1. **Cost != tokens.** Pruning mutates history and invalidates provider prompt-cache prefixes; raw
   token reduction overstates cost saving on cache-billed providers. This is why the response
   variable MUST be `cost_usd`, and why `cache_hit_rate` must be reported per arm.
2. **Short-session regression.** The plugins themselves document a token *increase* below ~15-20
   turns. A short-task experiment measures the regression, not the benefit — so the task suite must
   use long sessions.

## Where the dashboard fits, and where it doesn't

- **Fits**: loading the experimental feed, pivoting on `cwd_leaf`, eyeballing `cost_usd` /
  `cache_hit_rate` / `avg_prompt` over the experiment window, confirming conservation, live-polling
  a watch-exporter during the run.
- **Does not fit**: any confidence/delta statistic. The dashboard's whole model is
  `aggregate(events, state) -> rows + pivot + series` — pure sums, no inference.

## References
- `scratch/opencode-metadata/README.md` — `cost`, `pivot`, `export` semantics; the `cost_usd`
  billed-vs-estimated distinction; the store-wide finding that prompt (input 36% + cache-read 32% =
  68%) dominates spend.
- `scratch/agent-schema/events.json` — the v2 metric/dimension contract (source of truth).
- `scratch/agent-dashboard/README.md` + `SPEC.md` — viewer semantics, derived metrics, conservation.
- Backlog `03d79058` — the memory transport drop that forced this fallback write.
