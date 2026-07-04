/**
 * vitest.setup.ts — memory-server test setup.
 *
 * SOX_SYNC_EMBED=1 pins the PRE-EXISTING suite to the synchronous-embed
 * composition (the kill-switch path of the 2026-07-04 two-phase write split).
 * Rationale: dozens of existing specs write via handleToolCall and immediately
 * assert vector-dependent state (near-dup edges, clustering, recall ranking).
 * Under the async default those assertions would race the fire-and-forget
 * Phase-B pipeline. The sync composition is byte-compatible with the pre-split
 * behaviour, so the 92-test baseline pins exactly what it always pinned.
 *
 * The async DEFAULT path is covered explicitly and deterministically by
 * async-embed.spec.ts, which deletes this env for its own describe blocks and
 * uses the BL-161 deterministic provider seam (no real ONNX, no timing).
 */
process.env['SOX_SYNC_EMBED'] = '1';
