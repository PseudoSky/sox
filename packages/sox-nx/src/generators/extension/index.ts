/**
 * @sox/nx extension generator — thin adapter over libs/authoring scaffold().
 *
 * Maps scaffold(opts) → nx Tree by writing each FileSet entry.
 * This is the only place @nx/devkit is imported — libs/authoring has zero devkit.
 *
 * [inv:nx-free-core] compliance: ALL scaffolding logic lives in libs/authoring.
 * This generator is a thin shim: call scaffold(), iterate FileSet, write to Tree.
 *
 * [ref:scaffold-parity] anchor lives in extension.spec.ts in this directory.
 */

import type { Tree } from '@nx/devkit';
import { generateFiles, joinPathFragments } from '@nx/devkit';
import { scaffold } from '@sox/authoring';
import type { ScaffoldOpts, ActiveType, FileSet } from '@sox/authoring';
import * as path from 'node:path';

export interface ExtensionGeneratorSchema {
  type: ActiveType;
  id: string;
  title?: string;
  description?: string;
  author?: string;
  keywords?: string;
  /** Output directory within the workspace. Defaults to extensions/<type-dir>/<id> */
  directory?: string;
}

const DIR_MAP: Record<ActiveType, string> = {
  agent: 'agents',
  skill: 'skills',
  'mcp-server': 'mcp-servers',
  hook: 'hooks',
  command: 'commands',
  bundle: 'bundles',
  service: 'services',
};

/**
 * Apply a FileSet to an nx Tree at the given root path.
 * Each FileSet key is a relative path; content is written verbatim.
 */
export function applyFileSet(tree: Tree, fileSet: FileSet, rootPath: string): void {
  for (const [relPath, content] of Object.entries(fileSet)) {
    const fullPath = joinPathFragments(rootPath, relPath);
    tree.write(fullPath, content);
  }
}

/**
 * extensionGenerator — the @sox/nx:extension nx generator.
 *
 * Calls scaffold() from libs/authoring and applies the resulting FileSet to the Tree.
 * The parity test ([ref:scaffold-parity]) confirms this produces byte-identical output
 * to the sox init path.
 */
export async function extensionGenerator(
  tree: Tree,
  schema: ExtensionGeneratorSchema,
): Promise<void> {
  const opts: ScaffoldOpts = {
    type: schema.type,
    id: schema.id,
    ...(schema.title !== undefined ? { title: schema.title } : {}),
    ...(schema.description !== undefined ? { description: schema.description } : {}),
    ...(schema.author !== undefined ? { author: schema.author } : {}),
    ...(schema.keywords !== undefined
      ? { keywords: schema.keywords.split(',').map((k) => k.trim()).filter(Boolean) }
      : {}),
  };

  const fileSet = scaffold(opts);

  const outDir =
    schema.directory ?? path.join('extensions', DIR_MAP[schema.type], schema.id);

  applyFileSet(tree, fileSet, outDir);
}

export default extensionGenerator;

// Re-export generateFiles for use in test utilities (avoids importing devkit directly in tests)
void generateFiles; // side-effect: ensures the import is not dead-code-eliminated
