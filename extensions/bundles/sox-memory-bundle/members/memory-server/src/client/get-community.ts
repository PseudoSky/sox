/**
 * Community retrieval — SQL-backed community node + member lookup.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';
import { parseTags } from './db.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CommunityInfo {
  uid: string;
  label: string;
  member_count: number;
  mean_intra_sim: number;
  centroid_episode_uid: string;
  t_created: string;
}

export interface MemberSummary {
  uid: string;
  summary: string | null;
  topic: string | null;
  importance: number;
  t_created: string;
  project_path: string | null;
  tags: string[];
}

export interface GetCommunityResult {
  community?: CommunityInfo;
  members?: MemberSummary[];
  code?: string;
  message?: string;
  entity_uid?: string;
  community_uid?: string;
}

export const inputSchema = {
  type: 'object' as const,
  properties: {
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
    entity_uid: {
      type: 'string',
      description: 'Resolve community for this episode/entity UID (via MEMBER_OF edge).',
    },
    community_uid: { type: 'string', description: 'Fetch a community directly by its UID.' },
    level: { type: 'number', default: 0 },
  },
  required: [],
};

interface CommunityRow {
  rowid: number;
  uid: string;
  name: string | null;
  meta: string | null;
  t_created: string;
}

/**
 * Backing for memory_get_community.
 *
 * Lookup by entity_uid (via MEMBER_OF edge) or community_uid (direct lookup).
 * Returns the community info object and its member episodes.
 */
export async function getCommunity(
  db: Database,
  args: Record<string, unknown>,
): Promise<GetCommunityResult> {
  const entityUid = args['entity_uid'] as string | undefined;
  const communityUidArg = args['community_uid'] as string | undefined;
  const level = (args['level'] as number) ?? 0;

  if (entityUid && communityUidArg) {
    return { code: 'E_AMBIGUOUS', message: 'Supply entity_uid OR community_uid, not both' };
  }

  let communityRow: CommunityRow | undefined;

  if (communityUidArg) {
    communityRow = db
      .prepare<[string], CommunityRow>(
        `SELECT rowid, uid, name, meta, t_created FROM node
         WHERE uid = ? AND kind = 'community' AND t_invalid IS NULL`,
      )
      .get(communityUidArg);
  } else if (entityUid) {
    communityRow = db
      .prepare<[number, string], CommunityRow>(
        `SELECT n2.rowid, n2.uid, n2.name, n2.meta, n2.t_created
         FROM node n1
         JOIN edge e ON e.src = n1.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
         JOIN node n2 ON n2.rowid = e.dst AND n2.kind = 'community' AND n2.level = ? AND n2.t_invalid IS NULL
           AND (json_extract(n2.meta, '$.cluster_scope.kind') IS NULL
                OR json_extract(n2.meta, '$.cluster_scope.kind') = 'global')
         WHERE n1.uid = ? AND n1.t_invalid IS NULL
         LIMIT 1`,
      )
      .get(level, entityUid);
  } else {
    return { code: 'E_MISSING_INPUT', message: 'Supply entity_uid or community_uid' };
  }

  if (!communityRow) {
    return {
      code: 'E_NOT_FOUND',
      ...(entityUid !== undefined ? { entity_uid: entityUid } : {}),
      ...(communityUidArg !== undefined ? { community_uid: communityUidArg } : {}),
    };
  }

  // Parse community meta for quality metrics
  let memberCount = 0;
  let meanIntraSim = 0;
  let centroidEpisodeUid = '';
  if (communityRow.meta) {
    try {
      const m = JSON.parse(communityRow.meta) as {
        mean_intra_sim?: number;
        centroid_rowid?: number;
        member_count?: number;
      };
      if (typeof m.mean_intra_sim === 'number') meanIntraSim = m.mean_intra_sim;
      if (typeof m.member_count === 'number') memberCount = m.member_count;
      if (typeof m.centroid_rowid === 'number') {
        const centRow = db
          .prepare<[number], { uid: string }>(`SELECT uid FROM node WHERE rowid = ?`)
          .get(m.centroid_rowid);
        if (centRow) centroidEpisodeUid = centRow.uid;
      }
    } catch {
      /* malformed meta */
    }
  }

  // Fetch member episodes via MEMBER_OF edges
  const memberRows = db
    .prepare<
      [number],
      {
        uid: string;
        summary: string | null;
        topic: string | null;
        importance: number;
        t_created: string;
        project_path: string | null;
        tags: string | null;
      }
    >(
      `SELECT n.uid, n.summary, n.topic, n.importance, n.t_created, n.project_path, n.tags
       FROM edge e
       JOIN node n ON n.rowid = e.src AND n.t_invalid IS NULL
       WHERE e.dst = ? AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
       ORDER BY n.importance DESC`,
    )
    .all(communityRow.rowid);

  if (memberCount === 0) memberCount = memberRows.length;

  const community: CommunityInfo = {
    uid: communityRow.uid,
    label: communityRow.name ?? communityRow.uid,
    member_count: memberCount,
    mean_intra_sim: meanIntraSim,
    centroid_episode_uid: centroidEpisodeUid,
    t_created: communityRow.t_created,
  };

  const members: MemberSummary[] = memberRows.map(
    (m: {
      uid: string;
      summary: string | null;
      topic: string | null;
      importance: number;
      t_created: string;
      project_path: string | null;
      tags: string | null;
    }) => ({
      uid: m.uid,
      summary: m.summary ?? null,
      topic: m.topic ?? null,
      importance: m.importance,
      t_created: m.t_created,
      project_path: m.project_path ?? null,
      tags: parseTags(m.tags),
    }),
  );

  return { community, members };
}
