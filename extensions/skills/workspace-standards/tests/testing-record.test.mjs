// 595965cc T17.AC1-AC3: the filing-boundary check. Pure function plus the CLI; no backlog write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkTestingRecord, CHANGE_CLASSES } from '../scripts/testing-record.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'testing-record.mjs');
const good = (over = {}) => {
  const f = { 'change-class': 'new-behavior', rigor: 'standard', triggers: 'none', ac: 'AC1 returns 404 for unknown ids ; AC2 logs the miss', 'not-testing': 'load behaviour, owned by performance', plan: 'boundary -> integration -> AC1', ...over };
  return ['# item', '', '## Scope', 'something', '', '## Testing record', ...Object.entries(f).map(([k, v]) => `${k}: ${v}`), '', '## Next', 'x'].join('\n');
};

test('595965cc T17.AC1 a complete record passes the filing boundary', () => {
  assert.deepEqual(checkTestingRecord(good()), { ok: true, errors: [] });
});

test('595965cc T17.AC2 a body with no testing record is refused (backlog-operator ESCALATE)', () => {
  const v = checkTestingRecord('# item\n\nno record here\n');
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /no "## Testing record" section/);
});

test('595965cc T17.AC3 an invalid change-class is refused, and each of the eight valid values passes', () => {
  assert.equal(CHANGE_CLASSES.length, 8);
  const bad = checkTestingRecord(good({ 'change-class': 'feature' }));
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /change-class "feature" is not one of/);
  for (const c of CHANGE_CLASSES) assert.equal(checkTestingRecord(good({ 'change-class': c })).ok, true, c);
});

test('595965cc T17.AC1 missing ac ids, plan, or not-testing are each named; none is refused at standard', () => {
  assert.match(checkTestingRecord(good({ ac: 'no ids here' })).errors.join(' '), /ac: names no AC id/);
  assert.match(checkTestingRecord(good({ plan: '' })).errors.join(' '), /plan: is missing/);
  const noNt = good().replace('not-testing: load behaviour, owned by performance\n', '');
  assert.match(checkTestingRecord(noNt).errors.join(' '), /not-testing: is missing/);
  assert.match(checkTestingRecord(good({ 'not-testing': 'none' })).errors.join(' '), /"none" is refused at standard/);
  assert.equal(checkTestingRecord(good({ rigor: 'light', 'not-testing': 'none' })).ok, true, 'none is allowed below standard');
});

test('595965cc T17.AC2 the CLI exits 0 on a valid body, 1 on an invalid one, 64 on usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trec-'));
  const ok = path.join(dir, 'ok.md');
  const bad = path.join(dir, 'bad.md');
  fs.writeFileSync(ok, good());
  fs.writeFileSync(bad, '# no record\n');
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  assert.equal(run(['--file', ok]).status, 0);
  assert.equal(run(['--file', bad]).status, 1);
  assert.equal(run([]).status, 64);
});
