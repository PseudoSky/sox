/**
 * @adhd/sox-nx — nx plugin package providing generators for sox extensions and libs.
 *
 * Generators:
 *   extension  — scaffolds any of the 6 active extension types (delegates to libs/authoring)
 *   library    — thin wrapper over @nx/js:lib with type:lib tag
 *
 * [inv:nx-free-core] — libs/authoring core has zero @nx/devkit imports.
 * This package is the ONLY place @nx/devkit is imported.
 */

export { applyFileSet, extensionGenerator } from './generators/extension/index.js';
export type { ExtensionGeneratorSchema } from './generators/extension/index.js';
export { libraryGenerator } from './generators/library/index.js';
export type { LibraryGeneratorSchema } from './generators/library/index.js';

