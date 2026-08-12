/**
 * BL-373 family — memory_ping health-verdict honesty.
 *
 * The Aug-11 incident: `memory_ping → { ok: true, status: 'ok', store: null }`
 * while EVERY write failed (the store could not open — stale WAL-index
 * sidecar). The ping's `status` was derived ONLY from embed health and
 * ignored the store block. These tests pin the verdict contract of
 * `computePingHealthVerdict` (memory-core, pure — the bundle consumes it).
 *
 * Red→green (BL-225): the pre-fix bundle verdict was the one-liner
 * `status: embedHealth.state === 'real' ? 'ok' : 'degraded'`
 * (extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:1136
 * at 04414dca) — for the incident inputs {storeOpened:false, embedState:'real'}
 * that expression yields 'ok': the false positive. The arms below assert the
 * corrected contract; arm (a) is the exact incident shape.
 */
import { describe, it, expect } from 'vitest';
import { computePingHealthVerdict } from './ping-health.js';

describe('BL-373 — computePingHealthVerdict never reports healthy when the store write path is dead', () => {
  it('(a) store failed to open (store:null shape) ⇒ unhealthy, store_ok:false, store_error set — the exact incident false positive', () => {
    // Incident inputs: the store block is null (open threw) while embed is real.
    const verdict = computePingHealthVerdict({
      storeOpened: false,
      storeError: 'failed to open database .../memory.db: I/O error: short read on WAL frame at offset 61832',
      embedState: 'real',
    });
    expect(verdict.status).toBe('unhealthy');
    expect(verdict.status).not.toBe('ok');
    expect(verdict.store_ok).toBe(false);
    expect(verdict.store_error).toContain('short read on WAL frame');
    expect(verdict.status_reason).toContain('store write path is down');
  });

  it('(a2) store failed to open WITHOUT an error detail still reads unhealthy, never ok', () => {
    const verdict = computePingHealthVerdict({ storeOpened: false, storeError: null, embedState: 'real' });
    expect(verdict.status).toBe('unhealthy');
    expect(verdict.store_ok).toBe(false);
    expect(verdict.store_error).toMatch(/not open/);
  });

  it('(b) store open + embed real ⇒ status ok, store_ok:true, no error fields', () => {
    const verdict = computePingHealthVerdict({
      storeOpened: true,
      storeError: null,
      embedState: 'real',
    });
    expect(verdict.status).toBe('ok');
    expect(verdict.status_reason).toBeNull();
    expect(verdict.store_ok).toBe(true);
    expect(verdict.store_error).toBeNull();
  });

  it('(c) embed degraded but store healthy ⇒ status degraded with the embed reason, store_ok:true — the two dimensions do not collapse', () => {
    const verdict = computePingHealthVerdict({
      storeOpened: true,
      storeError: null,
      embedState: 'uninitialized',
      embedError: 'model load failed: disk full',
    });
    expect(verdict.status).toBe('degraded');
    expect(verdict.status).not.toBe('unhealthy');
    expect(verdict.store_ok).toBe(true);
    expect(verdict.store_error).toBeNull();
    expect(verdict.status_reason).toContain('model load failed');
  });

  it('(d) embed degraded without a stored error still reads degraded, not ok', () => {
    const verdict = computePingHealthVerdict({
      storeOpened: true,
      storeError: null,
      embedState: 'uninitialized',
    });
    expect(verdict.status).toBe('degraded');
    expect(verdict.status_reason).toMatch(/not 'real'/);
    expect(verdict.store_ok).toBe(true);
  });

  it('(e) store dead AND embed degraded ⇒ unhealthy (store wins — the write path dominates)', () => {
    const verdict = computePingHealthVerdict({
      storeOpened: false,
      storeError: 'open failed',
      embedState: 'uninitialized',
    });
    expect(verdict.status).toBe('unhealthy');
    expect(verdict.store_ok).toBe(false);
    expect(verdict.status_reason).toContain('open failed');
  });
});
