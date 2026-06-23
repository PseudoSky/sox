import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const workspaceRoot = resolve(__dirname, '../..');

export default defineConfig({
  test: {
    include: ['libs/install-engine/src/**/*.spec.ts', 'libs/install-engine/src/**/*.test.ts'],
    environment: 'node',
    root: workspaceRoot,
  },
});
