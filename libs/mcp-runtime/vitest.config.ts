import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = resolve(__dirname, '../..');
const sdkCjs = resolve(__dirname, 'node_modules/@modelcontextprotocol/sdk/dist/cjs');

export default defineConfig({
  resolve: {
    alias: {
      '@adhd/sox-host-runtime': resolve(root, 'libs/host-runtime/dist/index.js'),
      '@adhd/sox-service-proxy': resolve(root, 'libs/service-proxy/dist/index.js'),
      '@modelcontextprotocol/sdk/server/index.js': resolve(sdkCjs, 'server/index.js'),
      '@modelcontextprotocol/sdk/server/stdio.js': resolve(sdkCjs, 'server/stdio.js'),
      '@modelcontextprotocol/sdk/server/sse.js': resolve(sdkCjs, 'server/sse.js'),
      '@modelcontextprotocol/sdk/client/index.js': resolve(sdkCjs, 'client/index.js'),
      '@modelcontextprotocol/sdk/inMemory.js': resolve(sdkCjs, 'inMemory.js'),
      '@modelcontextprotocol/sdk/types.js': resolve(sdkCjs, 'types.js'),
    },
  },
  test: {
    include: [resolve(__dirname, 'src/**/*.spec.ts'), resolve(__dirname, 'src/**/*.test.ts')],
    globals: false,
    environment: 'node',
    passWithNoTests: true,
    testTimeout: 15000,
  },
});
