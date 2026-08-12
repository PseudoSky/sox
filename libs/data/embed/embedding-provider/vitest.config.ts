import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// BUG-006: the root must be ABSOLUTE and cwd-independent. The previous
// relative root ('libs/data/embed/embedding-provider') resolved against
// process.cwd(), so running vitest from INSIDE this package directory
// double-prefixed the path and found zero tests (nx, which runs with cwd at
// the repo root, happened to work). `resolve(__dirname)` mirrors the
// packages/sox-nx pattern.
const PKG_ROOT = resolve(__dirname);

export default defineConfig({
  test: {
    root: PKG_ROOT,
    include: ['src/**/*.{spec,test}.ts'],
  },
});
