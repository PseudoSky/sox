/**
 * BUG-019 — per-connection open marker (SPEC §T5).
 *
 * Before this fix the open marker was ONE shared file (`${dbPath}-openmark`),
 * overwritten by every open and unlinked by ANY orderly writable close. With N
 * concurrent processes (the production shape: 4-6 live MCP servers + short-lived
 * CLI one-shots) the FIRST orderly close deleted the marker while peers were
 * still open, so:
 *
 *  - a later crash of a still-live server left NO unclean-shutdown signal → the
 *    next open skipped the pre-flight that exists to catch panic-on-open schema
 *    states (BL-361 class); and
 *  - conversely, while any long-lived server was up the marker was present for
 *    hours, so EVERY fresh CLI open ran the pre-flight against a live
 *    multiprocess store — the trigger surface for the BUG-017 writable-repair
 *    hazard.
 *
 * The fix: one marker per connection, `<leaseDir>/<token>.openmark` (pid + ISO
 * time), written by `markStoreOpen(dbPath, token)` and unlinked by
 * `clearStoreOpenMarker(dbPath, token)` — which can only ever remove ITS OWN
 * marker. "Unclean shutdown happened" = a marker whose pid is DEAD
 * (`hasUncleanShutdown`, reusing storeQuiescence's liveness logic + the 24 h
 * age-out); "store busy" is derivable without false positives. Dead markers are
 * swept (`sweepDeadOpenMarkers`) after the pre-flight consumes them, so the
 * same crash evidence triggers the pre-flight exactly once. A legacy
 * `${dbPath}-openmark` file is honored as unclean once, then deleted.
 *
 * RED→GREEN staging (BL-225): the turso arms below FAIL with the new marker
 * functions present but the ADAPTER not wired (connect still writes/clears the
 * shared legacy marker): two live sessions leave zero `.openmark` files, a
 * sibling's clean close erases the victim's crash evidence, and the legacy
 * file survives the first open. They PASS once connect keys the marker off the
 * lease token, gates the pre-flight on dead-pid liveness, and sweeps after.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { leaseDirPath } from '../store-lease.js';
import {
  hasUncleanShutdown,
  hasStoreOpenMarker,
  markStoreOpen,
  clearStoreOpenMarker,
  sweepDeadOpenMarkers,
  openMarkerPath,
  storeOpenMarkerPath,
} from '../preflight.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(HERE, 'fixtures', 'bug019-open-child.ts');

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bug019-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

/** The `.openmark` files currently in the store's lease dir (sorted). */
function openMarkers(dbPath: string): string[] {
  try {
    return readdirSync(leaseDirPath(dbPath))
      .filter((f) => f.endsWith('.openmark'))
      .sort();
  } catch {
    return [];
  }
}

/** Create a minimal turso store (a table exists so connect is meaningful). */
async function seedStore(dbPath: string): Promise<void> {
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  try {
    await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  } finally {
    await adapter.close();
  }
}

/** Spawn the child holder; resolves with its pid once it prints READY=. */
function spawnHolder(dbPath: string): { proc: ReturnType<typeof spawn>; ready: Promise<number> } {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD, dbPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: resolve(HERE, '..', '..'),
  });
  const ready = new Promise<number>((resolveReady, rejectReady) => {
    let buf = '';
    proc.stdout?.on('data', (d: Buffer) => {
      buf += String(d);
      const m = buf.match(/READY=(\d+)/);
      if (m) resolveReady(Number(m[1]));
    });
    proc.on('error', rejectReady);
    proc.on('exit', (code, signal) => {
      if (!/READY=/.test(buf)) {
        rejectReady(new Error(`child exited before READY: code=${code} signal=${signal}`));
      }
    });
  });
  return { proc, ready };
}

// ── Pure marker mechanics (no engine needed) ────────────────────────────────

describe('BUG-019 — per-connection open marker mechanics', () => {
  it('a LIVE marker (own pid) is NOT unclean — a concurrent session is never a crash signal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bug019-live-'));
    try {
      const db = join(dir, 'store.db');
      markStoreOpen(db, 'tok-live');
      // The marker FILE exists (one per connection)…
      expect(existsSync(openMarkerPath(db, 'tok-live'))).toBe(true);
      // …but the pid it carries is THIS process — a live session, not an
      // unclean shutdown. The old shared-marker predicate returned true here,
      // which is exactly the false-positive BUG-019 removes.
      expect(hasUncleanShutdown(db)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a DEAD-pid marker IS unclean, and sweepDeadOpenMarkers consumes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bug019-dead-'));
    try {
      const db = join(dir, 'store.db');
      markStoreOpen(db, 'tok-crashed');
      // Rewrite the marker's pid to one no process can hold.
      writeFileSync(openMarkerPath(db, 'tok-crashed'), '99999999\n2026-01-01T00:00:00.000Z\n');
      expect(hasUncleanShutdown(db)).toBe(true);
      expect(sweepDeadOpenMarkers(db)).toBe(1);
      expect(existsSync(openMarkerPath(db, 'tok-crashed'))).toBe(false);
      expect(hasUncleanShutdown(db)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a marker older than 24 h is unclean regardless of pid (pid-reuse age-out)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bug019-aged-'));
    try {
      const db = join(dir, 'store.db');
      markStoreOpen(db, 'tok-aged');
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      writeFileSync(openMarkerPath(db, 'tok-aged'), `99999999\n${old}\n`);
      expect(hasUncleanShutdown(db)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clearStoreOpenMarker unlinks ONLY its own marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bug019-clear-'));
    try {
      const db = join(dir, 'store.db');
      markStoreOpen(db, 'tok-a');
      markStoreOpen(db, 'tok-b');
      expect(openMarkers(db)).toEqual(['tok-a.openmark', 'tok-b.openmark']);
      clearStoreOpenMarker(db, 'tok-a');
      expect(openMarkers(db)).toEqual(['tok-b.openmark']);
      expect(hasUncleanShutdown(db)).toBe(false); // both pids are this process
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legacy `${dbPath}-openmark` is honored as unclean ONCE, then swept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bug019-legacy-'));
    try {
      const db = join(dir, 'store.db');
      writeFileSync(storeOpenMarkerPath(db), '99999999 2026-01-01T00:00:00.000Z\n');
      expect(hasUncleanShutdown(db)).toBe(true);
      expect(sweepDeadOpenMarkers(db)).toBe(1);
      expect(existsSync(storeOpenMarkerPath(db))).toBe(false);
      expect(hasUncleanShutdown(db)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hasStoreOpenMarker is the deprecated alias of hasUncleanShutdown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bug019-alias-'));
    try {
      const db = join(dir, 'store.db');
      expect(hasStoreOpenMarker(db)).toBe(false);
      writeFileSync(storeOpenMarkerPath(db), '99999999 2026-01-01T00:00:00.000Z\n');
      expect(hasStoreOpenMarker(db)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an absent lease dir is clean and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bug019-absent-'));
    try {
      const db = join(dir, 'store.db');
      expect(hasUncleanShutdown(db)).toBe(false);
      expect(sweepDeadOpenMarkers(db)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── SPEC §T5 test (a): A closes cleanly → B's marker survives ───────────────

tursoDescribe('BUG-019 — SPEC §T5 (a): two adapters; A closes cleanly, B survives', () => {
  it('an orderly close unlinks only the closing connection’s marker (the refcount)', async () => {
    const dbPath = tempPath('bug019-two-adapters');
    await seedStore(dbPath);

    const a = await TursoAdapterImpl.connect({ dbPath });
    const b = await TursoAdapterImpl.connect({ dbPath });
    try {
      // Each connection holds its OWN marker — N connections, N markers.
      expect(openMarkers(dbPath)).toHaveLength(2);
      // Both pids are live (this process) — neither is an unclean signal.
      expect(hasUncleanShutdown(dbPath)).toBe(false);
    } finally {
      await a.close();
    }
    // RED→GREEN: the shared `${dbPath}-openmark` was deleted by a's close, so
    // b's crash evidence died with it. Per-connection: only a's marker is gone.
    expect(openMarkers(dbPath)).toHaveLength(1);
    expect(hasUncleanShutdown(dbPath)).toBe(false); // b is STILL OPEN — live

    await b.close();
    expect(openMarkers(dbPath)).toHaveLength(0);
    expect(hasUncleanShutdown(dbPath)).toBe(false);
  }, 60_000);
});

// ── SPEC §T5 test (b): kill -9 → next open unclean, preflight exactly once ──

tursoDescribe('BUG-019 — SPEC §T5 (b): kill -9 crash evidence survives a sibling close', () => {
  it('a dead-pid marker survives a sibling’s orderly close; the next open consumes it exactly once', async () => {
    const dbPath = tempPath('bug019-kill9');
    await seedStore(dbPath);

    // A server session that will DIE by SIGKILL, and a sibling that will close
    // cleanly — the production shape BUG-019 names.
    const { proc: victim, ready: victimReady } = spawnHolder(dbPath);
    await victimReady;
    const server = await TursoAdapterImpl.connect({ dbPath });
    try {
      // Both sessions hold their own markers; the server sees the victim as a
      // LIVE peer (its marker pid is alive), so nothing is unclean.
      expect(openMarkers(dbPath)).toHaveLength(2);
      expect(hasUncleanShutdown(dbPath)).toBe(false);

      victim.kill('SIGKILL');
      await once(victim, 'exit');
    } finally {
      // The sibling closes ORDERLY. Under the old shared marker this unlinked
      // the victim's crash evidence — the BUG-019 consequence (a).
      await server.close();
    }

    // THE discriminating assertion: the victim's DEAD marker survived the
    // sibling's clean close. Old code: server.close() deleted the shared
    // marker → no unclean signal → false (the next open skips the pre-flight
    // that exists to catch panic-on-open schema states).
    expect(openMarkers(dbPath)).toHaveLength(1);
    expect(hasUncleanShutdown(dbPath)).toBe(true);

    // The next open reports unclean and consumes the signal EXACTLY ONCE: the
    // pre-flight gate fires, the dead marker is swept, and a second open finds
    // nothing to trigger on.
    const fresh = await TursoAdapterImpl.connect({ dbPath });
    expect(openMarkers(dbPath)).toHaveLength(1); // only fresh's own LIVE marker
    expect(hasUncleanShutdown(dbPath)).toBe(false); // crash evidence consumed
    await fresh.close();
    expect(openMarkers(dbPath)).toHaveLength(0);

    const fresh2 = await TursoAdapterImpl.connect({ dbPath });
    await fresh2.close();
    expect(hasUncleanShutdown(dbPath)).toBe(false); // never re-triggered
  }, 120_000);
});

// ── SPEC §T5 test (c): legacy marker honored once ───────────────────────────

tursoDescribe('BUG-019 — SPEC §T5 (c): legacy marker honored once', () => {
  it('a pre-fix `${dbPath}-openmark` is unclean on the first open and is deleted there', async () => {
    const dbPath = tempPath('bug019-legacy-shim');
    await seedStore(dbPath);

    // Simulate a crash recorded by a pre-BUG-019 store-adapter version: ONE
    // shared marker at the legacy path.
    writeFileSync(storeOpenMarkerPath(dbPath), '99999999 2026-01-01T00:00:00.000Z\n');
    expect(hasUncleanShutdown(dbPath)).toBe(true);

    const first = await TursoAdapterImpl.connect({ dbPath });
    try {
      // The shim consumed it at the first unclean-detecting open: the legacy
      // file is gone (old code cleared it only at close → RED) and replaced by
      // the new per-connection marker.
      expect(existsSync(storeOpenMarkerPath(dbPath))).toBe(false);
      expect(openMarkers(dbPath)).toHaveLength(1);
      expect(hasUncleanShutdown(dbPath)).toBe(false);
    } finally {
      await first.close();
    }

    const second = await TursoAdapterImpl.connect({ dbPath });
    await second.close();
    expect(hasUncleanShutdown(dbPath)).toBe(false); // honored exactly once
  }, 60_000);
});
