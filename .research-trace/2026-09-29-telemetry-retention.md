# Research trace — durable performance-telemetry retention + cross-release comparison

- Date: 2026-09-29/30
- Agent: researcher (deepseek-flash)
- Slug: telemetry-retention
- Memory: default store (sha256:32e57263cf5f), ping `status: ok`

## Metrics (Step 0)

| Metric | Baseline | Result | Delta | Target | Verdict |
|---|---|---|---|---|---|
| Search terms executed | 0 | 23 | +23 | >=9 | PASS |
| Phases completed (0–7) | 0 | 8 | +8 | 8 | PASS |
| Tools approved/blocked | 0 | 7 (6 approved, 1 blocked) | +7 | >=3 | PASS |
| Confidence-labeled claims | 0 | 9 (see report) | +9 | >=1 | PASS |
| Sources verified per approved tool | 0 | >=2 for every approved tool | + | >=2 | PASS |
| Rate limit / block events | 0 | 0 | 0 | <=2 | PASS |

**Promotion gate: PASSED** (22/23 searches returned useful results; 7 tool decisions; 0 rate-limits/blocks).

Separate, non-gate count: **3 `memory_write` timeouts** (all recovered by a single sequential
re-send). Not a search failure — see "Environment finding" below.

## Worked well

- **Reading the repo's ADR catalog before searching** was decisive. `ds/decisions/0014`, `0022`,
  `0018`, `0013` turned four of the five research questions into "here is the house decision, cite
  it" instead of open discovery. ADR-0014 in particular already contains the full retention policy
  the caller needs (Finding 6 even names the exact `sink.ts:_pruneOldFiles()` mechanism).
- **Deep-fetching primary docs via the `fetch` provider** produced exact quotable semantics
  (logrotate `rotate -1`/`maxage` interaction; journald keep-free-raised-never-reclaims; Prometheus
  "whichever triggers first"; OTel fileexporter append⊕rotation). These are the load-bearing claims
  and all are from live HTTP 200 fetches.
- **Naming the in-repo mechanism and policy separately** (sink.ts = mechanism, ADR-0014 = policy)
  made the gap statement precise rather than vague.
- **Not citing Google redirect URLs.** Every `google.com/goto?url=…` was discarded; only canonical
  URLs appear.

## What failed / process failures

1. **Source selection (partial read) — 1 instance.** Grafana Alloy's `otelcol.exporter.file`
   (`max_days` default 0 = keep-forever) is a **DDG snippet only**, not deep-fetched; filed as
   `data_quality: estimated` and explicitly marked snippet-only. The primary doc URL is identical in
   shape to the OTel fileexporter page I *did* fetch, so this was one fetch away.
   → Classification: **source selection**.
2. **Search formulation — 1 instance.** The `arxiv` query
   (`cat:cs.DB time series downsampling retention policy local storage`) returned `outcome: empty`
   and was **not reformulated**. Scholarly coverage of RQ3 therefore rests on the LSM-tree classic
   (O'Neil 1996, found via DDG, not arxiv) rather than an observability-specific paper.
   → Classification: **search formulation**. Coverage gap: no peer-reviewed observability-retention
   paper was located.
3. **Inference leakage risk — 1 instance.** The name "Retention Floor Triad" and the claim that
   mature systems "converge" on it is **my synthesis** across ADR-0014 + journald + logrotate +
   Prometheus. It is labelled `pattern:recommended` with named per-source citations and the
   corroboration is independent, but the convergence claim is MEDIUM confidence, not HIGH.
   → Classification: **inference leakage** (bounded and labelled, not hidden).
4. **Filter-vocabulary mistake — validation step.** The first post-write recall filtered on
   `tags: ["tool-catalog"]`; `tool-catalog` is a **topic**, not a tag, so it returned empty. Re-run
   with `topic`. Cosmetic; cost one call.
   → Classification: tooling/query error, self-corrected.

## Environment finding (worth carrying forward)

`memory_ping` reports `write_latency_ms.p50 = 16413 ms`. Three of seven concurrent `memory_write`
calls hit the MCP client timeout while four succeeded in the same batch. The store was **not** dead
(reads and 4 writes succeeded; `store_ok: true`). Recovery: a **single** sequential re-send of each
failed write. This is safe because `memory_write` dedups on `content_hash` (which ignores
`project_path`), so an identical re-send either writes once or returns E_DEDUP — never a duplicate.
**Better practice for next run: batch memory writes at most 2 per message on this store.**

## Corrections to initial assumptions (Phase 0 priors)

- **Confirmed:** logrotate's `maxage` is not a standalone age cap; Prometheus size retention is
  best-effort; OTel resource attributes are the version-identity carrier.
- **Corrected / surprising:**
  - Downsampling **costs** space (Thanos: "doesn't save you any space … adds 2 more blocks …
    ~3x"), rather than saving it. This inverts the common assumption and is a genuine finding.
  - `deployment.environment.name` explicitly **does not** affect identity uniqueness — it is a
    description axis, not an identity axis. I had half-assumed it was part of identity.
  - OTel fileexporter's `append: true` is **mutually exclusive** with rotation — append-only and
    rotation do not compose.
  - Alloy's `max_days` defaults to **0 = keep indefinitely**, while the OTel fileexporter's
    `max_days` has **no default** (unlimited). Two "age caps" that default to no cap.
- **Prior knowledge that could NOT be verified:** an observability-specific retention paper
  (arxiv empty; not reformulated). Flagged.

## One actionable improvement for next run

**For any claim that will land in an `agent:approved` tool entry, deep-fetch the primary doc even
when a search snippet already answers it — never let a snippet be the sole source of a quality
signal or a default value.** (This is the single instance #1 above; a snippet-sourced default is
exactly the "snippet-sourced metric" failure family.)

## Second improvement

Reformulate an `arxiv` `outcome: empty` once before substituting a non-scholarly source, so
scholarly coverage is a decision rather than an accident.

## Not written to memory (by design)

This trace is a local process record only — no finding content is stored here.
