/**
 * libs/install-engine/src/verify-integrity.ts — ADR-0003 integrity primitive.
 *
 * The ONE low-level "is-this-current?" check for content-addressed identity.
 *
 * For an installed extension `id` at scope `S`:
 *   it is CURRENT iff sha256(artifact at the lockfile `source`) equals the
 *   `checksum` recorded under key `id` in scope `S`'s lockfile.
 *   Any inequality ⇒ STALE (needs upgrade: re-resolve + re-pin).
 *   A missing lockfile / missing entry ⇒ NOT INSTALLED.
 *
 * This is the sole authority. `install` (frozen), `update`, and `upgrade --all`
 * all call it rather than reimplementing the checksum comparison — the
 * scope-parity suite tests THIS primitive, not four divergent paths.
 *
 * There is NO version comparison anywhere here (ADR-0003): the content address
 * (sha256 of the built entrypoint) IS the identity.
 */

import { fetchArtifact } from './install.js';
import { loadLockfile } from './install.js';
import type { Scope } from './install.js';
import { getScopePath } from './install.js';

export type IntegrityStatus =
  | 'current'        // artifact hash == recorded checksum
  | 'stale'          // artifact hash != recorded checksum (needs upgrade)
  | 'not-installed'  // no lockfile entry for this id
  | 'unresolvable';  // entry exists but the artifact could not be fetched/hashed

export interface IntegrityResult {
  id: string;
  status: IntegrityStatus;
  /** Convenience boolean: status === 'current'. */
  current: boolean;
  /** The checksum recorded in the lockfile (null if not installed). */
  expected: string | null;
  /** The freshly-computed sha256 of the artifact on disk (null if unresolvable/not-installed). */
  actual: string | null;
  /** The resolved `source` from the lockfile entry (file:// or https://), if any. */
  source: string | null;
  /** Set when status is 'unresolvable' — why the artifact could not be hashed. */
  error?: string | undefined;
}

/**
 * Find the lockfile key that resolves to `id`. Tolerates the legacy v1
 * `id@version` form as well as the ADR-0003 bare `id`. `loadLockfile` already
 * normalizes legacy keys to bare ids, so in practice this finds the bare key —
 * the legacy fallback is belt-and-suspenders for a hand-written lockfile.
 */
function findKeyForId(resolved: Record<string, { source: string; checksum: string }>, id: string): string | undefined {
  if (resolved[id]) return id;
  return Object.keys(resolved).find((k) => {
    const at = k.lastIndexOf('@');
    return at !== -1 && k.slice(0, at) === id;
  });
}

export interface VerifyIntegrityOptions {
  /**
   * Explicit lockfile path. When omitted, the scope's canonical lockfile path
   * is used (getScopePath(scope).lockfile). The CLI passes an explicit path so
   * a per-project `root` resolves to the right `.extensions/extensions.lock`.
   */
  lockfilePath?: string | undefined;
}

/**
 * The integrity primitive. Hash the artifact at the lockfile `source` for
 * `id` in `scope` and compare it to the recorded checksum.
 *
 * Pure (no writes, no process.exit). Callers decide what to do with the verdict.
 */
export async function verifyIntegrity(
  scope: Scope,
  id: string,
  opts: VerifyIntegrityOptions = {},
): Promise<IntegrityResult> {
  const lockPath = opts.lockfilePath ?? getScopePath(scope).lockfile;
  const lock = loadLockfile(lockPath);

  if (!lock) {
    return { id, status: 'not-installed', current: false, expected: null, actual: null, source: null };
  }

  const key = findKeyForId(lock.resolved, id);
  if (!key) {
    return { id, status: 'not-installed', current: false, expected: null, actual: null, source: null };
  }

  const entry = lock.resolved[key]!;
  const expected = entry.checksum;
  const source = entry.source;

  let actual: string;
  try {
    const fetched = await fetchArtifact(source); // no expectedChecksum → never throws on mismatch; returns the hash
    actual = fetched.checksum;
  } catch (e) {
    return {
      id,
      status: 'unresolvable',
      current: false,
      expected,
      actual: null,
      source,
      error: String(e),
    };
  }

  const current = actual === expected;
  return {
    id,
    status: current ? 'current' : 'stale',
    current,
    expected,
    actual,
    source,
  };
}
