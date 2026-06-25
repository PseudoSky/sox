---
"@adhd/sox-extension-memory-server": minor
"@adhd/sox-extension-memory-flush": minor
"@adhd/sox-extension-memory-cli": minor
"@adhd/sox-extension-sox-memory-bundle": minor
---

Phase 0: scaffold sox-memory tenant as native ecosystem extensions.

Introduces five extensions: memory-server (mcp-server with lifecycle block),
memory-organizer (agent), memory-flush (hook, binds SessionEnd + ScopePromotionProposed),
memory-cli (command), and sox-memory-bundle (bundle type, members: the four behavioral
extensions). The bundle installs atomically via post-cascade expansion in install.ts.
Stubs only — memory behavior is implemented in subsequent phases (P1–P5).
