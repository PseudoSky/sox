/**
 * DEBT-003 / BUG-014 — content-live control (SPEC §T2 Change 3 + Change 4).
 *
 * The heal must NOT fire for a CONTENT-LIVE `-tshm`: a genuinely fresh index
 * under a live peer keeps the BUG-009 defer-and-retry behavior (the BUG-007
 * guard — never rename an index a live peer may be using). And the retry log
 * must serialize the LATEST error (`lastError`), not the original `err`, so
 * operators see the failure class change mid-retry (DEBT-003 fix-packet item
 * 1 / SPEC §T2 Change 4).
 *
 * Harness (deterministic, mocked driver — the heal spec proves the real
 * engine; this one pins the DECISION LOGIC): `@tursodatabase/database` is
 * mocked so every `connect()` rejects with a SHORT-READ error (the same class
 * `isStaleWalIndexError` matches). The on-disk fixture is fabricated to be
 * CONTENT-LIVE: a real-format `-wal` (32-byte header + one 4120-byte frame →
 * 4152 bytes, frame-aligned Shape A) and a real-format `-tshm` (76-byte
 * `TSHMWAL\0` header, `max_frame=1` at both probe offsets → the index claims
 * frame 1 at offset 32, well within the 4152-byte WAL EOF). The adapter is
 * forced into the NON-quiescent branch by an in-process second lease entry
 * (same trick as truncate-race.bug008.spec.ts: the registry counts entries,
 * not processes).
 *
 * RED (pre-fix): the retry loop serializes `err` on EVERY attempt — the
 * second attempt's log carries the ORIGINAL error message, not the latest.
 * GREEN (fix): each retry log serializes `lastError`; the final thrown error
 * is the LAST driver error and carries `retryable: true` (content-live
 * branch — a content-dead failure after reconcile would NOT be retryable,
 * that is the heal spec's shape).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { acquireStoreLease } from '../store-lease.js';
import { log } from '@adhd/sox-telemetry';

const mockDriverConnect = vi.fn();

vi.mock('@tursodatabase/database', () => ({
  connect: (...args: unknown[]) => mockDriverConnect(...args),
}));

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-debt003-live-'));
  mockDriverConnect.mockReset();
});

/** Every `.stale-*` sidecar rename under the store (excludes the lease dir). */
function staleSidecars(dbPath: string): string[] {
  return readdirSync(dirname(dbPath)).filter(
    (f) => f.startsWith(basename(dbPath)) && f.includes('.stale-') && !f.includes('.sox-lease.d'),
  );
}

/**
 * Fabricate a CONTENT-LIVE `-wal` + `-tshm` pair in the real on-disk format.
 * WAL: magic 0x377f0682 (BE) + version 1 + pageSize 4096 (BE) + ckpt seq +
 * salts + one frame (24-byte frame header + 4096-byte page) = 4152 bytes.
 * tshm: `TSHMWAL\0` + version 1 (u32 LE @8) + max_frame u64 LE @40 = 1 and
 * u32 LE @56 = 1 (both probe offsets in lockstep, as the engine keeps them).
 * The index claims frame 1 at offset 32 — inside the WAL — so
 * `isTshmContentDead` MUST verdict `dead: false`.
 */
function fabricateContentLiveSidecar(dbPath: string): void {
  // WAL header (32 bytes, big-endian fields, exactly what probeWalFrames reads).
  const wal = Buffer.alloc(32 + 24 + 4096);
  wal.writeUInt32BE(0x377f0682, 0); // magic
  wal.writeUInt32BE(1, 4); // version
  wal.writeUInt32BE(4096, 8); // page size
  wal.writeUInt32BE(7, 12); // checkpoint sequence
  wal.writeUInt32BE(0x11111111, 16); // salt 1
  wal.writeUInt32BE(0x22222222, 20); // salt 2
  writeFileSync(dbPath + '-wal', wal);

  // tshm coordination header (76 bytes, little-endian fields, exactly what
  // probeTshmFrameExtent reads).
  const tshm = Buffer.alloc(76);
  tshm.write('TSHMWAL\0', 0, 'latin1');
  tshm.writeUInt32LE(1, 8); // version
  tshm.writeBigUInt64LE(1n, 40); // max_frame (u64 LE @40)
  tshm.writeUInt32LE(1, 56); // max_frame (u32 LE @56)
  writeFileSync(dbPath + '-tshm', tshm);
}

describe('DEBT-003 — content-LIVE -tshm keeps the BUG-009 retry path (never renamed), log serializes lastError', () => {
  it('(1) content-live short-read: retries with the LATEST error, exhausts with retryable:true, NO tshm rename', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbPath = join(tmpDir, `live-${suffix}.db`);
    fabricateContentLiveSidecar(dbPath);

    // The three open attempts fail with DISTINCT messages so the serialized
    // error is observable: original, then a shifted offset on each retry.
    mockDriverConnect
      .mockRejectedValueOnce(new Error('I/O error: short read on WAL frame at offset 100: expected 4096 bytes, got 0'))
      .mockRejectedValueOnce(new Error('I/O error: short read on WAL frame at offset 200: expected 4096 bytes, got 0'))
      .mockRejectedValueOnce(new Error('I/O error: short read on WAL frame at offset 300: expected 4096 bytes, got 0'));

    // Force the NON-quiescent branch: a second live lease entry in-process
    // (the adapter's own entry is excluded by token — store-lease.ts:99-107).
    const peer = await acquireStoreLease(dbPath);

    const warnSpy = vi.spyOn(log, 'warn');
    let thrown: unknown = null;
    try {
      try {
        // (DEBT-003, lazy-connect) `connect()` itself no longer opens the
        // driver — it constructs a never-opened shell and always resolves.
        // The mocked driver rejection this test pins now surfaces on the
        // first real operation instead, via `_ensureHealthy()` →
        // `_reconnect()` → `_openReal()`.
        const adapter = await TursoAdapterImpl.connect({ dbPath });
        await adapter.executeGet('SELECT 1');
      } catch (err) {
        thrown = err;
      }
    } finally {
      await peer.release();
    }

    // The thrown error must be the LATEST driver error (offset 300), and the
    // content-live branch marks it retryable — the caller decides beyond the
    // adapter bound (ADR-0012 §4).
    expect(thrown, 'the connect must exhaust and throw').not.toBeNull();
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(
      msg,
      'DEBT-003: on exhaustion the content-live branch throws the LATEST error, not the original',
    ).toContain('offset 300');
    expect(
      (thrown as { retryable?: boolean } | null)?.retryable,
      'DEBT-003: a content-LIVE failure is transient — retryable must be true',
    ).toBe(true);

    // The retry log must serialize the LATEST error each attempt (Change 4).
    const retryLogs = warnSpy.mock.calls.filter((c) => c[0] === 'store_adapter.turso.open_shortread_transient_retry');
    expect(
      retryLogs.length,
      'the bounded retry must have run for the content-live branch',
    ).toBeGreaterThanOrEqual(2);
    const lastAttemptPayload = retryLogs[retryLogs.length - 1]?.[1] as { error?: string } | undefined;
    expect(
      lastAttemptPayload?.error ?? '',
      'DEBT-003 (Change 4): the retry-attempt log must serialize the LATEST error (lastError), not the original err',
    ).toContain('offset 200');

    // BUG-007 guard: the content-live tshm is NEVER renamed.
    expect(
      staleSidecars(dbPath),
      'DEBT-003: a content-LIVE -tshm must never be renamed (BUG-007 guard)',
    ).toHaveLength(0);
    expect(
      existsSync(dbPath + '-tshm'),
      'the content-live -tshm must still be in place at its original path',
    ).toBe(true);

    warnSpy.mockRestore();
  });
});
