/**
 * BUG-014 — content-proven-dead -tshm reconcile under a live peer, and the
 * close()-TRUNCATE tshm-reset (adapter-race-fix follow-on, 2026-08-12).
 *
 * DEFECT: the 0.5.7 lease-gate (BUG-009, commit b01c137a) gated sidecar
 * reconcile on QUIESCENCE. When a close()-TRUNCATE zeroed the `-wal` but the
 * `-tshm` survived (the BL-512 close shape + a dead writer), the ONLY cure —
 * moving the tshm aside — was declined while live peers held leases, and the
 * BUG-009 retry branch burned its budget on a provably non-transient failure
 * (identical short-read every retry; the incident failed 5/5). 0.5.6
 * (99ab90eb) reconciled unconditionally and self-healed — the regression.
 *
 * FIX (triage ses_0098321fdffedI1afGpuMR9CyH, evidence-backed — Probe D proved
 * reconcile-under-live-peer is safe for content-dead tshms):
 *  (a) the open-time catch, BEFORE the transient-retry branch, reconciles a
 *      CONTENT-PROVEN-DEAD tshm even under a live peer. The discriminator is
 *      content, never mtime: the `-wal` is 0 bytes/absent, or the tshm's own
 *      snapshot indexes a frame offset beyond the WAL EOF. A tshm indexing
 *      frames a 0-byte WAL cannot contain is not being used by anyone — the
 *      BUG-007 guard (a genuinely fresh tshm under live peers) is untouched.
 *  (b) close() resets the tshm beside its own successful quiescent TRUNCATE,
 *      so the stale-index state never persists (root-cause complement).
 *
 * RED→GREEN (BL-225, named BUG-014): against the pre-fix catch —
 *  (1) live-peer + stale tshm + 0-byte WAL: the open defers and retries
 *      (3 driver calls) then THROWS the original error; the tshm is never
 *      moved. Post-fix: ONE reconcile (tshm moved) + ONE retried open.
 *  (2) fresh tshm under live peers: pre- and post-fix behavior is identical
 *      defer + retry + exhaustion (3 calls, no reconcile) — the BUG-007 guard.
 *  (3) close() with a successful quiescent TRUNCATE: pre-fix the -tshm
 *      survives the close; post-fix it is moved aside.
 *
 * Integration (real engine, tursoDescribe — skipped when the driver is
 * absent): the incident shape built with REAL engine state (writer fixture
 * with checkpoint history, SIGKILLed; WAL fs-truncated) + a real long-lived
 * peer process. The fresh adapter open short-reads pre-reconcile, reconciles
 * under the peer lease, and succeeds; the long-lived peer still serves.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
  existsSync,
  truncateSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { acquireStoreLease } from '../store-lease.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

// ── Driver mock (unit tests only — the integration tests use the real engine
//    via child-process fixtures, so the file-scoped mock never touches them) ──
const mockDriverConnect = vi.fn();

vi.mock('@tursodatabase/database', () => ({
  connect: (...args: unknown[]) => mockDriverConnect(...args),
}));

function makeFakeDb(busy: number = 0): any {
  return {
    run: async () => ({ changes: 1, lastInsertRowid: 1 }),
    get: async () => null,
    all: async (sql: string) => {
      if (/wal_checkpoint/.test(sql)) return [{ busy, log: 0, checkpointed: 0 }];
      return [];
    },
    exec: async () => undefined,
    close: async () => undefined,
    pragma: async () => [],
  };
}

/** The exact short-read text of the BUG-014 incident (offset 2101232). */
function shortReadError(): Error {
  return Object.assign(
    new Error(
      'failed to open database: I/O error: short read on WAL frame at offset 2101232: expected 4096 bytes, got 0',
    ),
    { code: 'GenericFailure' },
  );
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bug014-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

/** Backdate a file's mtime (and atime) to `msAgo` ms in the past. */
function backdate(path: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  utimesSync(path, t, t);
}

/** Every `.stale-*` sidecar rename under the store. */
function staleSidecars(dbPath: string): string[] {
  return readdirSync(dirname(dbPath)).filter(
    (f) => f.startsWith(basename(dbPath)) && f.includes('.stale-'),
  );
}

/** Fabricate a `-tshm` with a 76-byte coordination header (TSHMWAL v1). */
function writeFakeTshm(dbPath: string, maxFrame: number): void {
  const buf = Buffer.alloc(76);
  buf.write('TSHMWAL\0', 0, 8, 'latin1');
  buf.writeUInt32LE(1, 8); // version
  buf.writeUInt32LE(64, 12); // reader_slot_count
  buf.writeBigUInt64LE(BigInt(maxFrame), 40); // frame extent (u64)
  buf.writeUInt32LE(maxFrame, 56); // frame extent (u32)
  writeFileSync(dbPath + '-tshm', buf);
}

/**
 * Fabricate a WAL with a VALID header + `frameCount` frames of zeros — enough
 * for probeWalFrames to read it (magic 0x377f0682 BE, page size 4096) while
 * the tshm's claimed extent decides content-deadness.
 */
function writeFakeWal(dbPath: string, frameCount: number): void {
  const size = 32 + frameCount * (24 + 4096);
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(0x377f0682, 0);
  buf.writeUInt32BE(1, 4); // version
  buf.writeUInt32BE(4096, 8); // page size
  writeFileSync(dbPath + '-wal', buf);
}

/** Truncate the WAL to 0 bytes (the dead truncator from the incident). */
function zeroWal(dbPath: string): void {
  writeFileSync(dbPath + '-wal', Buffer.alloc(0));
}

const openAdapters: TursoAdapterImpl[] = [];

beforeEach(() => {
  mockDriverConnect.mockReset();
});

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

async function connect(dbPath: string): Promise<TursoAdapterImpl> {
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  openAdapters.push(adapter);
  return adapter;
}

// ═══════════════════════════════════════════════════════════════════════════
// (a) PRIMARY — content-proven-dead reconcile under a live peer
// ═══════════════════════════════════════════════════════════════════════════

describe('BUG-014 — open-time catch: a content-dead -tshm is reconciled EVEN THOUGH a live peer holds the store', () => {
  it('(1) live-peer lease + stale tshm + 0-byte WAL: reconcile the tshm and the retried open succeeds', async () => {
    const dbPath = tempPath('bug014-dead-0byte-wal');
    // The incident shape: a tshm claiming real frames over a 0-byte WAL. The
    // WAL is empty; the tshm's mtime is frozen old (the mtime heuristic says
    // stale — but the fix must rely on CONTENT, which says dead here).
    zeroWal(dbPath);
    writeFakeTshm(dbPath, 511);
    backdate(dbPath + '-tshm', 120_000);

    // A live peer holds the store through its lease — exactly the shape where
    // the 0.5.7 gate deadlocked the incident (5/5 failed opens).
    const peer = await acquireStoreLease(dbPath);
    try {
      // First open fails with the incident's short-read; the content-dead
      // reconcile moves the tshm, and the retried open lands.
      mockDriverConnect
        .mockRejectedValueOnce(shortReadError())
        .mockResolvedValueOnce(makeFakeDb());

      const adapter = await connect(dbPath); // must NOT throw post-fix

      expect(
        mockDriverConnect,
        'BUG-014: the content-dead branch must reconcile and retry ONCE (1 fail + 1 success = 2 driver calls) — pre-fix the retry branch burned 3 calls on a provably non-transient failure',
      ).toHaveBeenCalledTimes(2);
      expect(
        staleSidecars(dbPath),
        'the content-dead -tshm must be moved aside even though a live peer holds the store',
      ).toHaveLength(1);
      expect(existsSync(dbPath + '-tshm'), 'the tshm must be gone from the path').toBe(false);
      expect(adapter).toBeInstanceOf(TursoAdapterImpl);
    } finally {
      await peer.release();
    }
  });

  it('(2) fresh tshm under a live peer still defers (BUG-007 guard): no reconcile, bounded retry, original error', async () => {
    const dbPath = tempPath('bug014-fresh-tshm');
    // Content-CONSISTENT state: a non-empty WAL whose extent matches the
    // tshm's claim (1 frame at offset 32, WAL exactly 4152 bytes). The mtime
    // heuristic would call this stale (backdated 2 min) — the fix must NOT
    // reconcile it: a live peer may genuinely be using this index.
    writeFakeWal(dbPath, 1);
    writeFakeTshm(dbPath, 1);
    backdate(dbPath + '-tshm', 120_000);

    const peer = await acquireStoreLease(dbPath);
    try {
      const original = shortReadError();
      mockDriverConnect.mockRejectedValue(original);

      let thrown: unknown;
      try {
        await connect(dbPath);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeDefined();
      expect(
        mockDriverConnect,
        'a NOT-content-dead tshm keeps the BUG-009 bounded retry (1 initial + 2 retries = 3 driver calls)',
      ).toHaveBeenCalledTimes(3);
      expect(thrown instanceof Error && (thrown as Error).message).toBe(original.message);
      expect((thrown as { retryable?: boolean }).retryable).toBe(true);
      expect(
        staleSidecars(dbPath),
        'BUG-007: a live store with a fresh tshm must NEVER be reconciled',
      ).toHaveLength(0);
      expect(existsSync(dbPath + '-tshm'), 'the fresh -tshm must survive untouched').toBe(true);
    } finally {
      await peer.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) COMPLEMENT — close() resets the tshm beside its own successful TRUNCATE
// ═══════════════════════════════════════════════════════════════════════════

describe('BUG-014 — close() resets the -tshm beside a successful quiescent TRUNCATE', () => {
  it('(3) solo close with busy=0 TRUNCATE: the -tshm residue is moved aside', async () => {
    const dbPath = tempPath('bug014-close-reset');
    mockDriverConnect.mockResolvedValue(makeFakeDb(0));
    const adapter = await connect(dbPath);
    // Fabricate the residue the engine leaves behind (the close-TRUNCATE
    // zeroes the -wal but not the -tshm).
    writeFakeTshm(dbPath, 0);
    expect(existsSync(dbPath + '-tshm'), 'precondition: tshm residue present').toBe(true);

    await adapter.close();

    expect(
      existsSync(dbPath + '-tshm'),
      'BUG-014: after a successful quiescent TRUNCATE the -tshm residue must be moved aside — the stale-index state must never persist',
    ).toBe(false);
    expect(
      staleSidecars(dbPath),
      'the orphaned -tshm must be renamed aside (forensic record), not deleted',
    ).toHaveLength(1);
  });

  it('(3b) busy=1 TRUNCATE: the tshm is NOT touched — the WAL still holds frames it describes', async () => {
    const dbPath = tempPath('bug014-close-busy');
    mockDriverConnect.mockResolvedValue(makeFakeDb(1));
    const adapter = await connect(dbPath);
    writeFakeTshm(dbPath, 1);

    await adapter.close();

    expect(
      existsSync(dbPath + '-tshm'),
      'a deferred (busy=1) TRUNCATE leaves frames in the WAL — the tshm still describes real content and must survive',
    ).toBe(true);
    expect(staleSidecars(dbPath)).toHaveLength(0);
  });

  it('(3c) close with a live peer lease: the TRUNCATE is deferred, so the tshm is untouched', async () => {
    const dbPath = tempPath('bug014-close-peer');
    mockDriverConnect.mockResolvedValue(makeFakeDb(0));
    const adapter = await connect(dbPath);
    writeFakeTshm(dbPath, 1);

    const peer = await acquireStoreLease(dbPath);
    try {
      await adapter.close();
    } finally {
      await peer.release();
    }

    expect(
      existsSync(dbPath + '-tshm'),
      'BUG-008: under a live peer the TRUNCATE is deferred and the tshm must survive',
    ).toBe(true);
    expect(staleSidecars(dbPath)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration — the incident shape with the REAL engine (copy-store only)
// ═══════════════════════════════════════════════════════════════════════════

const HERE = resolve(__dirname, '..');
const WRITER = resolve(HERE, '__tests__', 'fixtures', 'bug014-writer.ts');
const PEER = resolve(HERE, '__tests__', 'fixtures', 'bug014-peer.ts');
const FRESH_OPEN = resolve(HERE, '__tests__', 'fixtures', 'bug014-fresh-open.ts');

/** Spawn a fixture in a fresh process and wait for its marker file to appear
 *  with content; resolves to the marker's last line. */
async function runFixture(
  script: string,
  args: string[],
  marker: string,
  timeoutMs = 30_000,
): Promise<string> {
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], { stdio: 'ignore' });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(marker)) {
      return readFileSync(marker, 'utf8').trim().split('\n').pop() ?? '';
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`timed out waiting for marker ${marker}`);
}

/** Wait for a marker file that is being REWRITTEN by a running fixture (the
 *  marker is deleted first, so a stale read cannot satisfy the wait). */
async function waitForMarkerRewrite(marker: string, timeoutMs = 30_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(marker)) {
      const content = readFileSync(marker, 'utf8').trim().split('\n').pop() ?? '';
      if (content.length > 0) return content;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for rewritten marker ${marker}`);
}

/** Wait for a marker file written by an already-spawned fixture. */
async function waitForMarker(marker: string, timeoutMs = 30_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(marker)) {
      return readFileSync(marker, 'utf8').trim().split('\n').pop() ?? '';
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for marker ${marker}`);
}

tursoDescribe('BUG-014 — integration: incident shape (real engine, copy-store)', () => {
  beforeEach(async () => {
    // The integration tests must drive the REAL engine through the adapter.
    // The file-scoped vi.mock intercepts the adapter's driver import — wire
    // the mock's call-through to the actual driver so the full open-time
    // ceremony runs against the real @tursodatabase/database.
    const real = (await vi.importActual('@tursodatabase/database')) as {
      connect: (...args: unknown[]) => Promise<unknown>;
    };
    mockDriverConnect.mockImplementation((...args: unknown[]) => real.connect(...args));
  });

  it('live-peer lease + stale tshm + 0-byte WAL: the adapter reconciles and the open SUCCEEDS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-adapter-bug014-int-'));
    const dbPath = join(dir, 'incident.db');
    const wReady = join(dir, 'w.marker');
    const seedMod = (await vi.importActual('@tursodatabase/database')) as {
      connect: (p: string, o?: unknown) => Promise<{
        exec: (sql: string) => Promise<void>;
        run: (sql: string, ...a: unknown[]) => Promise<unknown>;
        all: (sql: string) => Promise<Array<Record<string, unknown>>>;
        close: () => Promise<void>;
      }>;
    };
    const seed = await seedMod.connect(dbPath, {
      experimental: ['index_method', 'multiprocess_wal'],
    });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await seed.close();

    // 1. Writer child builds the failing tshm state (checkpoint history +
    //    populated frame index), then is SIGKILLed below — the crash freezes
    //    the coordination state on disk (verified: without the checkpoint the
    //    engine self-heals on the next open; with it, the incident shape).
    const pw = spawn(process.execPath, ['--import', 'tsx', WRITER, dbPath, wReady], {
      stdio: 'ignore',
    });
    await waitForMarker(wReady);

    // 2. The dead truncator zeroes the WAL under the live writer, then the
    //    writer crashes (SIGKILL) — the frozen tshm survives.
    truncateSync(dbPath + '-wal', 0);
    pw.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));

    // Precondition: the fixture genuinely reproduces the incident — a FRESH
    // process open against the frozen tshm must short-read (the same probe
    // the triage ran on the byte-identical copies: 3/3 failed).
    const probeResult = await runFixture(FRESH_OPEN, [dbPath, join(dir, 'probe.marker')], join(dir, 'probe.marker'));
    expect(
      probeResult,
      'precondition: the fixture must reproduce the incident — a fresh open against the frozen tshm short-reads',
    ).toMatch(/^fail:.*short read on WAL frame/i);

    // 3. A live peer holds the store — the incident's deadlock condition.
    const peer = await acquireStoreLease(dbPath);
    try {
      // 4. The FIXED adapter open: pre-reconcile it short-reads, the
      //    content-dead branch moves the tshm, and the retried open lands.
      const adapter = await TursoAdapterImpl.connect({ dbPath });
      openAdapters.push(adapter);
      const row = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
      expect(
        row,
        'BUG-014: the open must succeed against the fresh sidecar (the incident failed 5/5 here)',
      ).not.toBeNull();
      expect(staleSidecars(dbPath).length, 'the content-dead -tshm must have been reconciled').toBe(1);
      expect(existsSync(dbPath + '-tshm'), 'a fresh sidecar must now exist at the path').toBe(true);
    } finally {
      await peer.release();
    }
  }, 60_000);

  it('two-process safety: a long-lived REAL peer survives the reconcile and still serves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-adapter-bug014-2proc-'));
    const dbPath = join(dir, 'twoproc.db');
    const wReady = join(dir, 'w.marker');
    const pReady = join(dir, 'p.marker');
    const seedMod = (await vi.importActual('@tursodatabase/database')) as {
      connect: (p: string, o?: unknown) => Promise<{
        exec: (sql: string) => Promise<void>;
        all: (sql: string) => Promise<Array<Record<string, unknown>>>;
        close: () => Promise<void>;
      }>;
    };
    const seed = await seedMod.connect(dbPath, {
      experimental: ['index_method', 'multiprocess_wal'],
    });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await seed.close();

    // Writer child builds the failing tshm state.
    const pw = spawn(process.execPath, ['--import', 'tsx', WRITER, dbPath, wReady], {
      stdio: 'ignore',
    });
    await waitForMarker(wReady);

    // The long-lived REAL peer (the MCP-server shape the triage demanded be
    // tested with a real connection, not a lease file). The child holds until
    // the `.stop` marker; its final status is read below.
    spawn(process.execPath, ['--import', 'tsx', PEER, dbPath, pReady], { stdio: 'ignore' });
    const peerStatus = await waitForMarker(pReady);
    expect(peerStatus, 'precondition: the peer opened and read the store').toMatch(/^peer:\d+$/);

    // Dead truncator + crash.
    truncateSync(dbPath + '-wal', 0);
    pw.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));

    // In-process lease (the other servers' leases) + the fixed open.
    const peer = await acquireStoreLease(dbPath);
    try {
      const adapter = await TursoAdapterImpl.connect({ dbPath });
      openAdapters.push(adapter);
      const row = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
      expect(row, 'the fresh open must succeed after the reconcile').not.toBeNull();
      expect(staleSidecars(dbPath).length, 'the tshm must have been reconciled under the peer').toBe(1);
    } finally {
      await peer.release();
    }

    // The peer STILL SERVES after the reconcile (its tshm inode was renamed
    // out from under it — POSIX mmap semantics must hold, and its data is
    // checkpointed into the main db).
    rmSync(pReady, { force: true }); // delete so the rewrite is observable
    writeFileSync(pReady + '.stop', 'stop\n');
    const finalStatus = await waitForMarkerRewrite(pReady);
    expect(
      finalStatus,
      'BUG-014: the long-lived peer must still serve reads after the reconcile — this is the proof the triage demanded (Probe D used only a lease file)',
    ).toMatch(/^peer-final:\d+$/);
  }, 60_000);
});
