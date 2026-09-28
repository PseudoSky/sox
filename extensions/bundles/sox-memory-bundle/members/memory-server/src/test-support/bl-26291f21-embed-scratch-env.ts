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

/** `'1'` when the global setup seeded the scratch model cache by clone, `'0'` when it could not. */
export const MODEL_SEEDED_ENV = 'SOX_MEMSRV_TEST_MODEL_SEEDED';

/** The on-disk model dir name for bge-base-en-v1.5 (embedding-provider's fastembed carrier). */
export const EMBED_MODEL_DIR_NAME = 'fast-bge-base-en-v1.5';

/**
 * BL-bd91334d test-only injection hook, modelled on memory-core's
 * `SOX_BL_BAE70DA4_EXTRA_GUARD_ROOT` pattern: an env var read directly by
 * `vitest.global-embed-scratch.ts`, present only to let a regression spec drive the teardown into
 * a fault deterministically, without depending on a real embed-host leak or a seeded operator
 * model cache (neither of which is guaranteed to exist in a hermetic test env).
 *
 * `'throw'`   — after the reap completes, throw a synthetic Error inside the teardown's try block.
 *               Proves the try/catch added for BL-bd91334d turns an uncaught teardown exception
 *               into a reported problem + non-zero exitCode instead of a silently-swallowed
 *               "error during close" (vitest 4.1.8 exits 0 on a thrown teardown otherwise).
 * `'force-problem'` — push a synthetic problem into the same array the real checks push into,
 *               with no throw. Proves the BL-bd91334d "keep the root on ANY problem" policy without
 *               requiring `seed.seeded` (the fetch-marker checks are gated on it and are silent on
 *               an unseeded machine).
 *
 * Any other non-empty value is a caller typo, not "no injection" — the setup treats it as a third,
 * always-failing case (`'unknown'`) rather than silently ignoring it, so a misspelled env value in
 * a future test can never read as a vacuous pass.
 */
export const TEST_INJECT_ENV = 'SOX_BL_BD91334D_TEST_INJECT';
export type TestInjection = 'throw' | 'force-problem';
