/**
 * write-queue-race.spec.ts — BL-402.
 *
 * `WriteQueue.forPath()`'s check (`instances.get`) and set (`instances.set`)
 * are separated by an `await` on `_create()` → `openDb()`. Two callers racing
 * on the SAME never-before-seen `dbPath` both observe `undefined` before
 * either has set the Map entry, so BOTH independently call `openDb(dbPath)` —
 * each paying the full open sequence (sqlite-vec load, Turso-compat VACUUM
 * check, WAL-index sidecar repair, migration checks) concurrently against the
 * same file. Measured cost in the wild: ~5.2s wall-clock for what should be a
 * cached-instance return in the microsecond range on the second caller.
 *
 * `openDb` is mocked here (not a real db.ts call) so the test is deterministic
 * and fast: it isolates the race in `forPath` itself rather than depending on
 * real I/O timing to open the window.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./db.js', () => ({
  openDb: vi.fn(),
}));

import { openDb } from './db.js';
import { WriteQueue } from './write-queue.js';

describe('BL-402: WriteQueue.forPath check-then-set race', () => {
  const dbPath = '/tmp/bl402-fake-store.db';

  beforeEach(async () => {
    await WriteQueue.clearInstances();
    vi.mocked(openDb).mockReset();
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    vi.mocked(openDb).mockReset();
  });

  it('BL-402: two concurrent forPath() calls for a never-before-seen path invoke openDb() exactly once', async () => {
    let resolveOpen!: (adapter: unknown) => void;
    const openGate = new Promise((resolve) => {
      resolveOpen = resolve;
    });
    const fakeAdapter = {
      capabilities: { needsWriteSerialization: true },
      pragmaSet: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    // openDb() does not resolve immediately — this holds the race window open
    // long enough for BOTH forPath() calls to observe the empty instance map
    // before either has a chance to populate it, which is exactly the failure
    // mode BL-402 describes (a real openDb() takes long enough on its own,
    // this just makes the window deterministic instead of timing-dependent).
    vi.mocked(openDb).mockImplementation(() => openGate as Promise<any>);

    // Fire both calls in the same microtask tick — neither has awaited
    // anything yet, so both see the map as empty.
    const p1 = WriteQueue.forPath(dbPath);
    const p2 = WriteQueue.forPath(dbPath);

    // Give both calls a chance to reach (and pass) the `instances.get` check
    // before openDb resolves.
    await new Promise((r) => setTimeout(r, 20));
    resolveOpen(fakeAdapter);

    const [q1, q2] = await Promise.all([p1, p2]);

    expect(openDb).toHaveBeenCalledTimes(1);
    expect(q1).toBe(q2);
  });
});
