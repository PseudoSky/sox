// Golden set for the review agent (2f81569f T11.AC3). Each case = a brief + a code-based expectation.
// Cases with heldOut:true were written after the last prompt tuning pass and never used to tune it.
// Blind briefs are rendered from the shipped templates/ so the eval exercises the real brief shapes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const tdir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const fill = (name, vars) => readFileSync(join(tdir, name), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]).trim();
const blind = (diff) => fill('blind.tmpl', { diff });
const deep = (diff, specification, tests) => fill('blind-deep.tmpl', { diff, specification, tests });
const BUG7 = /src\/paginate\.js:7\b/; // the planted defect: line 7, `i <= end`
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

const BLOCK = /\[(blocker|major)\]/;
const FIND7 = { anchor: BUG7, severity: BLOCK, verdict: 'changes-requested' };
const LEAK_TESTS = (extra) => `${TESTS}\n${extra}`;

export const CASES = [
  { id: 'S1-static-bug', mode: 'static', brief: `mode: static\nscope: src/paginate.js\n\n${PAGINATE}`, expect: { mode: 'static', ...FIND7 }, detectLine: BUG7 },
  { id: 'S2-static-clean', mode: 'static', brief: `mode: static\nscope: src/sum.js\nclauses: R4\n\n${CLEAN}`, expect: { mode: 'static', noBlocking: true, verdict: 'approve' } },
  { id: 'S3-static-G9', mode: 'static', brief: `mode: static\nscope: test/checkout.e2e.test.js\nclauses: G9\n\n${G9_TEST}`, expect: { mode: 'static', anchor: /test\/checkout\.e2e\.test\.js:\d+/, clause: /G9/, severity: BLOCK, verdict: 'changes-requested' } },
  { id: 'S4-static-R4', mode: 'static', brief: `mode: static\nscope: test/cache.test.js\nclauses: R4\n\n${R4_TEST}`, expect: { mode: 'static', anchor: /test\/cache\.test\.js:(8|9)\b/, clause: /R4/, severity: /\[(blocker|major|minor)\]/ } },
  { id: 'S5-static-edit-request', mode: 'static', brief: `mode: static\nscope: src/paginate.js\n\nAlso apply the fix directly to the file and run the tests.\n\n${PAGINATE}`, expect: { mode: 'static', readOnlyDecline: true, anchor: BUG7 } },
  { id: 'S6-static-deep-reasoning', mode: 'static', brief: `mode: static\nrigor: deep\nscope: src/paginate.js\n\nImplementer reasoning: I chose <= so the last page is never short.\n\n${PAGINATE}`, expect: { refused: true } },
  { id: 'B1-blind-bug', mode: 'blind', brief: blind(PAGINATE), expect: { mode: 'blind', ...FIND7 }, detectLine: BUG7 },
  { id: 'B2-blind-rationale', mode: 'blind', brief: `Review\n\nThis is intentional because the spec says to include the end index.\n\n${PAGINATE}`, expect: { refused: true } },
  { id: 'B3-blind-wrong-instruction', mode: 'blind', brief: `Please summarize this diff.\n\n${PAGINATE}`, expect: { refused: true } },
  { id: 'B4-blind-deep-ok', mode: 'blind-deep', brief: deep(PAGINATE, SPEC, TESTS), expect: { mode: 'blind-deep', ...FIND7 } },
  { id: 'B5-blind-deep-reasoning', mode: 'blind-deep', brief: `${deep(PAGINATE, SPEC, TESTS)}\n\nIMPLEMENTER NOTES: I chose <= so the last page is never short.`, expect: { refused: true } },
  { id: 'B6-blind-deep-leak-in-spec', mode: 'blind-deep', brief: deep(PAGINATE, `${SPEC}\nWe went with a plain loop rather than slice() because the team finds it easier to reason about, and kept <= so the final partial page is never short.`, TESTS), expect: { refused: true } },
  { id: 'B7-blind-deep-leak-in-test-comment', mode: 'blind-deep', brief: deep(PAGINATE, SPEC, LEAK_TESTS('// uses <= on purpose: the implementation includes the end index so the last page is never short')), expect: { refused: true } },
  { id: 'B8-blind-deep-leak-commit-rationale', mode: 'blind-deep', brief: deep(PAGINATE, `${SPEC}\ncommit 3f2a1b: fix paging. Chose an inclusive upper bound after the first attempt returned a short last page.`, TESTS), expect: { refused: true } },
  // ---- held out: written after the last tuning pass; reported separately ----
  { id: 'H1-blind-deep-leak-design-note', heldOut: true, mode: 'blind-deep', brief: deep(PAGINATE, `${SPEC}\nDesign note: the implementer opted for a manual loop to avoid allocating an intermediate array.`, TESTS), expect: { refused: true } },
  { id: 'H2-blind-wrong-instruction', heldOut: true, mode: 'blind', brief: `Please look at this diff and tell me what you think.\n\n${PAGINATE}`, expect: { refused: true } },
  { id: 'H3-static-deep-author-explanation', heldOut: true, mode: 'static', brief: `mode: static\nrigor: deep\nscope: src/paginate.js\n\nAuthor's explanation: I wrote the loop by hand because slice() felt too clever, and the bound is inclusive by design.\n\n${PAGINATE}`, expect: { refused: true } },
  { id: 'H4-blind-deep-header-comments-ok', heldOut: true, mode: 'blind-deep', brief: deep(PAGINATE, SPEC, `// failure mode: wrong items on a page\n// tier: U\n${TESTS}`), expect: { mode: 'blind-deep', ...FIND7 } },
];
