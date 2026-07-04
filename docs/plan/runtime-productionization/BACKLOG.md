# runtime-productionization — plan-scoped backlog IDs

IDs appended per the disclosure convention (full entries live in the repo-root `BACKLOG.md`).

- **BL-174** — `memory_ping` store block hardcodes `last_checkpoint_at: null` despite
  `WriteQueue.lastCheckpointAtForPath()` existing — **RESOLVED (2026-07-04, c7ae883)**.
- **BL-175** — DEFERRAL: apply the WriteQueue metrics → `memory_ping` integration patch — **RESOLVED (2026-07-04, c7ae883: write_queue live in ping, verified)**.
