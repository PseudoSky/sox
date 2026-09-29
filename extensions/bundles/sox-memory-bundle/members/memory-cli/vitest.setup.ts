/**
 * vitest.setup.ts — memory-cli test setup (BL-57ae788f, closing the memory-cli half of
 * BL-26291f21).
 *
 * Before this file, memory-cli had NO setup file at all: no operator-store-env scrub, no
 * deterministic embed provider, no embed-path isolation. The `pipeline drain` spec
 * (`bug-memoryserver-embed-heal-nooperator-001-cli.spec.ts`) drives `memoryCurate(adapter,
 * { op: 'drain' }, wq)` → `drainBacklog()` → memory-core's `embed()`, which without a test
 * provider resolves the REAL fastembed backend and spawns/dials the shared embedding host
 * against the OPERATOR's model cache and socket dir — exactly the BL-26291f21 leak class,
 * one spec earlier in the funnel, and the slow real-model path is why the spec timed out.
 *
 * Fix, mirroring memory-server's own setup (vitest.setup.ts, BL-7e5be7e8 + BL-567 +
 * BL-26291f21):
 *   1. Install the deterministic feature-hash provider by default, so `getOrCreateProvider()`
 *      short-circuits BEFORE `resolveProvider()`/`getSharedFastembedProcess()` is ever called —
 *      the mock fully bypasses the shared fastembed child boundary, it never flows through it.
 *   2. Scrub the operator's host-injected store config (`SOX_CONFIG_*`, `SOX_PROXY_BACKEND*`,
 *      `SOX_AUTO_BACKUP_DIR`) before any spec loads.
 *   3. Assert (at load, and again after every test) that this worker's embed paths resolve
 *      inside `vitest.global-embed-scratch.ts`'s run-scoped scratch root, never under the
 *      operator's real `~/.cache/sox` or `~/.adhd/sox-ecosystem` — defense-in-depth for the day
 *      a spec clears the mock.
 */
import { afterEach } from 'vitest';
import {
  DeterministicTestProvider,
  _setEmbedProviderForTest,
  scrubOperatorStoreEnv,
  getConfiguredEmbedPaths,
} from '@adhd/sox-memory-core';
import { assertEmbedPathsIsolated } from '@adhd/sox-memory-core/testing';
import { SCRATCH_ROOT_ENV } from './src/test-support/bl-57ae788f-embed-scratch-env.js';

_setEmbedProviderForTest(new DeterministicTestProvider());

const scrubbedOperatorKeys = scrubOperatorStoreEnv(process.env);
if (scrubbedOperatorKeys.length > 0) {
  process.stderr.write(
    `[memory-cli vitest.setup] BL-57ae788f: scrubbed inherited operator store config: ${scrubbedOperatorKeys.join(', ')}\n`,
  );
}

// BL-611a711e: `getConfiguredEmbedPaths()` is resolved here, by the caller, and passed in — the
// shared `@adhd/sox-memory-core/testing` helper takes paths as a parameter rather than resolving
// them itself (see that module's header comment).
assertEmbedPathsIsolated(SCRATCH_ROOT_ENV, getConfiguredEmbedPaths(), 'vitest.setup load');

afterEach(() => {
  assertEmbedPathsIsolated(SCRATCH_ROOT_ENV, getConfiguredEmbedPaths(), 'afterEach');
});
