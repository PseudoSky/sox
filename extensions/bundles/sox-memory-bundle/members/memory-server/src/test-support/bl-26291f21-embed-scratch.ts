/**
 * test-support/bl-26291f21-embed-scratch.ts — BL-26291f21.
 *
 * WHAT LEAKED: the memory-server `real-backend` vitest project (recall-sqlite.test.ts,
 * turso-clean-room.test.ts, clustering-e2e.test.ts) opts OUT of the setup's
 * DeterministicTestProvider (`_setEmbedProviderForTest(null)`) and embeds for real, IN-PROCESS,
 * inside a vitest fork worker. That worker's env never pinned the embed paths, so
 * `libs/memory-core/src/embed.ts` `resolveConfig()` fell through to
 * `<XDG_CACHE_HOME|~/.cache>/sox/models` and `embedHostConfig.ts` `resolveEmbedHostSocketDir()`
 * fell through to `~/.adhd/sox-ecosystem/run` — so `npx nx test memory-server` peer-spawned the
 * machine-wide embedding host against the OPERATOR's model cache and socket dir
 * (`--cache-dir=/Users/nix/.cache/sox/models`, `/Users/nix/.adhd/sox-ecosystem/run/proxy-a1e3f7ab4a38.sock`,
 * `--spawner-entry=.../vitest/dist/workers/forks.js`). Several default-mock specs also reset the
 * provider to `null` in their teardown, so the leak was one stray embed away in those files too.
 *
 * THE FIX (harness-level, so it covers every spec, not the three that happened to be caught):
 *   - `vitest.global-embed-scratch.ts` mints ONE run-scoped scratch root before any worker forks,
 *     seeds its model cache by copy-on-write clone of the operator's (read-only on the source,
 *     the scripts/smoke-test.mjs 3ebd7ecb mechanism), and pins `SOX_EMBED_CACHE_DIR`,
 *     `XDG_CACHE_HOME` and `SOX_ECOSYSTEM_HOME` into the env every worker inherits. Its teardown
 *     reaps every embed host whose argv carries that root, then removes it.
 *   - `vitest.setup.ts` calls {@link assertEmbedPathsIsolated} in every worker (and after every
 *     test), so a worker that could resolve an operator path FAILS FAST instead of spawning.
 *
 * This module is the single definition both sides share. The env-name constants live in the
 * dependency-free `bl-26291f21-embed-scratch-env.ts` so the global setup (runner process) never
 * loads memory-core.
 *
 * BL-611a711e: `isInside`/`operatorEmbedRoots`/`embedIsolationViolations`/
 * `assertEmbedPathsIsolated`'s CONTAINMENT ALGORITHM now delegates to the shared
 * `@adhd/sox-memory-core/testing` helper (originally extracted FROM this file for memory-cli,
 * BL-57ae788f) rather than carrying a second copy of it — this file's exported function
 * signatures are UNCHANGED, so `vitest.setup.ts` and this package's own isolation spec need no
 * changes. The two extra, product-specific checks this file has always carried beyond the shared
 * base — the `SOX_ECOSYSTEM_HOME`-under-operator check and the BL-404
 * `TELEMETRY_DIR_ENV`-exception check — are passed to the shared helper via its `extra` hook
 * rather than duplicated inline.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getConfiguredEmbedPaths } from '@adhd/sox-memory-core';
import {
  isInside,
  operatorEmbedRoots,
  embedIsolationViolations as sharedEmbedIsolationViolations,
} from '@adhd/sox-memory-core/testing';
import { EMBED_MODEL_DIR_NAME, SCRATCH_ROOT_ENV, TELEMETRY_DIR_ENV } from './bl-26291f21-embed-scratch-env.js';

export { SCRATCH_ROOT_ENV, TELEMETRY_DIR_ENV, EMBED_MODEL_DIR_NAME, MODEL_SEEDED_ENV } from './bl-26291f21-embed-scratch-env.js';
export { isInside, operatorEmbedRoots } from '@adhd/sox-memory-core/testing';

/**
 * Every reason the embed paths THIS process would resolve are not isolated (empty = isolated).
 * Positive containment (inside the run's scratch root) AND negative (never under the operator's
 * `~/.cache/sox` or `~/.adhd/sox-ecosystem`) come from the shared base check; the two extra checks
 * below (`SOX_ECOSYSTEM_HOME`, BL-404's `TELEMETRY_DIR_ENV` exception) are this package's own.
 */
export function embedIsolationViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  return sharedEmbedIsolationViolations(SCRATCH_ROOT_ENV, getConfiguredEmbedPaths(), env, (envArg, op) => {
    const out: string[] = [];
    if (envArg['SOX_ECOSYSTEM_HOME'] !== undefined && isInside(envArg['SOX_ECOSYSTEM_HOME'], op.ecosystemHome)) {
      out.push(`SOX_ECOSYSTEM_HOME ${envArg['SOX_ECOSYSTEM_HOME']} resolves under the OPERATOR's ${op.ecosystemHome}`);
    }
    const telemetryDir = envArg[TELEMETRY_DIR_ENV];
    if (telemetryDir !== undefined && telemetryDir !== '' && isInside(telemetryDir, op.ecosystemHome)) {
      if (path.resolve(telemetryDir) !== sanctionedOperatorTelemetryDir()) {
        out.push(
          `${TELEMETRY_DIR_ENV} ${telemetryDir} is under the OPERATOR's ${op.ecosystemHome} but is not the one ` +
            `sanctioned exception ${sanctionedOperatorTelemetryDir()} (BL-404)`,
        );
      }
    }
    return out;
  });
}

/**
 * The ONE path under the operator's `~/.adhd/sox-ecosystem` a memory-server test worker may
 * resolve: `<ecosystem home>/sox-tests/logs`, the dedicated durable namespace BL-404 gives the
 * per-worker `sox-tests` telemetry JSONL (vitest.setup.ts `initTelemetry`). It is test-only and
 * disjoint from every service's logs, so keeping it durable under the operator home is the
 * deliberate BL-404 design, not a leak. Anything else under that root — the embed-host socket
 * dir above all — is a BL-26291f21 violation. Exact match, never a prefix.
 */
export function sanctionedOperatorTelemetryDir(): string {
  return path.join(operatorEmbedRoots().ecosystemHome, 'sox-tests', 'logs');
}

/** Throw (fail fast, before anything can spawn a host) when the embed paths are not isolated. */
export function assertEmbedPathsIsolated(where: string): void {
  const v = embedIsolationViolations();
  if (v.length > 0) {
    throw new Error(
      `BL-26291f21 REGRESSION (${where}): a real embed in this worker would spawn/dial the shared ` +
        `embedding host outside the test scratch root:\n  - ${v.join('\n  - ')}`,
    );
  }
}

/**
 * The real-backend skip gate, shared by recall-sqlite / turso-clean-room / clustering-e2e: is the
 * ONNX model on disk at the cache dir memory-core will ACTUALLY load from? (The three files used
 * to re-derive the path as `.../sox-memory/models` while embed.ts loads `.../sox/models`, so the
 * gate and the load read two different directories.) Mirrors embedding-provider's
 * `isModelCached()`: `<cacheDir>/<hfRepoId>/model_optimized.onnx`.
 */
export function realModelCacheDir(): string {
  return getConfiguredEmbedPaths().cacheDir;
}

export function isRealModelCached(): boolean {
  return fs.existsSync(path.join(realModelCacheDir(), EMBED_MODEL_DIR_NAME, 'model_optimized.onnx'));
}
