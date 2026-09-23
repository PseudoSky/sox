/**
 * memoryGetRelated — graph neighbors at depth=1 over live edges and live nodes.
 *
 * Edge-level and node-level validity are applied in the SAME query that
 * applies `LIMIT`, in both directions. The prior implementation's defect was
 * the ORDER of those operations, not their absence: `getEdges()` does prepend
 * `t_invalid IS NULL` to the edge scan (graph-store/src/index.ts:2698), and
 * `t_invalid IS NULL` was applied to the neighbour nodes — but only AFTER
 * `.slice(0, limit)` had already truncated the edge array. An invalidated
 * neighbour inside the limit window therefore consumed a slot and was then
 * dropped, silently returning a short list while live neighbours that would
 * have filled those slots sat just past the cut.
 *
 * The replacement is a single bidirectional `UNION ALL` — out-edges keyed on
 * `e.src`, in-edges on `e.dst` — with `LIMIT` bound in SQL. `UNION ALL`, not
 * `UNION`: a reciprocal A→B/B→A pair is two distinct entries (one per
 * direction) and always has been. No `n.kind` predicate is applied, matching
 * prior behaviour — a `MENTIONS` edge reaches an entity node, and callers see
 * those today typed as `EpisodeBase`.
 *
 * Ordering is `dir_rank ASC, e.rowid ASC` — a literal 0/1 rank, because
 * `'inbound' < 'outbound'` alphabetically and outbound has always been
 * emitted first. No importance ordering is imposed: `memory_related` promises
 * none, unlike the sibling `memory_entity_episodes`.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { parseTags, isSuperseded, supersedesUidForRowid, communityUidForRowid } from './recall.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EpisodeBase {
  uid: string;
  content: string | null;
  summary: string | null;
  topic: string | null;
  tags: string[];
  project_path: string | null;
  importance: number;
  t_created: string;
  agent_id: string | null;
  is_superseded: boolean;
  supersedes_uid: string | null;
  community_uid: string | null;
}

export interface EdgeEntry {
  episode: EpisodeBase;
  rel: string;
  weight: number;
  direction: 'outbound' | 'inbound';
}

export interface RelatedResult {
  source_uid: string;
  edges: EdgeEntry[];
  /** Live edges (both directions, after the `rel` filter) whose neighbour node
   *  has been invalidated. NOT bounded by `limit` — it counts the whole
   *  neighbourhood, so it is a diagnostic of how much of this node's graph has
   *  been invalidated, never a paging denominator (`memoryGetRelated` has no
   *  `total` and no `offset`). Observability only; should trend toward zero as
   *  the near-dup pass stops auto-invalidating.
   *
   *  OPTIONAL, matching `EntityEpisodesResult.invalidated_count`. This ships
   *  under PUBLISHING.md's patch-for-additive-API exception, and a REQUIRED
   *  property would not qualify: `RelatedResult` is re-exported from the
   *  package root (index.ts:391), so any external site constructing the
   *  literal — a mock, a test double, an adapter shim — would fail to compile
   *  on a patch bump. Always populated by `memoryGetRelated`, including the
   *  E_NOT_FOUND path. */
  invalidated_count?: number;
  code?: string;
}

interface NeighborRow {
  rowid: number;
  uid: string;
  content: string | null;
  summary: string | null;
  topic: string | null;
  tags: string | null;
  project_path: string | null;
  importance: number;
  t_created: string;
  agent_id: string | null;
  rel: string;
  weight: number | null;
  dir_rank: number;
}

async function nodeRowToEpisode(adapter: StoreAdapter, r: NeighborRow): Promise<EpisodeBase> {
  return {
    uid: r.uid,
    content: r.content,
    summary: r.summary ?? null,
    topic: r.topic ?? null,
    tags: parseTags(r.tags),
    project_path: r.project_path ?? null,
    importance: r.importance,
    t_created: r.t_created,
    agent_id: r.agent_id ?? null,
    is_superseded: await isSuperseded(adapter, r.rowid),
    supersedes_uid: await supersedesUidForRowid(adapter, r.rowid),
    community_uid: await communityUidForRowid(adapter, r.rowid),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function memoryGetRelated(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
): Promise<RelatedResult> {
  const uid = args['uid'] as string;
  const relFilter = args['rel'] as string[] | undefined;
  // Normalize `limit` BEFORE it can reach SQL as a bind param. This is not
  // cosmetic: the MCP schema declares `limit` as a plain `number` (max 100, no
  // `minimum`, no `multipleOf`) and direct memory-core callers bypass the
  // schema entirely, so non-integer and negative values are reachable. Under
  // the old `.slice(0, limit)` both were harmlessly absorbed; under a real
  // `LIMIT ?` they are not — SQLite reads a NEGATIVE limit as "no limit"
  // (returning the entire neighbourhood, a strictly worse failure than the one
  // being fixed), and a non-integer bind throws `datatype mismatch`, which
  // nothing upstream catches. `Number.isFinite` rather than `x || default`,
  // because `||` would treat an explicit `limit: 0` as falsy and hand back a
  // full page where the adjacent `limit: -1` clamps to zero rows.
  const rawLimit = args['limit'] as number | undefined;
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit as number) ? Math.trunc(rawLimit as number) : 20, 0),
    100,
  );

  const sourceRow = await adapter.executeGet<{ rowid: number }>(
    `SELECT rowid FROM node WHERE uid = ? LIMIT 1`,
    [uid],
  );

  if (!sourceRow) {
    return { source_uid: uid, edges: [], invalidated_count: 0, code: 'E_NOT_FOUND' };
  }

  const srcRowid = sourceRow.rowid;

  // `rel` filter: an IN-list over the requested relation types, or no clause at
  // all when absent/empty — matching the prior `relSet === null` semantics of
  // "all live relation types". Bound as parameters, never interpolated.
  const rels = relFilter && relFilter.length > 0 ? relFilter : null;
  const relClause = rels ? ` AND e.rel IN (${rels.map(() => '?').join(',')})` : '';
  const relParams: unknown[] = rels ?? [];

  const NEIGHBOR_COLS = `n.rowid, n.uid, n.content, n.summary, n.topic, n.tags,
            n.project_path, n.importance, n.t_created, n.agent_id,
            e.rel AS rel, e.weight AS weight`;

  // One query, both directions, live edges joined to LIVE nodes, with LIMIT
  // applied by SQL after that filtering — the whole point of the fix. Out-edges
  // key the neighbour on e.dst, in-edges on e.src.
  const pageResult = await adapter.executeAll<NeighborRow>(
    `SELECT ${NEIGHBOR_COLS}, 0 AS dir_rank, e.rowid AS edge_rowid
       FROM edge e JOIN node n ON n.rowid = e.dst
      WHERE e.src = ? AND e.t_invalid IS NULL AND n.t_invalid IS NULL${relClause}
      UNION ALL
     SELECT ${NEIGHBOR_COLS}, 1 AS dir_rank, e.rowid AS edge_rowid
       FROM edge e JOIN node n ON n.rowid = e.src
      WHERE e.dst = ? AND e.t_invalid IS NULL AND n.t_invalid IS NULL${relClause}
      ORDER BY dir_rank ASC, edge_rowid ASC
      LIMIT ?`,
    [srcRowid, ...relParams, srcRowid, ...relParams, limit],
  );

  // Same join shape, inverted node predicate, and deliberately NOT limited —
  // see the `invalidated_count` docstring on RelatedResult.
  const invalidatedRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM (
       SELECT e.rowid FROM edge e JOIN node n ON n.rowid = e.dst
        WHERE e.src = ? AND e.t_invalid IS NULL AND n.t_invalid IS NOT NULL${relClause}
        UNION ALL
       SELECT e.rowid FROM edge e JOIN node n ON n.rowid = e.src
        WHERE e.dst = ? AND e.t_invalid IS NULL AND n.t_invalid IS NOT NULL${relClause}
     )`,
    [srcRowid, ...relParams, srcRowid, ...relParams],
  );

  const edges: EdgeEntry[] = [];
  for (const r of pageResult.rows) {
    edges.push({
      episode: await nodeRowToEpisode(adapter, r),
      rel: r.rel,
      weight: r.weight ?? 1.0,
      direction: r.dir_rank === 0 ? 'outbound' : 'inbound',
    });
  }

  return { source_uid: uid, edges, invalidated_count: invalidatedRow?.cnt ?? 0 };
}
