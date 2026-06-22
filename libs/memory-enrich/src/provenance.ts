/**
 * provenance.ts — project_path resolution (E1).
 * CONTRACTS.md C1.4.
 *
 * Determinism: for a fixed process.cwd() and repo state, always returns the same string.
 * No randomness, no LLM, no network.
 */

import * as childProcess from 'node:child_process';

/**
 * Resolve the caller's project root path (E1).
 *
 * Resolution order:
 *   1. If `override` is supplied and non-empty, use it as-is.
 *   2. Run `git rev-parse --show-toplevel` synchronously in `process.cwd()`.
 *      On success, use the trimmed stdout.
 *   3. If git fails (not a repo), use `process.cwd()`.
 *
 * @param override  Caller-supplied project_path (from write params); skips detection.
 * @returns         Absolute path string, or null if cwd resolution itself throws.
 */
export function resolveProjectPath(override?: string): string | null {
  if (override !== undefined && override.length > 0) {
    return override;
  }
  try {
    const result = childProcess.spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 2000,
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
    // Git failed (not a repo, git not installed, etc.) — fall back to cwd
    return process.cwd();
  } catch {
    return null;
  }
}
