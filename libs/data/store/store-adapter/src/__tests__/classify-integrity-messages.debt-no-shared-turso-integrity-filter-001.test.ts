/**
 * DEBT-NO-SHARED-TURSO-INTEGRITY-FILTER-001 — a shared, reusable classifier
 * for `PRAGMA integrity_check` output, so a caller can assert on
 * `damage.length === 0` and be RIGHT, instead of writing a regex (or three)
 * by hand and getting it wrong.
 *
 * Two separate authors hit the gap this closes within one week:
 *   1. A corruption investigation flagged its runs as "corrupted" purely on
 *      the benign page-accounting artifact.
 *   2. `tools/rehearse-live-vacuum.mjs` hand-rolled the filter regex inline
 *      rather than importing the one `integrity.ts` already owned.
 *
 * ── The shape of every test here ────────────────────────────────────────
 *
 * 1. The benign-classification test is deliberately NOT the only test — a
 *    classifier that called everything benign would pass a benign-only suite
 *    (BL-167's own lesson). `damage` must classify a synthetic real
 *    corruption message correctly, or this whole exercise has no teeth.
 * 2. The "filter before cap" test is the regression test for
 *    BUG-INTEGRITY-CHECK-BLINDED-BY-PAGE-NOISE-001 — 100 page-accounting
 *    messages saturated `integrity_check`'s own 100-message cap and left
 *    the probe unable to answer. It proves the classifier's `truncated`
 *    flag is honestly computed from the RAW input length, and that real
 *    damage buried among filterable noise is still surfaced even when the
 *    array as a whole is at the cap.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyIntegrityMessages,
  INTEGRITY_CHECK_MESSAGE_CAP,
} from '../integrity.js';

const REAL_DAMAGE =
  'rowid 41 out of order for index idx_node_project_path';
const PAGE_NEVER_USED = 'Page 12345: never used';
const PAGE_REFERENCED_MULTIPLE = 'Page 999 referenced multiple times';

describe('DEBT-NO-SHARED-TURSO-INTEGRITY-FILTER-001 — classifyIntegrityMessages', () => {
  it('classifies a synthetic REAL damage message as damage — a classifier that calls everything benign is dangerous, not safe', () => {
    const result = classifyIntegrityMessages([REAL_DAMAGE]);
    expect(result.damage).toEqual([REAL_DAMAGE]);
    expect(result.pageAccounting).toEqual([]);
  });

  it('classifies page-accounting messages ("Page N: ...") separately from damage', () => {
    const result = classifyIntegrityMessages([PAGE_NEVER_USED, PAGE_REFERENCED_MULTIPLE]);
    expect(result.pageAccounting).toEqual([PAGE_NEVER_USED, PAGE_REFERENCED_MULTIPLE]);
    expect(result.damage).toEqual([]);
  });

  it('classifies a mix of damage and page-accounting into their correct buckets, preserving order within each bucket', () => {
    const messages = [PAGE_NEVER_USED, REAL_DAMAGE, PAGE_REFERENCED_MULTIPLE];
    const result = classifyIntegrityMessages(messages);
    expect(result.damage).toEqual([REAL_DAMAGE]);
    expect(result.pageAccounting).toEqual([PAGE_NEVER_USED, PAGE_REFERENCED_MULTIPLE]);
  });

  it('reports truncated:false when input is well under the message cap', () => {
    const result = classifyIntegrityMessages([REAL_DAMAGE, PAGE_NEVER_USED]);
    expect(result.truncated).toBe(false);
  });

  // ── The regression test for BUG-INTEGRITY-CHECK-BLINDED-BY-PAGE-NOISE-001 ──
  it(
    'filtering precedes capping: given more benign messages than the cap, real damage after them is still reported ' +
      '(the actual incident — 100 page-accounting messages saturated the cap and blinded the probe)',
    () => {
      // INTEGRITY_CHECK_MESSAGE_CAP (100) page-accounting messages, exactly
      // the shape that saturated the live store's cap, with REAL damage
      // appended after them — i.e. present in the raw array, at a position
      // past where a naive "filter after truncating to N" implementation
      // would have already cut it off.
      const benignNoise = Array.from(
        { length: INTEGRITY_CHECK_MESSAGE_CAP },
        (_, i) => `Page ${i + 1}: never used`,
      );
      const messages = [...benignNoise, REAL_DAMAGE];

      const result = classifyIntegrityMessages(messages);

      // The cap is a property of the RAW input, computed honestly — the
      // input here is AT the cap (100 benign + 1 damage = 101 total, so
      // length >= cap is true regardless of composition).
      expect(result.truncated).toBe(true);
      // The regression assertion: damage is not silently swallowed by the
      // benign volume ahead of it. A caller must still see it.
      expect(result.damage).toEqual([REAL_DAMAGE]);
      expect(result.pageAccounting).toHaveLength(INTEGRITY_CHECK_MESSAGE_CAP);

      // Negative control on the same shape, minus the damage message: an
      // all-benign, capped input reports EMPTY damage but STILL truncated —
      // "clean as far as we could see" must never collapse into "clean".
      const allBenign = classifyIntegrityMessages(benignNoise);
      expect(allBenign.damage).toEqual([]);
      expect(allBenign.truncated).toBe(true);
    },
  );

  it('an empty input classifies as clean and not truncated', () => {
    const result = classifyIntegrityMessages([]);
    expect(result).toEqual({
      damage: [],
      pageAccounting: [],
      truncated: false,
    });
  });
});
