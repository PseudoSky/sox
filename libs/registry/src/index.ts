/**
 * libs/registry/src/index.ts
 *
 * Registry lib: drift gate / index / checksum utilities.
 * [def:session-fixes] registry drift gate carried forward (from A8/C2 work).
 *
 * The drift gate checks that the live registry/index.json is consistent with
 * the extensions on disk (no stale or unindexed entries).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RegistryIndexEntry {
  id: string;
  type: string;
  version: string;
  title: string;
  description: string;
  source: string;
  checksum: string;
  compatibility: { host: string };
  requires?: {
    tool_calling?: boolean;
    structured_output?: boolean;
    min_context_tokens?: number;
  };
  members?: Array<{ id: string; version: string }>;
}

export interface DriftReport {
  /** True if the registry is in sync with the extensions on disk. */
  ok: boolean;
  /** Extensions that are in the index but not found on disk. */
  stale: string[];
  /** Extensions on disk that are not in the index (unindexed). */
  unindexed: string[];
  /** Extensions whose checksum in the index does not match the current disk checksum. */
  mutated: string[];
}

export interface ChecksumEntry {
  id: string;
  source: string;
  checksum: string;
}

// ─── Registry index ───────────────────────────────────────────────────────────

/**
 * loadIndex — Load the registry/index.json from the given repo root.
 * Returns empty array if the file does not exist.
 */
export function loadIndex(root: string): RegistryIndexEntry[] {
  const indexPath = path.join(root, 'registry', 'index.json');
  if (!fs.existsSync(indexPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as RegistryIndexEntry[];
  } catch (_e) {
    return [];
  }
}

/**
 * writeIndex — Write entries to registry/index.json (creates the dir if missing).
 */
export function writeIndex(root: string, entries: RegistryIndexEntry[]): void {
  const registryDir = path.join(root, 'registry');
  if (!fs.existsSync(registryDir)) {
    fs.mkdirSync(registryDir, { recursive: true });
  }
  const indexPath = path.join(registryDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

// ─── Checksum utilities ───────────────────────────────────────────────────────

/**
 * computeChecksum — Compute sha256 checksum of a file or buffer.
 * Returns "sha256:<hex>".
 */
export function computeChecksum(data: Buffer | string): string {
  const hash = crypto
    .createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data) : data)
    .digest('hex');
  return `sha256:${hash}`;
}

/**
 * computeFileChecksum — Compute checksum from a file path.
 */
export function computeFileChecksum(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return computeChecksum(bytes);
}

/**
 * verifyChecksum — Returns true if the file at filePath has the given checksum.
 */
export function verifyChecksum(filePath: string, expectedChecksum: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const actual = computeFileChecksum(filePath);
  return actual === expectedChecksum;
}

// ─── Drift gate [def:session-fixes] ──────────────────────────────────────────

const DIR_TO_TYPE: Record<string, string> = {
  agents: 'agent',
  skills: 'skill',
  'mcp-servers': 'mcp-server',
  prompts: 'prompt',
  hooks: 'hook',
  commands: 'command',
  bundles: 'bundle',
};

/**
 * detectDrift — [def:session-fixes] registry drift gate.
 *
 * Compares the registry/index.json against the extensions on disk:
 *   - stale:     in index but not on disk (was removed without rebuild)
 *   - unindexed: on disk but not in index (was added without rebuild)
 *   - mutated:   checksum in index does not match current disk checksum
 *
 * Returns a DriftReport. When ok === false, the caller should re-run build-index.
 */
export function detectDrift(root: string): DriftReport {
  const index = loadIndex(root);
  const indexById = new Map<string, RegistryIndexEntry>(index.map((e) => [e.id, e]));

  // Collect all extension ids found on disk
  const onDiskIds = new Set<string>();
  const extensionsRoot = path.join(root, 'extensions');

  if (fs.existsSync(extensionsRoot)) {
    for (const typeDir of fs.readdirSync(extensionsRoot)) {
      if (!Object.keys(DIR_TO_TYPE).includes(typeDir)) continue;
      const typePath = path.join(extensionsRoot, typeDir);
      if (!fs.statSync(typePath).isDirectory()) continue;

      for (const extId of fs.readdirSync(typePath)) {
        const extPath = path.join(typePath, extId);
        if (!fs.statSync(extPath).isDirectory()) continue;
        const manifestPath = path.join(extPath, 'extension.json');
        if (!fs.existsSync(manifestPath)) continue;

        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { id?: string; private?: boolean };
          if (!manifest.id || manifest.private === true) continue;
          onDiskIds.add(manifest.id);
        } catch (_e) {
          // Skip malformed manifests
        }
      }
    }
  }

  const stale: string[] = [];
  const unindexed: string[] = [];
  const mutated: string[] = [];

  // Check for stale entries (in index but not on disk)
  for (const entry of index) {
    if (!onDiskIds.has(entry.id)) {
      stale.push(entry.id);
    }
  }

  // Check for unindexed + mutated
  for (const id of onDiskIds) {
    const entry = indexById.get(id);
    if (!entry) {
      unindexed.push(id);
      continue;
    }

    // Check checksum drift if the source is a local file (not a directory)
    if (entry.source.startsWith('file://')) {
      const filePath = entry.source.slice('file://'.length);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const current = computeFileChecksum(filePath);
        if (current !== entry.checksum) {
          mutated.push(id);
        }
      }
      // Directory sources: no per-file checksum check (checksum is of the content file, not dir)
    }
  }

  return {
    ok: stale.length === 0 && unindexed.length === 0 && mutated.length === 0,
    stale,
    unindexed,
    mutated,
  };
}

/**
 * assertNoDrift — Throws if the registry has drifted from disk.
 * Used in CI gates (C2 — registry checksums current + CI drift gate).
 */
export function assertNoDrift(root: string): void {
  const report = detectDrift(root);
  if (!report.ok) {
    const parts: string[] = [];
    if (report.stale.length > 0) {
      parts.push(`stale (in index, not on disk): ${report.stale.join(', ')}`);
    }
    if (report.unindexed.length > 0) {
      parts.push(`unindexed (on disk, not in index): ${report.unindexed.join(', ')}`);
    }
    if (report.mutated.length > 0) {
      parts.push(`mutated (checksum mismatch): ${report.mutated.join(', ')}`);
    }
    throw new Error(
      `[registry] Drift detected — re-run 'pnpm build-index' to update registry/index.json.\n` +
      parts.map((p) => `  - ${p}`).join('\n'),
    );
  }
}
