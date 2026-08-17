/**
 * BUG-008 — the double-TRUNCATE close race (adapter-race-fix plan §10B).
 *
 * Defect: a writable close() ran `PRAGMA wal_checkpoint(TRUNCATE)` TWICE —
 * once unconditionally (`checkpoint()`), then again after `markCleanShutdown`
 * (`if (flushed && !damaged) { await markCleanShutdown(this); await
 * checkpoint(); }`). The second TRUNCATE is a close()-TRUNCATE race window
 * (BUG-008): it physically zeroes the `-wal` (turso wal.rs:5208) while a
 * concurrent opener may be preading frames from it, so every extra TRUNCATE
 * multiplies the short-read window for sibling opens. Worse, close() issued
 * the TRUNCATE regardless of whether any OTHER live connection holds the
 * store — truncating the shared WAL out from under a live peer.
 *
 * The fix (plan §6e): exactly ONE quiescence-gated TRUNCATE per writable
 * close. PASSIVE always runs first (BL-330 durability backstop — copies WAL
 * frames into the main db through the fd we already hold); the clean-shutdown
 * stamp is written BEFORE the single TRUNCATE (gated `!damaged`) so the
 * stamp's single frame is flushed by the SAME truncate; then the TRUNCATE is
 * issued only when `storeQuiescence` reports no other live connection — under
 * contention it is deferred (frames stay durable; the next quiescent close
 * truncates) with a `close_checkpoint_busy` warn.
 *
 * Harness: the driver is mocked (`vi.mock('@tursodatabase/database')`, same
 * shape as open-handshake-retry.test.ts), so the sequence of PRAGMAs the
 * adapter issues through `executeAll`/`executeRun` is fully observable. The
 * fake's `all()` records every SQL text it receives and answers
 * `wal_checkpoint` with a busy=0 row (the driver's real TRUNCATE response when
 * no other connection holds the WAL).
 *
 * RED→GREEN (BL-225): against the pre-fix close() all three of these fail —
 * (1) observes TWO TRUNCATEs instead of one, (2) issues a TRUNCATE despite the
 * peer lease and never emits `close_checkpoint_busy`, (3) a hard readonly
 * close issues no checkpoint (guard — passes on both sides).
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { acquireStoreLease } from '../store-lease.js';
import { log } from '@adhd/sox-telemetry';

// ── Driver mock ──────────────────────────────────────────────────────────────
const mockDriverConnect = vi.fn();

vi.mock('@tursodatabase/database', () => ({
  connect: (...args: unknown[]) => mockDriverConnect(...args),
}));

interface FakeCall {
  method: 'run' | 'all';
  sql: string;
}

/** A driver handle shaped like @tursodatabase/database's Database that
 *  satisfies the post-open connect ceremony AND records every SQL statement
 *  issued through `run`/`all` so the close() PRAGMA sequence is assertable.
 *  `wal_checkpoint` answers with the driver's real busy=0 row shape
 *  (`[{ busy: 0, log: 0, checkpointed: 0 }]` — the raw array, which
 *  `executeAll` wraps into `{ columns, rows }`). */
function makeFakeDb(): any {
  const calls: FakeCall[] = [];
  return {
    __calls: calls,
    __reset: () => {
      calls.length = 0;
    },
    run: async (sql: string) => {
      calls.push({ method: 'run', sql });
      return { changes: 1, lastInsertRowid: 1 };
    },
    get: async () => null,
    all: async (sql: string) => {
      calls.push({ method: 'all', sql });
      if (/wal_checkpoint/.test(sql)) {
        return [{ busy: 0, log: 0, checkpointed: 0 }];
      }
      return [];
    },
    exec: async () => undefined,
    close: async () => undefined,
    pragma: async () => [],
  };
}

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-truncate-race-'));
});

beforeEach(() => {
  mockDriverConnect.mockReset();
});

const openAdapters: TursoAdapterImpl[] = [];

async function connect(dbPath: string, opts: { readonly?: boolean } = {}): Promise<TursoAdapterImpl> {
  const adapter = await TursoAdapterImpl.connect({ dbPath, ...opts });
  openAdapters.push(adapter);
  // (DEBT-003, lazy-connect) `TursoAdapterImpl.connect()` no longer opens the
  // mocked driver eagerly — `lastFakeDb()` below reads `mockDriverConnect`'s
  // results, which stay empty until a real operation forces the open. Force
  // it here (a read is safe even for `readonly` opens) so every existing
  // close()-sequence assertion in this file observes the real fake handle.
  await adapter.executeGet('SELECT 1');
  return adapter;
}

/** The fake driver handle the last connect() opened — its call log is the
 *  observation surface for the close() sequence. (The mock's `results[i].value`
 *  holds the call's Promise — await it for the resolved handle.) */
async function lastFakeDb(): Promise<{ __calls: FakeCall[]; __reset: () => void }> {
  const results = mockDriverConnect.mock.results;
  const result = results[results.length - 1];
  const value = result ? await (result.value as Promise<unknown>) : null;
  return (value as { __calls: FakeCall[]; __reset: () => void } | null) ?? {
    __calls: [],
    __reset: () => {},
  };
}

afterEach(async () => {
  while (openAdapters.length > 0) {
    const a = openAdapters.pop()!;
    try {
      await a.close();
    } catch {
      // already closed / best-effort on the fake handle
    }
  }
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

describe('BUG-008 — a writable close() issues exactly ONE quiescence-gated wal_checkpoint(TRUNCATE)', () => {
  it('(1) solo close: exactly ONE TRUNCATE, preceded by PASSIVE and by the clean-shutdown stamp', async () => {
    const dbPath = tempPath('bug008-solo');
    mockDriverConnect.mockResolvedValue(makeFakeDb());
    const adapter = await connect(dbPath);
    const fake = await lastFakeDb();

    // The connect ceremony runs many queries; the close sequence is what we
    // pin — reset the observation surface immediately before close().
    fake.__reset();

    await adapter.close();

    const calls = fake.__calls;
    const checkpoints = calls.filter((c) => c.method === 'all' && /wal_checkpoint/.test(c.sql));
    const truncates = checkpoints.filter((c) => /TRUNCATE/.test(c.sql));
    const passives = checkpoints.filter((c) => /PASSIVE/.test(c.sql));
    const stamps = calls.filter((c) => c.method === 'run' && /INSERT INTO _adapter_meta/.test(c.sql));

    // BUG-008, pinned: exactly ONE TRUNCATE per close — the pre-fix code ran a
    // second TRUNCATE after the stamp (`if (flushed && !damaged) { markCleanShutdown; checkpoint(); }`).
    expect(truncates, 'exactly one TRUNCATE — the pre-fix double-truncate issued two').toHaveLength(1);
    expect(passives, 'PASSIVE must still run as the durability backstop').toHaveLength(1);

    // Ordering: PASSIVE → stamp → TRUNCATE. The stamp is written BEFORE the
    // single TRUNCATE so its single frame is flushed by the SAME truncate.
    const passiveIdx = calls.findIndex((c) => /PASSIVE/.test(c.sql));
    const stampIdx = calls.findIndex((c) => c.method === 'run' && /INSERT INTO _adapter_meta/.test(c.sql));
    const truncateIdx = calls.findIndex((c) => /TRUNCATE/.test(c.sql));
    expect(passiveIdx).toBeGreaterThanOrEqual(0);
    expect(stampIdx).toBeGreaterThan(passiveIdx);
    expect(truncateIdx).toBeGreaterThan(stampIdx);
    // And the stamp is a clean-shutdown stamp (value '1'), not just any meta write.
    expect(stamps.length, 'the clean-shutdown stamp must be present').toBeGreaterThanOrEqual(1);
  });

  it('(2) close with a peer lease: ZERO TRUNCATE, emits close_checkpoint_busy, does not throw', async () => {
    const dbPath = tempPath('bug008-peer');
    mockDriverConnect.mockResolvedValue(makeFakeDb());
    const adapter = await connect(dbPath);

    // A live peer holds the store through its own lease entry (same process,
    // second entry — the registry counts entries, not processes).
    const peer = await acquireStoreLease(dbPath);
    const fake = await lastFakeDb();
    fake.__reset();

    const warnSpy = vi.spyOn(log, 'warn');
    try {
      await expect(adapter.close()).resolves.toBeUndefined();

      const calls = fake.__calls;
      const truncates = calls.filter((c) => /TRUNCATE/.test(c.sql));
      const passives = calls.filter((c) => /PASSIVE/.test(c.sql));
      expect(
        truncates,
        'BUG-008: with a live peer the -wal must NOT be truncated out from under it',
      ).toHaveLength(0);
      expect(passives, 'PASSIVE still runs — frames stay durable even under contention').toHaveLength(1);
      expect(warnSpy.mock.calls.map((c) => c[0])).toContain(
        'store_adapter.turso.close_checkpoint_busy',
      );
    } finally {
      warnSpy.mockRestore();
      await peer.release();
    }
  });

  it('(3) a hard readonly close issues no checkpoint at all (guard)', async () => {
    const dbPath = tempPath('bug008-readonly');
    mockDriverConnect.mockResolvedValue(makeFakeDb());
    const adapter = await connect(dbPath, { readonly: true });
    const fake = await lastFakeDb();
    fake.__reset();

    await adapter.close();

    const calls = fake.__calls;
    expect(
      calls.filter((c) => /wal_checkpoint/.test(c.sql)),
      'a hard readonly close must never checkpoint the WAL',
    ).toHaveLength(0);
  });
});
