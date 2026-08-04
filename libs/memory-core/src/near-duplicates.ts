/**
 * memoryGetNearDuplicates — list SAME_AS edge pairs with cosine sim metadata.
 *
 * Uses getEdges({rel:'SAME_AS'}) to find all near-duplicate pairs,
 * then looks up node content via raw SQL. Supports project_path/topic/threshold filters.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from '@adhd/sox-graph-store';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface NearDuplicatePair {
  uid_a: string;
  uid_b: string;
  /** Real measured cosine similarity (auto-detected pairs), or null when the
   *  pair was merged manually and no similarity was ever measured (BL-398 —
   *  never fabricated). */
  cosine_sim: number | null;
  content_preview_a: string;
  content_preview_b: string;
  already_merged: boolean;
}

export interface NearDuplicatesResult {
  pairs: NearDuplicatePair[];
  total: number;
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function memoryGetNearDuplicates(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
): Promise<NearDuplicatesResult> {
  const projectPath = args['project_path'] as string | undefined;
  const topicFilter = args['topic'] as string | undefined;
  const cosineThreshold = args['threshold'] as number | undefined;
  const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
  const offset = (args['offset'] as number | undefined) ?? 0;

  const backend = createGraphBackend(adapter);

  // Get all SAME_AS edges
  const edges = await backend.getEdges({ rel: 'SAME_AS' });

  // Collect all src+dst rowids to batch-look up nodes
  const nodeRowids = new Set<number>();
  for (const e of edges) {
    nodeRowids.add(e.src);
    nodeRowids.add(e.dst);
  }

  interface NodeInfo {
    rowid: number;
    uid: string;
    content: string | null;
    topic: string | null;
    project_path: string | null;
    t_invalid: string | null;
  }
  const nodeMap = new Map<number, NodeInfo>();
  if (nodeRowids.size > 0) {
    const ph = Array.from(nodeRowids, () => '?').join(',');
    const result = await adapter.executeAll<NodeInfo>(
      `SELECT rowid, uid, content, topic, project_path, t_invalid
       FROM node WHERE rowid IN (${ph})`,
      Array.from(nodeRowids),
    );
    for (const r of result.rows) {
      nodeMap.set(r.rowid, r);
    }
  }

  // Build pairs
  const pairs: NearDuplicatePair[] = [];

  for (const e of edges) {
    const nodeA = nodeMap.get(e.src);
    const nodeB = nodeMap.get(e.dst);
    if (!nodeA || !nodeB) continue;

    // Both must be episodes (skip if not)
    // We check via kind in a follow-up, but nodeMap has all nodes
    // For now, we just include all SAME_AS pairs (they should be between episodes)

    // Apply project_path filter
    if (projectPath) {
      if (nodeA.project_path !== projectPath && nodeB.project_path !== projectPath) {
        continue;
      }
    }

    // Apply topic filter
    if (topicFilter) {
      if (nodeA.topic !== topicFilter && nodeB.topic !== topicFilter) {
        continue;
      }
    }

    // Extract cosine_sim. The writer (applyNearDupResult, enrich.ts) binds
    // nearDup.cosine_sim into the `weight` column, not `meta` (BL-386) — read
    // that first. Fall back to metadata.cosine_sim for any edge written by an
    // older path that did populate meta instead.
    //
    // BL-398: MANUALLY-merged pairs (memory_curate merge_duplicates) write the
    // SAME_AS edge with weight NULL and meta '{"merge":"manual"}' — no detector
    // measured this pair, so any numeric report here would be fabricated.
    // (Before the fix, the graph-store column default `weight REAL DEFAULT 1.0`
    // silently filled NULL with 1.0 and every manual merge reported a fake
    // cosine_sim: 1.0.) Report null for unknown.
    let cosineSim: number | null = null;
    if (typeof e.weight === 'number') {
      cosineSim = e.weight;
    } else if (e.metadata) {
      const sim = (e.metadata as Record<string, unknown>)['cosine_sim'];
      if (typeof sim === 'number') cosineSim = sim;
    }

    // Apply threshold filter. A pair whose similarity is unknown (manual merge)
    // cannot be proven to meet the threshold — exclude it when one is given.
    if (typeof cosineThreshold === 'number' && (cosineSim === null || cosineSim < cosineThreshold)) {
      continue;
    }

    pairs.push({
      uid_a: nodeA.uid,
      uid_b: nodeB.uid,
      cosine_sim: cosineSim,
      content_preview_a: (nodeA.content ?? '').slice(0, 120),
      content_preview_b: (nodeB.content ?? '').slice(0, 120),
      already_merged: nodeB.t_invalid !== null,
    });
  }

  const total = pairs.length;
  const page = pairs.slice(offset, offset + limit);

  return { pairs: page, total };
}
