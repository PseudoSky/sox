#!/usr/bin/env node
/**
 * scripts/check-registry-sync.ts — Registry drift gate
 *
 * Fails (exit 1) if registry/index.json is out of sync with the
 * extension manifests currently on disk under extensions/ (and apps/).
 *
 * Use as a CI check or pre-commit hook:
 *   npx tsx scripts/check-registry-sync.ts
 *
 * When it fails, re-sync with:
 *   npx nx run registry:sync-index
 *
 * BL-33: this scanner MUST mirror `scripts/build-index.ts` exactly — same
 * directory walk (INCLUDING recursion into extensions/bundles/<id>/members/),
 * same source/checksum/version/visibility/bundleId derivation. Any divergence
 * re-introduces false drift. It is kept standalone (no import of build-index,
 * which has a top-level write side-effect) but is a faithful read-only mirror.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.argv[2] ?? process.cwd();

// Read the current committed registry
const registryPath = path.join(root, 'registry', 'index.json');
if (!fs.existsSync(registryPath)) {
  console.error('check-registry-sync: registry/index.json not found — run npx nx run registry:sync-index first');
  process.exit(1);
}

const committedRaw = fs.readFileSync(registryPath, 'utf8');

// ─── Mirror of scripts/build-index.ts (read-only) ────────────────────────────

// MUST match scripts/build-index.ts DIR_TO_TYPE exactly. build-index does NOT
// scan extensions/services/, so neither does this gate — adding a type here
// that build-index omits would create false drift in the opposite direction.
const DIR_TO_TYPE: Record<string, string> = {
  agents: 'agent',
  skills: 'skill',
  'mcp-servers': 'mcp-server',
  prompts: 'prompt',
  hooks: 'hook',
  commands: 'command',
  bundles: 'bundle',
};

interface Manifest {
  id: string;
  type: string;
  title: string;
  description: string;
  compatibility: { host: string };
  private?: boolean;
  checksum?: string;
  entrypoint?: string;
  requires?: Record<string, unknown>;
  members?: Array<{ id: string }>;
  visibility?: 'public' | 'internal';
  bundle_id?: string;
}

function computeFileChecksum(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Directory walk — mirrors build-index.findExtensionDirs (BL-33 fix):
 *   extensions/<type>/<id>/ and, for type=bundles, ALSO
 *   extensions/bundles/<bundle-id>/members/<member-id>/, plus apps/<name>/.
 */
function findExtDirs(): Array<{ extPath: string; bundleId?: string }> {
  const dirs: Array<{ extPath: string; bundleId?: string }> = [];

  const extensionsRoot = path.join(root, 'extensions');
  if (fs.existsSync(extensionsRoot)) {
    for (const typeDir of fs.readdirSync(extensionsRoot)) {
      const typePath = path.join(extensionsRoot, typeDir);
      if (!fs.statSync(typePath).isDirectory()) continue;
      if (!Object.keys(DIR_TO_TYPE).includes(typeDir)) continue;

      for (const extId of fs.readdirSync(typePath)) {
        const extPath = path.join(typePath, extId);
        if (!fs.statSync(extPath).isDirectory()) continue;
        if (!fs.existsSync(path.join(extPath, 'extension.json'))) continue;

        if (typeDir === 'bundles') {
          dirs.push({ extPath });
          // BL-33: recurse into members/ so bundle members are not false-flagged.
          const membersPath = path.join(extPath, 'members');
          if (fs.existsSync(membersPath) && fs.statSync(membersPath).isDirectory()) {
            for (const memberId of fs.readdirSync(membersPath)) {
              const memberPath = path.join(membersPath, memberId);
              if (!fs.statSync(memberPath).isDirectory()) continue;
              if (fs.existsSync(path.join(memberPath, 'extension.json'))) {
                dirs.push({ extPath: memberPath, bundleId: extId });
              }
            }
          }
        } else {
          dirs.push({ extPath });
        }
      }
    }
  }

  const appsRoot = path.join(root, 'apps');
  if (fs.existsSync(appsRoot)) {
    for (const appName of fs.readdirSync(appsRoot)) {
      const appPath = path.join(appsRoot, appName);
      if (!fs.statSync(appPath).isDirectory()) continue;
      if (fs.existsSync(path.join(appPath, 'extension.json'))) {
        dirs.push({ extPath: appPath });
      }
    }
  }

  return dirs;
}

/** Mirror of build-index.resolveDisplayVersion (ADR-0003 Decision 6). */
function resolveDisplayVersion(extDir: string): string {
  const pkgPath = path.join(extDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch { /* fall through */ }
  }
  return '0.0.0';
}

/** Mirror of build-index.resolveSource (incl. the Slice 3 publication signal). */
function resolveSource(extDir: string, manifest: Manifest): string {
  const pkgPath = path.join(extDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string; private?: boolean };
    const pkgName = pkg.name ?? `@adhd/sox-extension-${manifest.id}`;
    // Mirror build-index: only NON-PRIVATE (published) packages get an npm-package: locator.
    if (process.env['SOX_REGISTRY_PUBLISH'] && pkg.private !== true) {
      return `npm-package:${pkgName}@${resolveDisplayVersion(extDir)}`;
    }
    if (manifest.checksum) {
      return `https://cdn.jsdelivr.net/npm/${pkgName}@${resolveDisplayVersion(extDir)}/dist/index.js`;
    }
  }
  return `file://${extDir}`;
}

/** Mirror of build-index.resolveChecksum (C4 entrypoint resolution order). */
function resolveChecksum(extDir: string, manifest: Manifest): string {
  if (manifest.checksum && /^sha256:[0-9a-f]{64}$/.test(manifest.checksum)) {
    return manifest.checksum;
  }
  if (typeof manifest.entrypoint === 'string' && manifest.entrypoint.trim() !== '') {
    const declared = path.join(extDir, manifest.entrypoint);
    if (fs.existsSync(declared)) return computeFileChecksum(declared);
  }
  const distJs = path.join(extDir, 'dist', 'index.js');
  if (fs.existsSync(distJs)) return computeFileChecksum(distJs);
  const promptMd = path.join(extDir, 'prompt.md');
  if (fs.existsSync(promptMd)) return computeFileChecksum(promptMd);
  return computeFileChecksum(path.join(extDir, 'extension.json'));
}

function buildLiveEntries(): unknown[] {
  const entries: unknown[] = [];

  for (const { extPath: extDir, bundleId: detectedBundleId } of findExtDirs()) {
    const manifestPath = path.join(extDir, 'extension.json');
    let manifest: Manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
    } catch (e) {
      console.error(`check-registry-sync: ERROR parsing ${manifestPath}: ${String(e)}`);
      process.exit(1);
    }

    if (manifest.private === true) continue;

    const source = resolveSource(extDir, manifest);

    // Mirror build-index: under the publication signal, omit any entry whose source
    // is still file:// (private / unpublished package — not installable from npm).
    if (process.env['SOX_REGISTRY_PUBLISH'] && source.startsWith('file://')) continue;

    const entry: Record<string, unknown> = {
      id: manifest.id,
      type: manifest.type,
      version: resolveDisplayVersion(extDir),
      title: manifest.title,
      description: manifest.description,
      source,
      checksum: resolveChecksum(extDir, manifest),
      compatibility: manifest.compatibility,
    };

    if (manifest.requires && Object.keys(manifest.requires).length > 0) {
      entry['requires'] = manifest.requires;
    }
    if (manifest.type === 'bundle' && Array.isArray(manifest.members) && manifest.members.length > 0) {
      entry['members'] = manifest.members;
    }
    if (detectedBundleId !== undefined) {
      entry['visibility'] = 'internal';
      entry['bundleId'] = detectedBundleId;
    } else if (manifest.visibility === 'internal') {
      entry['visibility'] = 'internal';
      if (manifest.bundle_id !== undefined) entry['bundleId'] = manifest.bundle_id;
    }

    entries.push(entry);
  }

  return entries;
}

const liveEntries = buildLiveEntries();
const committedEntries = JSON.parse(committedRaw) as unknown[];

// Sort both by id for stable comparison
function sortedById(arr: unknown[]): unknown[] {
  return [...arr].sort((a, b) => {
    const aId = (a as { id: string }).id;
    const bId = (b as { id: string }).id;
    return aId.localeCompare(bId);
  });
}

const committedSorted = JSON.stringify(sortedById(committedEntries), null, 2);
const liveSorted = JSON.stringify(sortedById(liveEntries), null, 2);

if (committedSorted === liveSorted) {
  console.log(`check-registry-sync: OK — registry/index.json is in sync (${committedEntries.length} entries)`);
  process.exit(0);
} else {
  console.error('check-registry-sync: FAIL — registry/index.json is out of sync with disk.');
  console.error('  Extensions on disk but not in registry, or registry entries no longer on disk.');
  console.error('  Fix: npx nx run registry:sync-index && git add registry/index.json');
  console.error(`  Disk: ${liveEntries.length} entries  Registry: ${committedEntries.length} entries`);

  const committedIds = new Set(committedEntries.map((e) => (e as { id: string }).id));
  const liveIds = new Set(liveEntries.map((e) => (e as { id: string }).id));
  for (const id of liveIds) {
    if (!committedIds.has(id)) console.error(`  + on disk, missing from registry: ${id}`);
  }
  for (const id of committedIds) {
    if (!liveIds.has(id)) console.error(`  - in registry, not on disk: ${id}`);
  }
  // Same id-set but differing content (e.g. checksum/source drift): name the ids.
  for (const id of liveIds) {
    if (!committedIds.has(id)) continue;
    const live = liveEntries.find((e) => (e as { id: string }).id === id);
    const committed = committedEntries.find((e) => (e as { id: string }).id === id);
    if (JSON.stringify(live) !== JSON.stringify(committed)) {
      console.error(`  ~ content differs for: ${id}`);
    }
  }
  process.exit(1);
}
