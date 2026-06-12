/**
 * libs/install-engine/src/build-index.ts — Registry index builder (lib version)
 *
 * Ported from scripts/build-index.ts. Logic unchanged.
 * No CLI entry point here — that lives in apps/sox.
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
  members?: Array<{ id: string; version: string }>;
}

export interface IndexEntry {
  id: string;
  type: string;
  version: string;
  title: string;
  description: string;
  source: string;
  checksum: string;
  compatibility: { host: string };
  requires?: ExtensionManifest['requires'];
  members?: ExtensionManifest['members'];
}

const DIR_TO_TYPE: Record<string, string> = {
  agents: 'agent',
  skills: 'skill',
  'mcp-servers': 'mcp-server',
  prompts: 'prompt',
  hooks: 'hook',
  commands: 'command',
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
  const extensionsRoot = path.join(root, 'extensions');
  if (!fs.existsSync(extensionsRoot)) return [];

  const dirs: string[] = [];
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
  return dirs;
}

function resolveSource(extDir: string, manifest: ExtensionManifest): string {
  const pkgPath = path.join(extDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
    const pkgName = pkg.name ?? `@sox/extension-${manifest.id}`;
    if (manifest.checksum) {
      return `https://cdn.jsdelivr.net/npm/${pkgName}@${manifest.version}/dist/index.js`;
    }
  }
  return `file://${extDir}`;
}

function resolveChecksum(extDir: string, manifest: ExtensionManifest): string {
  if (manifest.checksum && /^sha256:[0-9a-f]{64}$/.test(manifest.checksum)) {
    return manifest.checksum;
  }

  const contentFile =
    manifest.type === 'prompt'
      ? path.join(extDir, 'prompt.md')
      : path.join(extDir, 'src', 'index.ts');

  if (fs.existsSync(contentFile)) {
    return computeFileChecksum(contentFile);
  }

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

    const requiredFields = ['id', 'type', 'version', 'title', 'description', 'compatibility'];
    for (const field of requiredFields) {
      if (!(field in manifest)) {
        console.error(
          `build-index: ERROR ${manifestPath} missing required field "${field}" — aborting`,
        );
        process.exit(1);
      }
    }

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

    if (manifest.type === 'bundle' && Array.isArray(manifest.members) && manifest.members.length > 0) {
      entry.members = manifest.members;
    }

    entries.push(entry);
  }

  const registryDir = path.join(root, 'registry');
  if (!fs.existsSync(registryDir)) {
    fs.mkdirSync(registryDir, { recursive: true });
  }
  const indexPath = path.join(registryDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  console.log(`build-index: wrote ${entries.length} entries to ${indexPath}`);
  return entries;
}

export async function checksumUrl(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return computeBytesChecksum(buf);
}
