#!/usr/bin/env node
/**
 * check-backlog-citations.debt008.test.mjs
 *
 * DEBT-008 regression test: "Plan-local and graph backlog ids share one
 * bare-numeric namespace." Proves the gate's collision detector
 * (`computeCollisions` in check-backlog-citations.mjs) actually catches a
 * NEWLY-introduced ambiguous citation — a plan-local id allowlisted under a
 * `planDir` that the graph later allocates for an unrelated item — rather
 * than silently accepting it.
 *
 * Run: node tools/check-backlog-citations.debt008.test.mjs
 * (plain node:test — no framework, no repo/graph/rg dependency: every input
 * is fabricated in-process.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCollisions, ID_PATTERN } from './check-backlog-citations.mjs';

test('DEBT-008: a plan-local id that the graph later allocates is a BLOCKING collision for refs outside its owning planDir', () => {
  const byId = new Map([
    [
      'BUG-777',
      [
        { file: 'docs/plan/fake-plan/SPEC.md', line: 10 }, // inside owning scope — fine
        { file: 'libs/data/store/store-adapter/src/newfile.ts', line: 42 }, // OUTSIDE — ambiguous
      ],
    ],
  ]);
  const allowlist = {
    'BUG-777': {
      cause: 'PLAN_LOCAL_TEST',
      reason: 'fabricated for DEBT-008 regression test',
      planDir: 'docs/plan/fake-plan',
    },
  };
  // The graph has since allocated BUG-777 to an unrelated real item — this
  // is the exact shape of the BUG-019/BUG-021/BUG-018/BUG-022/DEBT-008 id
  // reuse this remediation fixed.
  const graphIds = new Set(['BUG-777']);

  const { blockingCollisions } = computeCollisions({ byId, allowlist, graphIds });

  assert.equal(blockingCollisions.length, 1, 'expected the reused id to be reported as a blocking collision');
  const c = blockingCollisions[0];
  assert.equal(c.id, 'BUG-777');
  assert.equal(c.ambiguous.length, 1, 'only the out-of-scope ref should be ambiguous');
  assert.equal(c.ambiguous[0].file, 'libs/data/store/store-adapter/src/newfile.ts');
});

test('DEBT-008: a ref inside the owning planDir is NEVER ambiguous, even after graph reuse', () => {
  const byId = new Map([['BUG-778', [{ file: 'docs/plan/fake-plan/SPEC.md', line: 5 }]]]);
  const allowlist = {
    'BUG-778': { cause: 'PLAN_LOCAL_TEST', reason: 'fabricated', planDir: 'docs/plan/fake-plan' },
  };
  const { blockingCollisions } = computeCollisions({ byId, allowlist, graphIds: new Set(['BUG-778']) });
  assert.equal(blockingCollisions.length, 0);
});

test('DEBT-008: disambiguatedRefs is a per-file escape hatch, not a blanket suppression', () => {
  const byId = new Map([
    [
      'BUG-779',
      [
        { file: 'docs/incident-record.md', line: 1 }, // disambiguated inline — passes
        { file: 'libs/data/store/store-adapter/src/other.ts', line: 2 }, // NOT disambiguated — still ambiguous
      ],
    ],
  ]);
  const allowlist = {
    'BUG-779': {
      cause: 'STILL_LOST',
      reason: 'fabricated',
      disambiguatedRefs: ['docs/incident-record.md'],
    },
  };
  const { blockingCollisions } = computeCollisions({ byId, allowlist, graphIds: new Set(['BUG-779']) });
  assert.equal(blockingCollisions.length, 1);
  assert.equal(blockingCollisions[0].ambiguous.length, 1);
  assert.equal(blockingCollisions[0].ambiguous[0].file, 'libs/data/store/store-adapter/src/other.ts');
});

test('DEBT-008: an allowlisted id the graph has NOT (yet) allocated is not a collision at all', () => {
  const byId = new Map([['BUG-780', [{ file: 'anywhere/at/all.ts', line: 1 }]]]);
  const allowlist = { 'BUG-780': { cause: 'STILL_LOST', reason: 'fabricated' } };
  const { collisions, blockingCollisions } = computeCollisions({
    byId,
    allowlist,
    graphIds: new Set(), // not allocated
  });
  assert.equal(collisions.length, 0);
  assert.equal(blockingCollisions.length, 0);
});

test('DEBT-008: the new plan-local citation syntax (BUG014.T5) never matches ID_PATTERN, so it can never enter byId at all', () => {
  const re = new RegExp(ID_PATTERN);
  assert.equal(re.test('BUG014.T5'), false, 'BUG014.T5 must not match the graph-id citation pattern');
  assert.equal(re.test('BUG014.T3'), false);
  assert.equal(re.test('DEBT014.T8'), false);
  // Sanity: the pattern still matches genuine graph-id forms.
  assert.equal(re.test('BUG-19'), true);
  assert.equal(re.test('DEBT-8'), true);
});
