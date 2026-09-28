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
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getConfiguredEmbedPaths } from '@adhd/sox-memory-core';
import { EMBED_MODEL_DIR_NAME, SCRATCH_ROOT_ENV, TELEMETRY_DIR_ENV } from './bl-26291f21-embed-scratch-env.js';

export { SCRATCH_ROOT_ENV, TELEMETRY_DIR_ENV, EMBED_MODEL_DIR_NAME, MODEL_SEEDED_ENV } from './bl-26291f21-embed-scratch-env.js';

/** macOS reaches /tmp and /var through /private; compare both spellings. */
function spellings(p: string): string[] {
  const n = path.resolve(p);
  const out = new Set([n]);
  if (n.startsWith('/private/')) out.add(n.slice('/private'.length));
  else if (/^\/(?:tmp|var)(?:\/|$)/.test(n)) out.add(`/private${n}`);
  return [...out];
}

/** True when `p` is `root` or lies beneath it (in any /private spelling). */
export function isInside(p: string, root: string): boolean {
  for (const a of spellings(p)) {
    for (const r of spellings(root)) {
      if (a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return true;
    }
  }
  return false;
}

/**
 * The operator's real embed roots, derived from the passwd entry (`os.userInfo().homedir`), never
 * from `HOME` — a harness that overrides `HOME` must not be able to talk this check out of seeing
 * the real home.
 */
export function operatorEmbedRoots(): { modelCacheRoot: string; ecosystemHome: string } {
  const home = os.userInfo().homedir;
  return {
    modelCacheRoot: path.join(home, '.cache', 'sox'),
    ecosystemHome: path.join(home, '.adhd', 'sox-ecosystem'),
  };
}

/**
 * Every reason the embed paths THIS process would resolve are not isolated (empty = isolated).
 * Positive containment (inside the run's scratch root) AND negative (never under the operator's
 * `~/.cache/sox` or `~/.adhd/sox-ecosystem`), both against the product's own resolvers.
 */
export function embedIsolationViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const scratch = env[SCRATCH_ROOT_ENV];
  const { cacheDir, hostSocketDir } = getConfiguredEmbedPaths();
  const op = operatorEmbedRoots();
  if (scratch === undefined || scratch === '') {
    out.push(`${SCRATCH_ROOT_ENV} is unset — vitest.global-embed-scratch.ts did not run for this worker`);
  } else {
    if (!isInside(cacheDir, scratch)) out.push(`embed model cache ${cacheDir} is outside the run scratch root ${scratch}`);
    if (!isInside(hostSocketDir, scratch)) out.push(`embed host socket dir ${hostSocketDir} is outside the run scratch root ${scratch}`);
  }
  for (const [what, p] of [['embed model cache', cacheDir], ['embed host socket dir', hostSocketDir]] as const) {
    for (const root of [op.modelCacheRoot, op.ecosystemHome]) {
      if (isInside(p, root)) out.push(`${what} ${p} resolves under the OPERATOR's ${root}`);
    }
  }
  if (env['SOX_ECOSYSTEM_HOME'] !== undefined && isInside(env['SOX_ECOSYSTEM_HOME'], op.ecosystemHome)) {
    out.push(`SOX_ECOSYSTEM_HOME ${env['SOX_ECOSYSTEM_HOME']} resolves under the OPERATOR's ${op.ecosystemHome}`);
  }
  const telemetryDir = env[TELEMETRY_DIR_ENV];
  if (telemetryDir !== undefined && telemetryDir !== '' && isInside(telemetryDir, op.ecosystemHome)) {
    if (path.resolve(telemetryDir) !== sanctionedOperatorTelemetryDir()) {
      out.push(
        `${TELEMETRY_DIR_ENV} ${telemetryDir} is under the OPERATOR's ${op.ecosystemHome} but is not the one ` +
          `sanctioned exception ${sanctionedOperatorTelemetryDir()} (BL-404)`,
      );
    }
  }
  return out;
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
