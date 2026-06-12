import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const PKG_ROOT = resolve(__dirname);
const ROOT = resolve(__dirname, '../..');

export default defineConfig({
  test: {
    root: PKG_ROOT,
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@sox/authoring': resolve(ROOT, 'libs/authoring/dist/index.js'),
    },
  },
});
