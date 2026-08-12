/**
 * BL-461 — the marker-gated pre-flight only runs after an unclean session, so a
 * store damaged inside a cleanly-closed session still aborts the process.
 *
 * BL-361's out-of-band pre-flight is gated on a marker file written on open and
 * cleared on an orderly close. `preflight-panic.bl361.test.ts` states that gate's
 * cost honestly in an arm titled "THE GATE COSTS SOMETHING": with no marker, the
 * open still died with SIGABRT. This suite is that arm's replacement — the same
 * store, the same absent marker, now surviving because the adapter looks at
 * `sqlite_master` through its own open connection before anything issues the
 * `fts_match` that panics.
 *
 * ── What each arm pins ──────────────────────────────────────────────────────
 *
 * 1. **The hole, closed.** Damaged store + no marker + `TursoAdapterImpl.connect()`
 *    ⇒ clean exit and working full-text search. This is the red→green arm: with
 *    the `guardOrphanedFtsIndexes` call removed from `turso-adapter.ts` it dies
 *    with SIGABRT (watched, see the commit message).
 * 2. **Build BEFORE destroy.** The statement order is asserted directly against a
 *    recording adapter, not inferred from the outcome. Reordering to
 *    drop-then-create — BL-235's pattern inside the database — fails this.
 * 3. **A failed build still drops, and says so.** An orphan holds no data, and
 *    leaving it in the schema aborts the process on the next `fts_match`. The
 *    fallback is reported as `repair_failed`, never as a repair.
 * 4. **The name is a lookup.** After a rebuild the healthy index is
 *    `idx_fts_node__r1`; a hardcoded `CREATE INDEX IF NOT EXISTS idx_fts_node`
 *    finds its own name free and builds a *second* full index. Both the
 *    prevention and the damage it prevents are asserted.
 * 5. **Read-only detects, never writes.**
 * 6. **Concurrency, which BL-461 records as untested.** A second opener arrives
 *    while this process holds the store open — the case where the marker is
 *    present for a *live* session rather than a dead one.
 * 7. **Negative control.** A healthy store is untouched and costs one schema read.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { leaseDirPath } from '../store-lease.js';
import {
  clearStoreOpenMarker,
  hasStoreOpenMarker,
  hasUncleanShutdown,
  markStoreOpen,
} from '../preflight.js';
import { canonicalFtsIndexName, resolveExistingFtsIndexName } from '../fts-dialect.js';
import {
  findOrphanedFtsIndexes,
  guardOrphanedFtsIndexes,
  guardSucceeded,
  describeFtsOrphanGuard,
  nextShadowIndexName,
} from '../fts-orphan-guard.js';
import type { StoreAdapter, AllResult, RunResult } from '../types.js';

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
const CHILD = resolve(HERE, 'fixtures', 'bl461-open-child.ts');

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl461-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const open: StoreAdapter[] = [];
afterEach(async () => {
  while (open.length > 0) {
    const a = open.pop();
    try {
      await a?.close();
    } catch {
      // best effort
    }
  }
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

/** Every file the engines put beside `dbPath`, sorted. */
function sidecarsOf(dbPath: string): string[] {
  return readdirSync(dirname(dbPath))
    .filter((f) => f.startsWith(basename(dbPath)) && f !== basename(dbPath))
    .sort();
}

/** (BUG-019) The per-connection `.openmark` files currently in the lease dir. */
function openMarkers(dbPath: string): string[] {
  try {
    return readdirSync(leaseDirPath(dbPath))
      .filter((f) => f.endsWith('.openmark'))
      .sort();
  } catch {
    return [];
  }
}

/** A Turso store with a real Tantivy-backed FTS index over 20 rows. */
async function seedHealthyFtsStore(dbPath: string): Promise<void> {
  const adapter = await TursoAdapterImpl.connect({ dbPath });
  await adapter.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
  for (let i = 1; i <= 20; i++) {
    await adapter.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [
      i,
      `hello world of durable storage row ${i} zebra${i}`,
    ]);
  }
  await adapter.exec(
    `CREATE INDEX IF NOT EXISTS ${canonicalFtsIndexName('node')} ON "node" USING fts ("content")`,
  );
  await adapter.close();
}

/**
 * Fixture-only damage, PKT-69's recipe: strip the FTS index's Tantivy backing
 * objects from `sqlite_master` and leave the index row behind. `unsafeMode(true)`
 * is mandatory and must precede `writable_schema` — better-sqlite3 is defensive
 * by default, where the pragma is silently a no-op (BL-329).
 *
 * @param which `all` removes both backing rows; `key` removes only the
 *   `USING backing_btree` index, which is the object whose absence panics — the
 *   empty-but-present directory table stays, and the repair must still clean it up.
 */
function seedOrphanedFtsIndex(dbPath: string, which: 'all' | 'key' = 'all'): void {
  const Database = require('better-sqlite3') as new (p: string) => BetterSqlite3Database;
  const db = new Database(dbPath);
  db.unsafeMode(true);
  db.pragma('writable_schema = ON');
  db.prepare(
    which === 'all'
      ? `DELETE FROM sqlite_master WHERE name LIKE '__turso_internal_fts_dir_%'`
      : `DELETE FROM sqlite_master WHERE name LIKE '__turso_internal_fts_dir_%_key'`,
  ).run();
  db.pragma('writable_schema = RESET');
  db.close();
}

interface ChildOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

function openInChild(dbPath: string, mode: string): ChildOutcome {
  const run = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dbPath, mode], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: resolve(HERE, '..', '..'),
  });
  let json: Record<string, unknown> | null = null;
  const line = (run.stdout ?? '')
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  if (line) {
    try {
      json = JSON.parse(line) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return {
    status: run.status,
    signal: run.signal,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    json,
  };
}

/** The driver aborted rather than throwing. */
function aborted(o: ChildOutcome): boolean {
  return o.signal === 'SIGABRT' || o.status === 134 || o.status === null;
}

// ── A recording adapter, for the order assertion ─────────────────────────────

/**
 * The narrowest `StoreAdapter` the guard actually uses, recording every
 * statement. Ordering is a property of the algorithm, so it is asserted against
 * the algorithm rather than inferred from a database's end state — a
 * drop-then-create implementation produces the same final schema and would pass
 * every outcome-based assertion in this file.
 */
function recordingAdapter(opts: {
  master: { type: string; name: string; tbl_name: string; sql: string | null }[];
  failCreate?: boolean;
  /** Names that appear in `sqlite_master` once a CREATE has run. */
  materialise?: boolean;
}): { adapter: StoreAdapter; sql: string[] } {
  const sql: string[] = [];
  const rows = [...opts.master];
  const adapter = {
    config: { type: 'turso' as const },
    capabilities: { fts: true },
    async executeAll<T>(q: string, params?: unknown[]): Promise<AllResult<T>> {
      sql.push(q.replace(/\s+/g, ' ').trim());
      if (/FROM sqlite_master WHERE name IN/.test(q)) {
        const wanted = new Set((params ?? []) as string[]);
        return { columns: [], rows: rows.filter((r) => wanted.has(r.name)) as unknown as T[] };
      }
      if (/FROM sqlite_master/.test(q)) return { columns: [], rows: rows as unknown as T[] };
      return { columns: [], rows: [] };
    },
    async executeGet<T>(q: string, params?: unknown[]): Promise<T | null> {
      sql.push(q.replace(/\s+/g, ' ').trim());
      const name = (params ?? [])[0] as string;
      return (rows.find((r) => r.name === name) as unknown as T) ?? null;
    },
    async exec(q: string): Promise<void> {
      sql.push(q.replace(/\s+/g, ' ').trim());
      const create = /CREATE INDEX "([^"]+)"/.exec(q);
      if (create) {
        if (opts.failCreate) throw new Error('disk I/O error');
        if (opts.materialise !== false) {
          const n = create[1] as string;
          rows.push({ type: 'index', name: n, tbl_name: 'node', sql: q });
          rows.push({
            type: 'table',
            name: `__turso_internal_fts_dir_${n}`,
            tbl_name: `__turso_internal_fts_dir_${n}`,
            sql: 'CREATE TABLE x (y)',
          });
          rows.push({
            type: 'index',
            name: `__turso_internal_fts_dir_${n}_key`,
            tbl_name: 'node',
            sql: 'CREATE INDEX z ON node USING backing_btree (y)',
          });
        }
      }
      const drop = /DROP INDEX IF EXISTS "([^"]+)"/.exec(q);
      if (drop) {
        const n = drop[1] as string;
        for (let i = rows.length - 1; i >= 0; i--) {
          if ((rows[i] as { name: string }).name === n) rows.splice(i, 1);
        }
      }
    },
    async executeRun(): Promise<RunResult> {
      return { rowsAffected: 0, lastInsertRowid: 0 };
    },
  } as unknown as StoreAdapter;
  return { adapter, sql };
}

const ORPHAN_MASTER = [
  { type: 'table', name: 'node', tbl_name: 'node', sql: 'CREATE TABLE node (id, content)' },
  {
    type: 'index',
    name: 'idx_fts_node',
    tbl_name: 'node',
    sql: 'CREATE INDEX idx_fts_node ON "node" USING fts ("content")',
  },
];

// ── Pure predicate ───────────────────────────────────────────────────────────

describe('BL-461 — orphan detection predicate (no store required)', () => {
  it('flags an FTS index whose backing objects are absent, and names which are missing', () => {
    const orphans = findOrphanedFtsIndexes(ORPHAN_MASTER);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      index: 'idx_fts_node',
      table: 'node',
      columns: ['content'],
    });
    expect(orphans[0]?.missing).toEqual([
      '__turso_internal_fts_dir_idx_fts_node',
      '__turso_internal_fts_dir_idx_fts_node_key',
    ]);
  });

  it('flags the partial shape too — the `_key` backing_btree is the object whose absence panics', () => {
    const rows = [
      ...ORPHAN_MASTER,
      {
        type: 'table',
        name: '__turso_internal_fts_dir_idx_fts_node',
        tbl_name: '__turso_internal_fts_dir_idx_fts_node',
        sql: 'CREATE TABLE x (y)',
      },
    ];
    expect(findOrphanedFtsIndexes(rows)[0]?.missing).toEqual([
      '__turso_internal_fts_dir_idx_fts_node_key',
    ]);
  });

  it('NEGATIVE CONTROL: a fully-backed FTS index, a btree index and a plain table are all clean', () => {
    const rows = [
      ...ORPHAN_MASTER,
      {
        type: 'table',
        name: '__turso_internal_fts_dir_idx_fts_node',
        tbl_name: '__turso_internal_fts_dir_idx_fts_node',
        sql: 'CREATE TABLE x (y)',
      },
      {
        type: 'index',
        name: '__turso_internal_fts_dir_idx_fts_node_key',
        tbl_name: 'node',
        sql: 'CREATE INDEX k ON node USING backing_btree (y)',
      },
      { type: 'index', name: 'idx_node_topic', tbl_name: 'node', sql: 'CREATE INDEX i ON node(topic)' },
    ];
    expect(findOrphanedFtsIndexes(rows)).toEqual([]);
  });

  it('the shadow name never grows without bound — the __rN suffix is stripped before it is re-applied', () => {
    expect(nextShadowIndexName('idx_fts_node', new Set())).toBe('idx_fts_node__r1');
    expect(nextShadowIndexName('idx_fts_node', new Set(['idx_fts_node__r1']))).toBe(
      'idx_fts_node__r2',
    );
    expect(nextShadowIndexName('idx_fts_node__r1', new Set(['idx_fts_node__r1']))).toBe(
      'idx_fts_node__r2',
    );
  });
});

// ── Order: build, THEN destroy ───────────────────────────────────────────────

describe('BL-461 — the replacement is built BEFORE the orphan is destroyed', () => {
  it('emits CREATE INDEX before DROP INDEX, and verifies the backing objects materialised in between', async () => {
    const { adapter, sql } = recordingAdapter({ master: ORPHAN_MASTER });
    const result = await guardOrphanedFtsIndexes(adapter, { repair: true });

    expect(guardSucceeded(result)).toBe(true);
    expect(result.repairs[0]).toMatchObject({
      orphan: 'idx_fts_node',
      built: 'idx_fts_node__r1',
      dropped: true,
      buildError: null,
      dropError: null,
    });

    const createAt = sql.findIndex((s) => s.startsWith('CREATE INDEX "idx_fts_node__r1"'));
    const dropAt = sql.findIndex((s) => s.startsWith('DROP INDEX IF EXISTS "idx_fts_node"'));
    const verifyAt = sql.findIndex((s) => /FROM sqlite_master WHERE name IN/.test(s));
    expect(createAt, 'the replacement must be created').toBeGreaterThanOrEqual(0);
    expect(dropAt, 'the orphan must be dropped').toBeGreaterThanOrEqual(0);
    // This is the assertion BL-235's in-database twin fails: destroying the only
    // copy before knowing the replacement builds.
    expect(createAt).toBeLessThan(dropAt);
    expect(verifyAt).toBeGreaterThan(createAt);
    expect(verifyAt).toBeLessThan(dropAt);
  });

  it('a CREATE that reports success without materialising its backing objects is NOT accepted as built', async () => {
    const { adapter } = recordingAdapter({ master: ORPHAN_MASTER, materialise: false });
    const result = await guardOrphanedFtsIndexes(adapter, { repair: true });
    expect(result.repairs[0]?.built).toBeNull();
    expect(result.repairs[0]?.buildError).toMatch(/reported success but/);
    expect(guardSucceeded(result)).toBe(false);
  });

  it('a failed build still drops the orphan — it holds no data, and leaving it aborts the process — and reports repair_failed', async () => {
    const { adapter, sql } = recordingAdapter({ master: ORPHAN_MASTER, failCreate: true });
    const result = await guardOrphanedFtsIndexes(adapter, { repair: true });
    expect(result.repairs[0]?.buildError).toMatch(/disk I\/O error/);
    expect(result.repairs[0]?.dropped).toBe(true);
    expect(guardSucceeded(result), 'a dropped-without-replacement store is NOT a success').toBe(
      false,
    );
    expect(sql.some((s) => s.startsWith('DROP INDEX IF EXISTS "idx_fts_node"'))).toBe(true);
    const described = describeFtsOrphanGuard(result);
    expect(described).toMatch(/replacement could NOT be built/);
    expect(described).toMatch(/full-text search is DOWN/);
  });

  it('detect-only mode issues exactly one statement and never writes', async () => {
    const { adapter, sql } = recordingAdapter({ master: ORPHAN_MASTER });
    const result = await guardOrphanedFtsIndexes(adapter);
    expect(result.orphaned).toHaveLength(1);
    expect(result.repairs).toEqual([]);
    expect(sql).toEqual(['SELECT type, name, tbl_name, sql FROM sqlite_master']);
    expect(describeFtsOrphanGuard(result)).toMatch(/NOT repaired \(read-only\)/);
  });
});

// ── The hole itself, against a real Turso store ──────────────────────────────

tursoDescribe('BL-461 — a store damaged inside a cleanly-closed session', () => {
  it('RED→GREEN: no marker, no pre-flight, and the open now SURVIVES with full-text search restored', async () => {
    const dbPath = tempPath('bl461-no-marker');
    await seedHealthyFtsStore(dbPath);
    seedOrphanedFtsIndex(dbPath);
    // The exact state the marker gate cannot see: the previous session closed
    // cleanly, so there is nothing on disk to trigger the out-of-band pre-flight.
    clearStoreOpenMarker(dbPath);
    expect(hasStoreOpenMarker(dbPath)).toBe(false);

    const out = openInChild(dbPath, 'guarded');
    expect(
      out.status,
      `expected a clean open; status=${out.status} signal=${out.signal} stderr=${out.stderr}`,
    ).toBe(0);
    expect(aborted(out)).toBe(false);
    expect(out.json).toMatchObject({ opened: true, mode: 'guarded' });

    // The orphan is gone, exactly one FTS index remains, and it is the rebuild.
    expect(out.json?.ftsIndexes).toEqual(['idx_fts_node__r1']);
    // Full backfill, not just the rows written after the damage: every seeded
    // row is matchable, and the interior sentinel round-trips.
    expect(out.json?.ftsRowIds).toEqual([7]);
    expect(out.json?.ftsHelloCount).toBe(20);
    // No leftover directory objects from the dropped orphan.
    expect(out.json?.schemaObjects).toEqual([
      '__turso_internal_fts_dir_idx_fts_node__r1',
      '__turso_internal_fts_dir_idx_fts_node__r1_key',
      'idx_fts_node__r1',
    ]);
    // It said so, and said what it would mean if nobody damaged this by hand.
    expect(out.stderr).toMatch(/\[BL-461\]/);
    expect(out.stderr).toMatch(/reclassifies to HIGH/);
    expect(out.stderr).toMatch(/store\.integrity\.repaired/);
  }, 180_000);

  it('the partial damage shape (directory table present, backing_btree gone) is repaired identically, with no residue', async () => {
    const dbPath = tempPath('bl461-partial');
    await seedHealthyFtsStore(dbPath);
    seedOrphanedFtsIndex(dbPath, 'key');
    clearStoreOpenMarker(dbPath);

    const out = openInChild(dbPath, 'guarded');
    expect(out.status, `stderr=${out.stderr}`).toBe(0);
    expect(out.json?.ftsIndexes).toEqual(['idx_fts_node__r1']);
    // DROP INDEX on the orphan takes its stranded directory table with it.
    expect(out.json?.schemaObjects).not.toContain('__turso_internal_fts_dir_idx_fts_node');
    expect(out.json?.ftsHelloCount).toBe(20);
  }, 180_000);

  it('the index name is a LOOKUP: the rebuilt index is found under its new name, so no duplicate is created', async () => {
    const dbPath = tempPath('bl461-lookup');
    await seedHealthyFtsStore(dbPath);
    seedOrphanedFtsIndex(dbPath);
    clearStoreOpenMarker(dbPath);

    const out = openInChild(dbPath, 'guarded');
    expect(out.status, `stderr=${out.stderr}`).toBe(0);
    expect(out.json?.resolved).toBe('idx_fts_node__r1');
    expect(out.json?.ftsIndexes).toHaveLength(1);

    // And the damage that lookup prevents, demonstrated rather than asserted in
    // prose: the hardcoded `CREATE INDEX IF NOT EXISTS idx_fts_node` finds its
    // own name free and builds a SECOND full index over the same column. Both
    // answer queries, so nothing ever complains.
    const dupPath = tempPath('bl461-lookup-dup');
    await seedHealthyFtsStore(dupPath);
    seedOrphanedFtsIndex(dupPath);
    clearStoreOpenMarker(dupPath);
    const dup = openInChild(dupPath, 'hardcoded');
    expect(dup.status, `stderr=${dup.stderr}`).toBe(0);
    expect(dup.json?.ftsIndexes).toEqual(['idx_fts_node', 'idx_fts_node__r1']);
    expect(dup.json?.ftsHelloCount).toBe(20);
  }, 240_000);

  it('a read-only open DETECTS and reports the orphan but never writes', async () => {
    const dbPath = tempPath('bl461-readonly');
    await seedHealthyFtsStore(dbPath);
    seedOrphanedFtsIndex(dbPath);
    clearStoreOpenMarker(dbPath);

    const out = openInChild(dbPath, 'readonly');
    expect(out.status, `stderr=${out.stderr}`).toBe(0);
    // Unrepaired: the orphan is still the only FTS index row on the store.
    expect(out.json?.ftsIndexes).toEqual(['idx_fts_node']);
    expect(out.stderr).toMatch(/store\.integrity\.damaged/);
    expect(out.stderr).toMatch(/NOT repaired \(read-only\)/);

    // Still damaged on disk — a read-only open is not a repair path.
    const after = openInChild(dbPath, 'readonly');
    expect(after.json?.ftsIndexes).toEqual(['idx_fts_node']);
  }, 180_000);

  it('NEGATIVE CONTROL: a healthy store is reported clean and nothing is rebuilt', async () => {
    const dbPath = tempPath('bl461-healthy');
    await seedHealthyFtsStore(dbPath);

    const adapter = await TursoAdapterImpl.connect({ dbPath });
    open.push(adapter);
    const result = await guardOrphanedFtsIndexes(adapter, { repair: true });
    expect(result.ran).toBe(true);
    expect(result.skipped).toBeNull();
    expect(result.orphaned).toEqual([]);
    expect(result.repairs).toEqual([]);
    expect(guardSucceeded(result)).toBe(false); // nothing to succeed at
    expect(await resolveExistingFtsIndexName(adapter, 'node')).toBe('idx_fts_node');
    expect(await resolveExistingFtsIndexName(adapter, 'no_such_table')).toBeNull();
  }, 120_000);

  it('is idempotent: a second open of a repaired store finds nothing to do and does not rename again', async () => {
    const dbPath = tempPath('bl461-idempotent');
    await seedHealthyFtsStore(dbPath);
    seedOrphanedFtsIndex(dbPath);
    clearStoreOpenMarker(dbPath);

    expect(openInChild(dbPath, 'guarded').json?.ftsIndexes).toEqual(['idx_fts_node__r1']);
    const second = openInChild(dbPath, 'guarded');
    expect(second.status, `stderr=${second.stderr}`).toBe(0);
    expect(second.json?.ftsIndexes).toEqual(['idx_fts_node__r1']);
    expect(second.stderr).not.toMatch(/\[BL-461\]/);
  }, 240_000);
});

// ── The second, narrower risk BL-461 records as untested ─────────────────────

tursoDescribe('BL-461 — a concurrent opener while this process holds the store', () => {
  it('a second opener arrives on a LIVE store: the live marker is NOT an unclean signal, the arriving open skips the pre-flight, and the holder’s marker survives (BUG-019)', async () => {
    const dbPath = tempPath('bl461-concurrent');
    await seedHealthyFtsStore(dbPath);

    // The holder. Its `connect()` wrote ONE per-connection marker carrying a
    // LIVE pid (this process). Under the old shared marker that was
    // indistinguishable from a dead session, so the arriving process ran the
    // pre-flight's read-only better-sqlite3 scan against a store Turso
    // currently had open — the BUG-019 false-positive. Now a live marker is a
    // concurrent session, never an unclean signal.
    const holder = await TursoAdapterImpl.connect({ dbPath });
    open.push(holder);
    expect(openMarkers(dbPath)).toHaveLength(1);
    expect(hasUncleanShutdown(dbPath)).toBe(false);

    const arriving = openInChild(dbPath, 'guarded');
    expect(
      arriving.status,
      `concurrent open must not abort; status=${arriving.status} signal=${arriving.signal} stderr=${arriving.stderr}`,
    ).toBe(0);
    expect(arriving.json?.ftsIndexes).toEqual(['idx_fts_node']);
    expect(arriving.json?.ftsHelloCount).toBe(20);
    // No repair was attempted, because there was no damage to find.
    expect(arriving.stderr).not.toMatch(/\[BL-461\]/);

    // The sidecar question BL-461 raises, answered with the observed list
    // rather than a belief. (BUG-019) The marker-gated pre-flight NO LONGER
    // runs against a live store, so the arriving process opens NO `-shm` via
    // better-sqlite3 — the sidecar list is just Turso's own coordination set,
    // and the marker is inside the lease dir (excluded by the fixture).
    //
    // (DEBT-003/BUG-014) The `-tshm.stale-*` entry is expected: the seed's own
    // quiescent close() ran the single quiescence-gated TRUNCATE (BUG-008)
    // and, per the BUG-014 complement, reset the -tshm beside it — the TRUNCATE
    // zeroed the -wal, so the -tshm this close orphaned indexes frames the
    // empty WAL cannot hold, and it is moved aside (renamed, never deleted) so
    // the stale-index state never persists. It predates the arriving process.
    const before = (arriving.json?.sidecars ?? []) as string[];
    const stale = before.filter((f) => f.endsWith('-tshm.stale-') || f.includes('-tshm.stale-'));
    expect(
      before.filter((f) => !stale.includes(f)),
      `sidecars observed inside the arriving process: ${before.join(', ')}`,
    ).toEqual([`${basename(dbPath)}-tshm`, `${basename(dbPath)}-wal`]);
    expect(
      stale,
      'DEBT-003/BUG-014: exactly one -tshm.stale-* artifact (the seed close reset the orphaned -tshm beside its TRUNCATE)',
    ).toHaveLength(1);
    // (BUG-019) No `-shm` anywhere: the only classic-engine open that created
    // one was the marker-gated pre-flight, which no longer fires for a live
    // store. If a `-shm` appears here it is the BUG-019 false-positive
    // returning.
    expect(sidecarsOf(dbPath)).not.toContain(`${basename(dbPath)}-shm`);

    // ── BL-468, RESOLVED by BUG-019 (was "a second defect, found by this arm") ──
    // The old marker was a flag, not a refcount: the arriving process's
    // *orderly* close cleared a marker the HOLDER wrote and was still relying
    // on, so if the holder died next, its crash would leave no unclean signal.
    // The marker is now per-connection: the arriving close unlinked ONLY its
    // own marker, so the HOLDER's crash evidence survives intact.
    expect(
      openMarkers(dbPath),
      'BUG-019/BL-468: the arriving close must leave the holder’s marker intact',
    ).toHaveLength(1);
    expect(hasUncleanShutdown(dbPath)).toBe(false); // holder still LIVE — not unclean

    // The holder is unharmed: it still reads and still writes.
    const rows = await holder.executeAll<{ id: number }>(
      'SELECT id FROM node WHERE fts_match(content, ?)',
      ['zebra5'],
    );
    expect(rows.rows.map((r) => Number(r.id))).toEqual([5]);
    await holder.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [
      99,
      'hello world of durable storage row 99 zebra99',
    ]);
    const after = await holder.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM node');
    expect(Number(after?.c)).toBe(21);
  }, 180_000);

  it('WITH a marker the out-of-band pre-flight still wins, and the two repair paths are not interchangeable', async () => {
    const dbPath = tempPath('bl461-marker-present');
    await seedHealthyFtsStore(dbPath);
    seedOrphanedFtsIndex(dbPath);
    markStoreOpen(dbPath); // as a session that died — or a live holder — leaves it

    const first = openInChild(dbPath, 'guarded');
    expect(first.status, `stderr=${first.stderr}`).toBe(0);
    // BL-361's pre-flight runs BEFORE the driver opens, so it gets there first
    // and its repair is a plain `DELETE FROM sqlite_master` — no rebuild. The
    // in-process guard then finds nothing left to do, and the ordinary consumer
    // DDL recreates the index under its CANONICAL name. Same end state, reached
    // by a different route, and the name records which route ran.
    expect(first.json?.ftsIndexes).toEqual(['idx_fts_node']);
    expect(first.json?.ftsHelloCount).toBe(20);
    expect(first.stderr).toMatch(/\[BL-361\]/);
    expect(first.stderr).not.toMatch(/\[BL-461\]/);

    // Only the marker-ABSENT route is build-before-destroy, because only there
    // is the adapter the first thing to see the damage.
    const guarded = tempPath('bl461-marker-absent');
    await seedHealthyFtsStore(guarded);
    seedOrphanedFtsIndex(guarded);
    clearStoreOpenMarker(guarded);
    const out = openInChild(guarded, 'guarded');
    expect(out.status, `stderr=${out.stderr}`).toBe(0);
    expect(out.json?.ftsIndexes).toEqual(['idx_fts_node__r1']);
    expect(out.stderr).toMatch(/\[BL-461\]/);
  }, 240_000);
});
