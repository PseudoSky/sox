/**
 * prune-smoke-runs.mjs
 *
 * Bounded disk for the smoke harness. `scripts/smoke-test.mjs` writes each run
 * into a UNIQUE `dist/smoke/run-<ISO-timestamp>/` (~220 MB each) and never
 * pruned them — which is why AGENTS.md told agents to run
 * `rm -rf dist/smoke && node scripts/smoke-test.mjs`. That leading `rm -rf`
 * is the thing the global permission rule `"rm -rf *": "ask"` rejects on
 * headless agents (161 denials / 14 days; see backlog 87cff53c).
 *
 * The pruning belongs in the harness — scoped to `dist/smoke`, unable to touch
 * anything else — not in a raw shell glob in a doc. This module is pure over
 * the filesystem so it can be unit-tested without spawning the harness.
 *
 * Safety contract:
 *   - only DIRECT child directories of `baseDir` are considered;
 *   - only names beginning with `run-` are considered;
 *   - `currentRun` is never removed;
 *   - the `keep` most-recent prior runs are retained for post-mortem;
 *   - a path whose dirname is not exactly `baseDir` is refused, never removed.
 */

import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {string} baseDir     the smoke root (e.g. <workspace>/dist/smoke)
 * @param {string} currentRun  absolute path of the run being started (never removed)
 * @param {number} [keep=1]    number of most-recent PRIOR runs to retain
 * @returns {Promise<{kept:number, removed:string[], errors:string[]}>}
 */
export async function pruneSmokeRuns(baseDir, currentRun, keep = 1) {
  const base = path.resolve(baseDir);
  const current = path.resolve(currentRun);
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return { kept: 0, removed: [], errors: [] }; // base does not exist yet — nothing to prune
  }

  const runs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith('run-'))
    .map((e) => path.join(base, e.name))
    .filter((p) => p !== current)
    .sort(); // ISO-timestamp directory names sort oldest -> newest

  const stale = runs.slice(0, Math.max(0, runs.length - Math.max(0, keep)));
  const removed = [];
  const errors = [];
  for (const p of stale) {
    if (path.dirname(p) !== base) { errors.push(`${p}: refused (not a direct child of ${base})`); continue; }
    try {
      await rm(p, { recursive: true, force: true });
      removed.push(path.basename(p));
    } catch (err) {
      errors.push(`${path.basename(p)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { kept: runs.length - stale.length, removed, errors };
}
