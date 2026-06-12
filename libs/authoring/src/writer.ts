/**
 * writer.ts — filesystem helper for writing a FileSet to disk.
 *
 * Pure Node.js; zero nx-devkit imports. Used by:
 *   - sox init CLI (apps/sox or scripts/new-extension.ts wrapper)
 *   - tools/born-conformance.js gate
 *
 * [inv:nx-free-core] maintained — no nx-packages imports.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileSet } from './index.js';

/**
 * Write all entries in the FileSet to disk under outDir.
 * Parent directories are created automatically (recursive).
 * Existing files are overwritten.
 *
 * @param fileSet  - The FileSet returned by scaffold()
 * @param outDir   - Absolute or relative output directory
 */
export function writeFileSet(fileSet: FileSet, outDir: string): void {
  for (const [relPath, content] of Object.entries(fileSet)) {
    const absPath = path.resolve(outDir, relPath);
    const dir = path.dirname(absPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
  }
}
