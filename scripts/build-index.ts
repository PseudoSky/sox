#!/usr/bin/env node
/**
 * build-index.ts — Registry index builder
 *
 * Contract (Section 4.3):
 *   - Inputs: all extension.json under extensions/; for published entries, resolved npm-CDN URL
 *     and artifact bytes (to compute sha256).
 *   - Outputs: registry/index.json — array of {id,type,version,title,description,source,checksum,compatibility}
 *   - source points to npm CDN (or file:// for local); checksum is "sha256:<hex>"
 *   - private:true extensions are excluded (not an error)
 *   - An extension.json failing schema validation aborts with the offending path
 *   - Side effects: writes registry/index.json; may fetch published artifacts to checksum them.
 *     Runs post-publish in CI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

interface ExtensionManifest {
  $schema: string;
  id: string;
  version: string;
  type: string;
  title: string;
  description: string;
  compatibility: { host: string };
  license: string;
  entrypoint?: string;
  author?: string;
  private?: boolean;
  checksum?: string;
  requires?: {
    tool_calling?: boolean;
    structured_output?: boolean;
    min_context_tokens?: number;
  };
  tags?: string[];
  capabilities?: string[];
  /** G-B: bundle members. Present iff type=='bundle'. Indexed like any extension. */
  members?: Array<{ id: string; version: string }>;
}

export interface IndexEntry {
  id: string;
  type: string;
  version: string;
  title: string;
  description: string;
  /** npm CDN URL or file:// path or https:// URL */
  source: string;
  /** sha256:<hex> — computed from artifact bytes */
  checksum: string;
  compatibility: { host: string };
  /** Populated only if the entry has requires fields */
  requires?: ExtensionManifest['requires'];
  /** G-B: populated for bundle type; the members this bundle expands to at install time */
  members?: ExtensionManifest['members'];
}

const DIR_TO_TYPE: Record<string, string> = {
  agents: 'agent',
  skills: 'skill',
  'mcp-servers': 'mcp-server',
  prompts: 'prompt',
  hooks: 'hook',
  commands: 'command',
  // G-B: bundles are indexed like any extension; they are expanded at install time.
  bundles: 'bundle',
};

function computeFileChecksum(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hash}`;
}

function computeBytesChecksum(bytes: Buffer): string {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hash}`;
}

function findExtensionDirs(root: string): string[] {
  const dirs: string[] = [];

  // Primary scan: extensions/<type>/<id>/extension.json
  const extensionsRoot = path.join(root, 'extensions');
  if (fs.existsSync(extensionsRoot)) {
    for (const typeDir of fs.readdirSync(extensionsRoot)) {
      const typePath = path.join(extensionsRoot, typeDir);
      if (!fs.statSync(typePath).isDirectory()) continue;
      if (!Object.keys(DIR_TO_TYPE).includes(typeDir)) continue;

      for (const extId of fs.readdirSync(typePath)) {
        const extPath = path.join(typePath, extId);
        if (!fs.statSync(extPath).isDirectory()) continue;
        const manifestPath = path.join(extPath, 'extension.json');
        if (fs.existsSync(manifestPath)) {
          dirs.push(extPath);
        }
      }
    }
  }

  // Secondary scan: apps/<name>/extension.json
  // First-party CLI tools (e.g. apps/sox) are self-hosted extensions; they live
  // outside extensions/ but still declare an extension.json to be discoverable.
  const appsRoot = path.join(root, 'apps');
  if (fs.existsSync(appsRoot)) {
    for (const appName of fs.readdirSync(appsRoot)) {
      const appPath = path.join(appsRoot, appName);
      if (!fs.statSync(appPath).isDirectory()) continue;
      const manifestPath = path.join(appPath, 'extension.json');
      if (fs.existsSync(manifestPath)) {
        dirs.push(appPath);
      }
    }
  }

  return dirs;
}

/**
 * Determine the source URL for an extension.
 * For published extensions: npm CDN URL.
 * For local/unpublished extensions: file:// path.
 *
 * The NPM package name convention: @sox/extension-<id>
 */
function resolveSource(extDir: string, manifest: ExtensionManifest): string {
  // Check if there's an explicit source in the manifest
  // (checksum present in extension.json means it was published)
  const pkgPath = path.join(extDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
    const pkgName = pkg.name ?? `@sox/extension-${manifest.id}`;
    // Convention: if the package has been published, use cdn.jsdelivr.net
    // For local development, use file:// path
    // We use the manifest checksum presence as a signal of publication
    if (manifest.checksum) {
      return `https://cdn.jsdelivr.net/npm/${pkgName}@${manifest.version}/dist/index.js`;
    }
  }
  // Default: local file path
  return `file://${extDir}`;
}

/**
 * Compute checksum for the extension.
 * For a file:// source: checksum the content file (src/index.ts or prompt.md).
 * For a published extension: use the checksum already in the manifest.
 * For unpublished: compute from local content file.
 */
function resolveChecksum(extDir: string, manifest: ExtensionManifest): string {
  // If the manifest already has a checksum (set by CI on publish), use it
  if (manifest.checksum && /^sha256:[0-9a-f]{64}$/.test(manifest.checksum)) {
    return manifest.checksum;
  }

  // C4: checksum the declared entrypoint (the built artifact), not the TS source.
  // Resolution order mirrors fetchArtifact in install.ts — must stay in sync:
  //  1. manifest.entrypoint (explicit: dist/index.js, SKILL.md, org-agent.md, …)
  //  2. dist/index.js (built artifact fallback for code types)
  //  3. prompt.md (declarative prompt types)
  //  4. extension.json (final fallback)
  if (typeof manifest.entrypoint === 'string' && manifest.entrypoint.trim() !== '') {
    const declared = path.join(extDir, manifest.entrypoint);
    if (fs.existsSync(declared)) return computeFileChecksum(declared);
  }

  const distJs = path.join(extDir, 'dist', 'index.js');
  if (fs.existsSync(distJs)) return computeFileChecksum(distJs);

  const promptMd = path.join(extDir, 'prompt.md');
  if (fs.existsSync(promptMd)) return computeFileChecksum(promptMd);

  // Fallback: checksum the extension.json itself
  return computeFileChecksum(path.join(extDir, 'extension.json'));
}

export function buildIndex(opts: { root: string }): IndexEntry[] {
  const { root } = opts;
  const dirs = findExtensionDirs(root);
  const entries: IndexEntry[] = [];

  for (const extDir of dirs) {
    const manifestPath = path.join(extDir, 'extension.json');

    let manifest: ExtensionManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
    } catch (e) {
      console.error(`build-index: ERROR parsing ${manifestPath}: ${String(e)}`);
      process.exit(1);
    }

    // Validate required fields
    const requiredFields = ['id', 'type', 'version', 'title', 'description', 'compatibility'];
    for (const field of requiredFields) {
      if (!(field in manifest)) {
        console.error(
          `build-index: ERROR ${manifestPath} missing required field "${field}" — aborting`,
        );
        process.exit(1);
      }
    }

    // Skip private extensions
    if (manifest.private === true) {
      console.log(`build-index: skipping private extension "${manifest.id}" at ${extDir}`);
      continue;
    }

    const source = resolveSource(extDir, manifest);
    const checksum = resolveChecksum(extDir, manifest);

    const entry: IndexEntry = {
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
      entry.requires = manifest.requires;
    }

    // G-B: include members for bundle type so the install client can expand without re-reading disk
    if (manifest.type === 'bundle' && Array.isArray(manifest.members) && manifest.members.length > 0) {
      entry.members = manifest.members;
    }

    entries.push(entry);
  }

  // Write registry/index.json
  const registryDir = path.join(root, 'registry');
  if (!fs.existsSync(registryDir)) {
    fs.mkdirSync(registryDir, { recursive: true });
  }
  const indexPath = path.join(registryDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  console.log(`build-index: wrote ${entries.length} entries to ${indexPath}`);
  return entries;
}

// Utility: compute sha256 from fetched URL (for P4 npm CDN artifacts)
export async function checksumUrl(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return computeBytesChecksum(buf);
}

// CLI entry point
const root = process.argv[2] ?? process.cwd();
buildIndex({ root });
