/**
 * clustering-e2e.test.ts — end-to-end proof (or disproof) that community
 * clustering actually works, on BOTH storage backends, using the REAL
 * embedding provider.
 *
 * WHY THIS FILE EXISTS (2026-07-30 mission):
 * The live `~/.memory/memory.db` store reports, via `memory_stats`:
 *
 *   cluster_count: 139          <- communities exist, live (t_invalid IS NULL)
 *   total_clustered: 0          <- but ZERO episodes are MEMBER_OF any of them
 *   total_unclustered: 4411
 *   coverage: 0
 *   mean_intra_cluster_sim: 0.883  <- non-degenerate — these WERE real clusters
 *
 * Clustering has never been exercised end-to-end in this repo's test suite
 * before this file. Every existing clustering test either uses the
 * `DeterministicTestProvider` (meaningless similarity geometry) or asserts on
 * `cluster_count` alone (which the live store proves is NOT sufficient — 139
 * live communities with 0 members is exactly the failure mode a
 * cluster-count-only assertion would miss).
 *
 * This file:
 *   1. Seeds ~24 REAL-embedded episodes across 3 semantically distinct groups
 *      (db migrations, React hooks, coffee brewing) on a fresh store.
 *   2. Proves vectors actually land in `vec_node` (768-dim, 3072-byte blobs).
 *   3. Proves the INCREMENTAL clustering path (`incrementalOnly: true`, the
 *      ONLY thing a normal `memory_write` triggers) is a structural no-op —
 *      `cluster.ts:437-441` returns `{ clusters: [], full_pass: false }`
 *      unconditionally, even with valid vectors present. This is verified both
 *      at the pure `clusterStore()` level and through the production
 *      `runEnrichPassOnDb` wrapper.
 *   4. Proves the FULL pass (`clusterStore()` with no `incrementalOnly`) DOES
 *      correctly cluster real content: `cluster_count > 0` AND
 *      `total_clustered > 0` (the exact pair the live store fails), each
 *      group's episodes land in one shared community, and different groups
 *      never collapse together.
 *   5. Reproduces the live anomaly directly: invalidating a cluster's member
 *      episodes (the real `memory_invalidate` tool — ordinary bi-temporal
 *      supersession, not a special deletion path) leaves the community node
 *      live (`cluster_count` unchanged) while `total_clustered` drops, because
 *      `clusterStats`'s `total_clustered` JOIN requires
 *      `src.t_invalid IS NULL` (`cluster.ts:659`) and `materializeClusters`
 *      is never re-invoked by ordinary invalidation.
 *   6. Rules out the competing "a later sparse full pass produced this"
 *      theory: running a SECOND full pass after vector loss does NOT leave
 *      stale communities live-with-zero-members — `materializeClusters`
 *      unconditionally invalidates every prior global community before
 *      reinserting (`cluster.ts:274-296`), so a real full pass retires
 *      orphaned communities rather than abandoning them live. Since (3) shows
 *      a full pass essentially never runs automatically in steady state, the
 *      live anomaly is explained by (5), not (6).
 *
 * TEST-INFRASTRUCTURE TRAP AVOIDED: Turso availability is resolved
 * SYNCHRONOUSLY at module load (matching `throughput-golden.spec.ts` and
 * `turso-clean-room.test.ts`), never via `beforeAll` + `{ skip }` — Vitest
 * freezes `skip` at synchronous `describe()` collection time, before any
 * `beforeAll` has run, so an async-resolved flag is always its initializer.
 */

import {
  WriteQueue,
  clusterStats,
  clusterStore,
} from '@adhd/sox-memory-core';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleToolCall, runEnrichPassOnDb } from './src/index.js';

// ── Turso availability — resolved SYNCHRONOUSLY at module load ─────────────

const TURSO_DRIVER_PATH = path.resolve(
  __dirname,
  '../../../../../node_modules/@tursodatabase/database/dist/promise.js',
);
const HAS_TURSO = (() => {
  try {
    return fs.existsSync(TURSO_DRIVER_PATH);
  } catch {
    return false;
  }
})();

// ── Fixture corpus: 3 semantically distinct groups, 8 episodes each ────────
// Real, hand-written content (not random strings, not templated filler) so
// the REAL embedding provider produces meaningfully separable geometry.

const GROUPS: Record<string, string[]> = {
  'db-migrations': [
    'Database migration log: applied Flyway migration V14 adding an index to the orders table schema, migration completed in 4.2 seconds with no errors.',
    'Database migration log: applied Flyway migration V15 adding a nullable email_verified column to the users table schema, migration completed cleanly.',
    'Database migration log: applied Flyway migration V16 dropping the deprecated legacy_status column from the orders table schema after backfill finished.',
    'Database migration log: applied Flyway migration V17 renaming the customers table to accounts in the schema, migration completed with a brief lock.',
    'Database migration log: applied Flyway migration V18 adding a foreign key constraint between invoices and accounts in the schema, migration succeeded.',
    'Database migration log: applied Flyway migration V19 creating a new audit_log table in the schema for compliance tracking, migration completed instantly.',
    'Database migration log: applied Flyway migration V20 adding a composite index on orders(customer_id, created_at) in the schema, migration completed.',
    'Database migration log: applied Flyway migration V21 widening the phone_number column to varchar(32) in the schema, migration completed without downtime.',
  ],
  'react-hooks': [
    'React hooks code review note: the useEffect in CartSummary is missing quantity in its dependency array, causing a stale closure bug on the hook.',
    'React hooks code review note: the useState call in CheckoutForm should be replaced with useReducer since the hook branches on prior state.',
    'React hooks code review note: the useCallback in ProductList is unnecessary since the child component is not wrapped in React.memo for this hook.',
    'React hooks code review note: the useMemo in PriceCalculator recomputes on every render because its dependency array is empty in this hook.',
    'React hooks code review note: the custom useDebouncedSearch hook wraps useState and useEffect together to avoid firing on every keystroke.',
    'React hooks code review note: the useRef in ScrollContainer correctly tracks the previous scroll position without triggering a re-render via this hook.',
    'React hooks code review note: the useLocalStorage hook writes to localStorage inside useEffect every time the underlying state value changes.',
    'React hooks code review note: conditionally calling useState inside an early return in UserProfile violates the rules of hooks for this component.',
  ],
  'coffee-brewing': [
    'Coffee brewing log: pour-over V60, 205°F water, medium-fine grind, 1:16 ratio, bloom for 30 seconds, total brew time 2 minutes 45 seconds.',
    'Coffee brewing log: pour-over Kalita Wave, 202°F water, medium grind, 1:15 ratio, bloom for 45 seconds, total brew time 3 minutes 10 seconds.',
    'Coffee brewing log: French press, 200°F water, coarse grind, 1:12 ratio, four-minute steep, plunge slowly to avoid stirring up sediment.',
    'Coffee brewing log: espresso shot, fine grind, 18 grams in, 36 grams out, 27 second extraction, slight channeling noticed on this shot.',
    'Coffee brewing log: cold brew, coarse grind, room temperature water, steeped eighteen hours, strained twice through a paper filter.',
    'Coffee brewing log: pour-over Chemex, 204°F water, medium-coarse grind, 1:16 ratio, bloom for 40 seconds, total brew time 4 minutes.',
    'Coffee brewing log: AeroPress, 195°F water, medium-fine grind, inverted method, one-minute steep, thirty second press, no bitterness.',
    'Coffee brewing log: pour-over V60, fresh-roasted beans rested three days, 206°F water, medium-fine grind, noticeably brighter cup than usual.',
  ],
};
const GROUP_NAMES = Object.keys(GROUPS);

/**
 * Explicit clustering threshold used for the correctness-proving tests below.
 *
 * MEASURED, not guessed: a standalone probe (real bge-base-en-v1.5 embeddings,
 * this exact corpus, `SOX_SYNC_EMBED=1`) gave:
 *
 *   intra[db-migrations]   mean=0.8174 min=0.7572 max=0.8916
 *   intra[react-hooks]     mean=0.7947 min=0.7428 max=0.8495
 *   intra[coffee-brewing]  mean=0.8141 min=0.7321 max=0.9013
 *   inter (all 3 pairs)    max=0.5652
 *
 * i.e. every cross-group pair sits at or below 0.5652 and every within-group
 * pair sits at or above 0.7321 — a clean single-linkage separation window of
 * (0.5652, 0.7321]. 0.65 sits safely inside it. This is a REAL measurement,
 * not a tuned-to-pass constant — see the "production DEFAULT threshold"
 * probe test below for what the actual 0.82 default does to this same corpus.
 */
const CLUSTER_THRESHOLD = 0.65;

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function textOf(result: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/** Write the fixture corpus through the real MCP `memory_write` tool (real embed). */
async function writeGroupedCorpus(dbPath: string): Promise<Record<string, string[]>> {
  const uidsByGroup: Record<string, string[]> = {};
  for (const group of GROUP_NAMES) {
    uidsByGroup[group] = [];
    for (const content of GROUPS[group]!) {
      const result = await handleToolCall('memory_write', {
        db_path: dbPath,
        content,
        project_path: '/test/clustering-e2e',
        topic: group,
      });
      expect(result.isError, `write failed for group=${group}: ${JSON.stringify(result)}`).toBeFalsy();
      const body = textOf(result);
      const episodeUid = body['episode_uid'] as string | undefined;
      expect(episodeUid, `no episode_uid in write response: ${JSON.stringify(body)}`).toBeTruthy();
      uidsByGroup[group]!.push(episodeUid!);
    }
  }
  return uidsByGroup;
}

async function rowidForUid(adapter: StoreAdapter, uid: string): Promise<number> {
  const row = await adapter.executeGet<{ rowid: number }>(`SELECT rowid FROM node WHERE uid = ?`, [uid]);
  if (!row) throw new Error(`clustering-e2e: no node found for uid ${uid}`);
  return row.rowid;
}

async function vecStats(adapter: StoreAdapter): Promise<{ count: number; lengths: number[] }> {
  const rows = (
    await adapter.executeAll<{ node_id: number; embedding: Buffer }>(`SELECT node_id, embedding FROM vec_node`)
  ).rows;
  return { count: rows.length, lengths: rows.map((r) => r.embedding.length) };
}

/** The live MEMBER_OF community uid for an episode rowid, or null if unclustered. */
async function communityForRowid(adapter: StoreAdapter, rowid: number): Promise<string | null> {
  const row = await adapter.executeGet<{ uid: string }>(
    `SELECT dst_n.uid AS uid
     FROM edge e
     JOIN node dst_n ON dst_n.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
       AND dst_n.kind = 'community' AND dst_n.t_invalid IS NULL
     LIMIT 1`,
    [rowid],
  );
  return row?.uid ?? null;
}

async function communityLiveState(adapter: StoreAdapter, communityUid: string): Promise<'live' | 'invalidated' | 'missing'> {
  const row = await adapter.executeGet<{ t_invalid: string | null }>(
    `SELECT t_invalid FROM node WHERE uid = ? AND kind = 'community'`,
    [communityUid],
  );
  if (!row) return 'missing';
  return row.t_invalid === null ? 'live' : 'invalidated';
}

/** The dominant (most common non-null) community uid among a group's members. */
function dominantCommunity(communities: Array<string | null>): { dominant: string | null; nonNull: string[] } {
  const nonNull = communities.filter((c): c is string => c !== null);
  const counts = new Map<string, number>();
  for (const c of nonNull) counts.set(c, (counts.get(c) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { dominant: sorted[0]?.[0] ?? null, nonNull };
}

// ── Cross-backend results matrix (logged at the very end) ─────────────────

interface MatrixEntry {
  backend: string;
  phase: string;
  [k: string]: unknown;
}
const matrix: MatrixEntry[] = [];

// ── Suite factory — identical assertions run against both backends ────────

function runSuite(backend: 'sqlite' | 'turso'): void {
  const skipTurso = backend === 'turso' && !HAS_TURSO;

  describe(`clustering e2e — ${backend}${skipTurso ? ' (SKIPPED: turso driver unavailable)' : ''}`, () => {
    if (skipTurso) {
      it.skip('turso driver not available in node_modules — cannot exercise this backend', () => {
        /* intentionally empty */
      });
      return;
    }

    const tmp = makeTempDir(`sox-cluster-${backend}-`);
    const dbPath = path.join(tmp.dir, 'test.db');
    let origStoreAdapter: string | undefined;
    let adapter: StoreAdapter;
    let uidsByGroup: Record<string, string[]>;
    let dominantByGroup: Record<string, string> = {};

    beforeAll(async () => {
      origStoreAdapter = process.env['STORE_ADAPTER'];
      process.env['STORE_ADAPTER'] = backend;
      uidsByGroup = await writeGroupedCorpus(dbPath);
      // Reuse the SAME already-open StoreAdapter that powered the writes above
      // (WriteQueue.forPath is a per-dbPath cached singleton) instead of a
      // second independent openDb(dbPath) call — cheaper, and avoids ever
      // opening the file twice. NOTE: this does NOT route around the Turso
      // blocker documented in the delivery report — that crash reproduces on
      // the very FIRST openDb() for a brand-new TursoAdapter store (inside
      // writeGroupedCorpus's first memory_write, i.e. above this line), not on
      // a second open. See the delivery notes for the full repro: opening ANY
      // fresh Turso store in the current working tree crashes inside
      // `dropVec0ViaBetterSqlite3` (db.ts:212-238, invoked from db.ts:646) with
      // `SqliteError: malformed database schema
      // (__turso_internal_fts_dir_idx_fts_node_key) - near "USING": syntax
      // error` — better-sqlite3's SQLite build cannot parse a Turso-native FTS
      // internal object left by the in-flight fts-unify `index_method` work.
      // Reported to the team lead as a standalone, higher-priority finding
      // (it blocks ALL Turso e2e testing, not just clustering) rather than
      // fixed here — db.ts and turso-adapter.ts are owned by other in-flight
      // work. This describe block is already wired to exercise Turso
      // automatically the moment that blocker clears.
      const wq = await WriteQueue.forPath(dbPath);
      adapter = await wq.enqueue('clustering-e2e-grab-adapter', async (a) => a);
    }, 300_000);

    afterAll(async () => {
      if (origStoreAdapter === undefined) {
        delete process.env['STORE_ADAPTER'];
      } else {
        process.env['STORE_ADAPTER'] = origStoreAdapter;
      }
      await WriteQueue.clearInstances();
      tmp.cleanup();
    });

    it('step 1: real embeddings actually land in vec_node (768-dim / 3072-byte blobs)', async () => {
      const stats = await vecStats(adapter);
      matrix.push({ backend, phase: '1-vectors', vec_count: stats.count, lengths_sample: stats.lengths.slice(0, 3) });

      expect(stats.count, `expected vec_node rows for all 24 written episodes, got ${stats.count}`).toBeGreaterThan(0);
      expect(
        stats.lengths.every((l) => l === 3072),
        `every embedding must be 768 * 4 = 3072 bytes; got lengths ${JSON.stringify([...new Set(stats.lengths)])}`,
      ).toBe(true);
      expect(stats.count, 'SOX_SYNC_EMBED=1 (test setup) means every write is embedded synchronously — vec_count should equal the corpus size').toBe(24);
    });

    it('step 2: incremental-only clusterStore() is a structural no-op (cluster.ts:437-441) even though valid vectors exist', async () => {
      const before = await clusterStats(adapter);
      const result = await clusterStore(adapter, { incrementalOnly: true });
      const after = await clusterStats(adapter);

      matrix.push({
        backend,
        phase: '2-incremental-direct',
        clusters_returned: result.clusters.length,
        full_pass: result.full_pass,
        cluster_count_before: before.cluster_count,
        cluster_count_after: after.cluster_count,
      });

      expect(result.full_pass, 'incrementalOnly must report full_pass:false').toBe(false);
      expect(
        result.clusters.length,
        'incrementalOnly must never materialize clusters — computeClusters short-circuits to {clusters:[]} at cluster.ts:438-441 (a TODO stub, not a real local-neighbourhood check)',
      ).toBe(0);
      expect(after.cluster_count).toBe(before.cluster_count);
      expect(after.total_clustered).toBe(before.total_clustered);
    });

    it('step 3: the production wrapper (runEnrichPassOnDb, no pending full-enrich row) never grows clusters either', async () => {
      const before = await clusterStats(adapter);
      await runEnrichPassOnDb(adapter, dbPath);
      const after = await clusterStats(adapter);

      matrix.push({
        backend,
        phase: '3-prod-wrapper-incremental',
        total_clustered_before: before.total_clustered,
        total_clustered_after: after.total_clustered,
      });

      // runEnrichPassOnDb() with no pending organizer_queue "enrich" row calls
      // runBatchEnrich({ incrementalCluster: true }) → clusterStore({ incrementalOnly: true })
      // → same no-op proven in step 2. This is the ONLY enrichment path a normal
      // memory_write triggers in steady state (memory-server/src/index.ts:2024).
      expect(after.total_clustered).toBe(before.total_clustered);
      expect(after.cluster_count).toBe(before.cluster_count);
    });

    it('step 3.5 (informational): the production DEFAULT threshold (0.82, no override) against this real near-duplicate-style corpus', async () => {
      // This is the literal production default (resolveDefaultThreshold() in
      // cluster.ts:918-920) run against real embeddings of intentionally
      // near-duplicate-style content — about as favourable a corpus as
      // real-world episodes get. Whatever it does here is materialized; step 4
      // immediately re-clusters with an explicit threshold, which unconditionally
      // invalidates and replaces every prior global community
      // (materializeClusters, cluster.ts:274-296), so this probe cannot leak
      // into any later assertion. Soft assertion only — this test reports
      // real behaviour, it does not gate the suite.
      const result = await clusterStore(adapter, {});
      const stats = await clusterStats(adapter);
      matrix.push({
        backend,
        phase: '3.5-production-default-threshold',
        default_threshold: 0.82,
        clusters_at_default: result.clusters.length,
        cluster_count_at_default: stats.cluster_count,
        total_clustered_at_default: stats.total_clustered,
      });
      // Must at least run without throwing and return a well-formed result —
      // no hard expectation on cluster count either way (see comment above).
      expect(result).toHaveProperty('full_pass');
    });

    it('step 4: a FULL pass at an explicit, measured-safe threshold (clusterStore(), no incrementalOnly) actually clusters and covers the store', async () => {
      const result = await clusterStore(adapter, { threshold: CLUSTER_THRESHOLD });
      expect(result.full_pass).toBe(true);
      expect(result.clusters.length, `expected clusters to form across the ${GROUP_NAMES.length} semantic groups`).toBeGreaterThan(0);

      const stats = await clusterStats(adapter);
      matrix.push({
        backend,
        phase: '4-full-pass',
        cluster_count: stats.cluster_count,
        total_clustered: stats.total_clustered,
        total_unclustered: stats.total_unclustered,
        coverage: stats.coverage,
        largest_cluster_size: stats.largest_cluster_size,
        mean_intra_sim: stats.mean_intra_sim,
        mean_inter_sim: stats.mean_inter_sim,
      });

      // THIS is the exact pair the live store fails: cluster_count > 0 passes
      // live (139) but total_clustered > 0 does not (0). Both must pass here.
      expect(stats.cluster_count, 'cluster_count > 0').toBeGreaterThan(0);
      expect(stats.total_clustered, 'total_clustered > 0 — the assertion the live store fails').toBeGreaterThan(0);
      expect(stats.coverage, 'coverage > 0').toBeGreaterThan(0);
      expect(stats.largest_cluster_size, 'largest_cluster_size > 0').toBeGreaterThan(0);
    });

    it('step 5: MEMBER_OF edges exist and resolve to live community nodes', async () => {
      const row = await adapter.executeGet<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM edge e
         JOIN node src ON src.rowid = e.src AND src.kind = 'episode' AND src.t_invalid IS NULL
         JOIN node dst ON dst.rowid = e.dst AND dst.kind = 'community' AND dst.t_invalid IS NULL
         WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL`,
      );
      const cnt = row?.cnt ?? 0;
      matrix.push({ backend, phase: '5-edge-resolution', live_member_of_edges: cnt });
      expect(cnt, 'at least one live episode->community MEMBER_OF edge must resolve').toBeGreaterThan(0);
    });

    it('step 6: same-group episodes cluster together; different groups never collapse into one community', async () => {
      const groupCommunities: Record<string, Array<string | null>> = {};
      for (const group of GROUP_NAMES) {
        groupCommunities[group] = [];
        for (const uid of uidsByGroup[group]!) {
          const rowid = await rowidForUid(adapter, uid);
          groupCommunities[group]!.push(await communityForRowid(adapter, rowid));
        }
      }

      matrix.push({
        backend,
        phase: '6-purity',
        ...Object.fromEntries(Object.entries(groupCommunities).map(([g, c]) => [`${g}_communities`, c])),
      });

      for (const group of GROUP_NAMES) {
        const communities = groupCommunities[group]!;
        const { dominant, nonNull } = dominantCommunity(communities);
        expect(
          nonNull.length,
          `group ${group}: expected a majority of its ${communities.length} members to be clustered, got ${nonNull.length}`,
        ).toBeGreaterThanOrEqual(Math.ceil(communities.length * 0.5));
        expect(dominant, `group ${group} produced no dominant community`).not.toBeNull();
        expect(
          nonNull.every((c) => c === dominant),
          `group ${group} split across multiple communities instead of one shared cluster: ${JSON.stringify(nonNull)}`,
        ).toBe(true);
        dominantByGroup[group] = dominant!;
      }

      // Cross-group purity: no two groups share a dominant community.
      const dominantVals = Object.values(dominantByGroup);
      expect(
        new Set(dominantVals).size,
        `groups collapsed into fewer communities than expected: ${JSON.stringify(dominantByGroup)}`,
      ).toBe(dominantVals.length);
    });

    it('REPRO A: invalidating a cluster\'s member episodes reproduces the live "139 communities / 0 members" anomaly', async () => {
      const before = await clusterStats(adapter);
      expect(before.cluster_count).toBeGreaterThan(0);

      const targetGroup = GROUP_NAMES[0]!; // 'db-migrations'
      for (const uid of uidsByGroup[targetGroup]!) {
        const res = await handleToolCall('memory_invalidate', {
          db_path: dbPath,
          claim_uid: uid,
          reason: 'clustering-e2e anomaly repro (REPRO A)',
        });
        expect(res.isError, `memory_invalidate failed for ${uid}: ${JSON.stringify(textOf(res))}`).toBeFalsy();
      }

      const after = await clusterStats(adapter);
      matrix.push({
        backend,
        phase: '7-repro-A-invalidate',
        target_group: targetGroup,
        cluster_count_before: before.cluster_count,
        cluster_count_after: after.cluster_count,
        total_clustered_before: before.total_clustered,
        total_clustered_after: after.total_clustered,
      });

      // THE anomaly, reproduced with real numbers: communities are STILL live
      // (materializeClusters was never re-invoked — memory_invalidate only sets
      // node.t_invalid, it never touches the community node or its edges) ...
      expect(
        after.cluster_count,
        'community nodes must remain live after ordinary episode invalidation — this IS the live anomaly',
      ).toBe(before.cluster_count);
      // ...but member coverage genuinely collapses, because clusterStats' JOIN
      // requires src.t_invalid IS NULL (cluster.ts:659) and every member of the
      // target group is now invalidated.
      expect(
        after.total_clustered,
        'total_clustered must drop once member episodes are invalidated, while cluster_count does not',
      ).toBeLessThan(before.total_clustered);

      const orphanedCommunity = dominantByGroup[targetGroup]!;
      const state = await communityLiveState(adapter, orphanedCommunity);
      expect(state, `the ${targetGroup} community must still be a LIVE node with all members gone`).toBe('live');
    });

    it('REPRO B: a genuine second full pass RETIRES stale communities — it does NOT leave them live-with-zero-members', async () => {
      // Simulate vector loss on a still-LIVE group (react-hooks) to test the
      // competing "a later sparse full pass produced the anomaly" theory.
      const vectorLossGroup = GROUP_NAMES[1]!; // 'react-hooks'
      const healthyGroup = GROUP_NAMES[2]!; // 'coffee-brewing'
      const rowidsToStrip: number[] = [];
      for (const uid of uidsByGroup[vectorLossGroup]!) {
        rowidsToStrip.push(await rowidForUid(adapter, uid));
      }
      const placeholders = rowidsToStrip.map(() => '?').join(',');
      await adapter.executeRun(`DELETE FROM vec_node WHERE node_id IN (${placeholders})`, rowidsToStrip);

      const beforeCommunityStates = {
        [GROUP_NAMES[0]!]: await communityLiveState(adapter, dominantByGroup[GROUP_NAMES[0]!]!),
        [vectorLossGroup]: await communityLiveState(adapter, dominantByGroup[vectorLossGroup]!),
        [healthyGroup]: await communityLiveState(adapter, dominantByGroup[healthyGroup]!),
      };

      const result = await clusterStore(adapter, { threshold: CLUSTER_THRESHOLD });
      const after = await clusterStats(adapter);

      const afterCommunityStates = {
        [GROUP_NAMES[0]!]: await communityLiveState(adapter, dominantByGroup[GROUP_NAMES[0]!]!),
        [vectorLossGroup]: await communityLiveState(adapter, dominantByGroup[vectorLossGroup]!),
        [healthyGroup]: await communityLiveState(adapter, dominantByGroup[healthyGroup]!),
      };

      matrix.push({
        backend,
        phase: '8-repro-B-second-full-pass',
        clusters_after_second_pass: result.clusters.length,
        cluster_count_after: after.cluster_count,
        total_clustered_after: after.total_clustered,
        before_states: beforeCommunityStates,
        after_states: afterCommunityStates,
      });

      // The db-migrations community was already orphaned by REPRO A (members
      // invalidated, community still live). A genuine full pass now retires it —
      // it does NOT stay live-with-zero-members once a full pass actually runs.
      expect(
        afterCommunityStates[GROUP_NAMES[0]!],
        'a real full pass must invalidate the orphaned db-migrations community rather than leaving it live',
      ).toBe('invalidated');

      // The vector-loss group's OLD community is also retired — it can no
      // longer be reconstructed (no candidate vectors), so materializeClusters'
      // unconditional prior-invalidation sweep (cluster.ts:274-296) removes it.
      expect(
        afterCommunityStates[vectorLossGroup],
        'a real full pass must invalidate the react-hooks community once its vectors are gone, not abandon it live',
      ).toBe('invalidated');

      // The still-healthy coffee-brewing community survives (same member set →
      // same deterministic community_uid → upsert keeps it live).
      expect(
        afterCommunityStates[healthyGroup],
        'the still-vectorized coffee-brewing community must remain live across a real full pass',
      ).toBe('live');

      // Conclusion this proves: a genuine full recluster pass is SELF-HEALING
      // (it retires communities whose members are gone or unclusterable) — so
      // "a later sparse full pass" cannot explain 139-live/0-members on its
      // own. The live anomaly requires member invalidation WITHOUT a
      // subsequent full pass ever running — exactly REPRO A, combined with
      // steps 2/3 proving a full pass essentially never runs automatically.
    });
  });
}

runSuite('sqlite');
runSuite('turso');

afterAll(() => {
  // Printed once, after every describe block in this file has finished —
  // the real sqlite-vs-turso comparison matrix backing the delivery report.
  // (No eslint-disable needed — `no-console` is not enabled for test files, and an unused
  // directive is itself a lint warning.)
  console.log(`\n=== clustering-e2e backend matrix ===\n${JSON.stringify(matrix, null, 2)}\n`);
});
