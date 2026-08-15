import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * DEBT-EPIC-HOTPATH-REDUNDANT-IO-001 — the "worst offender": a synchronous
 * filesystem read on EVERY embed invocation.
 *
 * `detectCompetingFastembedHost()` is called from `request()` on every single
 * `embedSingle`/`embedBatch` call (the shared fastembed process client). Before
 * the fix it unconditionally called `existsSync` + `readFileSync` every time —
 * this test proves the fix (a short TTL cache) collapses N calls within the
 * TTL window into exactly ONE real fs read pair, without changing the
 * reported result.
 *
 * `node:fs` is mocked at the module level (hoisted) because vitest cannot spy
 * on individual named ESM exports of a module that's already been bound by a
 * static `import { existsSync, readFileSync } from 'node:fs'` elsewhere in
 * the same module graph ("Cannot redefine property" / module namespace is
 * not configurable).
 */
const existsSyncMock = vi.fn<(path: string) => boolean>(() => false);
const readFileSyncMock = vi.fn<(path: string, enc?: string) => string>(() => '');

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: string) => existsSyncMock(p),
    readFileSync: (p: string, enc?: string) => readFileSyncMock(p, enc),
  };
});

const {
  detectCompetingFastembedHost,
  __resetCompetingHostCacheForTests,
} = await import('./sharedFastembedProcess.js');

describe('DEBT-EPIC-HOTPATH-REDUNDANT-IO-001 — detectCompetingFastembedHost TTL cache', () => {
  beforeEach(() => {
    __resetCompetingHostCacheForTests();
    existsSyncMock.mockReset().mockReturnValue(false);
    readFileSyncMock.mockReset().mockReturnValue('');
  });

  afterEach(() => {
    __resetCompetingHostCacheForTests();
  });

  it('does not call existsSync/readFileSync on every invocation within the TTL window', () => {
    // 50 calls with no cache in front of them would previously be 50 real
    // fs.existsSync calls (the no-lock-file branch never even reaches
    // readFileSync, so this alone proves the per-call I/O is gone).
    for (let i = 0; i < 50; i++) {
      const result = detectCompetingFastembedHost(process.pid);
      expect(result).toBeNull();
    }

    // THE ASSERTION THAT WOULD FAIL PRE-FIX: 50 calls -> 50 existsSync calls.
    // Post-fix: only the first call (cache miss) performs the real read; the
    // remaining 49 are served from the TTL cache.
    expect(existsSyncMock).toHaveBeenCalledTimes(1);
    expect(readFileSyncMock).not.toHaveBeenCalled(); // no lock file -> never reaches readFileSync
  });

  it('re-reads after the TTL expires (the cache does not go stale forever)', () => {
    detectCompetingFastembedHost(process.pid);
    expect(existsSyncMock).toHaveBeenCalledTimes(1);

    // Still within TTL -> cached, no second read.
    detectCompetingFastembedHost(process.pid);
    expect(existsSyncMock).toHaveBeenCalledTimes(1);

    // Force cache expiry (equivalent to TTL elapsing).
    __resetCompetingHostCacheForTests();
    detectCompetingFastembedHost(process.pid);
    expect(existsSyncMock).toHaveBeenCalledTimes(2);
  });

  it('still detects a genuinely competing, live host (correctness preserved)', () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ pid: process.pid, startedAt: '2026-08-14T00:00:00.000Z' }),
    );

    // Lock names OUR OWN pid -> not a competing host (own process wrote it).
    const ownResult = detectCompetingFastembedHost(process.pid);
    expect(ownResult).toBeNull();

    __resetCompetingHostCacheForTests();

    // Lock names a pid that is definitely NOT alive (huge, unlikely-to-exist
    // pid) -> correctly treated as no competing host either.
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ pid: 999999999, startedAt: '2026-08-14T00:00:00.000Z' }),
    );
    const deadResult = detectCompetingFastembedHost(process.pid);
    expect(deadResult).toBeNull();
  });
});
