/**
 * BUG-015 — TursoAdapter poison-reconnect leaked one orphaned-but-live lease
 * entry per recovery.
 *
 * `TursoAdapterImpl._reconnect()` recovers from a poisoned connection
 * (`isFatalConnectionError`) by calling `TursoAdapterImpl._openReal()` to get
 * a fresh driver handle. `_openReal()`/`connect()` unconditionally acquires a
 * new cross-process lease entry for any `dbPath` — but the fix under test is
 * that `_reconnect()`'s poison-recovery branch must release that FRESH
 * instance's lease (its own original `this._lease` stays valid and
 * untouched) rather than silently discarding the `fresh` instance and
 * leaking its lease entry into `<dbPath>.sox-lease.d/` for the rest of the
 * process's life.
 *
 * A leaked entry is invisible to `storeQuiescence()`'s dead-pid sweep — the
 * owning pid IS this live process — so it permanently inflates the live-peer
 * count every other connection's close()/TRUNCATE gate observes.
 *
 * This test proves the leak directly: it counts real lease-dir entries
 * (excluding dotfiles/`.openmark` markers, matching `storeQuiescence()`'s own
 * filter) before and after a forced poison-reconnect cycle. Before the fix,
 * the count grows by +1 per poison-reconnect; after the fix, it is unchanged
 * (the original entry persists, the fresh one is immediately released).
 *
 * Fault injection follows the same monkey-patch-the-native-handle pattern as
 * `connection-recycle.bug-turso-wal.test.ts` AC-1 — no new production
 * test-hooks required.
 *
 * Data-destructive risk: none. Every store used here is a fresh
 * `mkdtempSync` temp file, never `~/.memory/*` or `~/.adhd/backlog/*`.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { leaseDirPath } from '../store-lease.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();

const tursoDescribe = hasTurso ? describe : describe.skip;

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bug015-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

const openAdapters: TursoAdapterImpl[] = [];

async function connect(dbPath: string): Promise<TursoAdapterImpl> {
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  openAdapters.push(adapter);
  return adapter;
}

afterEach(async () => {
  while (openAdapters.length > 0) {
    const a = openAdapters.pop()!;
    try {
      await a.close();
    } catch {
      // already closed / reconnect left a stale handle we don't own anymore
    }
  }
});

/** The incident's own text, verbatim, from the BL-TURSO-WAL item body — reused
 *  here purely as a realistically-shaped fatal fault to force `_reconnect()`. */
function fatalError(): Error & { code: string } {
  return Object.assign(
    new Error(
      'reset failed: I/O error: short read on WAL frame at offset 4152: expected 4096 bytes, got 0',
    ),
    { code: 'GenericFailure' },
  );
}

/** Real lease entries only — mirrors `storeQuiescence()`'s own filter
 *  (dot-names and `.openmark` per-connection open markers are not leases). */
function leaseEntryCount(dbPath: string): number {
  let names: string[];
  try {
    names = readdirSync(leaseDirPath(dbPath));
  } catch {
    return 0;
  }
  return names.filter((n) => !n.startsWith('.') && !n.endsWith('.openmark')).length;
}

tursoDescribe('TursoAdapterImpl — poison-reconnect lease leak (BUG-015)', () => {
  it('BUG-015: a poison-reconnect leaves the lease-dir entry count UNCHANGED, not +1', async () => {
    const dbPath = tempPath('bug015');
    const adapter = await connect(dbPath);
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await adapter.executeRun('INSERT INTO t (name) VALUES (?)', ['a']);

    // Exactly one entry: this adapter's own original lease.
    const before = leaseEntryCount(dbPath);
    expect(before).toBe(1);

    const raw = adapter.unwrap() as unknown as {
      all: (...args: unknown[]) => Promise<unknown>;
    };
    const realAll = raw.all.bind(raw);
    let allCalls = 0;
    raw.all = async (...args: unknown[]) => {
      allCalls++;
      if (allCalls === 1) throw fatalError();
      return realAll(...args);
    };

    // Force a poison → reconnect cycle. The failing call rejects with the
    // fatal fault; the adapter reports poisoned; a subsequent call drives
    // `_ensureHealthy()` → `_reconnect()` → `_openReal()` (which acquires a
    // FRESH lease entry) → recovery.
    await expect(adapter.executeAll('SELECT * FROM t')).rejects.toThrow(/short read on WAL frame/);
    expect(adapter.connectionHealth).toBe('poisoned');

    const pingResult = await adapter.executeGet<{ x: number }>('SELECT 1 AS x');
    expect(pingResult).toEqual({ x: 1 });
    expect(adapter.connectionHealth).toBe('healthy');

    // Proves a real reconnect happened (a new driver handle, therefore a new
    // `fresh` instance and a new lease acquisition inside `_openReal()`) —
    // otherwise this test would trivially pass by never exercising the leak
    // at all. Boolean compare (not `.not.toBe()`) for the same reason as
    // `connection-recycle.bug-turso-wal.test.ts` AC-1: comparing the stale,
    // already-closed native handle on a FAILING assertion would throw from
    // vitest's own inspect path and mask the real failure.
    expect(adapter.unwrap() !== raw).toBe(true);

    // THE ASSERTION: pre-fix, `fresh._lease` from the reconnect's
    // `_openReal()` call is discarded without release — the count grows to
    // 2. Post-fix, `_reconnect()`'s poison-recovery branch releases it
    // immediately, so the original entry is the only survivor.
    const after = leaseEntryCount(dbPath);
    expect(after).toBe(before);
  });

  it('BUG-015 sibling: three sequential poison-reconnects on the same adapter never accumulate leases', async () => {
    const dbPath = tempPath('bug015-repeat');
    const adapter = await connect(dbPath);
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');

    expect(leaseEntryCount(dbPath)).toBe(1);

    for (let i = 0; i < 3; i++) {
      const raw = adapter.unwrap() as unknown as {
        get: (...args: unknown[]) => Promise<unknown>;
      };
      const realGet = raw.get.bind(raw);
      let getCalls = 0;
      raw.get = async (...args: unknown[]) => {
        getCalls++;
        if (getCalls === 1) throw fatalError();
        return realGet(...args);
      };

      await expect(adapter.executeGet('SELECT 1 AS x')).rejects.toThrow(/short read on WAL frame/);
      expect(adapter.connectionHealth).toBe('poisoned');
      await adapter.executeGet('SELECT 1 AS x'); // triggers reconnect + recovery
      expect(adapter.connectionHealth).toBe('healthy');

      // Never grows past the single original entry, no matter how many
      // poison-reconnects this same adapter instance goes through.
      expect(leaseEntryCount(dbPath)).toBe(1);
    }
  });
});
