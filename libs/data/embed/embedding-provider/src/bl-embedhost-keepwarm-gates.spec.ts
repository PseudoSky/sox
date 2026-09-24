import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  resolveEmbedKeepWarmMs,
  resolveEmbedKeepWarmActiveWindowMs,
  shouldSkipKeepWarmTick,
  nextKeepWarmIntervalMs,
  KEEPWARM_SLOW_MS,
} from './embedHostMain.js';

/**
 * Regression coverage for the keep-warm gating/backoff logic added in
 * fix/embed-recall-resilience. Review flagged this as untested: the
 * activity-window gate, the skip-if-recent-activity gate, the no-lastInit
 * gate, the backoff doubling/cap, the reset-to-base on a fast tick, and the
 * env parsing for both resolver functions. `keepWarmTick`/`startKeepWarm`
 * themselves stay private to `runEmbedHost`'s closure (they close over
 * per-process mutable state and the real UDS server) — the decision logic
 * they call is factored out into `shouldSkipKeepWarmTick` /
 * `nextKeepWarmIntervalMs` specifically so it can be driven directly here
 * with controlled `now`/`workMs` inputs, with no fake timers or forked
 * process required.
 */

const BASE_ARGS = {
  keepWarmActiveWindowMs: 900_000,
  keepWarmIntervalMs: 45_000,
  hasInit: true,
};

describe('shouldSkipKeepWarmTick', () => {
  it('does not skip when a real request landed recently, the cadence has elapsed, and init happened', () => {
    const now = 1_000_000;
    expect(
      shouldSkipKeepWarmTick({
        ...BASE_ARGS,
        now,
        lastRealActivityAt: now - 1_000,
        lastActivityAt: now - 46_000,
      }),
    ).toBe(false);
  });

  it('activity-window gate: skips once no real request has landed within the window', () => {
    const now = 1_000_000;
    expect(
      shouldSkipKeepWarmTick({
        ...BASE_ARGS,
        now,
        lastRealActivityAt: now - 900_000, // exactly at the boundary — >= skips
        lastActivityAt: now - 46_000,
      }),
    ).toBe(true);
    expect(
      shouldSkipKeepWarmTick({
        ...BASE_ARGS,
        now,
        lastRealActivityAt: now - 900_001,
        lastActivityAt: now - 46_000,
      }),
    ).toBe(true);
  });

  it('activity-window gate: epoch (0) lastRealActivityAt before any real traffic always skips', () => {
    const now = 1_000_000;
    expect(
      shouldSkipKeepWarmTick({
        ...BASE_ARGS,
        now,
        lastRealActivityAt: 0,
        lastActivityAt: now - 46_000,
      }),
    ).toBe(true);
  });

  it('cadence gate: skips when something already completed within the current interval', () => {
    const now = 1_000_000;
    expect(
      shouldSkipKeepWarmTick({
        ...BASE_ARGS,
        now,
        lastRealActivityAt: now - 1_000,
        lastActivityAt: now - 1_000, // well inside the 45s cadence
      }),
    ).toBe(true);
  });

  it('cadence gate: does not skip once exactly keepWarmIntervalMs has elapsed', () => {
    const now = 1_000_000;
    expect(
      shouldSkipKeepWarmTick({
        ...BASE_ARGS,
        now,
        lastRealActivityAt: now - 1_000,
        lastActivityAt: now - 45_000,
      }),
    ).toBe(false);
  });

  it('no-lastInit gate: skips when the pool has never seen embedding.init', () => {
    const now = 1_000_000;
    expect(
      shouldSkipKeepWarmTick({
        ...BASE_ARGS,
        now,
        lastRealActivityAt: now - 1_000,
        lastActivityAt: now - 46_000,
        hasInit: false,
      }),
    ).toBe(true);
  });
});

describe('nextKeepWarmIntervalMs', () => {
  it('doubles the interval on a successful slow tick', () => {
    expect(
      nextKeepWarmIntervalMs({ currentIntervalMs: 45_000, baseMs: 45_000, workMs: KEEPWARM_SLOW_MS + 1, tickOk: true }),
    ).toBe(90_000);
  });

  it('caps the doubled interval at capMs', () => {
    expect(
      nextKeepWarmIntervalMs({
        currentIntervalMs: 700_000,
        baseMs: 45_000,
        workMs: KEEPWARM_SLOW_MS + 1,
        tickOk: true,
        capMs: 900_000,
      }),
    ).toBe(900_000);
    // already at the cap: stays there, does not exceed it
    expect(
      nextKeepWarmIntervalMs({
        currentIntervalMs: 900_000,
        baseMs: 45_000,
        workMs: KEEPWARM_SLOW_MS + 1,
        tickOk: true,
        capMs: 900_000,
      }),
    ).toBe(900_000);
  });

  it('resets to baseMs on a successful fast tick', () => {
    expect(
      nextKeepWarmIntervalMs({ currentIntervalMs: 360_000, baseMs: 45_000, workMs: 500, tickOk: true }),
    ).toBe(45_000);
  });

  it('a fast tick already at base is a no-op (idempotent reset)', () => {
    expect(
      nextKeepWarmIntervalMs({ currentIntervalMs: 45_000, baseMs: 45_000, workMs: 500, tickOk: true }),
    ).toBe(45_000);
  });

  it('leaves the cadence untouched on a failed tick, even a slow one', () => {
    expect(
      nextKeepWarmIntervalMs({ currentIntervalMs: 90_000, baseMs: 45_000, workMs: 20_000, tickOk: false }),
    ).toBe(90_000);
  });

  it('leaves the cadence untouched on a fast failed tick', () => {
    expect(
      nextKeepWarmIntervalMs({ currentIntervalMs: 180_000, baseMs: 45_000, workMs: 10, tickOk: false }),
    ).toBe(180_000);
  });

  it('treats exactly KEEPWARM_SLOW_MS as fast (strict >, not >=)', () => {
    expect(
      nextKeepWarmIntervalMs({ currentIntervalMs: 90_000, baseMs: 45_000, workMs: KEEPWARM_SLOW_MS, tickOk: true }),
    ).toBe(45_000);
  });
});

describe('resolveEmbedKeepWarmMs (env parsing)', () => {
  const ENV_KEY = 'SOX_EMBED_KEEPWARM_MS';
  const original = process.env[ENV_KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    vi.restoreAllMocks();
  });

  it('defaults to 45000ms when unset', () => {
    delete process.env[ENV_KEY];
    expect(resolveEmbedKeepWarmMs()).toBe(45_000);
  });

  it('defaults to 45000ms when empty string', () => {
    process.env[ENV_KEY] = '';
    expect(resolveEmbedKeepWarmMs()).toBe(45_000);
  });

  it('parses a valid override', () => {
    process.env[ENV_KEY] = '10000';
    expect(resolveEmbedKeepWarmMs()).toBe(10_000);
  });

  it('allows 0 to disable keep-warm', () => {
    process.env[ENV_KEY] = '0';
    expect(resolveEmbedKeepWarmMs()).toBe(0);
  });

  it('falls back to the default and does not throw on a malformed value', () => {
    process.env[ENV_KEY] = 'not-a-number';
    expect(resolveEmbedKeepWarmMs()).toBe(45_000);
  });

  it('falls back to the default on a negative value', () => {
    process.env[ENV_KEY] = '-5';
    expect(resolveEmbedKeepWarmMs()).toBe(45_000);
  });
});

describe('resolveEmbedKeepWarmActiveWindowMs (env parsing)', () => {
  const ENV_KEY = 'SOX_EMBED_KEEPWARM_ACTIVE_WINDOW_MS';
  const original = process.env[ENV_KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('defaults to 900000ms when unset', () => {
    delete process.env[ENV_KEY];
    expect(resolveEmbedKeepWarmActiveWindowMs()).toBe(900_000);
  });

  it('parses a valid override', () => {
    process.env[ENV_KEY] = '60000';
    expect(resolveEmbedKeepWarmActiveWindowMs()).toBe(60_000);
  });

  it('falls back to the default on a malformed value', () => {
    process.env[ENV_KEY] = 'nope';
    expect(resolveEmbedKeepWarmActiveWindowMs()).toBe(900_000);
  });

  it('falls back to the default on a negative value', () => {
    process.env[ENV_KEY] = '-1';
    expect(resolveEmbedKeepWarmActiveWindowMs()).toBe(900_000);
  });
});
