/**
 * spawnScratchGuard.ts — BL-0b0573f8: a spawn-time containment assertion for
 * the embedding funnel, for TESTS ONLY.
 *
 * `FunneledFastembedClient.doEnsure()` probes, spawns (`ensureBackend`) and
 * dials the machine-wide embedding host at a socket derived from
 * `SOX_ECOSYSTEM_HOME`, keyed on `(model, ep, cacheDir)`. A test harness that
 * leaves either path pointing at the operator's data root or model cache
 * would attach to the operator's live host, or start one that reads/downloads
 * into the operator's cache (BL-26291f21, BL-230d1d2a). Resolver-level checks
 * run only after the spawn has happened; this one runs before the first probe.
 *
 * ADR-0013: this is TYPED config set through a test seam, never an
 * environment variable or feature switch. Production never calls
 * {@link __setFunnelSpawnGuardForTests}; the guard is `null`, and
 * {@link assertSpawnInsideScratchRoot} returns on its first line — the funnel's
 * behaviour is unchanged. The seam is not re-exported from `index.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PermanentEmbeddingError } from './errors.js';

/** The typed test-only guard: every spawned host's paths must lie inside `scratchRoot`. */
export interface FunnelSpawnGuard {
  readonly scratchRoot: string;
}

/** Which host argument escaped the scratch root. */
export type ScratchRootField = 'cache-dir' | 'socket';

/**
 * Thrown (before any probe, spawn or dial) when an armed guard sees a host
 * target outside its scratch root. Permanent: a respawn cannot fix a
 * mis-scoped path, and it must not count toward the ensure circuit breaker.
 */
export class EmbedHostScratchRootViolationError extends PermanentEmbeddingError {
  readonly code = 'E_EMBED_HOST_OUTSIDE_SCRATCH_ROOT' as const;

  constructor(
    readonly field: ScratchRootField,
    readonly target: string,
    readonly resolvedTarget: string,
    readonly scratchRoot: string,
  ) {
    super(
      `embedding funnel refused to spawn a host: --${field}=${target} (resolves to ${resolvedTarget}) ` +
        `is outside the armed test scratch root ${scratchRoot}`,
    );
    this.name = 'EmbedHostScratchRootViolationError';
  }
}

let _guard: FunnelSpawnGuard | null = null;

/**
 * TEST-ONLY: arm (or, with `null`, disarm) the funnel's spawn-time scratch-root
 * guard for this module instance. `embedding-provider`'s own vitest setup
 * (`vitest.setup-scratch.ts`) arms it for every spec in the project.
 */
export function __setFunnelSpawnGuardForTests(guard: FunnelSpawnGuard | null): void {
  _guard = guard === null ? null : { scratchRoot: guard.scratchRoot };
}

/** TEST-ONLY: the currently armed guard, or `null`. */
export function __getFunnelSpawnGuardForTests(): FunnelSpawnGuard | null {
  return _guard;
}

/** The guard `doEnsure()` enforces: whatever the test seam armed, else `null`. */
export function activeFunnelSpawnGuard(): FunnelSpawnGuard | null {
  return _guard;
}

/**
 * Canonical absolute form of `p`, resolving symlinks through the deepest
 * EXISTING ancestor (a socket file, or a cache dir the host has yet to create,
 * does not exist at spawn time). `..` segments are normalised first, so a
 * traversal cannot hide behind a non-existent tail.
 */
function canonicalize(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const parent = path.dirname(head);
      // Only a missing/non-directory component is walked past; anything else
      // (EACCES, ELOOP, …) is unresolvable, and the guard fails closed on the
      // un-resolved spelling (which cannot match a realpath'd root by accident
      // unless it is lexically inside it).
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === head) {
        return path.join(head, ...tail);
      }
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

function isInside(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Throw {@link EmbedHostScratchRootViolationError} when `guard` is armed and the
 * host's `--cache-dir` or `--socket` resolves outside `guard.scratchRoot`.
 * With `guard === null` (production) this is a no-op.
 */
export function assertSpawnInsideScratchRoot(
  target: { readonly cacheDir: string; readonly socketPath: string },
  guard: FunnelSpawnGuard | null,
): void {
  if (guard === null) return;
  const root = canonicalize(guard.scratchRoot);
  const checks: Array<[ScratchRootField, string]> = [
    ['cache-dir', target.cacheDir],
    ['socket', target.socketPath],
  ];
  for (const [field, raw] of checks) {
    const resolved = raw === '' ? '' : canonicalize(raw);
    if (resolved === '' || !isInside(resolved, root)) {
      throw new EmbedHostScratchRootViolationError(field, raw, resolved, root);
    }
  }
}
