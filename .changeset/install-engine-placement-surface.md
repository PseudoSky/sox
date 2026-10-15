---
"@adhd/sox-install-engine": patch
---

Additive public surface: export `unifiedLineDiff` (diff.ts), `desiredPlacedContent` and `desiredPlacedArtifact` (install.ts), and `hashPathForInstall` (hash.ts); `diff` options accept `placementRoot`. Consumers that already import `diff`/`diffAll` are unaffected.
