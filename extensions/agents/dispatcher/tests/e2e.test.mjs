/**
 * E2E-ONLY: the only file in tests/ that spawns processes. Each guard tool is spawned at most once per
 * file run (memoized in runTool), so the citation guard serves both T12 AC3 and T47 AC5 from one child.
 * 595965cc T12 / T47 — dispatcher routing fix. Run: node --test tests/*.test.mjs (from extensions/agents/dispatcher).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const runs = new Map();

/** Spawn one repo tool, once per file run; returns the result and its wall-clock ms. */
function runTool(rel) {
  if (!runs.has(rel)) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(REPO, rel)], { encoding: 'utf8' });
    runs.set(rel, { r, ms: Date.now() - t0 });
  }
  return runs.get(rel);
}

test('595965cc T12.AC1: node tools/test-roster-guard.mjs exits 0', (t) => {
  const { r, ms } = runTool('tools/test-roster-guard.mjs');
  t.diagnostic(`595965cc T12 roster-guard wall-clock: ${ms} ms (one child process)`);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test('595965cc T12.AC3: node tools/test-dispatcher-ac-citation.mjs exits 0', (t) => {
  const { r, ms } = runTool('tools/test-dispatcher-ac-citation.mjs');
  t.diagnostic(`595965cc T12 ac-citation wall-clock: ${ms} ms (one child process)`);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test('595965cc T47 AC5 — tools/test-dispatcher-ac-citation.mjs still exits 0', (t) => {
  const { r, ms } = runTool('tools/test-dispatcher-ac-citation.mjs');
  t.diagnostic(`595965cc T47 e2e wall-clock: ${ms} ms (shared child with T12.AC3)`);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
