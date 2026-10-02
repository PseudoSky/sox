/**
 * runtime-release-resolution.spec.ts — the runtime fallback behind S3
 * (`5ac0a1a8…`).
 *
 * The library's release identity is normally caller-supplied and respected
 * verbatim (ADR-0013 — typed config only, never overridden). This suite covers
 * the NEW fallback that fires only when a caller passes NO `release` object at
 * all: `resolveRuntimeRelease(env, argv, cwd)` resolves the three fields from
 * what the process can actually know at runtime — the npm-signalled package
 * version, the working tree's git HEAD, and the byte identity of the running
 * entrypoint — and returns the all-null identity when those sources are absent.
 *
 * It is a PURE function (env/argv/cwd injected), so these assertions do not
 * mutate `process.env` and cannot leak into sibling suites.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeRelease } from './index.js';

const realEntrypoint = fileURLToPath(import.meta.url);
const repoCwd = process.cwd();

describe('sox-telemetry — resolveRuntimeRelease', () => {
  it('returns the all-null identity under a test worker (hermetic null-when-unset)', () => {
    expect(resolveRuntimeRelease({ NODE_ENV: 'test' }, ['node', realEntrypoint], repoCwd)).toEqual({
      version: null,
      artifact_sha256: null,
      git_sha: null,
    });
    expect(
      resolveRuntimeRelease({ VITEST_WORKER_ID: '1' }, ['node', realEntrypoint], repoCwd)
    ).toEqual({ version: null, artifact_sha256: null, git_sha: null });
  });

  it('resolves version from npm_package_version, git_sha from HEAD, artifact from argv[1]', () => {
    const resolved = resolveRuntimeRelease(
      { npm_package_version: '9.8.7' },
      ['node', realEntrypoint],
      repoCwd
    );
    expect(resolved.version).toBe('9.8.7');
    expect(resolved.git_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(resolved.artifact_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('leaves unavailable sources null (never fabricates) — no version, no entrypoint', () => {
    const resolved = resolveRuntimeRelease({}, ['node'], repoCwd);
    expect(resolved.version).toBeNull();
    expect(resolved.artifact_sha256).toBeNull();
    // git_sha still resolves because cwd is inside a real checkout.
    expect(resolved.git_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('leaves all three null when every source is absent (non-repo cwd, no env)', () => {
    const resolved = resolveRuntimeRelease({}, ['node'], '/nonexistent-not-a-repo');
    expect(resolved).toEqual({ version: null, artifact_sha256: null, git_sha: null });
  });
});
