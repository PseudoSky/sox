/**
 * bl-114f1dc4 — measureWork() (fastembedProcessHost.ts) captures
 * process.resourceUsage() majorPageFault/minorPageFault DELTAS across the
 * timed window and returns them as host_majflt/host_minflt, alongside
 * work_ms/cpu_ms. Pre-fix, only work_ms/cpu_ms were captured, so a genuine
 * page-in wait under CoreML (which never shows up in cpuUsage()) was
 * indistinguishable from ANE/GPU compute time.
 *
 * Unit-tests the exported `measureWork()` directly against a mocked
 * process.resourceUsage(), rather than forking the real host process
 * (avoids a real model load / minutes-long fork harness for this specific
 * telemetry-shape regression).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { measureWork } from './fastembedProcessHost.js';

describe('bl-114f1dc4 — measureWork() reports host_majflt/host_minflt deltas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computes majflt/minflt as the delta between start and end resourceUsage() snapshots', async () => {
    let call = 0;
    const usages = [
      { majorPageFault: 100, minorPageFault: 5000 }, // start snapshot
      { majorPageFault: 107, minorPageFault: 5050 }, // end snapshot
    ];
    vi.spyOn(process, 'resourceUsage').mockImplementation(() => {
      const u = usages[call] ?? usages[usages.length - 1];
      call++;
      return u as unknown as ReturnType<typeof process.resourceUsage>;
    });

    const { result, work_ms, cpu_ms, host_majflt, host_minflt } = await measureWork(async () => {
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(typeof work_ms).toBe('number');
    expect(typeof cpu_ms).toBe('number');
    expect(host_majflt).toBe(7);
    expect(host_minflt).toBe(50);
  });

  it('omits host_majflt/host_minflt (not a crash) when process.resourceUsage is unavailable', async () => {
    const original = process.resourceUsage;
    // @ts-expect-error — simulate a platform without resourceUsage() support
    delete (process as Record<string, unknown>)['resourceUsage'];
    try {
      const { result, host_majflt, host_minflt } = await measureWork(async () => 'ok2');
      expect(result).toBe('ok2');
      expect(host_majflt).toBeUndefined();
      expect(host_minflt).toBeUndefined();
    } finally {
      process.resourceUsage = original;
    }
  });

  it('still attaches majflt/minflt snapshot fields on a REJECTED fn (attributable failure)', async () => {
    let call = 0;
    const usages = [
      { majorPageFault: 10, minorPageFault: 10 },
      { majorPageFault: 12, minorPageFault: 15 },
    ];
    vi.spyOn(process, 'resourceUsage').mockImplementation(() => {
      const u = usages[call] ?? usages[usages.length - 1];
      call++;
      return u as unknown as ReturnType<typeof process.resourceUsage>;
    });

    await expect(
      measureWork(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
