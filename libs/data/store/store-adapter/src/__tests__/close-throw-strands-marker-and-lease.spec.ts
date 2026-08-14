/**
 * BUG-STOREADAPTER-CLOSE-THROW-STRANDS-MARKER-AND-LEASE — a throwing driver
 * close skipped ALL cleanup.
 *
 * `close()` ended with an unguarded `await this.db.close()` followed by the
 * marker unlink and the lease release. The ordering rationale in those comments
 * is correct — marker and lease genuinely must drop AFTER the driver lets go —
 * but because the close was not in a `try`, a throw meant neither line ran. The
 * process exited still holding a store-open marker and a LIVE lease entry.
 *
 * That is precisely the state the rest of this program is about. An orphaned
 * lease makes the store look permanently BUSY, so every operation correctly
 * gated on quiescence (reconcile, migration, TRUNCATE checkpoint) is blocked
 * forever by a connection that no longer exists — and the pressure that creates
 * is what motivates the destructive sweep path. The strand was also invisible:
 * the throw surfaced as an ordinary close error, and the orphan was only noticed
 * at the NEXT open.
 *
 * The fix wraps the driver close in `try`/`finally` with the cleanup in the
 * `finally`. Three properties matter and are asserted separately below, because
 * a fix that gets any one of them wrong is worse than the bug:
 *
 *   1. cleanup runs even when the driver close throws;
 *   2. the original close error still PROPAGATES (this is not a swallow — a
 *      silent close failure would hide real data-loss signals);
 *   3. a failure inside the cleanup itself does not mask the close error.
 *
 * RED→GREEN staging (BL-225): arms 1 and 3 FAIL against the unguarded close
 * (marker and lease survive; a cleanup throw replaces the close error). Arm 2
 * passes before and after and exists to pin the no-swallow contract, so a future
 * "fix" cannot quietly satisfy arm 1 by catching everything.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { leaseDirPath, storeQuiescence } from '../store-lease.js';
import { canonicalDbPath } from '../path-identity.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try {
      fn?.();
    } catch (err) {
      console.warn('[close-throw] cleanup failed:', err);
    }
  }
});

function makeStore(): string {
  const root = mkdtempSync(join(tmpdir(), 'close-throw-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'store.db');
}

function leaseDirContents(dbPath: string): { leases: string[]; markers: string[] } {
  const dir = leaseDirPath(canonicalDbPath(dbPath));
  if (!existsSync(dir)) return { leases: [], markers: [] };
  const all = readdirSync(dir);
  return {
    leases: all.filter((n) => !n.endsWith('.openmark')),
    markers: all.filter((n) => n.endsWith('.openmark')),
  };
}

describe('BUG-STOREADAPTER-CLOSE-THROW-STRANDS-MARKER-AND-LEASE', () => {
  it('releases the lease AND clears the marker when the driver close throws', async () => {
    const dbPath = makeStore();
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    await adapter.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)');

    // Precondition: this connection holds exactly one lease and one marker.
    const before = leaseDirContents(dbPath);
    expect(before.leases.length).toBe(1);
    expect(before.markers.length).toBe(1);

    // Force the driver close to fail, the way a native fault would.
    const realClose = (adapter as unknown as { db: { close: () => Promise<void> } }).db.close;
    (adapter as unknown as { db: { close: () => Promise<void> } }).db.close = () => {
      throw new Error('simulated driver close failure');
    };

    await expect(adapter.close()).rejects.toThrow(/simulated driver close failure/);

    // THE POINT: cleanup ran anyway. Pre-fix both of these were still present.
    const after = leaseDirContents(dbPath);
    expect(after.markers).toEqual([]);
    expect(after.leases).toEqual([]);

    // And the store is genuinely considered quiescent again, not merely tidy.
    expect(storeQuiescence(canonicalDbPath(dbPath)).quiescent).toBe(true);

    // Restore so teardown does not double-fault.
    (adapter as unknown as { db: { close: () => Promise<void> } }).db.close = realClose;
  });

  it('PROPAGATES the original close error rather than swallowing it', async () => {
    const dbPath = makeStore();
    const adapter = await TursoAdapterImpl.connect({ dbPath });

    const realClose = (adapter as unknown as { db: { close: () => Promise<void> } }).db.close;
    (adapter as unknown as { db: { close: () => Promise<void> } }).db.close = () => {
      throw new Error('distinctive-close-error-marker');
    };

    // A close failure is a data-loss-adjacent signal. Cleanup becoming
    // unconditional must NOT turn it into a silent success.
    await expect(adapter.close()).rejects.toThrow('distinctive-close-error-marker');

    (adapter as unknown as { db: { close: () => Promise<void> } }).db.close = realClose;
  });

  it('is idempotent: a second close after a failed close does not throw again', async () => {
    const dbPath = makeStore();
    const adapter = await TursoAdapterImpl.connect({ dbPath });

    const realClose = (adapter as unknown as { db: { close: () => Promise<void> } }).db.close;
    (adapter as unknown as { db: { close: () => Promise<void> } }).db.close = () => {
      throw new Error('first close fails');
    };
    await expect(adapter.close()).rejects.toThrow(/first close fails/);

    // `closed` is set at the top of close(), so the retry is a no-op. This
    // matters operationally: a caller's `finally { await store.close() }` after
    // a failed close must not raise a second, confusing error.
    (adapter as unknown as { db: { close: () => Promise<void> } }).db.close = realClose;
    await expect(adapter.close()).resolves.toBeUndefined();

    expect(leaseDirContents(dbPath).leases).toEqual([]);
  });

  it('leaves no lease behind on a normal close (control)', async () => {
    const dbPath = makeStore();
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    expect(leaseDirContents(dbPath).leases.length).toBe(1);
    await adapter.close();
    expect(leaseDirContents(dbPath).leases).toEqual([]);
    expect(leaseDirContents(dbPath).markers).toEqual([]);
  });
});
