/**
 * BL-9f6681ee — memory_ping's verdict never reads a starved deep verify as ok.
 *
 * An owed pass whose last attempt was `cancelled` (the opener closed mid-pass)
 * or is recorded `running` by an owner process that is now dead (a one-shot's
 * exit hook SIGKILLed the verifier and could write no terminal state) will
 * never finish on its own. Both must degrade.
 *
 * RED (fix disabled): `cancelled` absent from DEEP_VERIFY_DEGRADING_STATUSES,
 * or the dead-owner `running` branch removed ⇒ status 'ok'.
 */
import { describe, expect, it } from 'vitest';
import { computePingHealthVerdict, DEEP_VERIFY_DEGRADING_STATUSES } from './ping-health.js';

const healthy = { storeOpened: true, storeError: null, embedState: 'real' } as const;

describe('BL-9f6681ee — ping degrades for a starved owed deep verify', () => {
  it('owed + cancelled ⇒ degraded', () => {
    expect(DEEP_VERIFY_DEGRADING_STATUSES).toContain('cancelled');
    const v = computePingHealthVerdict({ ...healthy, deepVerify: { owed: true, status: 'cancelled', detail: 'owner closed' } });
    expect(v.status).toBe('degraded');
    expect(v.status_reason).toContain("'cancelled'");
    expect(v.store_ok).toBe(true);
  });

  it('owed + running with a DEAD owner pid ⇒ degraded', () => {
    const v = computePingHealthVerdict({ ...healthy, deepVerify: { owed: true, status: 'running', ownerAlive: false } });
    expect(v.status).toBe('degraded');
    expect(v.status_reason).toMatch(/'running'.*owner process is dead/);
  });

  it.each([
    [true, 'running', true],
    [true, 'running', null],
    [false, 'running', false],
    [false, 'cancelled', null],
  ] as const)('owed=%s status=%s ownerAlive=%s leaves an otherwise-healthy store ok', (owed, status, ownerAlive) => {
    const v = computePingHealthVerdict({ ...healthy, deepVerify: { owed, status, ownerAlive } });
    expect(v.status).toBe('ok');
  });
});
