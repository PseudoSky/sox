/**
 * BL-deepverify — memory_ping's verdict reports a store whose owed deep
 * integrity pass timed out / failed as DEGRADED, never `ok`
 * ([inv:list-never-lies]); and the deep-verify bound is typed config that
 * rejects a malformed value loudly (ADR-0013 D3).
 */
import { describe, expect, it } from 'vitest';
import { computePingHealthVerdict } from './ping-health.js';
import { DEEP_VERIFY_TIMEOUT_CONFIG_ENV, resolveStoreVerifyConfig } from './config.js';

const healthy = { storeOpened: true, storeError: null, embedState: 'real' } as const;

describe('BL-deepverify — ping verdict reads the deep-verify record', () => {
  it.each(['timed_out', 'failed', 'damaged', 'inconclusive'])(
    'owed + last attempt %s ⇒ degraded, with the reason named',
    (status) => {
      const v = computePingHealthVerdict({
        ...healthy,
        deepVerify: { owed: true, status, detail: 'bound 1500ms' },
      });
      expect(v.status).toBe('degraded');
      expect(v.status_reason).toContain(`'${status}'`);
      expect(v.status_reason).toContain('bound 1500ms');
      expect(v.store_ok).toBe(true);
    },
  );

  it.each([
    ['running', true],
    ['cancelled', true],
    ['ok', false],
    [null, false],
  ] as const)('status %s (owed=%s) leaves an otherwise-healthy store ok', (status, owed) => {
    const v = computePingHealthVerdict({ ...healthy, deepVerify: { owed, status } });
    expect(v.status).toBe('ok');
  });

  it('a failed attempt that is no longer owed (a later pass cleared it) does not degrade', () => {
    const v = computePingHealthVerdict({ ...healthy, deepVerify: { owed: false, status: 'timed_out' } });
    expect(v.status).toBe('ok');
  });

  it('the deep-verify reason survives alongside an embed degradation', () => {
    const v = computePingHealthVerdict({
      storeOpened: true,
      storeError: null,
      embedState: 'degraded',
      deepVerify: { owed: true, status: 'timed_out' },
    });
    expect(v.status).toBe('degraded');
    expect(v.status_reason).toMatch(/timed_out/);
    expect(v.status_reason).toMatch(/embed subsystem/);
  });

  it('a dead store is still unhealthy regardless of the deep record', () => {
    const v = computePingHealthVerdict({
      storeOpened: false,
      storeError: 'boom',
      embedState: 'real',
      deepVerify: { owed: true, status: 'timed_out' },
    });
    expect(v.status).toBe('unhealthy');
  });
});

describe('BL-deepverify — deep-verify bound is typed config, loud on garbage', () => {
  it('unset ⇒ undefined (store-adapter default applies)', () => {
    expect(resolveStoreVerifyConfig(undefined, {}).deepVerifyTimeoutMs).toBeUndefined();
  });
  it('config-cascade value is parsed', () => {
    expect(resolveStoreVerifyConfig(undefined, { [DEEP_VERIFY_TIMEOUT_CONFIG_ENV]: '90000' }).deepVerifyTimeoutMs).toBe(90_000);
  });
  it('typed override wins over the cascade', () => {
    expect(
      resolveStoreVerifyConfig({ deepVerifyTimeoutMs: 5_000 }, { [DEEP_VERIFY_TIMEOUT_CONFIG_ENV]: '90000' }).deepVerifyTimeoutMs,
    ).toBe(5_000);
  });
  it.each(['banana', '1.5', '-3', '10s', 'off'])('rejects %s loudly', (raw) => {
    expect(() => resolveStoreVerifyConfig(undefined, { [DEEP_VERIFY_TIMEOUT_CONFIG_ENV]: raw })).toThrow(
      /not an integer number of milliseconds/,
    );
  });
});
