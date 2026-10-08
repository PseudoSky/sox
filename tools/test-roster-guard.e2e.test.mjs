#!/usr/bin/env node
/**
 * tools/test-roster-guard.e2e.test.mjs — end-to-end test for tools/test-roster-guard.mjs (backlog 3fe895f3, T10).
 *
 * E2E-ONLY: spawns the real CLI as a child process against real git, once. The unit suite
 * (test-roster-guard.test.mjs) spawns nothing. One run drives the whole surface: process exit code,
 * the stdout report, real `git ls-tree`/`git show` through `--ref`, and the entrypoint wiring.
 * It does NOT assert on the live tree: the guard is red there by design until the dispatcher roster
 * is fixed. When 27be064c is not in this clone the test is skipped with a printed reason; when it is
 * present, any difference from the expected red set fails it.
 *
 * Run: node tools/test-roster-guard.e2e.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TOOLS_DIR, '..');
const SNAPSHOT_REF = '27be064c';
const EXPECTED_RED = ['backend', 'general', 'refactor', 'review', 'test'];

test('3fe895f3 T10.AC2 (e2e, real git + real CLI): exit 1 on the real 27be064c, naming review, backend, refactor, test, general', (t) => {
  const probe = spawnSync('git', ['cat-file', '-e', `${SNAPSHOT_REF}^{commit}`], { cwd: REPO, encoding: 'utf8' });
  if (probe.status !== 0) {
    const reason = `commit ${SNAPSHOT_REF} not present in this clone (git cat-file -e exit ${probe.status}: ${probe.stderr.trim() || 'no stderr'}); the pinned snapshot unit test is the AC2 red-proof`;
    console.log(`SKIP: ${reason}`);
    t.skip(reason);
    return;
  }
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(TOOLS_DIR, 'test-roster-guard.mjs'), '--ref', SNAPSHOT_REF, '--root', REPO], { encoding: 'utf8' });
  const msg = `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
  assert.equal(r.status, 1, msg);
  const unresolved = [...r.stdout.matchAll(/^UNRESOLVED: (\S+) /gm)].map((m) => m[1]).sort();
  assert.deepEqual(unresolved, EXPECTED_RED, msg);
  console.log(`e2e duration_ms=${Date.now() - started}`);
});
