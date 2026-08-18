/**
 * bl592-shutdown-margin.spec.ts — BL-592 / docs/spec/service-lifecycle.md §8.1a
 * part B.
 *
 * Proves `resolveShutdownSafetyNetMs`/`resolveStopTimeoutMsFromEnv` are
 * COMPUTED, not a hand-picked literal (BL-592 acceptance criterion 2), and
 * guards against `memory-server`'s and `tokenguard`'s DUPLICATE local copies
 * (`./shutdown-margin.ts` in each — they cannot import this private package at
 * runtime, see those files' own doc comments) drifting from the canonical
 * `SOX_SHUTDOWN_SAFETY_MARGIN_MS` defined here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SOX_SHUTDOWN_SAFETY_MARGIN_MS,
  resolveShutdownSafetyNetMs,
  resolveStopTimeoutMsFromEnv,
} from './shutdown.js';

describe('BL-592 §8.1a part B — resolveShutdownSafetyNetMs is computed, not a literal', () => {
  it('RED (pre-fix: memory-server/tokenguard hardcoded a fixed literal regardless of the declared grace) — the derived value CHANGES when stopTimeoutMs changes', () => {
    const at5000 = resolveShutdownSafetyNetMs(5000);
    const at9000 = resolveShutdownSafetyNetMs(9000);
    expect(at5000).not.toBe(at9000);
    expect(at5000).toBe(4000); // matches memory-server's PRE-existing 4000 literal at the default 5000 grace
    expect(at9000).toBe(8000);
  });

  it('always leaves the enforced margin of headroom below stopTimeoutMs', () => {
    for (const stopTimeoutMs of [1000, 5000, 9000, 30000]) {
      const net = resolveShutdownSafetyNetMs(stopTimeoutMs);
      expect(stopTimeoutMs - net).toBe(SOX_SHUTDOWN_SAFETY_MARGIN_MS);
    }
  });

  it('never goes negative — floors at 0 for a pathologically small grace', () => {
    expect(resolveShutdownSafetyNetMs(500)).toBe(0);
    expect(resolveShutdownSafetyNetMs(0)).toBe(0);
  });

  it('honors a custom margin override', () => {
    expect(resolveShutdownSafetyNetMs(5000, 2000)).toBe(3000);
  });
});

describe('BL-592 §8.1a part B — resolveStopTimeoutMsFromEnv', () => {
  it('reads SOX_CONFIG_STOP_TIMEOUT_MS from the injected env', () => {
    expect(resolveStopTimeoutMsFromEnv({ SOX_CONFIG_STOP_TIMEOUT_MS: '9000' })).toBe(9000);
  });

  it('falls back to 5000 (matching cmdService default) when absent or invalid', () => {
    expect(resolveStopTimeoutMsFromEnv({})).toBe(5000);
    expect(resolveStopTimeoutMsFromEnv({ SOX_CONFIG_STOP_TIMEOUT_MS: 'not-a-number' })).toBe(5000);
    expect(resolveStopTimeoutMsFromEnv({ SOX_CONFIG_STOP_TIMEOUT_MS: '-1' })).toBe(5000);
    expect(resolveStopTimeoutMsFromEnv({ SOX_CONFIG_STOP_TIMEOUT_MS: '0' })).toBe(5000);
  });
});

// ─── Drift guard: memory-server's and tokenguard's DUPLICATE local copies ─────
//
// Neither bundled extension can import this private workspace package at
// runtime (see each shutdown-margin.ts's own doc comment), so the margin
// constant is intentionally duplicated. This test is the mechanism that keeps
// those duplicates honest: it reads the SOURCE TEXT of each file (no runtime
// cross-import, so it works whether or not those projects are built) and
// regex-extracts the numeric literal, asserting it equals the canonical value.

const REPO_ROOT = path.resolve(__dirname, '../../..');

function extractMarginLiteral(relPath: string): number {
  const abs = path.join(REPO_ROOT, relPath);
  const src = fs.readFileSync(abs, 'utf8');
  const m = src.match(/export const SOX_SHUTDOWN_SAFETY_MARGIN_MS\s*=\s*(\d+)\s*;/);
  if (!m) throw new Error(`could not find SOX_SHUTDOWN_SAFETY_MARGIN_MS literal in ${relPath}`);
  return Number(m[1]);
}

describe('BL-592 §8.1a part B — duplicate-margin drift guard', () => {
  it('memory-server/src/shutdown-margin.ts matches the canonical margin', () => {
    expect(
      extractMarginLiteral(
        'extensions/bundles/sox-memory-bundle/members/memory-server/src/shutdown-margin.ts',
      ),
    ).toBe(SOX_SHUTDOWN_SAFETY_MARGIN_MS);
  });

  it('tokenguard/src/shutdown-margin.ts matches the canonical margin', () => {
    expect(extractMarginLiteral('extensions/services/tokenguard/src/shutdown-margin.ts')).toBe(
      SOX_SHUTDOWN_SAFETY_MARGIN_MS,
    );
  });
});
