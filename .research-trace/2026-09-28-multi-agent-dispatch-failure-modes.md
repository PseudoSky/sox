# Research process trace — 2026-09-28

**Engagement:** failure modes of a multi-agent dispatch process + cost/benefit of a dedicated research subagent.
**Agent:** researcher (deepseek-flash) · repo `sox-ecosystem` @ `af5c4900`
**Memory:** UNAVAILABLE — `memory-server` MCP not registered in this host (no `memory_ping`/`memory_recall`/`memory_write`
callables). Findings written to `docs/research/fallback/2026-09-28-multi-agent-dispatch-failure-modes/`.

## Metrics (Step 0)

| Metric | Baseline | Result | Delta | Target |
|---|---|---|---|---|
| Search terms executed (SEARCH calls) | 0 | 40 | +40 | ≥9 ✅ |
| Phases completed (0–7) | 0 | 7 (Phase 3 partially — memory absent) | +7 | 8 ⚠️ |
| Tools/findings cataloged | 0 | 10 fallback files | +10 | ≥3 ✅ |
| Confidence-labeled claims | 0 | all findings labeled | ✅ | ≥1 ✅ |
| Sources verified per key source | 0 | ≥2 for MAST, Anthropic, Cognition, review gates | ✅ | ≥2 ✅ |
| Rate-limit / block events | 0 | 1 (duckduckgo HITL tripwire, pre-existing) | +1 | ≤2 ✅ |

**Promotion gate:** ≥3 search terms returned useful results ✅; ≥2 tools found ✅; ≤3 rate limits ✅ → run is
**COMPLETE**, not `INCOMPLETE`.

## Outcome: what worked

- **arxiv + `fetch` + `curl`+`rg`** were the workhorses. `curl`-ing the MAST HTML and `rg`-ing `FM-*` codes
  extracted all 14 modes at a fraction of the token cost of a full HTML fetch.
- **Targeted `fetch` of known canonical URLs** (eng-practices, SRE book, Chromium, arxiv abs) produced clean,
  quotable, verified text — far better than Google result pages.
- Independent corroboration emerged naturally across RQ2/RQ3 from **three unrelated traditions** (Google
  eng-practices, lint-baseline tooling, formal inspection) plus the peer-reviewed MAST taxonomy.

## Outcome: what failed / friction

- **`duckduckgo` was locked by a PRE-EXISTING HITL captcha tripwire** (tripped by an unrelated
  `"cut_point_follow_max" instagram bot config` query — another session's traffic, not mine). Per the
  hitl-is-a-pause rule I did **not** retry or clear it; I moved general-web ground to **`google`** and state the
  substitution here. The trigger query appears in every error payload — it is collateral, not my research.
- **`google` provider returns ~400 KB of raw HTML per call** in `raw.preview` — costly. Should prefer `fetch`
  of known URLs and non-Google general search over Google result pages.
- **Two guessed URLs 404'd** (Cognition follow-up slug; LiteLLM budget page). Lesson: resolve a URL via search
  before fetching a guessed slug, or accept the search-snippet grade and say so.
- **No named agent-self-assessment "cite the revision" pattern exists** (RQ5) — searched, found only the
  protocol/ADR/provenance analogues. Recorded as an explicit gap.

## Corrections to Phase-0 priors

- **Confirmed:** MAST is real, and I was right to be unsure of the venue — it is **NeurIPS 2025 Datasets &
  Benchmarks** (I had it as "a 2025 taxonomy paper"; now A-grade).
- **Contradicted (surprising):** Cognition is often cited as flatly anti-multi-agent, but the post *explicitly
  endorses* the subagent context-isolation benefit and had a **2026 follow-up** softening the stance. My prior
  over-simplified it.
- **Confidence lowered:** I expected a clean "research subagent saves money" number; the evidence gives token
  multipliers and quality deltas, never a cost-per-task A/B. Downgraded accordingly (RQ6 = part-direction,
  part-gap).
- **New:** MAST has **no cost/budget failure category** — cost blindness is under-taxonomized.

## Process-failure classifications

- **Generalization drift:** none material — searches stayed on the caller's 6 RQs.
- **Inference leakage:** guarded. The 7-figure matrix explicitly separates "mechanism corroborated" from
  "numbers corroborated"; no external number was presented as validating a self-report.
- **Source selection:** a few `google` results are SEO listicles (Grade C) — used only for existence/phenomenon
  signals, flagged as C.
- **Search formulation:** good; the initial duckduckgo batch was wasted by the pre-existing tripwire (not a
  formulation error).

## One actionable improvement for next run

**Prefer `curl`+`rg` for large structured pages (arxiv HTML, docs).** Fetching arxiv HTML via `fetch` risks a
100 KB+ blob; `curl -sL … | rg -o '<pattern>'` extracted the 14 MAST modes in one cheap call. Adopt this as the
default for any table/list extraction.

## Stopping criterion

No LOW-confidence finding remains **unresolved**; every LOW/uncertain item (context-rot read partially; the 7×
subagent figure secondary; model-routing sources Grade C) is explicitly flagged rather than asserted. Process
stable → proceed to report.
