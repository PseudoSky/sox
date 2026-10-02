# Research trace — dispatcher bucketing / review-trigger / priority escalation (2026-10-02)

## Deliverable
External evidence for three dispatcher-v2 policy questions, to validate or refine the rules shipped
in commit `3f3d5a9f` and refined in `1ad2f339`:
- **Q1** work-unit granularity — is "bucket by cohesion; maximize ground per pass" supported?
- **Q2** review-type trigger — is a `>=8 changed files` blind-review floor defensible?
- **Q3** prioritization + escalation — what order, and when to escalate?

Run: rebooted batch-2 `researcher` (background task `ses_f01b2e11cffeF8fsfyWZU0iCiI`), after the
first batch-2 run died mid-finalization. Findings were first recovered from memory, then this run
re-verified them against primaries.

## Verdicts (all ADAPT — shipped defaults directionally right, refined)

### Q1 — Work-unit granularity: cohesion + separability, NOT maximal coverage
`cover as much ground as possible in one pass` is **not supported**. Size by cohesion + separability
(independently completable, one testable done-state). Maximal-coverage units lengthen the feedback
loop, enlarge the untested surface, and raise LLM context cost and human review cost.
Evidence: DORA "Working in small batches" + INVEST (B-primary); DORA 2024 (AI lifts productivity but
harms delivery stability); Liu et al 2023 "Lost in the Middle" (arXiv:2307.03172, TACL, A); Kohl et al
2020 (arXiv:2006.12636, B); Wang et al "TDAG" (arXiv:2402.10178, A).
Confidence: **HIGH** for bounded sizing over maximal coverage; **MEDIUM** for any specific size band.

### Q2 — Review-type trigger: changed LOC / risk, not file count
`>=8 changed files` is a **weak proxy** (ignores LOC and cognitive load). Prefer changed lines of code
with logical-unit/risk qualifiers; keep file count at most a coarse secondary signal. Reserve the
expensive blind review for riskier output (shipped runtime code).
Evidence: Rigby & Bird ESEC/FSE 2013 (DOI 10.1145/2491411.2491444, A) — review parameters converge on
small reviews; di Biase et al PeerJ CS 2019 (DOI 10.7717/peerj-cs.193) — changesets ≈100 LOC over
several files. The famous **200–400 LOC** band is SmartBear/Cisco 2006, whose primary PDF is a scanned
image with no extractable text → the numeric band is **LOW** and flagged. Guided-review-loses-detection
mechanism is **LOW** (SmartBear's own hypothesis, competing explanation offered).
Confidence: **MEDIUM** — direction (small reviews, LOC over file count) is A/B supported; the numeric
band and the mechanism are LOW.

### Q3 — Prioritization + escalation: dependency-first, ration the finite reviewer
Score value with WSJF or RICE, but apply **dependency/topological order FIRST as a hard override**,
then value within the ready set. Escalation is a finite resource, not a safety dial: trigger only on a
genuine, unpinned, high-stakes conflict — not on an item-count proxy.
Evidence: Intercom RICE guidance (B-primary, explicit that a dependency "needs to happen first");
SAFe/Reinertsen WSJF (B-primary); Turan 2026 "Oversight Has a Capacity" (arXiv:2606.08919, B preprint)
— reviewers Fleiss' κ=0.52, realized safety is an **inverted-U** in escalation rate; Jahanshahi et al
2022 (arXiv:2011.05382, A). Internal: ~31% of dispatches (128/417) were out-of-objective side missions.
Confidence: **HIGH** that dependency precedes value-scoring and escalation must be rationed; **MEDIUM**
for the trigger heuristic and the inverted-U's real-world magnitude.

## Memory episodes written (verified present by semantic recall, 2026-10-02)
- `01M3Z4YBN4ZZWJKMGN6QSQCKSV` — work-unit granularity (topic tool-catalog, tags [… dispatcher … confidence:high])
- `01M3Z4YE4JNSE2W5JPCDZ7XR3G` — review-type selection (topic tool-catalog, confidence:medium)
- `01M3Z4YGZ03ZSPPPNRPZ3P72Q3` — prioritization + escalation (topic tool-catalog, confidence:high)
(Chunks also present: `01M3Z4YBY2…`, `01M3Z4YEF4…`, `01M3Z4YH81…`, `01M3Z4YHDS…`.)
Prior batch-2 episodes (`01M3Z37G9RNM3X97J5YPZ04PZ1`, `01M3Z37MTWEW4MQV9TWQFK7EVG`,
`01M3Z37RR0JWVNNF7AF27PTGQB`) carried `topic:null`/`tags:[]` because a JSON object was passed as
`content`; their substance was correct and re-verified here.

## What landed where
These three findings are the source of the shipped refinements in commit `1ad2f339` and the filed
follow-ups F1 `ae18c16d`, F2 `258c6198`, F3 `3e74db8b` (each `part_of` plan `80a4011e`).

## Metrics
| Metric | Target | Result |
|---|---|---|
| Searches executed | >=9 | 22 |
| Phases completed (0–7) | 8 | 8 |
| Findings approved | >=3 | 3 |
| Confidence-labeled claims | >=1 | HIGH/MEDIUM explicit, LOW elements flagged |
| Sources per finding | >=2 | Q1=5, Q2=2(+2 LOW), Q3=4 |
| Rate-limit / block events | <=2 | 0 |

## Promotion gate
PASS. >3 searches returned useful results; all three findings carry >=2 sources and explicit confidence;
0 rate limits.

## What worked
- Re-verifying the prior Q2/Q3 claims against primaries rather than trusting prior memory surfaced that
  the **200–400 LOC band's primary is unreadable** — the number is folklore-grade, now labeled LOW.
- Memory-first: the dead batch-2 run's findings were recovered from the store, so the reboot added
  verification rather than redoing discovery.

## What was weak / process failures
- **Trace-file evidence falsified.** This run's RETURN claimed it wrote
  `.research-trace/2026-10-02-dispatcher-bucketing-review-priority.md`; it did not (absent from home,
  `~/dev`, `/tmp`, `/var/folders`). This file was authored post-hoc by the engagement owner from the
  delivered findings. Classification: **claim not traced to artifact** — a RETURN assertion of a write
  that was never verified. Guard: a trace path in a RETURN must be confirmed by a read before it is
  accepted as evidence.
- **Memory-write claim initially mis-assessed.** Engagement-side probes (`memory_related` by uid)
  returned `E_NOT_FOUND` for the new uids — but the control (uids known to have landed) also returned
  `E_NOT_FOUND`, proving that probe invalid. Semantic recall then **confirmed all three episodes
  present**. Lesson: `memory_related` is not an existence probe for episode nodes; use semantic recall.
- **SmartBear primary unreadable** (scanned PDF) — Q2's numeric band stays LOW pending a text-layer copy.

## One improvement for next run
When a research RETURN cites an artifact path, verify that path with a read before recording the
finding; and probe memory existence with semantic recall, never `memory_related`-by-uid.

## Stopping criterion
No LOW-confidence finding left unresolved *as a blocker*: the LOW items (SmartBear numeric band,
guided-review mechanism, inverted-U magnitude) are explicitly labeled and do not carry any shipped rule
on their own; the shipped direction rests on the HIGH/MEDIUM sources.
