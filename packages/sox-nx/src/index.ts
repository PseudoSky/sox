/**
 * @adhd/sox-nx — nx plugin package providing generators + executors for soxe
 * extensions and libs.
 *
 * Generators:
 *   extension  — scaffolds any of the 6 active extension types (delegates to libs/authoring)
 *   library    — thin wrapper over @nx/js:lib with type:lib tag
 *
 * Executors (registered via ./executors.json, see package.json "executors"):
 *   atomic-tsc — BL-235/BL-242: non-destructive drop-in replacement for @nx/js:tsc
 *
 * [inv:nx-free-core] — libs/authoring core has zero @nx/devkit imports.
 * This package is the ONLY place @nx/devkit is imported.
 */

export { applyFileSet, extensionGenerator } from './generators/extension/index.js';
export type { ExtensionGeneratorSchema } from './generators/extension/index.js';
export { libraryGenerator } from './generators/library/index.js';
export type { LibraryGeneratorSchema } from './generators/library/index.js';
export { default as atomicTscExecutor } from './executors/atomic-tsc/executor.js';
export type { AtomicTscExecutorSchema } from './executors/atomic-tsc/executor.js';

