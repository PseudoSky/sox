/**
 * bl-a49ca837-restart-proxy-backend-front-shim.spec.ts — BL a49ca837
 * (redeploy severs sessions).
 *
 * `restartProxyBackend` (apps/sox/src/main.ts) must not unload the extension's
 * os-unit when that unit IS the port-listening front-shim — the unit runs
 * `soxe serve <id> --port <port>` and does not supervise the detached backend
 * process this function restarts; unloading it is pointless churn that races
 * the shim's own session-serving process.
 *
 * `main.ts` exports nothing and every collaborator
 * (`unloadOwnedOsUnitsBeforeReap`, `mcpServerIsProxyMode`, ...) is file-local,
 * so this drives the extracted seam `unloadOsUnitUnlessFrontShim`
 * (./proxy-backend-front-shim.ts) that `restartProxyBackend` now calls —
 * see that module's docblock for why the extraction exists. This does not
 * exercise `restartProxyBackend`'s call site end-to-end (main.ts isn't
 * importable for mocking); it pins the gate the call site delegates to.
 */
import { describe, expect, it } from 'vitest';

import { unloadOsUnitUnlessFrontShim } from './proxy-backend-front-shim.js';

describe('unloadOsUnitUnlessFrontShim — BL a49ca837', () => {
  it('a49ca837: restartProxyBackend does not unload the os-unit when it is the front shim', () => {
    let unloadCalls = 0;
    const result = unloadOsUnitUnlessFrontShim({
      configEnv: { SOX_CONFIG_PORT: '4300' },
      proxyMode: true,
      unload: () => {
        unloadCalls += 1;
      },
    });

    expect(result.shimIsUnit).toBe(true);
    expect(unloadCalls).toBe(0);
  });

  it('control: unloads the os-unit when it is NOT the front shim (no port)', () => {
    let unloadCalls = 0;
    const result = unloadOsUnitUnlessFrontShim({
      configEnv: {},
      proxyMode: true,
      unload: () => {
        unloadCalls += 1;
      },
    });

    expect(result.shimIsUnit).toBe(false);
    expect(unloadCalls).toBe(1);
  });

  it('control: unloads the os-unit when a port is set but the manifest is not proxy-mode', () => {
    let unloadCalls = 0;
    const result = unloadOsUnitUnlessFrontShim({
      configEnv: { SOX_CONFIG_PORT: '4300' },
      proxyMode: false,
      unload: () => {
        unloadCalls += 1;
      },
    });

    expect(result.shimIsUnit).toBe(false);
    expect(unloadCalls).toBe(1);
  });
});
