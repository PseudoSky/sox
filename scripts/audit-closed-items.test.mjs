// scripts/audit-closed-items.test.mjs
//
// Regression test for tools/audit-closed-items.mjs's pure classifier. Lives under scripts/ (not
// tools/) because the root vitest.config.ts `include` is
// ['extensions/**/*.test.ts', 'scripts/**/*.test.{ts,mjs}'] — a test file under tools/ is never
// collected. This file imports the implementation from tools/ by relative path; only the test
// file itself needs to sit under scripts/.
//
// Observable done-state (per TRIAGE-SPEC.md item 9): feeds the classifier a synthetic corpus —
// one item with no test reference, one referenced only inside a statically-skipped test, one
// referenced in a live (non-skipped) test — and asserts NOT-AUDITABLE / SKIP-MASKED / CITED
// respectively. Also covers the UNEVIDENCED case (has an alias, zero grep hits) and the
// bodyGuardSuspect lead heuristic.

import { describe, it, expect } from 'vitest';
import {
  scrapeAliases,
  classifyHit,
  classifyItem,
  fileLineCache,
} from '../tools/audit-closed-items.mjs';

describe('scrapeAliases', () => {
  it('extracts BL-/BUG-/DEBT- aliases from free text, deduped by caller', () => {
    const text = 'Resolved (BL-412/BL-414 pair), see also BUG-019 and DEBT-008. BL-412 again.';
    expect(scrapeAliases(text)).toEqual(['BL-412', 'BL-414', 'BUG-019', 'DEBT-008']);
  });

  it('returns empty for text with no alias', () => {
    expect(scrapeAliases('nothing to see here')).toEqual([]);
  });

  it('returns empty for null/undefined/empty input', () => {
    expect(scrapeAliases(null)).toEqual([]);
    expect(scrapeAliases(undefined)).toEqual([]);
    expect(scrapeAliases('')).toEqual([]);
  });
});

describe('classifyHit — window heuristic against synthetic in-memory file content', () => {
  function seed(file, lines) {
    fileLineCache.set(file, lines);
  }

  it('flags a hit sitting inside `it.skip(...)` as skipMasked', () => {
    const file = '__synthetic__/skip-masked.test.ts';
    const lines = [
      "import { describe, it, expect } from 'vitest';",
      '',
      "it.skip('BL-999 regression', () => {",
      "  expect(1).toBe(1); // BL-999",
      '});',
    ];
    seed(file, lines);
    const result = classifyHit({ file, line: 4, alias: 'BL-999' });
    expect(result.skipMasked).toBe(true);
    expect(result.windowUnavailable).toBe(false);
  });

  it('flags a hit inside a frozen `{ skip: hasFoo }` option object as skipMasked', () => {
    const file = '__synthetic__/skip-option.test.ts';
    const lines = [
      'let hasFoo = false;',
      "beforeAll(async () => { hasFoo = await checkFoo(); });",
      "it('BL-888 regression', { skip: !hasFoo }, async () => {",
      '  expect(await doThing()).toBe(true); // BL-888',
      '});',
    ];
    seed(file, lines);
    const result = classifyHit({ file, line: 4, alias: 'BL-888' });
    expect(result.skipMasked).toBe(true);
  });

  it('does NOT flag a hit inside a plain, unskipped `it(...)` as skipMasked', () => {
    const file = '__synthetic__/live.test.ts';
    const lines = [
      "it('BL-777 regression', () => {",
      '  const result = doThing();',
      '  expect(result).toBe(true); // BL-777',
      '});',
    ];
    seed(file, lines);
    const result = classifyHit({ file, line: 3, alias: 'BL-777' });
    expect(result.skipMasked).toBe(false);
  });

  it('flags bodyGuardSuspect when an early return/continue guards an expect() nearby (BL-167 lead)', () => {
    const file = '__synthetic__/guard-suspect.test.ts';
    const lines = [
      "it('BL-167 regression', () => {",
      '  if (!hasChannelSignal) return;',
      '  expect(computeVerdict()).toBe("broken"); // BL-167',
      '});',
    ];
    seed(file, lines);
    const result = classifyHit({ file, line: 3, alias: 'BL-167' });
    expect(result.bodyGuardSuspect).toBe(true);
  });

  it('does not flag bodyGuardSuspect when there is no guard-return near the hit', () => {
    const file = '__synthetic__/no-guard.test.ts';
    const lines = ["it('BL-1 regression', () => {", '  expect(1).toBe(1); // BL-1', '});'];
    seed(file, lines);
    const result = classifyHit({ file, line: 2, alias: 'BL-1' });
    expect(result.bodyGuardSuspect).toBe(false);
  });

  it('reports windowUnavailable for a file with no cached/on-disk content', () => {
    const result = classifyHit({ file: '__synthetic__/does-not-exist.test.ts', line: 1, alias: 'BL-1' });
    expect(result.windowUnavailable).toBe(true);
    expect(result.skipMasked).toBe(false);
  });
});

describe('classifyItem — the three-way verdict the observable done-state requires', () => {
  it('NOT-AUDITABLE: no alias scraped, no test-file citation at all', () => {
    const { classification } = classifyItem({
      aliasesFound: [],
      citedTestFiles: [],
      citedTestFilesExtant: [],
      hitDetails: [],
    });
    expect(classification).toBe('NOT-AUDITABLE');
  });

  it('UNEVIDENCED: has an alias, but zero grep hits and no extant test citation', () => {
    const { classification } = classifyItem({
      aliasesFound: ['BL-9999'],
      citedTestFiles: [],
      citedTestFilesExtant: [],
      hitDetails: [],
    });
    expect(classification).toBe('UNEVIDENCED');
  });

  it('SKIP-MASKED: the only hit(s) found are inside a statically-skipped test — the BL-167 shape', () => {
    const { classification } = classifyItem({
      aliasesFound: ['BL-999'],
      citedTestFiles: [],
      citedTestFilesExtant: [],
      hitDetails: [
        { file: 'x.test.ts', line: 4, alias: 'BL-999', skipMasked: true, bodyGuardSuspect: false, windowUnavailable: false },
      ],
    });
    expect(classification).toBe('SKIP-MASKED');
  });

  it('CITED: at least one hit is live (not skip-masked)', () => {
    const { classification } = classifyItem({
      aliasesFound: ['BL-777'],
      citedTestFiles: [],
      citedTestFilesExtant: [],
      hitDetails: [
        { file: 'x.test.ts', line: 3, alias: 'BL-777', skipMasked: false, bodyGuardSuspect: false, windowUnavailable: false },
      ],
    });
    expect(classification).toBe('CITED');
  });

  it('CITED: an extant cited test file counts even with zero alias grep hits', () => {
    const { classification } = classifyItem({
      aliasesFound: [],
      citedTestFiles: ['libs/x/__tests__/y.test.ts'],
      citedTestFilesExtant: ['libs/x/__tests__/y.test.ts'],
      hitDetails: [],
    });
    expect(classification).toBe('CITED');
  });

  it('one hit live + one hit skip-masked still resolves CITED (any live hit wins)', () => {
    const { classification } = classifyItem({
      aliasesFound: ['BL-1'],
      citedTestFiles: [],
      citedTestFilesExtant: [],
      hitDetails: [
        { file: 'a.test.ts', line: 1, alias: 'BL-1', skipMasked: true, bodyGuardSuspect: false, windowUnavailable: false },
        { file: 'b.test.ts', line: 1, alias: 'BL-1', skipMasked: false, bodyGuardSuspect: false, windowUnavailable: false },
      ],
    });
    expect(classification).toBe('CITED');
  });

  it('bodyGuardSuspect propagates to the item level when any hit is flagged', () => {
    const { bodyGuardSuspect } = classifyItem({
      aliasesFound: ['BL-167'],
      citedTestFiles: [],
      citedTestFilesExtant: [],
      hitDetails: [
        { file: 'a.test.ts', line: 1, alias: 'BL-167', skipMasked: false, bodyGuardSuspect: true, windowUnavailable: false },
      ],
    });
    expect(bodyGuardSuspect).toBe(true);
  });
});
