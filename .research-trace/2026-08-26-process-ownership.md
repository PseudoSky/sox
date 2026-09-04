# Research trace — process supervision & child-process ownership models

Date: 2026-08-26 · Agent: researcher · Run: process-ownership (macOS/Linux supervisor reconciliation)

## Generalized problem
A service supervisor must reap processes belonging to dead service instances while NEVER killing
legitimate children of live services. The current env-token + socket-fd-count classifier
misclassifies fork children of live services (they inherit the env token, hold no socket fd) and
kills them every reconciliation cycle.

## Metrics (Phase 6 Step 0)

| Metric | Baseline | Result | Delta | Target |
|---|---|---|---|---|
| Search terms executed | 0 | 25 | +25 | >=9 ✅ |
| Phases completed (0–7) | 0 | 8 | +8 | 8 ✅ |
| Tools approved/blocked | 0 | 7 (4 approved / 3 blocked) | +7 | >=3 ✅ |
| Confidence-labeled claims | 0 | ~10 | +10 | >=1 ✅ |
| Sources verified per approved tool | 0 | 2+ each | +2 | >=2 per approved tool ✅ |
| Rate limit / block events | 0 | 1 (google HITL) | +1 | <=2 ✅ |

Promotion gate: PASSED (13/14 discovery searches useful; 7 tools found; 1 block event).

## Findings written to memory (22 episodes)
- Tools: ps-list (approved), pidtree (approved), go-proc/supervisor (approved, reference),
  tini (approved, reference), tree-kill (blocked), fkill (blocked), @apify/ps-tree (blocked).
- Patterns: cgroup structural ownership; parentage+root-liveness two-key check; subreaper+SIGCHLD
  wait4 drain; kqueue EVFILT_PROC watch; session/pgid boundary; ANTIPATTERN env-token-only;
  ANTIPATTERN fd-count-only; ANTIPATTERN kill-every-cycle; zombie/orphan semantics + hazards.
- Use cases: systemd, launchd, supervisord, pm2, docker/tini, s6.

## What worked
- Local macOS man pages (`man kqueue`, `man 5 launchd.plist`, `man launchctl`, `man 2 fork`) +
  SDK header check verified the primary-platform primitives authoritatively and cheaply.
  NOTE_REAP discovered DEPRECATED locally — nuance lost in web sources.
- fetch-provider raw READMEs (go-proc/supervisor, TreeKill.js) gave source-level verification.
- python3 tag-strip + marker extraction kept deep-fetch budget ~11k/15k tokens.

## What failed / flagged
- google provider HITL on 1 of 2 queries early in the run — per protocol: stopped, did not retry,
  did not route around; coverage obtained via duckduckgo/man7. Wait for resolver before next google use.
- arxiv query returned empty (expected — engineering prior art, not academic).
- Phase 3 memory recall returned only unrelated episodes (Turso/adhd) — no prior work on this topic.
- Initial post-write validation recall with `filters: { tags: [...] }` returned 0 — filter shape
  mismatch; recovered with unfiltered recall; all 22 episodes confirmed present.
- FLAGGED (not LOW): proc_pidinfo(PROC_PPID) — function declared in CLT libproc.h:96 (verified);
  the PROC_PPID flavor constant + proc_bsdinfo struct are NOT in the CLT header (private/xnu side)
  and were not independently verified from a second source — treat the flavor constant as MEDIUM
  confidence; `ps -o pid,ppid,sess,pgid` observability WAS verified locally.
- MEDIUM-confidence items (explicitly labeled in episodes): pidtree recursive-descendant breadth;
  EVFILT_PROC NOTE_FORK not carrying the child pid.

## Corrections to initial assumptions
- NOTE_REAP exists on macOS but is DEPRECATED (use NOTE_EXIT) — my prior said "exists"; nuance added.
- launchd's ownership boundary at kill time is the process GROUP (pgid), not a launchd pid table —
  verified from launchd.plist(5) + web mirror.
- systemd's subreaper usage is explicitly documented in the PR_SET_CHILD_SUBREAPER man page.
- cgroup.kill is fork-safe and migration-protected (kernel docs) — stronger than my prior.

## Process failure classifications
- None serious. One minor: over-broad Phase 3 recall consumed tokens returning irrelevant episodes
  (query formulation, not source selection). Improvement: add topic/entity filters in first recall pass.

## Stopping criterion
Zero LOW-confidence findings remain unresolved; all flagged items are MEDIUM or explicit.
Process considered stable for this run. Logged complete.

## One actionable improvement for next run
Verify platform primitives against LOCAL man pages / SDK headers FIRST (cheap, authoritative),
then use web only for third-party supervisors and tool metadata.
