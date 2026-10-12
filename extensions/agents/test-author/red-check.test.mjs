// 595965cc T23.AC8: the red-record check accepts each valid red kind and rejects each seeded invalid kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'support', 'red-check.mjs');
const fx = (name) => path.join(here, 'support', 'fixtures', name);
const run = (exit, file) => spawnSync(process.execPath, [CLI, '--exit', String(exit), '--output', file], { encoding: 'utf8' });

test('595965cc T23.AC8 a stub-marker record and an assertion record are accepted (exit 0)', () => {
  assert.equal(run(1, fx('stub-marker.txt')).status, 0);
  assert.equal(run(1, fx('assertion.txt')).status, 0);
});

test('595965cc T23.AC8 a missing-symbol record is rejected with a structural reason (exit 1)', () => {
  const r = run(1, fx('missing-export.txt'));
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).reason, /structural failure/);
});

test('595965cc T23.AC8 a record of exit zero is rejected: no teeth (exit 1)', () => {
  assert.equal(run(0, fx('assertion.txt')).status, 1);
});

test('595965cc T23.AC8 usage without --output is E_USAGE (exit 64)', () => {
  const r = spawnSync(process.execPath, [CLI, '--exit', '1'], { encoding: 'utf8' });
  assert.equal(r.status, 64);
});

test('595965cc T23.AC8 an unreadable --output is E_IO (exit 65), never a red verdict', () => {
  const r = spawnSync(process.execPath, [CLI, '--exit', '1', '--output', '/nonexistent/red-record.txt'], { encoding: 'utf8' });
  assert.equal(r.status, 65);
  assert.equal(JSON.parse(r.stderr).error.code, 'E_IO');
});
