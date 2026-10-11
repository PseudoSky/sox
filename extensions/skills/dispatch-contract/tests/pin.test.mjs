// Pin tests for the dispatch-contract skill. Each test cites the ticket and the AC ids it exercises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const brief = readFileSync(join(root, 'templates', 'brief.md'), 'utf8');
const returnBlock = skill.match(/## 2\. The return block[\s\S]*?```text\n([\s\S]*?)```/)?.[1] ?? '';
const section = (name) => skill.match(new RegExp(`## ${name}[\\s\\S]*?(?=\\n## )`))?.[0] ?? '';

test('5416b29f AC1: the binary test standard is replaced by inlining the role card and the tier-mapping excerpt', () => {
  const std = section('1a\\.');
  assert.match(std, /inline/i);
  assert.match(std, /role's card/);
  assert.match(std, /tier-mapping excerpt/);
  assert.doesNotMatch(skill, /Unit tests mock every library/);
  assert.doesNotMatch(brief, /Unit tests mock every library/);
  assert.match(brief, /tier-mapping excerpt/);
});

test('5416b29f AC2: the return block carries tier: and tests-obsoleted:', () => {
  assert.match(returnBlock, /^tier:/m);
  assert.match(returnBlock, /^tests-obsoleted:/m);
});

test('5416b29f AC3: the static-review brief checks tier and gap validity; the audit brief carries R1-R6 and the audit record format', () => {
  const staticReview = section('1a\\.').match(/\*\*Static-analysis review\*\*[^\n]*/)?.[0] ?? '';
  assert.match(staticReview, /tier/);
  assert.match(staticReview, /gap/);
  const briefStatic = brief.match(/## Static-analysis review[\s\S]*?(?=\n## )/)?.[0] ?? '';
  assert.match(briefStatic, /tier/);
  assert.match(briefStatic, /gap/);
  const audit = brief.match(/## Audit[^\n]*\n[\s\S]*?(?=\n## )/)?.[0] ?? '';
  assert.match(audit, /R1/);
  assert.match(audit, /R6/);
  assert.match(audit, /audit record/i);
  assert.match(section('1a\\.'), /\*\*Audit\*\*/);
});

test('5416b29f AC4: "one shared scaffold" no longer appears in SKILL.md', () => {
  assert.equal(skill.includes('one shared scaffold'), false);
});

test('5416b29f AC5: the brief gains test-authorship:, rigor and playbook; the return block gains red: and test-dispute:', () => {
  for (const f of ['test-authorship:', 'rigor:', 'playbook:']) {
    assert.ok(skill.includes('`' + f + '`'), `SKILL.md names ${f}`);
    assert.ok(brief.includes(f), `brief template carries ${f}`);
  }
  assert.match(returnBlock, /^red:/m);
  assert.match(returnBlock, /^test-dispute:/m);
});

test('5416b29f AC6: the citation duty attaches to whoever writes a test; the test standard rides test-writing roles only', () => {
  const ac = skill.match(/- \*\*Acceptance criteria[^\n]*/)?.[0] ?? '';
  assert.doesNotMatch(ac, /the executor writes/);
  assert.match(ac, /whoever writes a test/);
  assert.match(brief, /whoever writes a test/);
  assert.match(section('1a\\.'), /test-writing roles only/);
  assert.match(brief, /## Test standard \(test-writing roles only\)/);
});

test('5416b29f AC1-AC6: every AC is cited by its own test title', () => {
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // Titles are parsed from the source: `test('<ticket> AC<n>: ...'`. A range title such as "AC1-AC6" cites no single AC.
  const cited = [...self.matchAll(/^test\('5416b29f AC(\d+)(?=[:\s])/gm)].map((m) => Number(m[1]));
  for (let n = 1; n <= 6; n++) {
    assert.equal(cited.filter((c) => c === n).length, 1, `AC${n} must be cited by exactly one test title (cited: ${cited.join(',')})`);
  }
  // negative control: the same parse over a file whose only citation is a range title cites nothing
  const rangeOnly = "test('5416b29f AC1-AC6: this file cites every AC', () => {});";
  assert.deepEqual([...rangeOnly.matchAll(/^test\('5416b29f AC(\d+)(?=[:\s])/gm)], []);
});
