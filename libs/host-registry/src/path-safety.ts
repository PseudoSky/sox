/**
 * libs/host-registry/src/path-safety.ts
 *
 * BUG-EPIC-MANIFEST-PATH-ESCAPE-001: paths taken from extension manifests
 * (untrusted — extensions install from a registry and from `file://` sources)
 * and from CLI arguments must never be allowed to resolve outside the base
 * directory they were joined onto. This module is the ONE containment check
 * every manifest/CLI-argument path join in this package routes through.
 *
 * [inv:no-manifest-path-escape]
 *
 * NOTE ON DUPLICATION: an identical, independently-maintained copy of this
 * module lives in apps/sox/src/path-safety.ts, libs/host-runtime/src/path-safety.ts,
 * and libs/host-registry/src/path-safety.ts. This is deliberate, not an oversight:
 * install-engine already depends on host-registry (lazy require in install.ts /
 * mcp-project-sync.ts), so host-registry importing this module from install-engine
 * would create a package cycle; host-runtime and apps/sox have no existing
 * dependency edge to install-engine either, and adding one purely to share ~40
 * lines of dependency-free node:fs/node:path logic is a disproportionate and
 * permanent coupling cost for a security helper that should stay boring and
 * inlineable. Each copy is covered by its own spec file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export class PathEscapeError extends Error {
  constructor(
    public readonly base: string,
    public readonly candidate: string,
    public readonly resolvedBase: string,
    public readonly resolvedCandidate: string,
  ) {
    super(
      `path escape refused: "${candidate}" resolves to "${resolvedCandidate}", ` +
      `which is outside base "${base}" (resolved: "${resolvedBase}")`,
    );
    this.name = 'PathEscapeError';
  }
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve `candidate` to its real (symlink-free) absolute path.
 *
 * For paths that exist, this is a plain `realpathSync` — the strongest
 * guarantee, because it also defeats a symlink INSIDE the base pointing
 * outward (a string-only / `path.resolve`-only check cannot catch that: the
 * string still reads as "inside", but the filesystem will follow the link
 * out on open/read/write).
 *
 * For paths that do not exist yet (e.g. an install target that hasn't been
 * written), we cannot realpath the full path, so we walk up to the nearest
 * existing ancestor, realpath THAT (defeating a symlink planted at an
 * intermediate directory), and re-append the non-existent tail verbatim.
 */
function resolveReal(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (fs.existsSync(resolved)) {
    return fs.realpathSync(resolved);
  }
  let dir = path.dirname(resolved);
  const tail: string[] = [path.basename(resolved)];
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root without finding anything real
    tail.unshift(path.basename(dir));
    dir = parent;
  }
  return path.join(realpathOrSelf(dir), ...tail);
}

/**
 * Assert that `candidate` (typically `path.join(base, untrustedSegment)`)
 * resolves to a location inside `base`. Both sides are resolved through
 * `resolveReal` first, so this is safe against:
 *   - `../` segments in the untrusted input,
 *   - symlinks (inside or at an ancestor of the base) that redirect outside it,
 *   - the `/base-evil` vs `/base` prefix-string bug (this compares path
 *     SEGMENTS via `path.relative`, never a bare `startsWith`).
 *
 * Returns the resolved candidate path on success (callers should use this
 * resolved value for the actual filesystem operation, not the raw `candidate`,
 * so a TOCTOU symlink swap between the check and the operation is at least
 * minimized). Throws {@link PathEscapeError} naming both paths on failure.
 */
export function assertWithinBase(base: string, candidate: string): string {
  const realBase = resolveReal(base);
  const realCandidate = resolveReal(candidate);
  const rel = path.relative(realBase, realCandidate);
  const isWithin = rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
  if (!isWithin) {
    throw new PathEscapeError(base, candidate, realBase, realCandidate);
  }
  return realCandidate;
}

/**
 * Convenience wrapper: join `base` with `untrustedSegment` (as `path.join`
 * would) and assert the result stays within `base`. Returns the resolved
 * (symlink-free) joined path.
 */
export function joinWithinBase(base: string, untrustedSegment: string): string {
  const candidate = path.join(base, untrustedSegment);
  return assertWithinBase(base, candidate);
}
