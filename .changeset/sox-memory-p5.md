---
"@sox/extension-memory-server": patch
"@sox/extension-memory-organizer": patch
"@sox/extension-memory-flush": patch
"@sox/extension-memory-cli": patch
"@sox/extension-sox-memory-bundle": patch
---

Phase 5: conformance hardening, strict-caps test, bench-scale, TypeScript strict-mode fixes.

Fixes exactOptionalPropertyTypes and noUnusedLocals errors in memory-server/memoryd.ts,
memory-server/write.ts, and memory-organizer/src/index.ts. Adds tools/test-strict-caps.js
(strict_capabilities hard-block proof) and tools/bench-scale.js (G1 db_engine switch
advisory at p95>35ms proven). Ships as 0.1.0 with verified lockfile checksums.
