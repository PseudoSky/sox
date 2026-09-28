/**
 * libs/install-engine/src/verify-integrity.ts — ADR-0003 integrity primitive.
 *
 * The ONE low-level "is-this-current?" check for content-addressed identity.
 *
 * For an installed extension `id` at scope `S`:
 *   it is CURRENT iff sha256(artifact at the lockfile `source`) equals the
 *   `checksum` recorded under key `id` in scope `S`'s lockfile — AND, when the
 *   caller supplies `desired` (upgrade does), the pin itself still matches what
 *   resolution yields now: a `file://` origin re-hashes to the pin, and the
 *   registry's published checksum (or an explicit configured locator) is the
 *   one the entry was resolved from (BL-cd1fe520).
 *   Any inequality ⇒ STALE (needs upgrade: re-resolve + re-pin).
 *   A missing lockfile / missing entry ⇒ NOT INSTALLED.
 *
 * BL-cd1fe520: for an `npm-package:` install `source` is the copy npm placed in
 *   the content store, so the first check alone compares that copy with a
 *   checksum taken from itself and can never report a newer release. The pin
 *   comparison against `desired` is what makes a published version bump visible.
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
import type { DesiredPin } from './install.js';

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
  /** BL-cd1fe520: the lock entry's recorded origin (absent on legacy entries). */
  origin?: string | undefined;
  /** BL-cd1fe520: why a 'stale' verdict was reached (drift / origin-changed / pin-moved). */
  reason?: string | undefined;
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
  /**
   * BL-cd1fe520: what a fresh resolution of this id would install now
   * (`resolveDesiredPin`). Without it only the materialized copy and a
   * `file://` origin can be checked — which, for an `npm-package:` install whose
   * `source` is the content-store copy, can never observe a newer release. The
   * frozen-lockfile path deliberately omits it (it verifies the installed bytes
   * against the lock, not the lock against its upstream); `upgrade` must pass it.
   * Passing the key at all — even as `null` (no registry row, no configured
   * source) — opts into the freshness checks: a `file://` origin distinct from
   * the materialized copy is re-hashed too.
   */
  desired?: DesiredPin | null | undefined;
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

  const origin = entry.origin;
  const stale = (actual: string, reason: string): IntegrityResult =>
    ({ id, status: 'stale', current: false, expected, actual, source, origin, reason });

  // 1. The materialized artifact must still be the bytes that were pinned.
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
      origin,
      error: String(e),
    };
  }
  if (actual !== expected) return stale(actual, 'materialized artifact drifted from the pinned checksum');

  // 2. BL-cd1fe520: a local origin distinct from the materialized copy is
  //    re-hashed — a rebuilt checkout is a new artifact even though the copy is
  //    unchanged. Non-file origins (npm-package:, npm:, https:) are never
  //    re-fetched here: that is side-effectful and networked; step 3 judges them.
  //    An origin that has vanished is not a verdict on the installed copy, so it
  //    is skipped rather than reported unresolvable.
  const freshness = opts.desired !== undefined;
  if (freshness && origin !== undefined && origin.startsWith('file://') && origin !== source) {
    let originHash: string | null = null;
    try {
      originHash = (await fetchArtifact(origin)).checksum;
    } catch (e) {
      console.warn(`verifyIntegrity: ${id}: origin ${origin} could not be hashed (${String(e)}) — judging the installed copy only`);
    }
    if (originHash !== null && originHash !== expected) {
      return stale(originHash, `origin ${origin} changed since it was pinned`);
    }
  }

  // 3. BL-cd1fe520: compare the pin itself against what resolution yields now.
  const desired = opts.desired ?? null;
  if (desired !== null) {
    if (desired.checksum !== undefined) {
      if (desired.checksum !== expected) {
        return stale(desired.checksum, `pin moved: ${origin ?? source} → ${desired.source}`);
      }
    } else if (desired.source.startsWith('file://')) {
      let desiredHash: string | null = null;
      try {
        desiredHash = (await fetchArtifact(desired.source)).checksum;
      } catch (e) {
        return { id, status: 'unresolvable', current: false, expected, actual, source, origin, error: String(e) };
      }
      if (desiredHash !== expected) return stale(desiredHash, `desired source ${desired.source} differs from the pin`);
    } else if (origin !== desired.source) {
      // An unpinned non-file locator (explicit config `npm-package:…`): the only
      // evidence of currency is that the lock was resolved from that very locator.
      return stale(actual, `origin ${origin ?? '(unrecorded)'} is not the configured source ${desired.source}`);
    }
  }

  return { id, status: 'current', current: true, expected, actual, source, origin };
}
