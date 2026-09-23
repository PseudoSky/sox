/**
 * vitest-timeout-budget.spec.ts
 *
 * Regression for the `apps/sox` timeout-fragility defect: `apps/sox/vitest.config.ts`
 * previously set no `testTimeout`, so vitest 4.x's 5000ms default applied — strictly
 * SMALLER than the 8000ms wait budgets `doctor-reconcile.spec.ts`'s own helpers
 * (`waitForFile`/`waitForPpid`) are written against. Under load, the suite-level
 * deadline killed a test before its own waiters had been given their stated budget.
 *
 * This is a STATIC assertion (per BL-225: the flake itself is load-dependent and not
 * deterministically reproducible; a test that tries to induce load to reproduce it
 * would itself be nondeterministic and would not count as red→green evidence). It
 * pins the invariant that actually broke:
 *
 *   A project's configured testTimeout must be >= the maximum wait budget any of its
 *   tests can consume. No test may be killed by a deadline shorter than the budget
 *   it was written against.
 *
 * Fails today (before the fix) because `config.test.testTimeout` is `undefined` and
 * `undefined >= N` is `false`. Passes after `apps/sox/vitest.config.ts` sets
 * `testTimeout: 30_000`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import configModule from '../vitest.config';

describe('apps/sox vitest.config timeout budget', () => {
  it('testTimeout is >= 2x every helper wait-budget declared in doctor-reconcile.spec.ts', () => {
    const specSrc = readFileSync(
      resolve(__dirname, 'doctor-reconcile.spec.ts'),
      'utf8',
    );

    // Pull every `timeoutMs = <number>` default out of the spec's helper
    // signatures (waitForFile/waitForPpid today; robust to future additions).
    const helperBudgets = [...specSrc.matchAll(/timeoutMs\s*=\s*(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(helperBudgets.length).toBeGreaterThan(0);
    const maxHelperBudget = Math.max(...helperBudgets);

    const config = (configModule as { test?: { testTimeout?: number } }).test;
    expect(config).toBeDefined();
    expect(config!.testTimeout).toBeDefined();
    expect(config!.testTimeout as number).toBeGreaterThanOrEqual(maxHelperBudget * 2);
  });

  // Behavioural companion to the static assertion above: proves the configured
  // testTimeout actually changes what vitest DOES, not just what the config
  // object says. A plain 6000ms await is deterministic in both directions —
  // unlike trying to reproduce the original load-dependent flake, which would
  // itself be nondeterministic (per BL-225, not acceptable red→green evidence).
  // Pre-fix (no testTimeout -> vitest's 5000ms default) this test is killed
  // with "Test timed out in 5000ms". Post-fix (testTimeout: 30_000) it passes
  // with 5x headroom — well below the 8000ms helper budgets this exists to
  // protect, so it can never itself be the thing that goes flaky under load.
  it('a 6000ms await completes — impossible under vitest\'s 5000ms default testTimeout', async () => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 6000));
    expect(Date.now() - start).toBeGreaterThanOrEqual(6000);
  });
});
