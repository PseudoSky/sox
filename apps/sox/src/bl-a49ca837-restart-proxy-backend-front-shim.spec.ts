/**
 * bl-a49ca837-restart-proxy-backend-front-shim.spec.ts — BL a49ca837
 * (redeploy severs sessions).
 *
 * Pins `unloadOsUnitUnlessFrontShim` (./proxy-backend-front-shim.ts), the
 * extracted `shimIsUnit` gate `restartProxyBackend` (apps/sox/src/main.ts)
 * delegates to before verified-stopping a proxy backend. `shimIsUnit` must
 * reflect what the ON-DISK unit actually runs (`serve <id> --port <port>`
 * vs the bare backend entrypoint), never re-derived from current config —
 * see that module's docblock.
 *
 * SCOPE NOTE (does not claim call-site coverage): `main.ts` exports nothing
 * and every collaborator (`unloadOwnedOsUnitsBeforeReap`, `getOsUnitPlatform`,
 * ...) is file-local, so `restartProxyBackend`'s actual call into this
 * function — including that it passes the real platform/label and gates the
 * matching re-enable step on the same `shimIsUnit` value (main.ts's
 * `restartProxyBackend` re-enable gate) — is NOT exercised here. This suite
 * only pins the predicate module's own contract: given a unit-text reader,
 * does it compute `shimIsUnit` correctly and call `unload()` exactly when
 * expected.
 */
import { describe, expect, it } from 'vitest';

import { unloadOsUnitUnlessFrontShim } from './proxy-backend-front-shim.js';

const launchdPlatform = {
  kind: 'launchd' as const,
  defaultUnitDir: () => '/fake/LaunchAgents',
  unitFileName: (label: string) => `${label}.plist`,
} as Parameters<typeof unloadOsUnitUnlessFrontShim>[0]['platform'];

const systemdPlatform = {
  kind: 'systemd' as const,
  defaultUnitDir: () => '/fake/systemd/user',
  unitFileName: (label: string) => `sox-${label}.service`,
} as Parameters<typeof unloadOsUnitUnlessFrontShim>[0]['platform'];

const launchdShimText = `<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>--enable-source-maps</string>
    <string>/path/to/soxe</string>
    <string>serve</string>
    <string>memory-server</string>
    <string>--port</string>
    <string>4300</string>
  </array>
</dict></plist>`;

const launchdBareBackendText = `<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>--enable-source-maps</string>
    <string>/path/to/memory-server/dist/index.js</string>
  </array>
</dict></plist>`;

const systemdShimText = `[Service]\nExecStart=/usr/bin/node --enable-source-maps /path/to/soxe serve memory-server --port 4300\n`;

describe('unloadOsUnitUnlessFrontShim — BL a49ca837 (real on-disk argv, not config)', () => {
  it('does not unload when the on-disk unit argv is the front-shim (launchd)', () => {
    let unloadCalls = 0;
    const result = unloadOsUnitUnlessFrontShim({
      extId: 'memory-server',
      platform: launchdPlatform,
      label: 'com.sox.user.memory-server',
      readUnitText: () => launchdShimText,
      unload: () => {
        unloadCalls += 1;
      },
    });

    expect(result.shimIsUnit).toBe(true);
    expect(unloadCalls).toBe(0);
  });

  it('does not unload when the on-disk unit argv is the front-shim (systemd)', () => {
    let unloadCalls = 0;
    const result = unloadOsUnitUnlessFrontShim({
      extId: 'memory-server',
      platform: systemdPlatform,
      label: 'com.sox.user.memory-server',
      readUnitText: () => systemdShimText,
      unload: () => {
        unloadCalls += 1;
      },
    });

    expect(result.shimIsUnit).toBe(true);
    expect(unloadCalls).toBe(0);
  });

  it('unloads when the on-disk unit runs the bare backend entrypoint (BL-156 fallback case)', () => {
    let unloadCalls = 0;
    const result = unloadOsUnitUnlessFrontShim({
      extId: 'memory-server',
      platform: launchdPlatform,
      label: 'com.sox.user.memory-server',
      readUnitText: () => launchdBareBackendText,
      unload: () => {
        unloadCalls += 1;
      },
    });

    expect(result.shimIsUnit).toBe(false);
    expect(unloadCalls).toBe(1);
  });

  it('fail-safe: unloads when the unit file is unreadable (missing/EACCES) rather than assuming front-shim', () => {
    let unloadCalls = 0;
    const result = unloadOsUnitUnlessFrontShim({
      extId: 'memory-server',
      platform: launchdPlatform,
      label: 'com.sox.user.memory-server',
      readUnitText: () => {
        throw new Error('ENOENT: no such file');
      },
      unload: () => {
        unloadCalls += 1;
      },
    });

    expect(result.shimIsUnit).toBe(false);
    expect(unloadCalls).toBe(1);
  });

  it('fail-safe: unloads when the unit argv is unparseable (garbage content)', () => {
    let unloadCalls = 0;
    const result = unloadOsUnitUnlessFrontShim({
      extId: 'memory-server',
      platform: launchdPlatform,
      label: 'com.sox.user.memory-server',
      readUnitText: () => 'not a plist at all',
      unload: () => {
        unloadCalls += 1;
      },
    });

    expect(result.shimIsUnit).toBe(false);
    expect(unloadCalls).toBe(1);
  });

  it('does not false-positive on an unrelated extId that is a token-substring away from a match', () => {
    let unloadCalls = 0;
    const result = unloadOsUnitUnlessFrontShim({
      extId: 'memory-server-2',
      platform: launchdPlatform,
      label: 'com.sox.user.memory-server-2',
      readUnitText: () => launchdShimText, // serves 'memory-server', not 'memory-server-2'
      unload: () => {
        unloadCalls += 1;
      },
    });

    expect(result.shimIsUnit).toBe(false);
    expect(unloadCalls).toBe(1);
  });
});
