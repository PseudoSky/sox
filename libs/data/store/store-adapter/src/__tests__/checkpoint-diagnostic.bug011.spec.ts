/**
 * BUG-011 — the close() PASSIVE-backstop diagnostic overstates contended
 * closes as data loss.
 *
 * Defect (triage-proven 2026-08-12): the close() PASSIVE backstop emitted
 * `emitIntegrityReport(..., 'repair_failed', 'checkpoint of the WAL failed —
 * data since the last checkpoint is being lost: ...')` whenever
 * `PRAGMA wal_checkpoint(PASSIVE)` threw. Under a CONTENDED close (a peer
 * reader pins the WAL, or the closing connection holds its own read tx)
 * PASSIVE can fail while the frames remain DURABLE in the `-wal` and replay
 * on the next open — nothing is being lost. Since Segment C (BUG-008 fix)
 * made PASSIVE run on EVERY writable close, the overstatement's trigger is
 * now common.
 *
 * The fix distinguishes the two cases at the catch site:
 *   1. Genuine loss (BL-330 orphaned-WAL): the `-wal` is absent, or the
 *      wal_identity probe already flagged it unlinked/replaced. The strong
 *      "data since the last checkpoint is being lost" wording stays.
 *   2. Transient contention: the `-wal` still exists at the catch site, so
 *      the frames are durable. Emitted as the `checkpoint_deferred` event
 *      with the "frames remain durable in the WAL and replay on the next
 *      open (checkpoint deferred)" wording — never a loss claim.
 *
 * Harness: the driver is mocked (same shape as truncate-race.bug008.spec.ts)
 * so `wal_checkpoint(PASSIVE)` can be forced to throw deterministically, and
 * the `-wal` file's real on-disk existence is what the adapter's
 * `existsSync` discriminator reads. `setIntegrityReportSink` captures every
 * emitted event.
 *
 * RED→GREEN (BL-225): against the pre-fix close() the deferral test FAILS —
 * the old code emits `repair_failed` with the "being lost" wording even
 * though the `-wal` is present (the exact overstatement BUG-011 exists to
 * remove). The loss test passes on both sides — it pins the BL-330 wording.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { setIntegrityReportSink } from '../integrity.js';
import type { IntegrityReportEvent } from '../integrity.js';

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
 *  so the close() PRAGMA sequence is observable. `wal_checkpoint(PASSIVE)`
 *  throws when `throwPassive` is set (the contended-close simulation);
 *  `wal_checkpoint(TRUNCATE)` answers with the driver's real busy=0 row. */
function makeFakeDb(opts: { throwPassive?: boolean } = {}): any {
  const calls: FakeCall[] = [];
  return {
    __calls: calls,
    run: async (sql: string) => {
      calls.push({ method: 'run', sql });
      return { changes: 1, lastInsertRowid: 1 };
    },
    get: async () => null,
    all: async (sql: string) => {
      calls.push({ method: 'all', sql });
      if (/wal_checkpoint\(PASSIVE\)/.test(sql) && opts.throwPassive === true) {
        throw new Error('database is locked (contended close)');
      }
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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bug011-'));
});

beforeEach(() => {
  mockDriverConnect.mockReset();
});

const openAdapters: TursoAdapterImpl[] = [];

async function connect(dbPath: string): Promise<TursoAdapterImpl> {
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  openAdapters.push(adapter);
  // (DEBT-003, lazy-connect) `TursoAdapterImpl.connect()` no longer opens the
  // mocked driver (or captures the WAL baseline `close()` reads) eagerly —
  // force it here so both arms' ordering (baseline captured, THEN the -wal
  // unlink in the loss arm, THEN close()) is preserved exactly as before.
  await adapter.executeGet('SELECT 1');
  return adapter;
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

/** Capture every integrity event emitted during `fn`. */
async function captureEvents(
  fn: () => Promise<void>,
): Promise<{ event: IntegrityReportEvent; detail: string }[]> {
  const events: { event: IntegrityReportEvent; detail: string }[] = [];
  setIntegrityReportSink((event, detail) => events.push({ event, detail }));
  try {
    await fn();
  } finally {
    setIntegrityReportSink(null);
  }
  return events;
}

describe('BUG-011 — close() PASSIVE-failure diagnostics distinguish contention from genuine loss', () => {
  it('RED→GREEN: a PASSIVE failure with the -wal PRESENT reports checkpoint_deferred — never "being lost"', async () => {
    const dbPath = tempPath('bug011-deferral');
    // The contention shape: a real -wal file exists on disk, so the frames it
    // holds are durable and replay on the next open.
    writeFileSync(dbPath + '-wal', 'wal-frames');
    mockDriverConnect.mockResolvedValue(makeFakeDb({ throwPassive: true }));
    const adapter = await connect(dbPath);

    const events = await captureEvents(() => adapter.close());

    expect(
      events.some((e) => e.event === 'checkpoint_deferred'),
      `expected a checkpoint_deferred event, got: ${JSON.stringify(events)}`,
    ).toBe(true);
    expect(
      events.some(
        (e) => e.event === 'checkpoint_deferred' && /frames remain durable/.test(e.detail),
      ),
      'the deferral event must carry the durable-frames wording',
    ).toBe(true);
    expect(
      events.some((e) => /being lost/.test(e.detail)),
      `BUG-011: a present -wal means nothing is being lost; the loss claim must not fire. Got: ${JSON.stringify(
        events,
      )}`,
    ).toBe(false);
  });

  it('guard: a PASSIVE failure after the -wal was unlinked mid-session KEEPS the strong loss wording (BL-330)', async () => {
    const dbPath = tempPath('bug011-loss');
    // The BL-330 orphaned-WAL shape: the WAL existed at open (baseline
    // captured) but was unlinked before close — the frames are unreachable.
    writeFileSync(dbPath + '-wal', 'wal-frames');
    mockDriverConnect.mockResolvedValue(makeFakeDb({ throwPassive: true }));
    const adapter = await connect(dbPath);
    unlinkSync(dbPath + '-wal');

    const events = await captureEvents(() => adapter.close());

    expect(
      events.some(
        (e) => e.event === 'repair_failed' && /data since the last checkpoint is being lost/.test(e.detail),
      ),
      `the orphaned-WAL case must keep the strong loss wording. Got: ${JSON.stringify(events)}`,
    ).toBe(true);
  });
});
