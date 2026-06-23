import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const workspaceRoot = resolve(__dirname, '../..');

export default defineConfig({
  test: {
    include: ['libs/install-engine/src/**/*.spec.ts', 'libs/install-engine/src/**/*.test.ts'],
    environment: 'node',
    root: workspaceRoot,
    // BL-35: sandbox $SOX_ECOSYSTEM_HOME so specs that drive install()/upsertInstallRecord
    // never write the developer's real ~/.adhd/sox-ecosystem install-registry/ledger/ownership.
    setupFiles: [resolve(__dirname, 'vitest.setup.ts')],
  },
});
