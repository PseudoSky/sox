---
"@adhd/sox-memory-core": patch
"@adhd/sox-extension-memory-server": patch
---

Stop re-scoring rejected candidates on every incremental clustering pass.

- The incremental join persists a rejection watermark in `sox_store_meta` and evaluates only candidates above it, so a steady-state tick no longer rescans every unassigned episode against every community member.
- The watermark resets on a threshold change, a membership change, growth of the unassigned set below the watermark (un-invalidation), or a 6 hour full-rescan backstop. Candidates with no vector, or rejected by the degenerate-ratio guard, hold it below them.
- Enrich passes with no backlog no longer time out inside the clustering step.
