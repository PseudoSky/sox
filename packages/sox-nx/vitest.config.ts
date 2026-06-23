import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

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
      '@adhd/sox-authoring': resolve(ROOT, 'libs/authoring/dist/index.js'),
    },
  },
});
