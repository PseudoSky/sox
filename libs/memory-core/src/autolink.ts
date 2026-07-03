import type { Database } from 'better-sqlite3';

export interface AutoLinkResult {
  edges_inserted: number;
  stoplist_additions: string[];
}

interface EpisodeEntityRow {
  episode_rowid: number;
  episode_uid: string;
  entity_rowid: number;
  entity_uid: string;
}

export function buildAutoLinks(
  db: Database,
  entityStoplistThreshold = 0.30,
): AutoLinkResult {
  const now = new Date().toISOString();
  let edgesInserted = 0;

  // ── Entity-based auto-linking (existing algorithm) ──────────────────────────

  const totalRow = db
    .prepare<[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
    )
    .get();
  const totalEpisodes = totalRow?.cnt ?? 0;

  const stoplistUids = new Set<string>();
  const stoplistAdditions: string[] = [];

  if (totalEpisodes >= 2) {
    const entityFreqRows = db
      .prepare<[], { entity_uid: string; entity_rowid: number; ep_count: number }>(
        `SELECT n_ent.uid AS entity_uid, n_ent.rowid AS entity_rowid, COUNT(DISTINCT n_ep.rowid) AS ep_count
         FROM node n_ent
         JOIN edge e ON e.dst = n_ent.rowid AND e.rel = 'MENTIONS' AND e.t_expired IS NULL
         JOIN node n_ep ON n_ep.rowid = e.src AND n_ep.kind = 'episode' AND n_ep.t_invalid IS NULL
         WHERE n_ent.kind = 'entity' AND n_ent.t_invalid IS NULL
         GROUP BY n_ent.uid`,
      )
      .all();

    for (const row of entityFreqRows) {
      if (row.ep_count / totalEpisodes > entityStoplistThreshold) {
        stoplistUids.add(row.entity_uid);
        stoplistAdditions.push(row.entity_uid);
      }
    }

    try {
      const scopeRow = db
        .prepare<[], { meta: string | null }>(`SELECT meta FROM memory_scope LIMIT 1`)
        .get();
      const scopeMeta: Record<string, unknown> = scopeRow?.meta
        ? (JSON.parse(scopeRow.meta) as Record<string, unknown>)
        : {};
      scopeMeta['entity_stoplist'] = Array.from(stoplistUids);
      db.prepare(`UPDATE memory_scope SET meta = ?`).run(JSON.stringify(scopeMeta));
    } catch {
      // memory_scope.meta column may not exist in older stores
    }

    const allMentions = db
      .prepare<[], EpisodeEntityRow>(
        `SELECT n_ep.rowid AS episode_rowid, n_ep.uid AS episode_uid,
                n_ent.rowid AS entity_rowid, n_ent.uid AS entity_uid
         FROM edge e
         JOIN node n_ep ON n_ep.rowid = e.src AND n_ep.kind = 'episode' AND n_ep.t_invalid IS NULL
         JOIN node n_ent ON n_ent.rowid = e.dst AND n_ent.kind = 'entity' AND n_ent.t_invalid IS NULL
         WHERE e.rel = 'MENTIONS' AND e.t_expired IS NULL
         ORDER BY n_ep.rowid, n_ent.rowid`,
      )
      .all();

    const episodeEntities = new Map<number, { uid: string; entityRowids: number[]; entityUids: string[] }>();
    for (const row of allMentions) {
      if (stoplistUids.has(row.entity_uid)) continue;
      if (!episodeEntities.has(row.episode_rowid)) {
        episodeEntities.set(row.episode_rowid, {
          uid: row.episode_uid,
          entityRowids: [],
          entityUids: [],
        });
      }
      const ep = episodeEntities.get(row.episode_rowid)!;
      ep.entityRowids.push(row.entity_rowid);
      ep.entityUids.push(row.entity_uid);
    }

    const sortedEps = Array.from(episodeEntities.entries()).sort(([a], [b]) => a - b);
    const edgeCountPerEpisode = new Map<number, number>();

    const insertEdge = db.prepare<[number, number, number, string, number, number], void>(
      `INSERT INTO edge (src, dst, rel, origin, weight, t_created)
       SELECT ?, ?, 'RELATES_TO', 'inferred', ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM edge WHERE src = ? AND dst = ? AND rel = 'RELATES_TO' AND t_expired IS NULL
       )`,
    );

    const entityTx = db.transaction(() => {
      for (let i = 0; i < sortedEps.length; i++) {
        const [rowid_i, ep_i] = sortedEps[i]!;
        const set_i = new Set(ep_i.entityRowids);

        for (let j = i + 1; j < sortedEps.length; j++) {
          const [rowid_j, ep_j] = sortedEps[j]!;

          const capI = edgeCountPerEpisode.get(rowid_i) ?? 0;
          const capJ = edgeCountPerEpisode.get(rowid_j) ?? 0;
          if (capI >= 10 && capJ >= 10) continue;

          let sharedCount = 0;
          for (const eRowid of ep_j.entityRowids) {
            if (set_i.has(eRowid)) sharedCount++;
          }
          if (sharedCount < 2) continue;

          const weight = sharedCount / Math.max(ep_i.entityRowids.length, ep_j.entityRowids.length, 1);

          const result = insertEdge.run(rowid_i, rowid_j, weight, now, rowid_i, rowid_j) as unknown as { changes: number };
          if (result.changes > 0) {
            edgesInserted++;
            edgeCountPerEpisode.set(rowid_i, (edgeCountPerEpisode.get(rowid_i) ?? 0) + 1);
            edgeCountPerEpisode.set(rowid_j, (edgeCountPerEpisode.get(rowid_j) ?? 0) + 1);
          }
        }
      }
    });

    entityTx();
  }

  return { edges_inserted: edgesInserted, stoplist_additions: stoplistAdditions };
}
