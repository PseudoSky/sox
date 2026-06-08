#!/usr/bin/env node
/**
 * validate-manifests.ts — enforce identity, type/dir, and format invariants
 *
 * P0 scope (id-format + type/dir checks only; dedup + secret lint added in P2):
 *   1. id must match ^[a-z][a-z0-9-]*$
 *   2. id must NOT end with its type name (e.g. id="my-skill" when type="skill" is banned)
 *   3. type must equal the singular of the parent directory
 *      (agents/ → agent, mcp-servers/ → mcp-server, etc.)
 *   4. version in extension.json must equal version in package.json
 *
 * Contract (Section 4.5): reads extension.json under extensions/; exits 0/1 + diagnostics.
 * Side effects: none — read-only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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
  order?: number;
  [key: string]: unknown;
}

interface PackageJson {
  name: string;
  version: string;
  [key: string]: unknown;
}

interface Diagnostic {
  path: string;
  message: string;
}

const DIR_TO_TYPE: Record<string, string> = {
  agents: 'agent',
  skills: 'skill',
  'mcp-servers': 'mcp-server',
  prompts: 'prompt',
  hooks: 'hook',
  commands: 'command',
};

const VALID_TYPES = new Set(['agent', 'skill', 'mcp-server', 'prompt', 'hook', 'command']);
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

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

function validateManifest(extDir: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const manifestPath = path.join(extDir, 'extension.json');
  const packagePath = path.join(extDir, 'package.json');

  // Parse extension.json
  let manifest: ExtensionManifest;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(raw) as ExtensionManifest;
  } catch (e) {
    diags.push({ path: manifestPath, message: `Failed to parse extension.json: ${String(e)}` });
    return diags;
  }

  const { id, type, version } = manifest;

  // Check 1: id format
  if (!ID_PATTERN.test(id)) {
    diags.push({
      path: manifestPath,
      message: `id "${id}" must match ^[a-z][a-z0-9-]*$ (got "${id}")`,
    });
  }

  // Check 2: id must not end with type name
  if (id.endsWith(`-${type}`) || id === type) {
    diags.push({
      path: manifestPath,
      message: `id "${id}" must not end with its type name "${type}"`,
    });
  }

  // Check 3: type must be valid
  if (!VALID_TYPES.has(type)) {
    diags.push({
      path: manifestPath,
      message: `type "${type}" is not in the closed enum [${Array.from(VALID_TYPES).join(', ')}]`,
    });
  }

  // Check 4: type/dir match — type must equal singular of parent directory
  const typeDir = path.basename(path.dirname(extDir));
  const expectedType = DIR_TO_TYPE[typeDir];
  if (expectedType === undefined) {
    diags.push({
      path: manifestPath,
      message: `Unknown type directory "${typeDir}" — must be one of: ${Object.keys(DIR_TO_TYPE).join(', ')}`,
    });
  } else if (type !== expectedType) {
    diags.push({
      path: manifestPath,
      message: `type "${type}" does not match parent directory "${typeDir}" (expected "${expectedType}")`,
    });
  }

  // Check 5: version sync — extension.json.version must equal package.json.version
  if (fs.existsSync(packagePath)) {
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as PackageJson;
      if (pkg.version !== version) {
        diags.push({
          path: manifestPath,
          message: `version mismatch: extension.json="${version}" vs package.json="${pkg.version}"`,
        });
      }
    } catch (e) {
      diags.push({ path: packagePath, message: `Failed to parse package.json: ${String(e)}` });
    }
  } else {
    diags.push({ path: packagePath, message: 'package.json not found' });
  }

  return diags;
}

function validateManifests(root: string): { ok: boolean; errors: Diagnostic[] } {
  const extDirs = findExtensionDirs(root);
  const allErrors: Diagnostic[] = [];

  if (extDirs.length === 0) {
    console.log('No extensions found — nothing to validate.');
    return { ok: true, errors: [] };
  }

  for (const extDir of extDirs) {
    const diags = validateManifest(extDir);
    allErrors.push(...diags);
  }

  return { ok: allErrors.length === 0, errors: allErrors };
}

// CLI entry point
const root = process.argv[2] ?? process.cwd();
const result = validateManifests(root);

if (result.errors.length > 0) {
  console.error('validate-manifests: FAILED');
  for (const err of result.errors) {
    console.error(`  [ERROR] ${err.path}: ${err.message}`);
  }
  process.exit(1);
} else {
  const extCount = findExtensionDirs(root).length;
  console.log(`validate-manifests: OK (${extCount} extension(s) validated)`);
  process.exit(0);
}
