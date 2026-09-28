/**
 * test-support/bl-57ae788f-embed-scratch-env.ts — BL-57ae788f env contract between
 * `vitest.global-embed-scratch.ts` (runner process) and every worker of this
 * suite. Dependency-free on purpose — mirrors memory-server's
 * `bl-26291f21-embed-scratch-env.ts` (own constant, own env var name, so the
 * two suites' scratch roots can never collide when both run on one machine).
 */

/** The run-scoped scratch root every memory-cli worker's embed paths must resolve inside. */
export const SCRATCH_ROOT_ENV = 'SOX_MEMCLI_TEST_SCRATCH_ROOT';
