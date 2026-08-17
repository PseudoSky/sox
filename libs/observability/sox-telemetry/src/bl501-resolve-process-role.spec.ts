/**
 * bl501-resolve-process-role.spec.ts — BL-501 acceptance.
 *
 * BEFORE this fix: every composition root (`memory-server`, `memory-cli`)
 * passed a hardcoded role LITERAL to `initTelemetry()` — e.g.
 * `role: 'live-service'` — with no way to distinguish a genuine production
 * spawn from a synthetic one (an integration harness like
 * `scripts/smoke-test.mjs` execing the exact same compiled binary
 * out-of-process). The cross-repo instance of this exact bug — documented in
 * `docs/reporting/memory/findings/2026-08-17-store-connection-lifetime-
 * forensics.md` §1d — made a log's `role` field useless for separating
 * short-lived one-shot CLI invocations from a `serve` mode that had been
 * running, misdiagnosably labelled `role:'cli'`, for 2.5+ days, during a live
 * WAL/checkpoint corruption investigation.
 *
 * `resolveProcessRole(structuralDefault)` fixes this by deriving the role
 * from a STRUCTURAL signal (how the process was actually started) rather
 * than trusting a compile-time constant. This spec proves:
 *   1. Absent the signal, the caller's own claimed identity
 *      (`structuralDefault`) passes through unchanged — a real production
 *      spawn is NOT relabelled.
 *   2. The signal, when present, overrides the default toward 'harness'.
 *   3. `VITEST_WORKER_ID`/`NODE_ENV=test` are deliberately NOT treated as
 *      signals here (unlike `defaultRole()` elsewhere in this file) — they
 *      are ambient to the whole vitest worker process and leak into any
 *      child process a spec spawns via `{ ...process.env, ... }`, which
 *      would mislabel a genuinely out-of-process black-box test of the real
 *      entrypoint (e.g. memory-server's own
 *      `bl404-telemetry-composition-root.spec.ts`, which spawns the real
 *      entrypoint via `tsx` and asserts `role === 'live-service'`) as
 *      `'test'` even though it is exercising real production code.
 */
import { describe, it, expect } from 'vitest';
import { resolveProcessRole } from './index.js';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('BL-501: resolveProcessRole() derives role from a structural signal', () => {
  it('no SOX_TELEMETRY_HARNESS signal -> the caller-claimed structuralDefault passes through unchanged (genuine production spawn is never relabelled)', () => {
    withEnv({ SOX_TELEMETRY_HARNESS: undefined }, () => {
      expect(resolveProcessRole('live-service')).toBe('live-service');
      expect(resolveProcessRole('cli')).toBe('cli');
    });
  });

  it(
    'SOX_TELEMETRY_HARNESS=1 -> "harness" — THE regression: this is how ' +
      'scripts/smoke-test.mjs spawns of the real memory-server/memory-cli ' +
      'binaries stop reporting "live-service"/"cli" identically to a real spawn',
    () => {
      withEnv({ SOX_TELEMETRY_HARNESS: '1' }, () => {
        expect(resolveProcessRole('live-service')).toBe('harness');
        expect(resolveProcessRole('cli')).toBe('harness');
      });
    },
  );

  it('SOX_TELEMETRY_HARNESS set to anything other than exactly "1" is NOT treated as the signal (no silent partial-match)', () => {
    withEnv({ SOX_TELEMETRY_HARNESS: 'true' }, () => {
      expect(resolveProcessRole('live-service')).toBe('live-service');
    });
  });

  it(
    'a NODE_ENV=test / VITEST_WORKER_ID environment does NOT override ' +
      'structuralDefault on its own — proves this function is immune to the ' +
      'ambient-env-leak failure mode its own doc comment warns about (unlike ' +
      'defaultRole() elsewhere in this file, which intentionally DOES key off them)',
    () => {
      withEnv({ NODE_ENV: 'test', VITEST_WORKER_ID: '1', SOX_TELEMETRY_HARNESS: undefined }, () => {
        expect(resolveProcessRole('live-service')).toBe('live-service');
      });
    },
  );
});
