#!/usr/bin/env node
/**
 * prune-smoke-runs.test.mjs
 *
 * Regression test for scripts/lib/prune-smoke-runs.mjs — the fix for backlog
 * 87cff53c (the mandated `rm -rf dist/smoke` that the global permission rule
 * denies headless). Proves the harness prunes stale runs itself AND cannot be
 * tricked into removing anything that is not a direct `run-*` child of the
 * smoke root.
 *
 * Run: node scripts/lib/prune-smoke-runs.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pruneSmokeRuns } from './prune-smoke-runs.mjs';

function fixture(names) {
  const base = mkdtempSync(path.join(tmpdir(), 'prune-smoke-'));
  for (const n of names) {
    const d = path.join(base, n);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'log.json'), '{}');
  }
  return base;
}

test('keeps the current run + N prior, removes the rest', async () => {
  const base = fixture([
    'run-2026-01-01T00-00-00', 'run-2026-01-02T00-00-00', 'run-2026-01-03T00-00-00',
    'run-2026-01-04T00-00-00', 'run-2026-01-05T00-00-00',
  ]);
  const current = path.join(base, 'run-2026-01-05T00-00-00');
  const r = await pruneSmokeRuns(base, current, 1);
  assert.deepEqual(r.removed.sort(), ['run-2026-01-01T00-00-00', 'run-2026-01-02T00-00-00', 'run-2026-01-03T00-00-00']);
  assert.ok(existsSync(current), 'current run must survive');
  assert.ok(existsSync(path.join(base, 'run-2026-01-04T00-00-00')), 'keep=1 retains the most recent prior run');
  assert.ok(!existsSync(path.join(base, 'run-2026-01-01T00-00-00')));
  rmSync(base, { recursive: true, force: true });
});

test('keep=0 removes every prior run but never the current one', async () => {
  const base = fixture(['run-2026-01-01T00-00-00', 'run-2026-01-02T00-00-00']);
  const current = path.join(base, 'run-2026-01-02T00-00-00');
  const r = await pruneSmokeRuns(base, current, 0);
  assert.deepEqual(r.removed, ['run-2026-01-01T00-00-00']);
  assert.ok(existsSync(current));
  rmSync(base, { recursive: true, force: true });
});

test('ignores non-run dirs and files (never deletes unrelated things)', async () => {
  const base = fixture(['run-2026-01-01T00-00-00', 'run-2026-01-02T00-00-00', 'keepme']);
  writeFileSync(path.join(base, 'run-something-but-a-file'), 'x');
  const current = path.join(base, 'run-2026-01-02T00-00-00');
  await pruneSmokeRuns(base, current, 0);
  assert.ok(existsSync(path.join(base, 'keepme')), 'non-run dir survives');
  assert.ok(existsSync(path.join(base, 'run-something-but-a-file')), 'file survives');
  assert.ok(!existsSync(path.join(base, 'run-2026-01-01T00-00-00')));
  rmSync(base, { recursive: true, force: true });
});

test('missing base dir is a no-op, not a throw', async () => {
  const r = await pruneSmokeRuns('/nonexistent/prune-smoke-xxx', '/nonexistent/prune-smoke-xxx/run-x', 1);
  assert.deepEqual(r, { kept: 0, removed: [], errors: [] });
});
