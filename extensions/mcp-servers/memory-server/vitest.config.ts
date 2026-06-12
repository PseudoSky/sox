import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: [
      'extensions/mcp-servers/memory-server/src/**/*.spec.ts',
      'extensions/mcp-servers/memory-server/src/**/*.test.ts',
      'extensions/mcp-servers/memory-server/*.test.ts',
    ],
    environment: 'node',
    root: resolve(__dirname, '../../..'),
  },
});
