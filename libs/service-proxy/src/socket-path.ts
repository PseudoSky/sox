/**
 * libs/service-proxy/src/socket-path.ts -- backend UDS path derivation (S9.5.4).
 *
 * The backend socket path is derived from the data-root resolver keyed by the
 * [def:singleton-key] so there is never a port-selection problem and never a clash
 * (S9.5.4). This lib is a dependency-free leaf (no host-runtime import), so the
 * CALLER passes in the resolved socket directory (`socketDir()`, ADR-0004) and the
 * singleton key; this helper composes the deterministic path + sanitises it.
 *
 * Leaf module, and PURE -- node builtins `path` and `crypto` only. It never reads
 * the environment (no `os.tmpdir()`), so every peer that computes the path for
 * the same (socketDir, key) derives the same bytes regardless of its `TMPDIR`
 * ([inv:singleton]: one key => one socket => one backend).
 *
 * Three tiers, first fit wins against the 104-byte `sun_path` budget:
 *
 *   1. `<socketDir>/proxy-<sanitised-key>-<digest12>.sock` -- the full name.
 *   2. `<socketDir>/proxy-<digest12>.sock` -- the short name, for a long key
 *      under a short dir.
 *   3. `/tmp/sox-<uid>/p-<sha256(socketDir + ' ' + key)[0:16]>.sock` -- when
 *      `socketDir` itself is too long (BL-578: a scratch data root nested several
 *      directories deep, e.g. `.claude/worktrees/agent-<hash>/dist/smoke/run-<ts>/
 *      sox-data-root/run/supervisors`, measures 138 bytes on its own). The root
 *      is a fixed, short, per-uid directory: `/tmp/sox-<uid>/p-<16hex>.sock` is at
 *      most 43 bytes for any 32-bit uid. It lives in world-writable `/tmp`, so it
 *      is only safe because the listener and every dialer verify it is a real
 *      directory, owned by this uid, mode exactly 0700, before binding or
 *      connecting (`socket-dir.ts`, BL-4041c6e0). A root that fails that check
 *      is refused, never repaired and never swapped for another path.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * The max length of a Unix-domain-socket path. macOS `sun_path` is 104 bytes;
 * Linux is 108. We use the smaller bound so a path that works on the dev mac also
 * works on Linux. A key that would overflow is hashed into a short stable name.
 */
const MAX_SUN_PATH = 104;

/**
 * The per-uid root for tier-3 socket paths: `/tmp/sox-<uid>`.
 *
 * Fixed (never derived from `TMPDIR`) so every peer converges on one path, and
 * per-uid so two users never share a directory. `/tmp` is used rather than
 * `os.tmpdir()` because macOS `TMPDIR` (`/var/folders/<2>/<30+>/T/`) is itself
 * long enough to blow the `sun_path` budget and differs between processes that
 * inherit different environments.
 *
 * @param uid  the owning uid; defaults to `process.getuid()`.
 * @throws Error with `code: 'E_UDS_UNSUPPORTED_PLATFORM'` when no uid is given
 *         and the platform has no `process.getuid` (Windows).
 */
export function udsFallbackRoot(uid?: number): string {
  if (uid !== undefined) return `/tmp/sox-${String(uid)}`;
  if (typeof process.getuid !== 'function') {
    throw Object.assign(
      new Error(
        'E_UDS_UNSUPPORTED_PLATFORM: process.getuid() is unavailable on this platform; ' +
          'a per-uid Unix-domain-socket root cannot be derived',
      ),
      { code: 'E_UDS_UNSUPPORTED_PLATFORM' },
    );
  }
  return `/tmp/sox-${String(process.getuid())}`;
}

/**
 * Derive the backend service socket path.
 *
 * @param socketDir  the resolved socket directory (`socketDir()`, ADR-0004 -- e.g.
 *                   `$userDataRoot/run/supervisors`). The caller resolves it; this
 *                   lib does not import the data-root resolver (leaf hygiene).
 * @param singletonKey  the [def:singleton-key] for the backend (id + backing store
 *                   resource). Identical keys => identical socket => one backend.
 */
export function backendSocketPath(socketDir: string, singletonKey: string): string {
  // Sanitise the key into a filesystem-safe segment. Collisions are avoided by the
  // hash suffix, which is derived from the FULL untruncated key.
  const safe = singletonKey.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  const digest = createHash('sha256').update(singletonKey, 'utf8').digest('hex').slice(0, 12);
  const name = `proxy-${safe}-${digest}.sock`;
  const full = path.join(socketDir, name);

  if (Buffer.byteLength(full, 'utf8') <= MAX_SUN_PATH) return full;

  // The un-shortened filename didn't fit. Try shortening JUST the filename first
  // (the historical fallback) -- this still covers the "long key, short dir" case.
  const shortName = `proxy-${digest}.sock`;
  const shortenedFilenameOnly = path.join(socketDir, shortName);
  if (Buffer.byteLength(shortenedFilenameOnly, 'utf8') <= MAX_SUN_PATH) {
    return shortenedFilenameOnly;
  }

  // Tier 3 (BL-578): `socketDir` itself is already too long. The kernel only sees
  // the literal byte string passed to bind(2), so the socket moves OUTSIDE the
  // data root, into the fixed per-uid root. Deterministic on (socketDir,
  // singletonKey), so every peer for the same store converges on ONE backend.
  const bothDigest = createHash('sha256')
    .update(`${socketDir} ${singletonKey}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return path.join(udsFallbackRoot(), `p-${bothDigest}.sock`);
}
