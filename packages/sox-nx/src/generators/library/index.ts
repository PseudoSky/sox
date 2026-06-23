/**
 * @adhd/sox-nx library generator — thin wrapper around @nx/js:lib.
 *
 * Wraps the @nx/js:lib generator with sox-specific defaults (type:lib tag, etc.)
 * This is intentionally minimal — it delegates to the upstream generator.
 *
 * [inv:nx-free-core] — this file CAN import @nx/devkit (it IS the adapter layer).
 * Only libs/authoring/src/** must stay devkit-free.
 */

import type { Tree } from '@nx/devkit';
import { libraryGenerator as nxLibraryGenerator } from '@nx/js';

export interface LibraryGeneratorSchema {
  name: string;
  directory?: string;
  tags?: string;
  publishable?: boolean;
  buildable?: boolean;
  unitTestRunner?: 'vitest' | 'jest' | 'none';
}

/**
 * libraryGenerator — thin wrapper around @nx/js:lib with sox defaults.
 *
 * Always adds type:lib to tags so module-boundary enforcement works.
 */
export async function libraryGenerator(
  tree: Tree,
  schema: LibraryGeneratorSchema,
): Promise<void> {
  const tags = [schema.tags, 'type:lib'].filter(Boolean).join(',');

  await nxLibraryGenerator(tree, {
    name: schema.name,
    directory: schema.directory ?? `libs/${schema.name}`,
    tags,
    publishable: schema.publishable ?? false,
    buildable: schema.buildable ?? true,
    unitTestRunner: schema.unitTestRunner ?? 'vitest',
  });
}

export default libraryGenerator;
