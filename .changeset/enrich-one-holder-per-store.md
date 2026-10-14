---
"@adhd/sox-memory-core": patch
"@adhd/sox-extension-memory-server": patch
---

Fix memory store contention and enrich-child churn.

- Enrich passes run in a child process that is refused while a prior child for the same store is still alive, so one store never has two holders.
- Enrich children exit when their parent disconnects, and the parent SIGKILLs live children on exit, so no orphan holds the store.
- SIGKILL escalation after SIGTERM is armed independently of settle, so a SIGTERM-ignoring child cannot survive a timeout.
- Idle enrich ticks (no open trigger and an unchanged store) skip the fork, with a forced real pass every 13 ticks.
- Replace two untraced catch blocks with traced warnings and trace the enrich child lifecycle.
