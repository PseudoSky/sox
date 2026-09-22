/**
 * memoryGetEntityEpisodes — episodes mentioning an entity via MENTIONS edges.
 *
 * Resolves entity by uid or name, then joins live MENTIONS edges to their
 * live episode source nodes via the same SQL shape for `total`,
 * `invalidated_count`, and the page (BL: Q4 of the near-dup invalidation fix
 * plan) — pagination never slices a raw, unfiltered edge array the way the
 * prior implementation did. Results are ordered `importance DESC, rowid ASC`
 * per the tool's documented "ranked by importance" contract
 * (memory-server/src/index.ts).
 *
 * The three reads run inside one `adapter.transaction()` (deferred/read) so
 * they see one consistent snapshot of the edge/node tables — without it, an
 * invalidation from a concurrent writer (e.g. the near-dup pass) landing
 * between the count and the page query reproduces the exact "total N, short
 * page" symptom this function exists to eliminate. Per-episode enrichment
 * (`isSuperseded`/`supersedesUidForRowid`/`communityUidForRowid` below) runs
 * OUTSIDE that transaction, against already-resolved rowids — it is not
 * covered by this consistency guarantee, and is a pre-existing N+1 query
 * pattern (one call per returned row) tracked separately, not fixed here.
 *
 * Two constraints this introduces, worth knowing before calling this from a
 * new site:
 * (a) This function is no longer safe against a soft-readonly adapter.
 *     `TursoAdapterImpl.transaction()` calls `_assertWritable()` first and
 *     throws `[BL-391] TursoAdapter is read-only` on a connection built by
 *     `openDbReadOnly()`. Not reachable today — the MCP tool is always
 *     handed the primary writable adapter — but a future caller passing a
 *     read-only adapter here will get that throw instead of a result.
 * (b) The snapshot guarantee is Turso-specific in HOW it is enforced.
 *     `TursoAdapterImpl.transaction()` runs under `_withTxLock`; the SQLite
 *     adapter's `_runTransaction` BEGINs directly on the shared handle with
 *     a ~70ms retry budget and no equivalent serialization mutex. Adding a
 *     transaction to this read path widens the window in which a concurrent
 *     writer on the SQLite backend could contend for that BEGIN. This is a
 *     flagged risk, not a demonstrated defect — no failing input has been
 *     produced for it.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { parseTags, isSuperseded, supersedesUidForRowid, communityUidForRowid } from './recall.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EntityInfo {
  uid: string;
  name: string;
}

export interface EpisodeSummary {
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

export interface EntityEpisodesResult {
  entity?: EntityInfo;
  episodes?: EpisodeSummary[];
  total?: number;
  /** Live MENTIONS edges whose source episode is invalidated. Observability
   *  only, not the fix — should trend to zero once the near-dup pass stops
   *  auto-invalidating (Q1 of the near-dup invalidation fix plan). */
  invalidated_count?: number;
  code?: string;
  message?: string;
  candidates?: string[];
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function memoryGetEntityEpisodes(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
): Promise<EntityEpisodesResult> {
  const entityUid = args['entity_uid'] as string | undefined;
  const entityName = args['entity_name'] as string | undefined;
  // Normalize limit/offset ONCE, before either value can reach SQL as a bind
  // param. The MCP schema declares both as plain `number` (no `multipleOf`,
  // no `minimum`/`maximum`), so non-integer, negative, and huge values are
  // all schema-valid — slice() used to silently absorb them; a raw
  // `LIMIT ? OFFSET ?` bind does not: a non-integer, or a magnitude outside
  // SQLite/Turso's int64 bind range (e.g. 1e20), throws "datatype mismatch"
  // (uncaught by dispatchTool/handleToolCall, so it crashes the tool call
  // instead of returning a structured {code} error), and SQLite reads a
  // negative LIMIT as "no limit", defeating the upper clamp entirely. Use an
  // explicit `Number.isFinite` check rather than `Math.trunc(x) || default`
  // — the `||` form treats an explicit `limit: 0`/`offset: 0` as falsy and
  // silently substitutes the default, which would make `0` return a full
  // page while the adjacent `-1` clamps to zero rows (opposite directions
  // for two non-positive inputs). `offset` is capped at
  // `Number.MAX_SAFE_INTEGER` (~9.007e15) — comfortably inside int64 range
  // (~9.223e18) and far larger than any real page count, so it never
  // meaningfully truncates a legitimate offset while still keeping
  // out-of-range values (1e20, 1e308, ...) off the wire to SQL.
  const rawLimit = args['limit'] as number | undefined;
  const rawOffset = args['offset'] as number | undefined;
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit as number) ? Math.trunc(rawLimit as number) : 20, 0),
    200,
  );
  const offset = Math.min(
    Math.max(Number.isFinite(rawOffset as number) ? Math.trunc(rawOffset as number) : 0, 0),
    Number.MAX_SAFE_INTEGER,
  );

  let resolvedEntityUid = entityUid;
  let resolvedEntityName = '';

  if (!resolvedEntityUid && entityName) {
    const matchResult = await adapter.executeAll<{ uid: string; name: string }>(
      `SELECT uid, name FROM node WHERE kind = 'entity' AND LOWER(name) = LOWER(?) AND t_invalid IS NULL`,
      [entityName],
    );
    const matchRows = matchResult.rows;

    if (matchRows.length === 0) {
      return {
        code: 'E_NOT_FOUND',
        episodes: [],
        total: 0,
        entity: { uid: '', name: entityName },
      };
    }
    if (matchRows.length > 1) {
      return {
        code: 'E_AMBIGUOUS',
        episodes: [],
        total: 0,
        entity: { uid: '', name: entityName },
        candidates: matchRows.map((r) => r.uid),
      };
    }
    resolvedEntityUid = matchRows[0]!.uid;
    resolvedEntityName = matchRows[0]!.name ?? entityName;
  }

  if (!resolvedEntityUid) {
    return {
      code: 'E_MISSING_INPUT',
      episodes: [],
      total: 0,
      entity: { uid: '', name: '' },
    };
  }

  if (!resolvedEntityName) {
    const nameRow = await adapter.executeGet<{ name: string | null }>(
      `SELECT name FROM node WHERE uid = ? LIMIT 1`,
      [resolvedEntityUid],
    );
    resolvedEntityName = nameRow?.name ?? resolvedEntityUid;
  }

  const entityRow = await adapter.executeGet<{ rowid: number }>(
    `SELECT rowid FROM node WHERE uid = ? LIMIT 1`,
    [resolvedEntityUid],
  );

  if (!entityRow) {
    return {
      code: 'E_NOT_FOUND',
      episodes: [],
      total: 0,
      entity: { uid: resolvedEntityUid, name: resolvedEntityName },
    };
  }

  interface EpRow {
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
  }

  // total/invalidated_count/page all read the SAME live-filtered
  // MENTIONS→episode join shape, inside one transaction — pagination must
  // never slice a raw edge array (that was the defect: total counted
  // invalid edges while pages were filtered afterward, so pages came back
  // short and offsets shifted meaning as invalid rows fell in different
  // slices). The transaction additionally guarantees these three reads see
  // one snapshot: without it, a concurrent invalidation landing between the
  // count and the page query reproduces the same "total N, short page"
  // symptom via a different mechanism.
  const { total, invalidatedCount, pageResult } = await adapter.transaction(async (tx) => {
    const totalRow = await tx.executeGet<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
         FROM edge e JOIN node n ON n.rowid = e.src
        WHERE e.dst = ? AND e.rel = 'MENTIONS' AND e.t_invalid IS NULL
          AND n.kind = 'episode' AND n.t_invalid IS NULL`,
      [entityRow.rowid],
    );

    const invalidatedRow = await tx.executeGet<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
         FROM edge e JOIN node n ON n.rowid = e.src
        WHERE e.dst = ? AND e.rel = 'MENTIONS' AND e.t_invalid IS NULL
          AND n.kind = 'episode' AND n.t_invalid IS NOT NULL`,
      [entityRow.rowid],
    );

    const page = await tx.executeAll<EpRow>(
      `SELECT n.rowid, n.uid, n.content, n.summary, n.topic, n.tags, n.project_path,
              n.importance, n.t_created, n.agent_id
         FROM edge e JOIN node n ON n.rowid = e.src
        WHERE e.dst = ? AND e.rel = 'MENTIONS' AND e.t_invalid IS NULL
          AND n.kind = 'episode' AND n.t_invalid IS NULL
        ORDER BY n.importance DESC, n.rowid ASC
        LIMIT ? OFFSET ?`,
      [entityRow.rowid, limit, offset],
    );

    return {
      total: totalRow?.cnt ?? 0,
      invalidatedCount: invalidatedRow?.cnt ?? 0,
      pageResult: page,
    };
  }, { mode: 'deferred' });

  const episodes: EpisodeSummary[] = [];
  for (const r of pageResult.rows) {
    episodes.push({
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
    });
  }

  return {
    entity: { uid: resolvedEntityUid, name: resolvedEntityName },
    episodes,
    total,
    invalidated_count: invalidatedCount,
  };
}
