/**
 * test-support/bl-26291f21-embed-scratch-env.ts — BL-26291f21 env contract between
 * `vitest.global-embed-scratch.ts` (runner process) and every worker. Dependency-free on purpose:
 * the global setup must not load memory-core. See `bl-26291f21-embed-scratch.ts` for the story.
 */

/** The run-scoped scratch root every worker's embed paths must resolve inside. */
export const SCRATCH_ROOT_ENV = 'SOX_MEMSRV_TEST_SCRATCH_ROOT';

/**
 * Where `vitest.setup.ts` writes the per-worker `sox-tests` telemetry JSONL. BL-404 wants those
 * records durable (never a bare tmpdir), so the global setup resolves this from the ORIGINAL
 * ecosystem home before it re-points `SOX_ECOSYSTEM_HOME` at the scratch root.
 */
export const TELEMETRY_DIR_ENV = 'SOX_MEMSRV_TEST_TELEMETRY_DIR';

/** The on-disk model dir name for bge-base-en-v1.5 (embedding-provider's fastembed carrier). */
export const EMBED_MODEL_DIR_NAME = 'fast-bge-base-en-v1.5';
