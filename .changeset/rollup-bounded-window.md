---
'@adhd/sox-telemetry': patch
---

The metrics rollup reader now reads only the trailing window of each snapshot file: it seeks the first read to the window start, streams bounded 1 MiB chunks, and resumes incrementally by byte offset. Retained memory is bounded to the in-window records instead of the full snapshot history. The rollup cache is dropped when the read target changes.
