/**
 * E2E-ONLY: spawns real child processes by design; routing-rows.test.mjs spawns nothing.
 * 595965cc T12 — dispatcher routing fix. Run: node --test tests/*.test.mjs (from extensions/agents/dispatcher).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('595965cc T12.AC1: node tools/test-roster-guard.mjs exits 0', (t) => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools/test-roster-guard.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test('595965cc T12.AC3: node tools/test-dispatcher-ac-citation.mjs exits 0', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools/test-dispatcher-ac-citation.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
