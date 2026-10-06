---
"@adhd/sox-extension-memory-server": patch
"@adhd/sox-extension-memory-cli": patch
"@adhd/sox-extension-memory-flush": patch
---

Pick up the batched `getEdges({ srcs, dsts, rels })` read from `@adhd/sox-graph-store` (89cc3a30).

Extensions ship as self-contained esbuild bundles that inline `@adhd/sox-memory-core` and its `@adhd/sox-graph-store` dependency, so the new bounded, page-keyed edge read only reaches users when these bundles are republished. `memory-cli` and `memory-flush` inline `memory-core` identically to `memory-server`, so they are republished alongside it.
