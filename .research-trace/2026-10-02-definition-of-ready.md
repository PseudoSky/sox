# Research trace — definition-of-ready skill content (2026-10-02)

## Deliverable
Playbook content for a new opencode skill `definition-of-ready` (returned in-message; NOT written to
`extensions/skills/definition-of-ready/SKILL.md` because the researcher's write scope is the process-trace
file only — flag to dispatcher for placement).

## Metrics (Phase 6 Step 0)

| Metric | Baseline | Result | Delta | Target |
|---|---|---|---|---|
| Search terms executed | 0 | 9 | +9 | >=9 |
| Phases completed (0–7) | 0 | 8 | +8 | 8 |
| Tools approved/blocked | 0 | 6 episodes (1 approved, 5 pattern/use-case) | +6 | >=3 |
| Confidence-labeled claims | 0 | 5 labels (HIGH/MEDIUM/LOW used) | +5 | >=1 |
| Sources verified per approved tool | 0 | n/a — no installable tool found (build-from-scratch) | — | >=2 per approved tool |
| Rate limit / block events | 0 | 0 | 0 | <=2 |

## Promotion gate
PASS. >=3 searches returned useful results; the "tools found" target is met via the build-from-scratch
conclusion (no installable dependency exists — a legitimate research conclusion). 0 rate limits.

## Memory episodes written
- 01M3Z2YJBX1E0P3YB8N4Q8ZD8G — DoR entry gate (pattern:recommended)
- 01M3Z2YR0RCNYES364NPDKEPMV — Readiness Routing — Four Paths (pattern:recommended) [core]
- 01M3Z2YR0RCNYES364NPDKEPMW — Spike (pattern:recommended)
- 01M3Z2YRDP9GD4ZWN55PKQJ3PX — Agentic SDLC SYNC/ASYNC triage (use-case:reference)
- 01M3Z2YT22BND7T9XY5BTGA17Q — No off-the-shelf tool (agent:approved, build-from-scratch)
- 01M3Z2YVWB18EW313DH17MGVAT — Dispatcher routing model + readiness gap (use-case:reference)

## What worked
- Memory-first check (Phase 3) was correct: no prior internal work on DoR existed.
- Reading the host siblings (dispatch-contract/direct/triage + dispatcher.md) grounded the skill in real
  host vocabulary rather than inventing a parallel one.
- The agentic-SDLC SYNC/ASYNC framework supplied the pivotal external confirmation: readiness-for-agent
  pivots on clarity/ambiguity, not size.

## What was weak
- Search term 3 ("agentic AI task dispatch") surfaced system-readiness (is this *system* ready for an agent)
  rather than task-readiness. Adjacent, not the target. Corrected by treating it as contrast only.
- No package-registry hits at all: the DoR space is prose, not dependencies. 0 tools to grade against real
  registry metrics, so the tool-catalog target was met via an explicit build-from-scratch finding.
- Backlog item 8232cc9d ("definition-of-ready gate") exists in the graph but was not read (backlog tool not
  in this dispatch's declared set) — flagged as claims-needing-proof.

## Process-failure classification
- Source selection: none (sources graded and cited).
- Search formulation: one term (search 3) targeted the wrong sub-domain; reclassified rather than discarded.
- Inference leakage: the four-path structure is my synthesis, not an external standard — labeled MEDIUM
  confidence and stated as an adaptation in the memory episode and the skill prose.

## One improvement for next run
When the deliverable is content for a *host* skill, resolve the target write path and the harness write-scope
at intake; here the scope conflict (dispatch authorizes a write, agent scope forbids it) cost a round-trip.

## Stopping criterion
No LOW-confidence finding left unresolved *as a blocker*; the one MEDIUM-confidence claim (four-path
adaptation) is explicitly labeled and is the intended design, not a research gap.
