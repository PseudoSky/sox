import { describe, expect, it } from 'vitest';

import {
  checkBackendOnlyProxyModeRefusal,
  checkBackendOnlyPortRefusal,
  evaluateBackendOnlyOutcome,
} from './backend-only-restart.js';

// `soxe service restart --backend-only` CLI contract (§9.4a/§9.5). These
// exercise the pure decision functions `cmdServiceRestart` calls before
// writing stdout/stderr and calling process.exit — previously untested
// (review item: main.ts:5560-5647 --backend-only branch has no tests).

describe('checkBackendOnlyProxyModeRefusal', () => {
  it('refuses when the extension is not served in proxy mode', () => {
    const outcome = checkBackendOnlyProxyModeRefusal({
      cli: 'soxe',
      extId: 'memory-server',
      isProxyMode: false,
    });
    expect(outcome?.exitCode).toBe(1);
    expect(outcome?.stderr).toContain('--backend-only refused');
    expect(outcome?.stderr).toContain('not served in proxy mode');
    expect(outcome?.stderr).toContain('§9.5');
  });

  it('does not refuse in proxy mode', () => {
    expect(
      checkBackendOnlyProxyModeRefusal({ cli: 'soxe', extId: 'memory-server', isProxyMode: true }),
    ).toBeUndefined();
  });
});

describe('checkBackendOnlyPortRefusal', () => {
  it('refuses when proxy mode has no SOX_CONFIG_PORT (BL-156)', () => {
    const outcome = checkBackendOnlyPortRefusal({
      cli: 'soxe',
      extId: 'memory-server',
      scope: 'user',
      portConfigured: false,
    });
    expect(outcome?.exitCode).toBe(1);
    expect(outcome?.stderr).toContain('no SOX_CONFIG_PORT');
    expect(outcome?.stderr).toContain('BL-156');
    expect(outcome?.stderr).toContain('soxe service enable memory-server --scope user');
  });

  it('does not refuse when a port is configured', () => {
    expect(
      checkBackendOnlyPortRefusal({ cli: 'soxe', extId: 'memory-server', scope: 'user', portConfigured: true }),
    ).toBeUndefined();
  });
});

describe('evaluateBackendOnlyOutcome', () => {
  const baseResult = { ok: true, before: [200], after: [300] };

  it('fails when the shim pid rotated (must never change under --backend-only)', () => {
    const outcome = evaluateBackendOnlyOutcome({
      cli: 'soxe',
      label: 'sox.memory-server',
      beforeMainPid: 111,
      afterMainPid: 222,
      result: baseResult,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain('rotated the shim pid');
    expect(outcome.stderr).toContain('111 -> 222');
  });

  it('fails when result.ok is false, surfacing result.reason', () => {
    const outcome = evaluateBackendOnlyOutcome({
      cli: 'soxe',
      label: 'sox.memory-server',
      beforeMainPid: 111,
      afterMainPid: 111,
      result: { ok: false, reason: 'no pid rotated before deadline', before: [200], after: [200] },
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain('no pid rotated before deadline');
  });

  it('falls back to a generic reason when result.reason is absent', () => {
    const outcome = evaluateBackendOnlyOutcome({
      cli: 'soxe',
      label: 'sox.memory-server',
      beforeMainPid: 111,
      afterMainPid: 111,
      result: { ok: false, before: [200], after: [200] },
    });
    expect(outcome.stderr).toContain('backend deploy could not be verified');
  });

  it('succeeds and reports the rotated pid(s) when the shim pid is stable and result.ok', () => {
    const outcome = evaluateBackendOnlyOutcome({
      cli: 'soxe',
      label: 'sox.memory-server',
      beforeMainPid: 111,
      afterMainPid: 111,
      result: baseResult,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('backend-only deploy');
    expect(outcome.stdout).toContain('[200] -> [300]');
  });

  it('treats undefined mainPids as equal (never-configured case), not a rotation', () => {
    const outcome = evaluateBackendOnlyOutcome({
      cli: 'soxe',
      label: 'sox.memory-server',
      beforeMainPid: undefined,
      afterMainPid: undefined,
      result: baseResult,
    });
    expect(outcome.exitCode).toBe(0);
  });
});

describe('dc6261c1: evaluateBackendOnlyOutcome — a rotation onto the stale entrypoint is never "deployed"', () => {
  it('exits non-zero naming the running and the lockfile-resolved artifact, and points at a full restart', () => {
    const running = '/dev/checkout/extensions/bundles/sox-memory-bundle/members/memory-server/dist/index.js';
    const resolved = '/home/.adhd/sox-ecosystem/ext/memory-server/node_modules/@adhd/sox-extension-memory-server/dist/index.js';
    const outcome = evaluateBackendOnlyOutcome({
      cli: 'soxe',
      label: 'com.sox.user.memory-server',
      beforeMainPid: 14742,
      afterMainPid: 14742,
      result: {
        ok: false,
        reason: 'rotated on divergent entrypoint',
        before: [60640],
        after: [70000],
        rotatedOnDivergentEntrypoint: { pids: [70000], running: [running], resolved },
      },
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBeUndefined();
    expect(outcome.stderr).toContain('NOT DEPLOYED');
    expect(outcome.stderr).toContain(running);
    expect(outcome.stderr).toContain(resolved);
    expect(outcome.stderr).toContain('without --backend-only');
    expect(outcome.stderr).not.toContain('backend-only deploy');
  });
});
