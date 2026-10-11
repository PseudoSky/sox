/**
 * 595965cc T47 AC1: every `### Step N` heading in dispatcher.md is ONE line with an em-dash title.
 *
 * Why the lifecycle predicates missed a split heading (`### Step 3` / ` — Dispatch`): tools/test-dispatcher-
 * delivery-lifecycle.mjs normalises all whitespace (`norm`) before matching, so a newline inside a heading is
 * invisible to it. This test reads the RAW text. Spawns nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dispatcher.md');

/** Offending headings in `text`: a `### Step N` line that is not `### Step N — <title>`. */
export const badStepHeadings = (text) =>
  text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /^### Step \d+/.test(l) && !/^### Step \d+ — \S/.test(l));

test('595965cc T47 AC1: every ### Step N heading in dispatcher.md is a single line with an em-dash title', () => {
  const text = fs.readFileSync(FILE, 'utf8');
  assert.ok(text.split('\n').filter((l) => /^### Step \d+/.test(l)).length >= 10, 'the step headings were found');
  assert.deepEqual(badStepHeadings(text), []);
});

test('595965cc T47 AC1: a heading split across two lines is caught by the same check', () => {
  assert.deepEqual(badStepHeadings('### Step 3\n — Dispatch\n').map(([n]) => n), [1]);
  assert.deepEqual(badStepHeadings('### Step 3 — Dispatch\n'), []);
});
