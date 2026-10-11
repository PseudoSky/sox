/**
 * E2E-ONLY: spawns one real child process by design; role-availability.test.mjs spawns nothing.
 * 595965cc T47 AC5 — tools/test-dispatcher-ac-citation.mjs still exits 0.
 * Run: node --test tests/*.test.mjs   (from extensions/agents/dispatcher)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('595965cc T47 AC5 — tools/test-dispatcher-ac-citation.mjs still exits 0', (t) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools/test-dispatcher-ac-citation.mjs')], { encoding: 'utf8' });
  t.diagnostic(`595965cc T47 e2e wall-clock: ${Date.now() - t0} ms (one child process)`);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
