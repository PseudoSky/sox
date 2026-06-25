/**
 * libs/service-proxy/src/socket-path.ts — backend UDS path derivation (§9.5.4).
 *
 * The backend socket path is derived from the data-root resolver keyed by the
 * [def:singleton-key] so there is never a port-selection problem and never a clash
 * (§9.5.4). This lib is a dependency-free leaf (no host-runtime import), so the
 * CALLER passes in the resolved socket directory (`socketDir()`, ADR-0004) and the
 * singleton key; this helper composes the deterministic path + sanitises it.
 *
 * Leaf module — node builtins only (path, crypto).
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
 * Derive the backend service socket path.
 *
 * @param socketDir  the resolved socket directory (`socketDir()`, ADR-0004 — e.g.
 *                   `$userDataRoot/run/supervisors`). The caller resolves it; this
 *                   lib does not import the data-root resolver (leaf hygiene).
 * @param singletonKey  the [def:singleton-key] for the backend (id + backing store
 *                   resource). Identical keys ⇒ identical socket ⇒ one backend.
 */
export function backendSocketPath(socketDir: string, singletonKey: string): string {
  // Sanitise the key into a filesystem-safe segment. Collisions are avoided by the
  // hash suffix, which is derived from the FULL untruncated key.
  const safe = singletonKey.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  const digest = createHash('sha256').update(singletonKey, 'utf8').digest('hex').slice(0, 12);
  const name = `proxy-${safe}-${digest}.sock`;
  const full = path.join(socketDir, name);

  if (Buffer.byteLength(full, 'utf8') <= MAX_SUN_PATH) return full;

  // Path too long for sun_path — fall back to a fully-hashed short name.
  const shortName = `proxy-${digest}.sock`;
  return path.join(socketDir, shortName);
}
