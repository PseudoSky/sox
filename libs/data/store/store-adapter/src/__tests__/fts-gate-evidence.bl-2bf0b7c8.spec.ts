/**
 * BL-2bf0b7c8 — the FTS leak gate's observability gap: when the upgrade-gate
 * test (fts-optimize-leak-gate.bl-c5249cdd.spec.ts) asserts the leak fact and
 * the version-pin fact as two SEPARATE `expect`s, vitest throws on the FIRST
 * failure. If the leak fact passes but the version-pin fact fails (the exact
 * shape of a driver bump that fixed the leak), the interleaved/single
 * page_counts never reach the reported message — the operator sees "driver
 * moved" but no numbers, which is precisely what they need to decide whether to
 * retire the pass alarm or bump `FTS_OPTIMIZE_LEAK_MEASURED_ON`.
 *
 * The fix is a SINGLE combined-object assertion. This spec proves, without a
 * 600 s leak run, that the combined-object assertion emits BOTH page counts in
 * the thrown message on the A-passes/B-fails path (leak reproduces, driver
 * moved). It mirrors the exact construction TEST 1 uses so the two cannot
 * drift.
 */
import { describe, expect, it } from 'vitest';
import { FTS_OPTIMIZE_LEAK_MEASURED_ON } from '../store-rebuild.js';

/** The combined-object shape TEST 1 asserts against (kept byte-identical). */
interface LeakGateVerdict {
  leak_reproduces: boolean;
  installed_matches: boolean;
  interleaved_pages: number;
  single_pages: number;
}

/** Build the combined object + message exactly as TEST 1 does. */
function buildLeakGateVerdict(
  interleaved: number,
  single: number,
  installed: string,
  measuredOn: string,
): { actual: LeakGateVerdict; expected: LeakGateVerdict; message: string } {
  const message =
    `BL-c5249cdd / BL-2bf0b7c8: interleaved=${interleaved} single=${single} installed=${installed} ` +
    `measured_on=${measuredOn}. The interleaved page_count must exceed 110% of the single-optimize ` +
    `control (the FTS segment leak), and the installed driver must still be the version these facts ` +
    `were measured on. If the leak no longer reproduces, retire the pass alarm / re-evaluate memory ` +
    `fts-rebuild; if the driver moved, re-run this gate's measurement on the new version and (leak ` +
    `gone) retire the pass alarm or (leak persists) bump FTS_OPTIMIZE_LEAK_MEASURED_ON. Do not widen ` +
    `this comparison.`;
  return {
    actual: {
      leak_reproduces: interleaved > single * 1.1,
      installed_matches: installed === measuredOn,
      interleaved_pages: interleaved,
      single_pages: single,
    },
    expected: {
      leak_reproduces: true,
      installed_matches: true,
      interleaved_pages: interleaved,
      single_pages: single,
    },
    message,
  };
}

/** Capture the assertion error message by running `expect(...).toEqual(...)` on synthetic values. */
function captureAssertionMessage(v: ReturnType<typeof buildLeakGateVerdict>): string {
  try {
    expect(v.actual, v.message).toEqual(v.expected);
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('BL-2bf0b7c8 — the FTS leak gate always emits both page counts', () => {
  it('BL-2bf0b7c8: on the A-passes/B-fails path (leak reproduces, driver moved), the thrown message contains BOTH page counts', () => {
    // Synthetic numbers: leak reproduces (interleaved > 1.1× single) but the
    // installed driver is no longer the measured one — the exact shape of a
    // future driver bump (past 0.8.1) that re-introduced the leak while the
    // version-pin anchor moved.
    const interleaved = 5000;
    const single = 1000;
    const installed = '0.9.0';
    const v = buildLeakGateVerdict(interleaved, single, installed, FTS_OPTIMIZE_LEAK_MEASURED_ON);

    // The facts are SEPARATE fields (leak true, pin false)…
    expect(v.actual.leak_reproduces).toBe(true);
    expect(v.actual.installed_matches).toBe(false);
    // …and the assertion genuinely fails.
    expect(v.actual, v.message).not.toEqual(v.expected);

    const thrown = captureAssertionMessage(v);
    // The regression: BOTH raw page counts appear in the thrown message, plus
    // the moved version and the anchor — the numbers the operator needs.
    expect(thrown).toContain('interleaved=5000');
    expect(thrown).toContain('single=1000');
    expect(thrown).toContain('installed=0.9.0');
    expect(thrown).toContain(`measured_on=${FTS_OPTIMIZE_LEAK_MEASURED_ON}`);
  });

  it('BL-2bf0b7c8: on the A-fails/B-passes path (leak gone, driver still measured), the thrown message contains BOTH page counts', () => {
    // The other corner: the leak no longer reproduces but the driver is still
    // the measured one (an in-place fix without a version bump).
    const interleaved = 1000;
    const single = 1000;
    const installed = FTS_OPTIMIZE_LEAK_MEASURED_ON;
    const v = buildLeakGateVerdict(interleaved, single, installed, FTS_OPTIMIZE_LEAK_MEASURED_ON);

    expect(v.actual.leak_reproduces).toBe(false);
    expect(v.actual.installed_matches).toBe(true);
    expect(v.actual, v.message).not.toEqual(v.expected);

    const thrown = captureAssertionMessage(v);
    expect(thrown).toContain('interleaved=1000');
    expect(thrown).toContain('single=1000');
    expect(thrown).toContain(`installed=${FTS_OPTIMIZE_LEAK_MEASURED_ON}`);
  });

  it('BL-2bf0b7c8: the passing path produces no assertion error (both facts hold)', () => {
    const interleaved = 5000;
    const single = 1000;
    const v = buildLeakGateVerdict(interleaved, single, FTS_OPTIMIZE_LEAK_MEASURED_ON, FTS_OPTIMIZE_LEAK_MEASURED_ON);
    expect(captureAssertionMessage(v)).toBe('');
  });
});
