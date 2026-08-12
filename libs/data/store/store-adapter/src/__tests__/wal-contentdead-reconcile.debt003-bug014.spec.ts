/**
 * DEBT-003 / BUG-014 — the exp8 heal: a fresh open reconciles a
 * CONTENT-PROVEN-DEAD `-tshm` even under a live peer (SPEC §T2, INV-2, INV-3).
 *
 * The BUG-014 deadlock by design: a close()-TRUNCATE (or the exp8 out-of-band
 * zero) empties the `-wal` while the `-tshm` — Turso's WAL-index sidecar —
 * survives, still indexing the frames the empty WAL cannot hold. Every fresh
 * open then short-reads at a frozen offset, and the BUG-009 lease-gate (live
 * peers) forbids the reconcile that is the ONLY cure — so the retry branch
 * burns its budget on a provably non-transient failure (live 5/5).
 *
 * The heal (SPEC §T2 Changes 1–2): in the non-quiescent catch, BEFORE the
 * retry loop, probe content-deadness (`isTshmContentDead` — WAL 0 bytes, or
 * the tshm's own snapshot beyond the WAL EOF). If dead, reconcile the `-tshm`
 * via `recoverStaleWalIndex({ allowUnderLivePeers: true,
 * requireContentDead: true })` — content-deadness is the gate, not quiescence
 * (triage Probe D proved a content-dead sidecar is safe to move under a live
 * peer: the peer's mmap survives; the sidecar is derived state). Then reopen
 * once. A content-LIVE tshm keeps the BUG-007 guard — never renamed.
 *
 * Harness (exp8 recipe, real engine): a REAL child process
 * (`fixtures/debt003-exp8-child.ts`) connects through the REAL adapter, seeds
 * a populated WAL (50 rows → frames in `-wal` and `-tshm`), and idles holding
 * the store while serving a stdin query protocol. The PARENT fabricates the
 * poisoned state on the TEMP store: `: > store-wal` (zero the WAL out-of-band
 * while the tshm still indexes frames). A fresh adapter open in the parent —
 * under the child's live lease — must SUCCEED via the content-dead reconcile,
 * and the CHILD must still answer queries afterward (Probe D: the peer's
 * in-memory handle is unaffected; the MCP-server incident signature).
 *
 * RED (pre-fix): the non-quiescent catch has no content-dead probe; the fresh
 * open exhausts the 3 retries (identical short read each time) and throws.
 * GREEN (fix): the content-dead probe fires, the tshm is renamed aside, the
 * reopen lands, and the child answers `COUNT=50`.
 *
 * Scratch-copy only — never a live store, never ~/.memory, never a real
 * backlog DB. `tursoDescribe` gate skips when the driver is absent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { TursoAdapterImpl } from '../turso-adapter.js';

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
const CHILD = resolve(HERE, 'fixtures', 'debt003-exp8-child.ts');

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
  return mod.connect(dbPath, { experimental: ['index_method', 'multiprocess_wal'], timeout: 5000 });
}

/**
 * Pre-seed the TEMP store with the incident geometry: schema + a few rows
 * CHECKPOINTED into the main db file (TRUNCATE zeroes the WAL at the end), so
 * the store is openable-with-data even after the WAL is later destroyed. The
 * child then writes 50 more rows into the WAL; the tshm indexes those frames.
 * Zeroing the WAL out-of-band then leaves schema+seed rows in the main db and
 * a tshm claiming frames the empty WAL cannot hold — the exact short-read
 * shape (reproduced live: "short read on WAL frame at offset 32: expected
 * 4096 bytes, got 0").
 */
async function preseedStore(dbPath: string, seedRows = 3): Promise<void> {
  const seed = await rawConnect(dbPath);
  await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  for (let i = 0; i < seedRows; i++) {
    await seed.run('INSERT INTO t (v) VALUES (?)', `seed-${i}`);
  }
  await seed.all('PRAGMA wal_checkpoint(TRUNCATE)');
  await seed.close();
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

/**
 * Ask the child (Probe D) for the row count it sees through ITS OWN
 * connection. Writes `COUNT\n` to its stdin and resolves the `COUNT=<n>` (or
 * `ERR=<msg>`) line it prints in response.
 */
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

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-debt003-exp8-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

tursoDescribe('DEBT-003/BUG-014 — content-dead -tshm reconcile under a live peer (SPEC §T2, exp8)', () => {
  it(
    'heals a poisoned store on the next fresh open while the peer child keeps serving (Probe D)',
    async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const dbPath = join(tmpDir, `exp8-${suffix}.db`);

      // Pre-seed the incident geometry: schema + rows CHECKPOINTED into the
      // main db (the store stays openable-with-data after the WAL zero).
      await preseedStore(dbPath);

      // Spawn the REAL turso multiprocess peer: connects, seeds 50 rows into
      // a populated WAL, idles holding the store + its lease.
      const child: ChildProcess = spawn(
        process.execPath,
        ['--import', 'tsx', CHILD, dbPath],
        { stdio: ['pipe', 'pipe', 'pipe'], cwd: process.cwd() },
      );
      await waitForReady(child);

      try {
        const walPath = dbPath + '-wal';
        const tshmPath = dbPath + '-tshm';
        expect(existsSync(walPath), 'precondition: -wal exists').toBe(true);
        expect(existsSync(tshmPath), 'precondition: -tshm exists').toBe(true);
        expect(
          statSync(walPath).size,
          'precondition: the peer must have populated the WAL with frames',
        ).toBeGreaterThan(0);

        // THE POISON (exp8 recipe): zero the WAL out-of-band while the tshm
        // still indexes its frames — the exact BUG-014 fingerprint (WAL 0
        // bytes + surviving tshm). The child's in-memory handle is untouched.
        truncateSync(walPath, 0);
        expect(statSync(walPath).size, 'the poison must leave a 0-byte WAL').toBe(0);
        expect(existsSync(tshmPath), 'the poison must leave the tshm in place').toBe(true);

        // THE HEAL: a fresh adapter open in the PARENT under the child's live
        // lease must succeed via the content-dead reconcile — RED on pre-fix
        // code (retries exhaust and connect() throws). The open LANDING is
        // the assertion; the WAL was zeroed out-of-band, so the child's
        // uncheckpointed frames are gone with it — only the CHECKPOINTED seed
        // rows (in the main db file) must survive (exp8's documented shape:
        // "fresh opens see empty/failed store until tshm reconciled").
        //
        // (INV-2 acceptance) 5/5 fresh opens must succeed on the previously
        // poisoned store while the live peer is attached — the BUG-014 owner
        // directive: a fresh one-shot open never fails because a server holds
        // the store. The first open heals (moves the dead tshm aside); the
        // next four open against the rebuilt sidecar.
        for (let round = 1; round <= 5; round++) {
          const fresh = await TursoAdapterImpl.connect({ dbPath });
          try {
            // The fresh sidecar was rebuilt and the open landed — the
            // checkpointed seed rows are still queryable.
            const cnt = await fresh.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
            expect(cnt, `INV-2 round ${round}: the healed store must answer queries`).not.toBeNull();
            expect(
              cnt!.c,
              `DEBT-003 round ${round}: the CHECKPOINTED seed rows must survive the heal ` +
                `(frames lost with the zeroed WAL are expected to be gone)`,
            ).toBe(3);
          } finally {
            await fresh.close();
          }
        }

        // INV-3 evidence: the content-dead tshm was renamed aside (never
        // deleted — the forensic record), exactly once.
        const stale = staleSidecars(dbPath).filter((f) => f.includes('-tshm.stale-'));
        expect(
          stale.length,
          'DEBT-003: the content-proven-dead -tshm must have been reconciled (renamed .stale-*)',
        ).toBe(1);

        // Probe D — the peer child STILL answers queries through its own
        // connection after the heal (the MCP-server incident signature: a
        // connection opened BEFORE the poison keeps serving; it does not crash,
        // error, or lose its checkpointed data). The child's own view here is
        // the 3 CHECKPOINTED seed rows — NOT 53.
        //
        // (BUG-021, SPEC §T3) The original spec pinned 53 (seed + the child's
        // 50 WAL frames), but that figure was a stale session-local artifact:
        // the 50 frames were physically destroyed by the out-of-band WAL zero,
        // and whether the child's view briefly retains them depends on which
        // session created the `-tshm`. With the content-deadness trigger, the
        // CHILD's own connect now reconciles the preseed's TRUNCATE-residue
        // `-tshm` (a content-proven-dead 86016-byte index over the 0-byte WAL —
        // the poison shape, INV-3), so the child opens against a REBUILT index
        // and the parent's first fresh open heals via the driver's own sidecar
        // rebuild instead of failing into the adapter catch — syncing the shared
        // wal-index to the truncated-WAL reality. The child then correctly sees
        // 3; the peer-keeps-serving property that Probe D actually guards (no
        // error, data intact) is unchanged.
        const probe = await childCount(child);
        expect(
          probe.error,
          `BUG-014 Probe D: the peer must keep serving — child error: ${probe.error}`,
        ).toBeNull();
        expect(
          probe.count,
          'BUG-014 Probe D: the peer still sees its checkpointed seed rows (3 — the uncheckpointed ' +
            'WAL frames were destroyed by the out-of-band zero; see BUG-021 note)',
        ).toBe(3);
      } finally {
        child.kill('SIGKILL');
        await waitForExit(child);
      }
    },
    120000,
  );
});
