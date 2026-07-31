/**
 * integrity-status.test.ts — BL-334 (report integrity into the status surface)
 * and BL-368 (a proxied adapter must still resolve its integrity result).
 *
 * The governing assertion of this suite is NEGATIVE: there must be no input for
 * which a damaged, unverified, or unvalidated store reports `healthy: true`.
 * Every "unhealthy" case therefore asserts `healthy === false` explicitly rather
 * than asserting the absence of a complaint — the BL-347 failure was precisely
 * that silence read as health.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { createSqliteAdapter } from '../factory.js';
import { verifyStoreIntegrity } from '../integrity.js';
import {
  getLastIntegrityResult,
  getLastIntegrityResultForPath,
  getLastIntegrityRunAt,
  recordIntegrityResult,
  readIntegrityResult,
  INTEGRITY_META_KEY,
  _resetIntegrityRegistryForTest,
  type IntegrityFinding,
  type VerifyAndRepairResult,
} from '../integrity.js';
import {
  summarizeIntegrityForStatus,
  integrityHeadline,
} from '../integrity-status.js';
import type { StoreAdapter } from '../types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function finding(over: Partial<IntegrityFinding> = {}): IntegrityFinding {
  return {
    probe: 'fts_index_live',
    object: 'idx_fts_node',
    status: 'ok',
    detail: 'sentinel round-trip 3/3',
    repairable: true,
    backlog: 'BL-347',
    probeValidated: true,
    ...over,
  };
}

function result(
  findings: IntegrityFinding[],
  over: Partial<VerifyAndRepairResult['verify']> = {},
  repair: VerifyAndRepairResult['repair'] = null,
): VerifyAndRepairResult {
  return {
    verify: {
      ok: findings.every((f) => f.status === 'ok'),
      depth: 'fast',
      durationMs: 91,
      findings,
      damaged: findings.filter((f) => f.status === 'damaged'),
      unknown: findings.filter((f) => f.status === 'unknown'),
      ...over,
    },
    repair,
  };
}

/** Minimal adapter stub — only `config` is read by the registry. */
function fakeAdapter(dbPath: string): StoreAdapter {
  return { config: { type: 'turso', dbPath } } as unknown as StoreAdapter;
}

/** The telemetry wrapper memory-core actually applies (db.ts:305). */
function instrumentLikeMemoryCore<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop) {
      const orig = Reflect.get(obj, prop, obj) as unknown;
      if (typeof orig !== 'function') return orig;
      return (orig as (...a: unknown[]) => unknown).bind(obj);
    },
  }) as T;
}

beforeEach(() => _resetIntegrityRegistryForTest());

// ── BL-368: the proxy identity defect ────────────────────────────────────────

describe('BL-368 — integrity result resolves through a proxied adapter', () => {
  it('resolves the result when the caller holds the telemetry Proxy, not the instance', () => {
    const real = fakeAdapter('/tmp/bl367.db');
    recordIntegrityResult(real, result([finding()]));

    // What memory-core's openDb() hands every consumer, including memory_ping.
    const proxied = instrumentLikeMemoryCore(real);
    expect(proxied).not.toBe(real); // distinct identity — the whole problem

    // RED before the path-keyed fallback: this returned null, so memory_ping
    // would have reported `unknown` forever on a perfectly verified store.
    expect(getLastIntegrityResult(proxied)).not.toBeNull();
    expect(getLastIntegrityResult(proxied)?.verify.ok).toBe(true);
  });

  it('still resolves via the real instance (no regression on the WeakMap path)', () => {
    const real = fakeAdapter('/tmp/bl367b.db');
    recordIntegrityResult(real, result([finding()]));
    expect(getLastIntegrityResult(real)).not.toBeNull();
  });

  it('NEGATIVE CONTROL: an unrelated path resolves to null, not to someone else\'s report', () => {
    recordIntegrityResult(fakeAdapter('/tmp/bl367c.db'), result([finding()]));
    expect(getLastIntegrityResultForPath('/tmp/not-this-one.db')).toBeNull();
    expect(getLastIntegrityResult(fakeAdapter('/tmp/other.db'))).toBeNull();
  });

  it('records a run timestamp so staleness is answerable', () => {
    const real = fakeAdapter('/tmp/bl367d.db');
    expect(getLastIntegrityRunAt('/tmp/bl367d.db')).toBeNull();
    recordIntegrityResult(real, result([finding()]));
    expect(getLastIntegrityRunAt('/tmp/bl367d.db')).toBeGreaterThan(0);
  });
});

// ── BL-334: a damaged store can never read as healthy ────────────────────────

describe('BL-334 — unhealthy states never report healthy', () => {
  it('never ran → unknown, NOT healthy', () => {
    const v = summarizeIntegrityForStatus(null, null);
    expect(v.overall).toBe('unknown');
    expect(v.healthy).toBe(false);
    expect(v.reason).toMatch(/NOT a clean bill of health/i);
  });

  it('verification switched off → unknown, NOT healthy, and distinguishable from never-ran', () => {
    const off = summarizeIntegrityForStatus(null, null, true);
    expect(off.overall).toBe('unknown');
    expect(off.healthy).toBe(false);
    expect(off.reason).toMatch(/DISABLED/i);
    expect(off.reason).not.toEqual(summarizeIntegrityForStatus(null, null, false).reason);
  });

  it('THE TRAP: an aborted pass (ok:false, EMPTY findings) is unknown, not healthy', () => {
    // integrity.ts:1266-1277 records exactly this on an aborted pass. A
    // summariser asking `damaged.length === 0` would call it healthy.
    const aborted = result([], { ok: false, damaged: [], unknown: [], findings: [] });
    const v = summarizeIntegrityForStatus(aborted, Date.now());
    expect(v.overall).toBe('unknown');
    expect(v.healthy).toBe(false);
    expect(v.damaged).toHaveLength(0); // the very thing that would have fooled us
  });

  it('damaged and unrepaired → damaged, NOT healthy, with the backlog id surfaced', () => {
    const v = summarizeIntegrityForStatus(
      result([
        finding({
          status: 'damaged',
          detail: 'fts_match returned 0 rows for 3/3 sentinels; index is dead',
        }),
      ]),
      Date.now(),
    );
    expect(v.overall).toBe('damaged');
    expect(v.healthy).toBe(false);
    expect(v.damaged[0]?.backlog).toBe('BL-347');
    expect(v.reason).toMatch(/not repaired/i);
  });

  it('a probe that reports ok WITHOUT validating is unknown, not healthy', () => {
    // The BL-347 shape: a check that cannot fail reports success forever.
    const v = summarizeIntegrityForStatus(
      result([finding({ status: 'ok', probeValidated: false })]),
      Date.now(),
    );
    expect(v.overall).toBe('unknown');
    expect(v.healthy).toBe(false);
    expect(v.reason).toMatch(/without demonstrably exercising/i);
    expect(v.probes.fts_index_live?.validated).toBe(false);
  });

  it('an explicitly unknown probe → unknown, NOT healthy', () => {
    const v = summarizeIntegrityForStatus(
      result([finding({ status: 'unknown', probeValidated: false, detail: 'planner refused' })]),
      Date.now(),
    );
    expect(v.overall).toBe('unknown');
    expect(v.healthy).toBe(false);
  });

  it('repair that was NOT re-verified does not earn health', () => {
    const damaged = finding({ status: 'damaged', detail: 'dead' });
    const v = summarizeIntegrityForStatus(
      result([damaged], {}, {
        ok: true,
        actions: [{ probe: 'fts_index_live', object: 'idx_fts_node', action: 'rebuilt', ok: true, durationMs: 12 }],
        durationMs: 12,
        verified: null, // never re-verified — the BL-347 failure
      }),
      Date.now(),
    );
    expect(v.overall).toBe('damaged');
    expect(v.healthy).toBe(false);
    expect(v.repair?.reverified).toBeNull();
  });

  it('repair that WAS re-verified clean reports `repaired` — healthy, but not "ok"', () => {
    const damaged = finding({ status: 'damaged', detail: 'dead' });
    const v = summarizeIntegrityForStatus(
      result([damaged], {}, {
        ok: true,
        actions: [{ probe: 'fts_index_live', object: 'idx_fts_node', action: 'rebuilt', ok: true, durationMs: 12 }],
        durationMs: 12,
        verified: { ok: true, depth: 'fast', durationMs: 8, findings: [finding()], damaged: [], unknown: [] },
      }),
      Date.now(),
    );
    expect(v.overall).toBe('repaired');
    expect(v.healthy).toBe(true);
    // An operator must be able to tell "was correct" from "was made correct",
    // otherwise damage recurring on every restart is invisible.
    expect(v.overall).not.toBe('ok');
    expect(v.reason).toMatch(/did not open correct/i);
  });

  it('the ONLY healthy-and-ok input is a completed, damage-free, fully validated pass', () => {
    const v = summarizeIntegrityForStatus(
      result([
        finding({ probe: 'fts_index_live' }),
        finding({ probe: 'btree_index_populated', object: 'idx_node_topic' }),
      ]),
      Date.now(),
    );
    expect(v.overall).toBe('ok');
    expect(v.healthy).toBe(true);
    expect(v.reason).toBeNull();
  });
});

// ── Reported detail ──────────────────────────────────────────────────────────

describe('BL-334 — reported detail is actionable', () => {
  it('worst-finding-wins per probe: one damaged object makes the probe damaged', () => {
    const v = summarizeIntegrityForStatus(
      result([
        finding({ object: 'idx_a', status: 'ok' }),
        finding({ object: 'idx_b', status: 'damaged', detail: 'b is dead' }),
      ]),
      Date.now(),
    );
    expect(v.probes.fts_index_live?.status).toBe('damaged');
    expect(v.probes.fts_index_live?.objects).toBe(2);
    expect(v.probes.fts_index_live?.detail).toBe('b is dead');
  });

  it('surfaces depth, duration and staleness', () => {
    const t = Date.now() - 42_000;
    const v = summarizeIntegrityForStatus(result([finding()]), t, false, Date.now());
    expect(v.depth).toBe('fast');
    expect(v.duration_ms).toBe(91);
    expect(v.age_seconds).toBe(42);
    expect(v.last_run_at).toBe(new Date(t).toISOString());
  });

  it('headline names the state in words an operator can act on', () => {
    expect(integrityHeadline(summarizeIntegrityForStatus(null, null))).toMatch(/UNKNOWN/);
    expect(
      integrityHeadline(
        summarizeIntegrityForStatus(result([finding({ status: 'damaged' })]), Date.now()),
      ),
    ).toMatch(/DAMAGED/);
    expect(integrityHeadline(summarizeIntegrityForStatus(result([finding()]), Date.now()))).toMatch(
      /ok/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BL-334 / BL-347 — the question this whole wiring exists to answer:
// does REAL damage to a REAL store render as damaged in the status surface?
//
// Everything above is a unit test over synthesised findings. This one damages
// an actual FTS index on an actual store, runs the real probes, and asserts
// the operator-facing view says so. Without it, the summariser could be
// perfectly correct about inputs the real probes never produce.
// ═══════════════════════════════════════════════════════════════════════════

const liveTmp = mkdtempSync(join(tmpdir(), 'bl334-status-'));
afterAll(() => rmSync(liveTmp, { recursive: true, force: true }));

describe('BL-334 — real FTS damage renders as damaged in the status view', () => {
  it('a live store with a dead FTS index does NOT report healthy', async () => {
    const dbPath = join(liveTmp, `fts-${Date.now()}.db`);
    const adapter = await createSqliteAdapter({ dbPath });

    await adapter.exec(`
      CREATE TABLE IF NOT EXISTS node (
        id INTEGER PRIMARY KEY, content TEXT, name TEXT, summary TEXT, topic TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(
        content, name, summary, content='node', content_rowid='rowid'
      );
    `);
    for (let i = 0; i < 12; i++) {
      await adapter.executeRun(
        `INSERT INTO node (content, name, summary, topic) VALUES (?, ?, ?, ?)`,
        [
          `episode ${i} concerning quarterly hippopotamus logistics and reconciliation`,
          `name-${i}`,
          `summary ${i}`,
          `topic-${i % 3}`,
        ],
      );
    }
    await adapter.exec(`INSERT INTO fts_node(fts_node) VALUES('rebuild')`);

    // ── healthy baseline: the probe must PASS before we damage anything,
    //    otherwise the "damaged" assertion below proves nothing (BL-167).
    const healthyView = summarizeIntegrityForStatus(
      { verify: await verifyStoreIntegrity(adapter), repair: null },
      Date.now(),
    );
    const healthyFts = healthyView.probes.fts_index_live;
    expect(healthyFts?.status, JSON.stringify(healthyView.probes)).toBe('ok');
    expect(healthyFts?.validated).toBe(true);

    // ── damage: empty the index, leave the virtual table and every
    //    sqlite_master row in place. The BL-347 shape exactly — the artifact
    //    exists, so `CREATE ... IF NOT EXISTS` no-ops on it forever.
    const raw = adapter.unwrap() as BetterSqlite3Database;
    raw.exec(`INSERT INTO fts_node(fts_node) VALUES('delete-all')`);

    const damagedView = summarizeIntegrityForStatus(
      { verify: await verifyStoreIntegrity(adapter), repair: null },
      Date.now(),
    );

    // THE ASSERTION. Before this wiring the operator saw nothing at all here.
    expect(damagedView.healthy).toBe(false);
    expect(damagedView.overall).toBe('damaged');
    expect(damagedView.probes.fts_index_live?.status).toBe('damaged');
    expect(damagedView.damaged.some((d) => d.probe === 'fts_index_live')).toBe(true);
    expect(damagedView.damaged.find((d) => d.probe === 'fts_index_live')?.backlog).toBe('BL-347');
    expect(integrityHeadline(damagedView)).toMatch(/DAMAGED/);

    await adapter.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BL-334 — the DURABLE verdict is what the status surface actually reads.
//
// The in-process registries above cannot be read by `memory_ping`, for two
// independent measured reasons: `openDb` hands back a Proxy, and memory-core
// reaches this package through `require()` while an ESM consumer gets a second
// module instance with its own Maps. Either one silently yields "never ran"
// forever. So the verdict is persisted into the store, and THAT round-trip is
// what these tests pin.
// ═══════════════════════════════════════════════════════════════════════════

describe('BL-334 — integrity verdict round-trips through the store itself', () => {
  it('a store that was never verified reads as UNKNOWN, never as healthy', async () => {
    const dbPath = join(liveTmp, `durable-never-${Date.now()}.db`);
    const adapter = createSqliteAdapter({ dbPath });
    // Deliberately do NOT call init() — nothing has verified this store.
    await adapter.exec(`CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)`);

    expect(await readIntegrityResult(adapter)).toBeNull();
    const view = summarizeIntegrityForStatus(null, null);
    expect(view.healthy).toBe(false);
    expect(view.overall).toBe('unknown');
    expect(view.reason).toMatch(/NOT a clean bill of health/i);
    await adapter.close();
  });

  it('an open-time pass persists a verdict that a SEPARATE handle can read back', async () => {
    const dbPath = join(liveTmp, `durable-ok-${Date.now()}.db`);
    const writer = createSqliteAdapter({ dbPath });
    await writer.exec(`
      CREATE TABLE IF NOT EXISTS node (id INTEGER PRIMARY KEY, topic TEXT);
      CREATE INDEX IF NOT EXISTS ix_topic ON node (topic);
    `);
    for (let i = 0; i < 8; i++) {
      await writer.executeRun(`INSERT INTO node (topic) VALUES (?)`, [`t${i}`]);
    }
    await writer.init(); // the normal open path: stamp, verify, repair, persist
    await writer.close();

    // A DIFFERENT adapter instance — no shared in-process state to lean on.
    const reader = createSqliteAdapter({ dbPath });
    const persisted = await readIntegrityResult(reader);
    expect(persisted, 'the verdict must survive the handle that produced it').not.toBeNull();
    expect(persisted!.runAtMs).toBeGreaterThan(0);

    const view = summarizeIntegrityForStatus(persisted!.result, persisted!.runAtMs);
    expect(view.healthy).toBe(true);
    expect(view.probes.btree_index_populated?.status).toBe('ok');
    expect(view.probes.btree_index_populated?.validated).toBe(true);
    await reader.close();
  });

  it('survives a Proxy wrapper — the shape `openDb` actually returns', async () => {
    const dbPath = join(liveTmp, `durable-proxy-${Date.now()}.db`);
    const adapter = createSqliteAdapter({ dbPath });
    await adapter.exec(`CREATE TABLE IF NOT EXISTS node (id INTEGER PRIMARY KEY)`);
    await adapter.init();

    // Mirrors memory-core's instrumentAdapter: a Proxy that binds methods to
    // the target. A WeakMap keyed on the adapter cannot see through this.
    const proxied = new Proxy(adapter as unknown as Record<string | symbol, unknown>, {
      get(obj, prop): unknown {
        const orig = Reflect.get(obj, prop, obj);
        return typeof orig === 'function' ? (orig as (...a: unknown[]) => unknown).bind(obj) : orig;
      },
    }) as unknown as StoreAdapter;

    expect(
      getLastIntegrityResult(proxied as StoreAdapter),
      'in-process lookup through a Proxy is exactly what BL-368 is about',
    ).not.toBeUndefined();
    const persisted = await readIntegrityResult(proxied);
    expect(persisted, 'the durable read must not care about object identity').not.toBeNull();
    expect(summarizeIntegrityForStatus(persisted!.result, persisted!.runAtMs).healthy).toBe(true);
    await adapter.close();
  });

  it('REAL damage persisted with repair disabled reads back as DAMAGED', async () => {
    // The acceptance an operator cares about: reopen a store whose FTS index is
    // dead and confirm the status surface says so rather than staying silent.
    const dbPath = join(liveTmp, `durable-damaged-${Date.now()}.db`);
    const build = createSqliteAdapter({ dbPath });
    await build.exec(`
      CREATE TABLE IF NOT EXISTS node (
        id INTEGER PRIMARY KEY, content TEXT, name TEXT, summary TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(
        content, name, summary, content='node', content_rowid='rowid'
      );
    `);
    for (let i = 0; i < 10; i++) {
      await build.executeRun(
        `INSERT INTO node (content, name, summary) VALUES (?, ?, ?)`,
        [`episode ${i} concerning quarterly hippopotamus logistics`, `n${i}`, `s${i}`],
      );
    }
    await build.exec(`INSERT INTO fts_node(fts_node) VALUES('rebuild')`);
    (build.unwrap() as BetterSqlite3Database).exec(
      `INSERT INTO fts_node(fts_node) VALUES('delete-all')`,
    );
    await build.close();

    // Reopen through the normal path with auto-repair OFF, so the persisted
    // verdict records the damage instead of a repair that already fixed it.
    const prev = process.env.SOX_STORE_REPAIR;
    process.env.SOX_STORE_REPAIR = 'off';
    let view;
    try {
      const reopened = createSqliteAdapter({ dbPath });
      await reopened.init();
      await reopened.close();

      const reader = createSqliteAdapter({ dbPath });
      const persisted = await readIntegrityResult(reader);
      expect(persisted).not.toBeNull();
      view = summarizeIntegrityForStatus(persisted!.result, persisted!.runAtMs);
      await reader.close();
    } finally {
      if (prev === undefined) delete process.env.SOX_STORE_REPAIR;
      else process.env.SOX_STORE_REPAIR = prev;
    }

    expect(view!.healthy, JSON.stringify(view, null, 2)).toBe(false);
    expect(view!.overall).toBe('damaged');
    expect(view!.damaged.find((d) => d.probe === 'fts_index_live')?.backlog).toBe('BL-347');
    expect(integrityHeadline(view!)).toMatch(/DAMAGED/);
  });

  it('an unparseable or foreign meta row reads as unknown, not as healthy', async () => {
    const dbPath = join(liveTmp, `durable-garbage-${Date.now()}.db`);
    const adapter = createSqliteAdapter({ dbPath });
    await adapter.init();
    await adapter.executeRun(
      `INSERT INTO _adapter_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [INTEGRITY_META_KEY, 'not json at all'],
    );
    expect(await readIntegrityResult(adapter)).toBeNull();

    // A future/foreign envelope version must also refuse to be interpreted.
    await adapter.executeRun(
      `INSERT INTO _adapter_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [INTEGRITY_META_KEY, JSON.stringify({ v: 99, run_at_ms: 1, result: {} })],
    );
    expect(await readIntegrityResult(adapter)).toBeNull();
    expect(summarizeIntegrityForStatus(null, null).healthy).toBe(false);
    await adapter.close();
  });
});
