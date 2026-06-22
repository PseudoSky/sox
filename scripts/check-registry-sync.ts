#!/usr/bin/env node
/**
 * scripts/check-registry-sync.ts — Registry drift gate
 *
 * Fails (exit 1) if registry/index.json is out of sync with the
 * extension manifests currently on disk under extensions/.
 *
 * Use as a CI check or pre-commit hook:
 *   npx tsx scripts/check-registry-sync.ts
 *
 * When it fails, re-sync with:
 *   npx tsx scripts/build-index.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

const root = process.argv[2] ?? process.cwd();

// Read the current committed registry
const registryPath = path.join(root, 'registry', 'index.json');
if (!fs.existsSync(registryPath)) {
  console.error('check-registry-sync: registry/index.json not found — run npx tsx scripts/build-index.ts first');
  process.exit(1);
}

const committedRaw = fs.readFileSync(registryPath, 'utf8');

// Build the registry to a temp file and compare.
// We do this by writing to a temp location and diffing — build-index always
// writes to <root>/registry/index.json, so we temporarily redirect output.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-reg-check-'));

// Symlink everything from the real root to tmpDir so build-index can scan extensions/
// without actually copying files. We just need the extensions/ tree visible.
const extSrc = path.join(root, 'extensions');
const extDst = path.join(tmpDir, 'extensions');
fs.symlinkSync(extSrc, extDst);

// Also symlink registry/ so build-index can write to it
fs.mkdirSync(path.join(tmpDir, 'registry'), { recursive: true });

// Inline the core logic from build-index.ts rather than re-importing to avoid
// circular module concerns; this is intentionally a standalone check script.

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
  version: string;
  type: string;
  title: string;
  description: string;
  compatibility: { host: string };
  private?: boolean;
  checksum?: string;
  requires?: Record<string, unknown>;
  members?: Array<{ id: string; version: string }>;
}

function computeChecksum(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

function findExtDirs(): string[] {
  const dirs: string[] = [];

  // Primary: extensions/<type>/<id>/
  const extensionsRoot = path.join(root, 'extensions');
  if (fs.existsSync(extensionsRoot)) {
    for (const typeDir of fs.readdirSync(extensionsRoot)) {
      const typePath = path.join(extensionsRoot, typeDir);
      if (!fs.statSync(typePath).isDirectory()) continue;
      if (!Object.keys(DIR_TO_TYPE).includes(typeDir)) continue;
      for (const extId of fs.readdirSync(typePath)) {
        const extPath = path.join(typePath, extId);
        if (!fs.statSync(extPath).isDirectory()) continue;
        if (fs.existsSync(path.join(extPath, 'extension.json'))) dirs.push(extPath);
      }
    }
  }

  // Secondary: apps/<name>/ (first-party CLI tools with extension.json)
  const appsRoot = path.join(root, 'apps');
  if (fs.existsSync(appsRoot)) {
    for (const appName of fs.readdirSync(appsRoot)) {
      const appPath = path.join(appsRoot, appName);
      if (!fs.statSync(appPath).isDirectory()) continue;
      if (fs.existsSync(path.join(appPath, 'extension.json'))) dirs.push(appPath);
    }
  }

  return dirs;
}

function buildLiveEntries(): unknown[] {
  const entries: unknown[] = [];

  for (const extPath of findExtDirs()) {
      const manifestPath = path.join(extPath, 'extension.json');
      if (!fs.existsSync(manifestPath)) continue;

      let manifest: Manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
      } catch (e) {
        console.error(`check-registry-sync: ERROR parsing ${manifestPath}: ${String(e)}`);
        process.exit(1);
      }

      if (manifest.private === true) continue;

      // Determine source (file://)
      const source = `file://${extPath}`;

      // Determine checksum
      const contentFile =
        manifest.type === 'prompt'
          ? path.join(extPath, 'prompt.md')
          : path.join(extPath, 'src', 'index.ts');
      const checksum = fs.existsSync(contentFile)
        ? computeChecksum(contentFile)
        : computeChecksum(manifestPath);

      const entry: Record<string, unknown> = {
        id: manifest.id,
        type: manifest.type,
        version: manifest.version,
        title: manifest.title,
        description: manifest.description,
        source,
        checksum,
        compatibility: manifest.compatibility,
      };

      if (manifest.requires && Object.keys(manifest.requires).length > 0) {
        entry['requires'] = manifest.requires;
      }
      if (manifest.type === 'bundle' && Array.isArray(manifest.members) && manifest.members.length > 0) {
        entry['members'] = manifest.members;
      }

      entries.push(entry);
  }

  return entries;
}

const liveEntries = buildLiveEntries();
// liveEntries used below for comparison
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

// Clean up temp dir
fs.rmSync(tmpDir, { recursive: true, force: true });

if (committedSorted === liveSorted) {
  console.log(`check-registry-sync: OK — registry/index.json is in sync (${committedEntries.length} entries)`);
  process.exit(0);
} else {
  console.error('check-registry-sync: FAIL — registry/index.json is out of sync with disk.');
  console.error('  Extensions on disk but not in registry, or registry entries no longer on disk.');
  console.error('  Fix: npx tsx scripts/build-index.ts && git add registry/index.json');
  console.error(`  Disk: ${liveEntries.length} entries  Registry: ${committedEntries.length} entries`);

  // Show which ids differ
  const committedIds = new Set(committedEntries.map((e) => (e as { id: string }).id));
  const liveIds = new Set(liveEntries.map((e) => (e as { id: string }).id));
  for (const id of liveIds) {
    if (!committedIds.has(id)) console.error(`  + on disk, missing from registry: ${id}`);
  }
  for (const id of committedIds) {
    if (!liveIds.has(id)) console.error(`  - in registry, not on disk: ${id}`);
  }
  process.exit(1);
}
