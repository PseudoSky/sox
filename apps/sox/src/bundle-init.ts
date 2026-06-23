/**
 * apps/sox/src/bundle-init.ts — Bundle-resolution helpers for `sox init --bundle`.
 *
 * Extracted from cmdInit so they can be unit-tested independently.
 *
 * Exports:
 *   resolveBundleDir   — map bundle name → absolute source directory
 *   registerBundleMember — append a member entry to a bundle's extension.json
 */

// ─── resolveBundleDir ─────────────────────────────────────────────────────────

/**
 * resolveBundleDir — resolve a bundle's source directory by name.
 *
 * Strategy:
 *   1. Look in registry/index.json (in cwd, i.e. the repo root) for an entry
 *      where type == "bundle" and id == bundleName. Strip the "file://" prefix
 *      from its `source` field to get the absolute path.
 *   2. Fallback: scan extensions/bundles/<bundle>/extension.json in cwd,
 *      checking the manifest `id` field.
 *
 * Returns the resolved directory path, or undefined if not found.
 *
 * [bundle-resolve.1]: registry lookup is the primary path — it gives the canonical
 *   installed source path. The filesystem scan is a fallback for development scenarios
 *   where registry/index.json hasn't been regenerated yet.
 */
export function resolveBundleDir(
  bundleName: string,
  cwd: string,
  pathMod: Pick<typeof import('node:path'), 'join'>,
  existsFn: (p: string) => boolean,
  readFileFn: (p: string, enc: 'utf8') => string,
  readdirFn: (p: string) => string[],
): string | undefined {
  // ── Step 1: registry/index.json lookup ──────────────────────────────────────
  const registryPath = pathMod.join(cwd, 'registry', 'index.json');
  if (existsFn(registryPath)) {
    try {
      const entries = JSON.parse(readFileFn(registryPath, 'utf8')) as Array<{
        id: string;
        type: string;
        source?: string;
      }>;
      for (const entry of entries) {
        if (entry.type === 'bundle' && entry.id === bundleName && entry.source) {
          // source is "file:///abs/path/to/bundle-dir"
          const dirPath = entry.source.replace(/^file:\/\//, '');
          if (existsFn(dirPath)) return dirPath;
        }
      }
    } catch {
      // Malformed registry — fall through to filesystem scan
    }
  }

  // ── Step 2: filesystem scan of extensions/bundles/ ──────────────────────────
  const bundlesRoot = pathMod.join(cwd, 'extensions', 'bundles');
  if (existsFn(bundlesRoot)) {
    let entries: string[];
    try {
      entries = readdirFn(bundlesRoot);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const candidateDir = pathMod.join(bundlesRoot, entry);
      const manifestPath = pathMod.join(candidateDir, 'extension.json');
      if (!existsFn(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileFn(manifestPath, 'utf8')) as {
          id?: string;
          type?: string;
        };
        if (manifest.type === 'bundle' && manifest.id === bundleName) {
          return candidateDir;
        }
      } catch {
        // Skip unreadable/malformed manifests
      }
    }
  }

  return undefined;
}

// ─── registerBundleMember ─────────────────────────────────────────────────────

/**
 * registerBundleMember — append a member entry to a bundle's extension.json members[].
 *
 * Idempotent: if a member with the same id already exists, it is not duplicated.
 * Writes the updated manifest back to disk as formatted JSON (2-space indent, trailing
 * newline — matching the existing bundle extension.json style).
 *
 * [bundle-register.1]: ADR-0003 — members are referenced by `id` only. Identity is
 *   id + content checksum; there is no per-member version. New members are appended
 *   as `{ id }`.
 *
 * @throws Error if the manifest cannot be read, is malformed, or cannot be written.
 */
export function registerBundleMember(
  bundleManifestPath: string,
  memberId: string,
  readFileFn: (p: string, enc: 'utf8') => string,
  writeFileFn: (p: string, data: string, enc: 'utf8') => void,
): void {
  let raw: string;
  try {
    raw = readFileFn(bundleManifestPath, 'utf8');
  } catch (e) {
    throw new Error(
      `registerBundleMember: cannot read ${bundleManifestPath}: ${String(e)}`,
    );
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `registerBundleMember: malformed JSON in ${bundleManifestPath}: ${String(e)}`,
    );
  }

  // Ensure members is an array
  let members = manifest['members'];
  if (!Array.isArray(members)) {
    members = [];
    manifest['members'] = members;
  }

  // Idempotent: no-op if already present
  const existing = members as Array<Record<string, unknown>>;
  if (existing.some((m) => m['id'] === memberId)) {
    return;
  }

  // Append the new member (ADR-0003: id-only reference).
  existing.push({ id: memberId });
  manifest['members'] = existing;

  try {
    writeFileFn(bundleManifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  } catch (e) {
    throw new Error(
      `registerBundleMember: cannot write ${bundleManifestPath}: ${String(e)}`,
    );
  }
}
