---
"@adhd/sox-memory-core": patch
"@adhd/sox-store-adapter": patch
"@adhd/sox-host-registry": patch
"@adhd/sox-host-runtime": patch
"@adhd/sox-authoring": patch
---

Release unreleased public `.d.ts` surface changes that landed without a changeset (dispatch-2026-10-04-b7d4, item cbf985e1). Shipped as patches under the owner-accepted additive-API exception in PUBLISHING.md, so no dependent's range is invalidated and the cascade stays empty.

- `@adhd/sox-memory-core` (0.12.3): global-guard no longer flags the live store's sidecar churn; the known-false-positive suppression is dropped; turso FTS migration out-of-band orphan destroy lands (d5cd461f, 437f3f28, 0bb7b7ee, 0c4bb76f, ac2d4afe).
- `@adhd/sox-store-adapter` (0.13.2): offline Turso FTS v1-to-v2 format migration engine plus the `fts-migrate` CLI verb, out-of-band orphan destroy, and a hardened rollback image and restore contract that reports the restored format (3df09bc5, 0bb7b7ee, 337fd4f7, 660be41a, f13c8912).
- `@adhd/sox-host-registry` (0.6.0): skill headers are rendered from the manifest; stale `version` field dropped and invalid agent tools pruned (40647109, 2f4638c9).
- `@adhd/sox-host-runtime` (0.6.2): the extension-config cascade is now scope-deterministic (ae033317).
- `@adhd/sox-authoring` (0.2.2): skill headers are rendered from the manifest (40647109).
