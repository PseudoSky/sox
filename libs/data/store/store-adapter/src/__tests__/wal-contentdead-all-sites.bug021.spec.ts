/**
 * BUG014.T3 — content-deadness at ALL THREE reconcile decision sites (SPEC §T3).
 *
 * The `-tshm` staleness heuristic was mtime-based, but under multiprocess WAL
 * the tshm mtime FREEZES at file creation: a LIVE, healthy WAL-index sidecar
 * reads as "provably stale" to the mtime-vs-wal comparison once a peer's
 * writes advance the `-wal` mtime past the 60 s threshold. That structural
 * false positive produced the 08:28–08:46 rename churn (2026-08-12): a
 * healthy sidecar renamed during a brief quiescent window, the engine rebuilt
 * it, the new sidecar's mtime froze again → flagged stale again → renamed
 * again. Pre-fix, only the non-quiescent open-time catch used the
 * content-deadness discriminator (DEBT-003/T2); the pre-open proactive
 * reconcile and the quiescent `recoverStaleWalIndex` path were still
 * mtime-keyed.
 *
 * This spec pins the swap (SPEC §T3, INV-3) at the two remaining decision
 * sites and the invariant boundary: a CONTENT-PROVEN-DEAD `-tshm` (WAL 0
 * bytes/absent, or its own index extent beyond the WAL EOF) is still renamed;
 * a content-live `-tshm` is NEVER renamed, however large the mtime skew —
 * mtime survives only as a log-only hint in decline/warning text.
 *
 * RED (pre-fix, BL-225):
 *  - Test 1: the healthy multiprocess store's fresh open RENAMES the live
 *    sidecar (false positive) — `.stale-*` appears.
 *  - Test 2: the mtime-backdated-but-content-live sidecar is MOVED by the
 *    quiescent path — it must be declined untouched.
 *  - Tests 3/4a: the content-dead (beyond-EOF) sidecar is DECLINED by the
 *    mtime heuristic (age diff ≈ 0) — it must be renamed.
 *  - Test 4b: the content-live backdated sidecar is MOVED by the proactive
 *    path — it must be declined.
 *
 * Scratch copies only — never a live store, never ~/.memory, never a real
 * backlog DB. Real-engine tests are `tursoDescribe`-gated; the hand-crafted
 * fs fixtures run unconditionally.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { recoverStaleWalIndex, proactivelyReconcileStaleSidecar, setIntegrityReportSink } from '../integrity.js';
import type { IntegrityReportEvent } from '../integrity.js';

const require = createRequire(import.meta.url);

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const CHILD = resolve(HERE, 'fixtures', 'bug021-healthy-peer-child.ts');

// ── Shared helpers ───────────────────────────────────────────────────────────

interface RawDb {
  exec: (sql: string) => Promise<void>;
  run: (sql: string, ...a: unknown[]) => Promise<unknown>;
  all: (sql: string) => Promise<Array<Record<string, unknown>>>;
  close: () => Promise<void>;
}

/** Raw-driver connect with the adapter's exact experimental flags. */
async function rawConnect(dbPath: string): Promise<RawDb> {
  const mod = (await import('@tursodatabase/database')) as {
    connect: (p: string, o?: unknown) => Promise<RawDb>;
  };
  return mod.connect(dbPath, { experimental: ['index_method', 'multiprocess_wal'] });
}

/** Seed a REAL store whose WAL retains frames after close. */
async function seedStore(dbPath: string, rows = 1200): Promise<void> {
  const seed = await rawConnect(dbPath);
  await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  for (let i = 0; i < rows; i++) {
    await seed.run('INSERT INTO t (v) VALUES (?)', 'v'.repeat(400) + i);
  }
  await seed.all('PRAGMA wal_checkpoint(PASSIVE)');
  await seed.close();
}

/** Backdate a file's mtime (and atime) to `msAgo` ms in the past. */
function backdate(path: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  utimesSync(path, t, t);
}

/** Every `.stale-*` sidecar rename under the store (excludes the lease dir). */
function staleSidecars(dbPath: string): string[] {
  return readdirSync(dirname(dbPath)).filter(
    (f) => f.startsWith(basename(dbPath)) && f.includes('.stale-') && !f.includes('.sox-lease.d'),
  );
}

/** Resolve when the child prints `READY=<pid>` (or fail on early exit). */
function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for the peer child READY')),
      30000,
    );
    timer.unref();
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes('READY=')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`peer child exited before READY (code ${code})`));
    });
  });
}

/** Resolve when the child has exited — immediately if it already has. */
function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => child.once('exit', () => done()));
}

/** Ask the child for the row count it sees through ITS OWN connection. */
function childCount(child: ChildProcess): Promise<{ count: number | null; error: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for the child COUNT response')),
      15000,
    );
    timer.unref();
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/COUNT=(\d+)/);
      const e = buf.match(/ERR=(.+)/);
      if (m || e) {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        resolve(
          m
            ? { count: Number(m[1]), error: null }
            : { count: null, error: e?.[1] ?? 'unknown child response' },
        );
      }
    };
    child.stdout?.on('data', onData);
    child.stdin?.write('COUNT\n');
  });
}

// ── Hand-crafted content-dead fixtures (no driver needed) ───────────────────

/**
 * A WAL that `probeWalFrames` accepts as readable: valid magic/version/page
 * size in the 32-byte header plus `frames` zero-filled frames (geometry is
 * what the probe validates — frame payloads are never read).
 */
function craftReadableWal(path: string, frames: number, pageSize = 4096): void {
  const buf = Buffer.alloc(32 + frames * (24 + pageSize));
  buf.writeUInt32BE(0x377f0682, 0); // WAL magic
  buf.writeUInt32BE(4, 4); // version 4
  buf.writeUInt32BE(pageSize, 8); // page size
  buf.writeUInt32BE(0, 12); // checkpoint sequence
  buf.writeUInt32BE(1, 16); // salt 1
  buf.writeUInt32BE(2, 20); // salt 2
  writeFileSync(path, buf);
}

/**
 * A `-tshm` whose 76-byte coordination header claims `maxFrame` (u64 @ 40 /
 * u32 @ 56 — the probe reads the larger). `frame_offset(id) = 32 +
 * (id-1)*(24+page_size)`, so a maxFrame beyond what the WAL's byte size can
 * hold is the Aug-11 "index beyond WAL EOF" content-dead shape.
 */
function craftTshm(path: string, maxFrame: number): void {
  const buf = Buffer.alloc(76);
  buf.write('TSHMWAL\0', 0, 8, 'latin1');
  buf.writeUInt32LE(1, 8); // coordination header version 1
  buf.writeBigUInt64LE(BigInt(maxFrame), 40);
  buf.writeUInt32LE(maxFrame, 56);
  writeFileSync(path, buf);
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bug021-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

// ═══════════════════════════════════════════════════════════════════════════
// (1) THE regression: a healthy multiprocess store's fresh open performs
//     NO rename, however large the mtime skew (RED on pre-fix code)
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BUG014.T3 — healthy multiprocess store: mtime skew never triggers a rename', () => {
  it(
    'a live peer freezes the -tshm mtime while its writes advance the -wal; the fresh open leaves the healthy sidecar in place and the peer keeps serving',
    async () => {
      const dbPath = tempPath('bug021-healthy');
      // The mtime freeze reproduces in seconds with a shrunken threshold; the
      // paced child writes accumulate skew >> threshold by READY.
      const prevThreshold = process.env.SOX_WAL_SIDECAR_STALE_THRESHOLD_MS;
      process.env.SOX_WAL_SIDECAR_STALE_THRESHOLD_MS = '1500';

      const child: ChildProcess = spawn(
        process.execPath,
        ['--import', 'tsx', CHILD, dbPath],
        { stdio: ['pipe', 'pipe', 'pipe'], cwd: process.cwd() },
      );
      try {
        await waitForReady(child);

        // PREMISE (BUG014.T3's documented freeze): the peer's paced writes
        // advanced the -wal mtime far past the frozen -tshm mtime — a
        // "provably stale" reading for the old heuristic. The content is
        // HEALTHY (the sidecar indexes frames the WAL holds). Fail loudly if
        // the premise cannot be built — a vacuous pass is worthless (BL-225).
        const walMtime = statSync(dbPath + '-wal').mtimeMs;
        const tshmMtime = statSync(dbPath + '-tshm').mtimeMs;
        expect(
          walMtime - tshmMtime,
          'precondition: the peer must have built real mtime skew (wal mtime ' +
            `${new Date(walMtime).toISOString()} vs frozen tshm mtime ${new Date(tshmMtime).toISOString()})`,
        ).toBeGreaterThan(1500);

        // THE REGRESSION: a fresh open must NOT rename the healthy sidecar.
        // (Asserted BEFORE close(): the writable close runs the quiescent
        // TRUNCATE + BUG-014 fix-b `resetTshmAfterTruncate`, which LEGITIMATELY
        // renames the tshm it just orphaned — that is close-side hygiene, not
        // the open-side false positive under test.)
        const events: { event: IntegrityReportEvent; detail: string }[] = [];
        setIntegrityReportSink((event, detail) => events.push({ event, detail }));
        try {
          const fresh = await TursoAdapterImpl.connect({ dbPath });
          try {
            const cnt = await fresh.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
            expect(cnt!.c, 'the fresh open must see the peer\'s rows').toBe(20);

            expect(
              staleSidecars(dbPath),
              'BUG014.T3: a healthy content-live -tshm must NOT be renamed by a fresh open, ' +
                'however large the mtime skew (pre-fix the proactive reconcile renamed it — the false positive)',
            ).toHaveLength(0);
            expect(
              events.some((e) => e.event === 'repaired' && /BEFORE the open/.test(e.detail)),
              'no repaired-before-open event may fire for a healthy store: ' + JSON.stringify(events),
            ).toBe(false);
            expect(
              events.some((e) => e.event === 'damaged'),
              'the open must not have failed: ' + JSON.stringify(events),
            ).toBe(false);
          } finally {
            await fresh.close();
          }
        } finally {
          setIntegrityReportSink(null);
        }

        // The peer is genuinely unaffected (healthy multiprocess, Probe D).
        const probe = await childCount(child);
        expect(probe.error, `the peer must keep serving — child error: ${probe.error}`).toBeNull();
        expect(probe.count, 'the peer still sees its own rows').toBe(20);
      } finally {
        child.kill('SIGKILL');
        await waitForExit(child);
        if (prevThreshold === undefined) delete process.env.SOX_WAL_SIDECAR_STALE_THRESHOLD_MS;
        else process.env.SOX_WAL_SIDECAR_STALE_THRESHOLD_MS = prevThreshold;
      }
    },
    90000,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// (2) Site swap, quiescent path: an mtime-backdated but content-LIVE sidecar
//     is declined untouched; the decline carries the mtime hint + frame probe
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BUG014.T3 — recoverStaleWalIndex quiescent path: content-live is declined, content-dead is moved', () => {
  it('an mtime-backdated but content-LIVE -tshm over a non-empty WAL is declined — no rename (RED pre-fix: moved)', async () => {
    const dbPath = tempPath('bug021-quiescent-live');
    await seedStore(dbPath);
    expect(statSync(dbPath + '-wal').size, 'precondition: non-empty WAL').toBeGreaterThan(0);
    // Backdate ONLY the mtime — the content stays consistent with the WAL,
    // which is exactly the healthy-but-skewed state BUG014.T3 removes.
    backdate(dbPath + '-tshm', 120_000);

    const recovery = recoverStaleWalIndex(dbPath);
    expect(recovery.attempted).toBe(false);
    expect(recovery.movedAside).toEqual([]);
    expect(recovery.declined).toMatch(/NOT content-proven dead/i);
    // mtime survives as a log-only hint inside the decline — evidence, not trigger.
    expect(recovery.declined).toMatch(/mtime hint/i);
    // The decline text carries the frame probe (SPEC §T3).
    expect(recovery.declined).toMatch(/WAL frame probe/);
    expect(existsSync(dbPath + '-tshm'), 'the content-live sidecar must be left untouched').toBe(true);
  });

  it('a content-dead -tshm (index extent beyond the WAL EOF) is still renamed — only the -tshm moves', () => {
    const dbPath = tempPath('bug021-quiescent-dead');
    // Hand-crafted beyond-EOF shape: 3 frames in the WAL, the tshm claiming
    // frame 999 → last offset 32 + 998*4120 = 4111192 > 12392-byte WAL EOF.
    craftReadableWal(dbPath + '-wal', 3);
    craftTshm(dbPath + '-tshm', 999);
    writeFileSync(dbPath, '');

    const recovery = recoverStaleWalIndex(dbPath);
    expect(recovery.attempted).toBe(true);
    expect(recovery.movedAside.length).toBe(1);
    expect(recovery.movedAside[0]!.from).toBe(dbPath + '-tshm');
    expect(recovery.movedAside[0]!.to).toMatch(/-tshm\.stale-\d{4}-\d{2}-\d{2}-\d{4}/);
    expect(existsSync(dbPath + '-tshm'), 'the dead sidecar must be RENAMED, never deleted').toBe(false);
    expect(existsSync(recovery.movedAside[0]!.to)).toBe(true);
  });

  it('a content-dead -tshm beside an ABSENT WAL is still renamed (empty-WAL reconcile preserved)', () => {
    const dbPath = tempPath('bug021-quiescent-walabsent');
    // WAL absent + surviving tshm — the mixed-engine clean-close shape.
    craftTshm(dbPath + '-tshm', 3);
    writeFileSync(dbPath, '');

    const recovery = recoverStaleWalIndex(dbPath);
    expect(recovery.attempted).toBe(true);
    expect(
      recovery.movedAside.some((m) => m.from === dbPath + '-tshm'),
      'the orphaned -tshm must be renamed beside the absent WAL',
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (3) Site swap, proactive pre-open path: content is the trigger, mtime is a
//     log-only hint
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BUG014.T3 — proactivelyReconcileStaleSidecar: content-live is declined, content-dead is moved', () => {
  it('an mtime-backdated but content-LIVE sidecar is declined with the mtime hint (RED pre-fix: moved)', async () => {
    const dbPath = tempPath('bug021-proactive-live');
    await seedStore(dbPath);
    backdate(dbPath + '-tshm', 120_000);

    const result = proactivelyReconcileStaleSidecar(dbPath);
    expect(result.moved).toBe(false);
    expect(result.declined).toMatch(/NOT content-proven dead/i);
    expect(result.declined).toMatch(/mtime hint/i);
    expect(existsSync(dbPath + '-tshm'), 'the content-live sidecar must be left untouched').toBe(true);
  });

  it('a content-dead sidecar (beyond-EOF shape) is moved BEFORE the open (RED pre-fix: declined — age diff ≈ 0)', () => {
    const dbPath = tempPath('bug021-proactive-dead');
    craftReadableWal(dbPath + '-wal', 3);
    craftTshm(dbPath + '-tshm', 999);
    writeFileSync(dbPath, '');

    const result = proactivelyReconcileStaleSidecar(dbPath);
    expect(result.moved).toBe(true);
    expect(result.to).toMatch(/-tshm\.stale-\d{4}-\d{2}-\d{2}-\d{4}/);
    expect(existsSync(dbPath + '-tshm'), 'the dead sidecar must be moved aside').toBe(false);
    expect(existsSync(result.to!)).toBe(true);
  });

  it('the storeInUse quiescence gate is unchanged: a live peer still means decline (BUG-007 guard)', () => {
    const dbPath = tempPath('bug021-proactive-inuse');
    craftTshm(dbPath + '-tshm', 999);
    writeFileSync(dbPath, '');

    const result = proactivelyReconcileStaleSidecar(dbPath, { storeInUse: true });
    expect(result.moved).toBe(false);
    expect(result.declined).toMatch(/in use by another connection/);
    expect(existsSync(dbPath + '-tshm'), 'the live-store sidecar must never be touched').toBe(true);
  });
});
