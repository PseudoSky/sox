/**
 * libs/service-proxy/src/socket-path.ts -- backend UDS path derivation (S9.5.4).
 *
 * The backend socket path is derived from the data-root resolver keyed by the
 * [def:singleton-key] so there is never a port-selection problem and never a clash
 * (S9.5.4). This lib is a dependency-free leaf (no host-runtime import), so the
 * CALLER passes in the resolved socket directory (`socketDir()`, ADR-0004) and the
 * singleton key; this helper composes the deterministic path + sanitises it.
 *
 * Leaf module -- node builtins only (path, crypto, os).
 *
 * BL-578: the original fallback below assumed only the FILENAME could overflow the
 * kernel's `sun_path` budget, and shortened only the filename while re-joining onto
 * the SAME `socketDir`. That is unsound whenever `socketDir` itself already exceeds
 * the budget -- which is the normal case for a scratch data root nested several
 * directories deep (e.g. `.claude/worktrees/agent-<hash>/dist/smoke/run-<ts>/
 * sox-data-root/run/supervisors` measures 138 bytes on its own, already 34 bytes
 * over the 104-byte macOS limit, before any filename is appended). `bind(2)` then
 * fails with `EINVAL`, the losing singleton racer exits (by design, S9.5), and
 * nothing downstream noticed because the caller never re-checked disposition
 * (fixed separately in scripts/smoke-test.mjs). See socket-path.spec.ts's
 * "long socketDir" case for the reproduction.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

/**
 * The max length of a Unix-domain-socket path. macOS `sun_path` is 104 bytes;
 * Linux is 108. We use the smaller bound so a path that works on the dev mac also
 * works on Linux. A key that would overflow is hashed into a short stable name.
 */
const MAX_SUN_PATH = 104;

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

  // BL-578: shortening the filename alone was not enough -- `socketDir` itself is
  // already too long (deep worktree/scratch roots). A UDS path has no notion of
  // "relative to the data root"; the kernel only sees the literal byte string
  // passed to bind(2). Fall back to a directory OUTSIDE the (possibly deep) data
  // root: the OS temp dir, which every platform guarantees stays well under the
  // sun_path budget for exactly this reason (mktemp/mkstemp UDS conventions).
  // Deterministic on (socketDir, singletonKey) so repeated calls for the same
  // store still converge on ONE backend (the singleton invariant is unaffected --
  // it never depended on the socket living under the data root, only on the key).
  const bothDigest = createHash('sha256')
    .update(`${socketDir} ${singletonKey}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  const tmpFallback = path.join(os.tmpdir(), 'sox-uds', `p-${bothDigest}.sock`);
  if (Buffer.byteLength(tmpFallback, 'utf8') <= MAX_SUN_PATH) return tmpFallback;

  // Last resort -- os.tmpdir() itself can be long on some sandboxes (macOS
  // /var/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/ occasionally exceeds
  // budget once joined with even a 20-byte leaf). '/tmp' is POSIX-guaranteed to
  // exist and be short on every target platform this repo ships to (darwin,
  // linux) -- the true floor when even os.tmpdir() doesn't fit.
  return path.join('/tmp', `s-${bothDigest.slice(0, 12)}.sock`);
}
