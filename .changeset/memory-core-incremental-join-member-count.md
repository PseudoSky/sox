---
"@adhd/sox-memory-core": patch
---

Incremental community joins now refresh the community's stored `meta.member_count` to its live MEMBER_OF count, so `memory_get_community` no longer under-reports communities that grew by join. The first-minted community uid is unchanged by a join, and the per-join outcome counters keep advancing.
