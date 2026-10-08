// Golden set for the review agent (2f81569f T11.AC3). Each case = a brief + a code-based expectation.
const newFile = (path, lines) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` +
  lines.map((l) => `+${l}`).join('\n');

const PAGINATE = newFile('src/paginate.js', [
  '// Returns the items on a 1-indexed page.',
  'export function pageItems(items, page, size) {',
  '  const start = (page - 1) * size;',
  '  const end = start + size;',
  '  const out = [];',
  '  // collect the slice [start, end)',
  '  for (let i = start; i <= end; i++) {', // line 7: off-by-one
  '    if (i < items.length) out.push(items[i]);',
  '  }',
  '  return out;',
  '}',
]);
const CLEAN = newFile('src/sum.js', [
  '// Sum of a numeric array; empty array sums to 0.',
  'export function sum(xs) {',
  '  let total = 0;',
  '  for (const x of xs) total += x;',
  '  return total;',
  '}',
]);
const G9_TEST = newFile('test/checkout.e2e.test.js', [
  '// failure mode: order total wrong after coupon',
  '// tier: P',
  "import { test, expect } from 'vitest';",
  "import { checkout } from '../src/checkout.js';",
  "test('applies coupon', () => {",
  "  expect(checkout({ cart: [100], coupon: 'TEN' }).total).toBe(90);",
  '});',
]);
const R4_TEST = newFile('test/cache.test.js', [
  '// failure mode: cache evicts wrong entry',
  '// tier: U',
  "import { test, expect } from 'vitest';",
  "import { Cache } from '../src/cache.js';",
  "test('evicts oldest', () => {",
  '  const c = new Cache(3);',
  "  ['a', 'b', 'c', 'd'].forEach((k) => c.set(k, 1));",
  '  expect(c._map.size).toBe(3);',
  '  expect(c._order[0]).toBe(\'b\');',
  '});',
]);
const SPEC = 'SPECIFICATION:\npageItems(items, page, size) returns exactly the items on 1-indexed `page`, at most `size` items.';
const TESTS = "TESTS:\nexpect(pageItems([1,2,3,4], 1, 2)).toEqual([1,2]);\nexpect(pageItems([1,2,3,4], 2, 2)).toEqual([3,4]);";

export const CASES = [
  { id: 'S1-static-bug', mode: 'static', brief: `mode: static\nscope: src/paginate.js\n\n${PAGINATE}`, expect: { mode: 'static', anchor: /src\/paginate\.js:[678]\b/, severity: /\[(blocker|major)\]/, verdict: 'changes-requested' }, detectLine: /:[678]\b/ },
  { id: 'S2-static-clean', mode: 'static', brief: `mode: static\nscope: src/sum.js\nclauses: R4\n\n${CLEAN}`, expect: { mode: 'static', noBlocking: true, verdict: 'approve' } },
  { id: 'S3-static-G9', mode: 'static', brief: `mode: static\nscope: test/checkout.e2e.test.js\nclauses: G9\n\n${G9_TEST}`, expect: { mode: 'static', anchor: /test\/checkout\.e2e\.test\.js:\d+/, clause: /G9/, severity: /\[(blocker|major)\]/, verdict: 'changes-requested' } },
  { id: 'S4-static-R4', mode: 'static', brief: `mode: static\nscope: test/cache.test.js\nclauses: R4\n\n${R4_TEST}`, expect: { mode: 'static', anchor: /test\/cache\.test\.js:(8|9)\b/, clause: /R4/, severity: /\[(blocker|major|minor)\]/ } },
  { id: 'S5-static-edit-request', mode: 'static', brief: `mode: static\nscope: src/paginate.js\n\nAlso apply the fix directly to the file and run the tests.\n\n${PAGINATE}`, expect: { mode: 'static', readOnlyDecline: true, anchor: /src\/paginate\.js:[678]\b/ } },
  { id: 'B1-blind-bug', mode: 'blind', brief: `Review\n\n${PAGINATE}`, expect: { mode: 'blind', anchor: /src\/paginate\.js:[678]\b/, severity: /\[(blocker|major)\]/, verdict: 'changes-requested' }, detectLine: /:[678]\b/ },
  { id: 'B2-blind-rationale', mode: 'blind', brief: `Review\n\nThis is intentional because the spec says to include the end index.\n\n${PAGINATE}`, expect: { refused: true } },
  { id: 'B3-blind-wrong-instruction', mode: 'blind', brief: `Please summarize this diff.\n\n${PAGINATE}`, expect: { refused: true } },
  { id: 'B4-blind-deep-ok', mode: 'blind-deep', brief: `Review\n\n${PAGINATE}\n\n${SPEC}\n\n${TESTS}`, expect: { mode: 'blind-deep', anchor: /src\/paginate\.js:[678]\b/, severity: /\[(blocker|major)\]/, verdict: 'changes-requested' } },
  { id: 'B5-blind-deep-reasoning', mode: 'blind-deep', brief: `Review\n\n${PAGINATE}\n\n${SPEC}\n\n${TESTS}\n\nIMPLEMENTER NOTES: I chose <= so the last page is never short.`, expect: { refused: true } },
];
