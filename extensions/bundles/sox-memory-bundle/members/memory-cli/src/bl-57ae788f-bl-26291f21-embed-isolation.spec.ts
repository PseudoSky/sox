/**
 * BL-57ae788f / BL-26291f21 (memory-cli half) — memory-cli test workers never scrub-fail into
 * the operator's store config, and never resolve a real embed path outside this run's scratch
 * root.
 *
 * BL-57ae788f: "suites outside memory-server/memory-core do not scrub the operator store env" —
 * memory-cli had no vitest.setup.ts at all, so a spec that spawns/inherits `{ ...process.env }`
 * (or an in-process `createStoreAdapter()` call that omits `dbPath`) could fall through to the
 * operator's real `SOX_CONFIG_DB_PATH`/`SOX_AUTO_BACKUP_DIR`.
 *
 * BL-26291f21 (memory-cli half): the `pipeline drain` spec
 * (`bug-memoryserver-embed-heal-nooperator-001-cli.spec.ts`) reaches memory-core's `embed()` via
 * `memoryCurate(..., { op: 'drain' }, wq)` → `drainBacklog()`. With no test provider installed
 * and no isolated embed paths pinned, that resolved the REAL fastembed backend and
 * spawned/dialed the shared embedding host against the operator's `~/.cache/sox/models` model
 * cache and `~/.adhd/sox-ecosystem/run` socket dir — the same leak class already fixed for
 * memory-server, one spec earlier in the funnel, and the reason the spec timed out (real ONNX
 * load + inference vs. the ~0ms deterministic mock).
 *
 * RED reproduction (verified by hand, not committed): comment out the `setupFiles`/`globalSetup`
 * entries in `vitest.config.mts` (or the `_setEmbedProviderForTest`/`scrubOperatorStoreEnv`/
 * `assertEmbedPathsIsolated` calls in `vitest.setup.ts`) and every test below fails:
 *   - "decoy operator store config is scrubbed" fails because `SOX_CONFIG_DB_PATH` /
 *     `SOX_AUTO_BACKUP_DIR` are still the `vitest.config.mts` decoy values.
 *   - "embed paths resolve inside the run scratch root" fails because
 *     `SOX_MEMCLI_TEST_SCRATCH_ROOT` is unset, so `embedIsolationViolations()` is non-empty.
 *   - "the deterministic test provider is installed by default" fails because
 *     `getActiveEmbedModel()` is `null` (no provider constructed yet) instead of the mock's id.
 * GREEN: with the fix (this file's imports untouched, setup wired), all three pass.
 */
import { describe, expect, it } from 'vitest';
import {
  embedIsolationViolations,
  getActiveEmbedModel,
  getConfiguredEmbedPaths,
  getEmbedState,
  isInside,
  operatorEmbedRoots,
} from '@adhd/sox-memory-core';
import { SCRATCH_ROOT_ENV } from './test-support/bl-57ae788f-embed-scratch-env.js';

describe('BL-57ae788f — memory-cli scrubs operator env', () => {
  it('decoy operator store config injected by vitest.config.mts is scrubbed before this spec loads', () => {
    expect(process.env['SOX_CONFIG_DB_PATH']).toBeUndefined();
    expect(process.env['SOX_AUTO_BACKUP_DIR']).toBeUndefined();
    // The prefix-matched family (SOX_CONFIG_*) is scrubbed too, not just the two decoys above.
    for (const key of Object.keys(process.env)) {
      expect(key.startsWith('SOX_CONFIG_'), `unscrubbed operator key: ${key}`).toBe(false);
    }
  });
});

describe('BL-26291f21 (memory-cli half) — memory-cli test workers never resolve operator embed paths', () => {
  it('embed model cache + host socket dir resolve inside the run scratch root, never under the operator roots', () => {
    const { cacheDir, hostSocketDir } = getConfiguredEmbedPaths();
    const op = operatorEmbedRoots();
    expect(isInside(cacheDir, op.modelCacheRoot), `cacheDir ${cacheDir} under operator ${op.modelCacheRoot}`).toBe(false);
    expect(isInside(hostSocketDir, op.ecosystemHome), `socket dir ${hostSocketDir} under operator ${op.ecosystemHome}`).toBe(false);
    const scratch = process.env[SCRATCH_ROOT_ENV];
    expect(scratch, `${SCRATCH_ROOT_ENV} must be pinned by vitest.global-embed-scratch.ts`).toBeTruthy();
    expect(isInside(cacheDir, scratch as string)).toBe(true);
    expect(isInside(hostSocketDir, scratch as string)).toBe(true);
    expect(embedIsolationViolations(SCRATCH_ROOT_ENV)).toEqual([]);
  });

  it('the deterministic test provider is installed by default, so drain never reaches the real backend', () => {
    // MODEL_ID from embed-test-provider.ts — proves the mock, not real bge-base-en-v1.5, is active.
    expect(getActiveEmbedModel()).toBe('test-feature-hash-768');
    expect(getEmbedState()).toBe('real'); // 'real' here means "a provider is constructed"; it is the mock.
  });
});
