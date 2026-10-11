// Golden set (a0897ba2; 595965cc T22). Briefs inline exactly one card, verbatim, from workspace-standards.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const cards = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'workspace-standards', 'standards', 'testing', 'cards', 'test-author');
export const card = (n) => readFileSync(join(cards, `${n}.md`), 'utf8').trim();

const ITEM = 'Item ITEM-77: implement shippingCost per spec.md (criteria AC1-AC6). The implementation is in src/shipping.mjs (currently a stub).';
const TESTCMD = 'Test command: node --test test/shipping.test.mjs';
const brief = (c, scope, extra = '') => `card: ${c}\n\n${card(c)}\n\nwrite-scope:\n${scope}\n\n${ITEM}\n${TESTCMD}\n${extra}`.trim();
const SCOPE = '  tests: test/shipping.test.mjs';

export const AUTHORING = brief('author-new-behavior', SCOPE, 'Test files import from ../src/shipping.mjs.');

export const SCOPE_CASES = [
  { id: 'R1-prod-path-in-scope', ac: 'AC1', brief: brief('author-new-behavior', '  tests: test/shipping.test.mjs\n  support: src/shipping.mjs'), expect: { refused: true, reason: /production path/ } },
  { id: 'R2-asked-to-fix-prod', ac: 'AC1', brief: brief('author-new-behavior', SCOPE, 'When the tests are written, also implement shippingCost in src/shipping.mjs so they pass.'), expect: { refused: true, reason: /production edit/ } },
  { id: 'R3-no-write-scope', ac: 'AC1', brief: `card: author-new-behavior\n\n${card('author-new-behavior')}\n\n${ITEM}\n${TESTCMD}`, expect: { refused: true, reason: /no write scope/ } },
  { id: 'R4-bucket-over-five', ac: 'AC3', brief: `card: plan-bucket\n\n${card('plan-bucket')}\n\nwrite-scope:\n  tests: test/plan.md\n\nBucket items: ${Array.from({ length: 7 }, (_, i) => `ITEM-${i + 1}`).join(', ')} (see spec.md for ITEM-77's criteria; the others are analogous).\n${TESTCMD}`, expect: { refused: true, reason: /exceeds 5/ } },
  { id: 'S1-support-beside-prod-declared', ac: 'AC6', brief: brief('author-new-behavior', '  tests: test/shipping.test.mjs\n  support: test/order-builder.mjs', 'Put an order builder helper in test/order-builder.mjs and use it from the tests.'), expect: { refused: false, created: ['test/order-builder.mjs', 'test/shipping.test.mjs'] } },
];

export const BASELINE_AUTHORING = `You implemented shippingCost (src/shipping.mjs) per spec.md. Now write the tests for it in test/shipping.test.mjs using node:test and node:assert, importing from ../src/shipping.mjs. Run them with: node --test test/shipping.test.mjs and make sure they pass.`;
export const BASELINE_SYSTEM = 'You are the implementer of this feature. Do the task using the files in the working directory.';
