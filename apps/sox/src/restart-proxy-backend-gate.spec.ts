import { describe, it, expect, vi } from 'vitest';
import { getOsUnitPlatform } from '@adhd/sox-host-runtime';
import {
  determineShimIsUnit,
  reEnableAfterRestartGate,
} from './restart-proxy-backend-gate.js';

describe('determineShimIsUnit', () => {
  it('calls unloadOsUnitUnlessFrontShim once with the derived platform/label/unload thunk', () => {
    const unload = () => 'unloaded';
    const unloadOsUnitUnlessFrontShim = vi.fn().mockReturnValue({ shimIsUnit: false });
    const log = vi.fn();
    const platform = getOsUnitPlatform('launchd');

    const result = determineShimIsUnit({
      extId: 'ext-a',
      platform,
      label: 'label-a',
      log,
      unload,
      deps: { unloadOsUnitUnlessFrontShim },
    });

    expect(result).toEqual({ shimIsUnit: false });
    expect(unloadOsUnitUnlessFrontShim).toHaveBeenCalledTimes(1);
    const call = unloadOsUnitUnlessFrontShim.mock.calls[0]![0];
    expect(call.extId).toBe('ext-a');
    expect(call.platform).toBe(platform);
    expect(call.label).toBe('label-a');
    expect(call.unload).toBe(unload);
    // log is wrapped with the extId suffix, not passed through raw.
    call.log('msg');
    expect(log).toHaveBeenCalledWith('msg (ext-a)');
  });

  it('propagates shimIsUnit: true from the underlying predicate', () => {
    const unloadOsUnitUnlessFrontShim = vi.fn().mockReturnValue({ shimIsUnit: true });
    const result = determineShimIsUnit({
      extId: 'ext-b',
      platform: getOsUnitPlatform('systemd'),
      label: 'label-b',
      log: vi.fn(),
      unload: () => undefined,
      deps: { unloadOsUnitUnlessFrontShim },
    });
    expect(result.shimIsUnit).toBe(true);
  });
});

describe('reEnableAfterRestartGate (BUG-023 guard)', () => {
  it('calls reEnableOwnedOsUnit exactly once when shimIsUnit is false', () => {
    const reEnableOwnedOsUnit = vi.fn().mockReturnValue({ owned: true, verifiedLoaded: true, label: 'l' });
    const log = vi.fn();

    const result = reEnableAfterRestartGate(false, 'ext-c', 'user', '/root', log, {
      reEnableOwnedOsUnit,
    });

    expect(reEnableOwnedOsUnit).toHaveBeenCalledTimes(1);
    expect(reEnableOwnedOsUnit).toHaveBeenCalledWith('ext-c', 'user', '/root', log);
    expect(result).toEqual({ owned: true, verifiedLoaded: true, label: 'l' });
  });

  it('does NOT call reEnableOwnedOsUnit when shimIsUnit is true (nothing was unloaded)', () => {
    const reEnableOwnedOsUnit = vi.fn();

    const result = reEnableAfterRestartGate(true, 'ext-d', 'user', '/root', vi.fn(), {
      reEnableOwnedOsUnit,
    });

    expect(reEnableOwnedOsUnit).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
