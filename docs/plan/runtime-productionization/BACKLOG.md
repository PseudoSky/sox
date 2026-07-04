# runtime-productionization — plan-scoped backlog IDs

IDs appended per the disclosure convention (full entries live in the repo-root `BACKLOG.md`).

- **BL-174** — `memory_ping` store block hardcodes `last_checkpoint_at: null` despite
  `WriteQueue.lastCheckpointAtForPath()` existing (surfaced by the write-path observability
  worktree, 2026-07-04).
- **BL-175** — DEFERRAL: apply the WriteQueue metrics → `memory_ping` integration patch
  (`06-hardening-final/WRITEQ_METRICS_INTEGRATION.md`) at merge, after the live-incident agent
  finishes in `memory-server/src/index.ts`.
