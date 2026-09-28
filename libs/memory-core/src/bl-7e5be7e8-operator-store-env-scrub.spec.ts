/**
 * BL-7e5be7e8 — memory-core's vitest.setup.ts must scrub the operator's
 * host-injected store config before any spec loads.
 *
 * memory-core has no signal handler of its own, but `createStoreAdapter()`
 * (store-adapter factory.ts) falls back to `SOX_CONFIG_DB_PATH` when called
 * without a `dbPath`, and every spec that spawns a child with
 * `{ ...process.env }` forwards whatever the worker inherited. Run the suite
 * with `SOX_CONFIG_DB_PATH=<scratch decoy>` exported to exercise this for real:
 * without the setup call this spec fails, with it the key is gone.
 */
import { describe, it, expect } from 'vitest';
import { isOperatorStoreEnvKey } from './test-env-scrub.js';

describe('BL-7e5be7e8: memory-core test workers carry no operator store config', () => {
  it('[BL-7e5be7e8 wiring] vitest.setup.ts left no SOX_CONFIG_* / SOX_PROXY_BACKEND* / SOX_AUTO_BACKUP_DIR key', () => {
    const leaked = Object.keys(process.env).filter(isOperatorStoreEnvKey);
    expect(leaked).toEqual([]);
  });
});
