/**
 * bl501-cli-harness-role.spec.ts — BL-501 acceptance for memory-cli's
 * composition root.
 *
 * BEFORE this fix: `MEMORY_CLI_TELEMETRY_INIT_OPTIONS.role` was the hardcoded
 * literal `'cli'` — a `scripts/smoke-test.mjs` spawn of the exact same
 * compiled `memory-cli` binary (execed out-of-process to exercise it
 * end-to-end) was telemetry-indistinguishable from a real one-shot operator
 * invocation, the same failure class documented cross-repo in
 * `docs/reporting/memory/findings/2026-08-17-store-connection-lifetime-
 * forensics.md` §1d.
 *
 * `role` is now `resolveProcessRole('cli')`, resolved at module-import time
 * from the `SOX_TELEMETRY_HARNESS` env var. This spec proves both directions
 * with a real dynamic import (module-scope constants are evaluated once at
 * import, so each case needs `vi.resetModules()` + a fresh
 * `await import(...)` with the env var already set).
 */
import { describe, it, expect, afterEach } from 'vitest';

const ORIGINAL = process.env['SOX_TELEMETRY_HARNESS'];

async function importFreshWithEnv(harness: string | undefined): Promise<{
  role: string;
}> {
  const vitest = await import('vitest');
  vitest.vi.resetModules();
  if (harness === undefined) delete process.env['SOX_TELEMETRY_HARNESS'];
  else process.env['SOX_TELEMETRY_HARNESS'] = harness;
  const mod = (await import('./index.js')) as {
    MEMORY_CLI_TELEMETRY_INIT_OPTIONS: { role: string };
  };
  return { role: mod.MEMORY_CLI_TELEMETRY_INIT_OPTIONS.role };
}

describe('BL-501: memory-cli composition root resolves role structurally, not as a hardcoded literal', () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env['SOX_TELEMETRY_HARNESS'];
    else process.env['SOX_TELEMETRY_HARNESS'] = ORIGINAL;
  });

  it('no SOX_TELEMETRY_HARNESS -> role stays "cli" (a genuine one-shot CLI invocation is unaffected)', async () => {
    const { role } = await importFreshWithEnv(undefined);
    expect(role).toBe('cli');
  });

  it(
    'SOX_TELEMETRY_HARNESS=1 (set by scripts/smoke-test.mjs on every child it spawns) ' +
      '-> role is "harness", NOT "cli" — THE regression this fix closes',
    async () => {
      const { role } = await importFreshWithEnv('1');
      expect(role).toBe('harness');
    },
  );
});
