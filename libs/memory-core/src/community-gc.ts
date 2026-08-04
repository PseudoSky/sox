/**
 * community-gc.ts — BUG-CLUSTER-ORPHANED-COMMUNITIES-NEVER-GC-001.
 *
 * When an EPISODE is invalidated (memory_invalidate, near-dup supersession,
 * merge_duplicates), its live MEMBER_OF edge and — transitively — any community
 * left with zero live members must be invalidated in the SAME transaction.
 * Otherwise ordinary churn silently decays total_clustered toward 0 while
 * cluster_count stays fixed (the orphaned-community leak; the live
 * 139-communities/0-members signature). A full clustering pass used to be the
 * only repair (materializeClusters self-heals); this makes invalidation
 * self-cleaning at O(1) per episode.
 *
 * Scoping: only GLOBAL communities (cluster_scope.kind IS NULL or 'global')
 * are candidates. Subset-lens communities and zero-member lens markers
 * (BL-153, cluster_scope.marker) belong to their filter's slice and must not
 * be swept by an unrelated invalidation — the scoped `rowid IN (...)` of THIS
 * episode's communities guarantees that.
 */
import type { AdapterTransaction } from '@adhd/sox-store-adapter';

export interface CommunityGcResult {
  member_of_edges_invalidated: number;
  communities_invalidated: number;
}

export async function gcOrphanedCommunityState(
  tx: AdapterTransaction,
  episodeRowid: number,
  tTransition: string,
): Promise<CommunityGcResult> {
  // 1. Invalidate the episode's live MEMBER_OF edges.
  const edgeResult = await tx.executeRun(
    `UPDATE edge SET t_invalid = ?
     WHERE src = ? AND rel = 'MEMBER_OF' AND t_invalid IS NULL`,
    [tTransition, episodeRowid],
  );

  // 2. Invalidate any GLOBAL community this episode was a member of that now
  //    has zero live members. The NOT EXISTS check re-reads membership AFTER
  //    step 1's invalidation (same transaction → serializable), so a community
  //    that still has other live members survives untouched.
  const communityResult = await tx.executeRun(
    `UPDATE node SET t_invalid = ?
     WHERE kind = 'community' AND t_invalid IS NULL
       AND (json_extract(meta, '$.cluster_scope.kind') IS NULL
            OR json_extract(meta, '$.cluster_scope.kind') = 'global')
       AND rowid IN (SELECT dst FROM edge WHERE src = ? AND rel = 'MEMBER_OF')
       AND NOT EXISTS (
         SELECT 1 FROM edge e
         WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL AND e.dst = node.rowid
       )`,
    [tTransition, episodeRowid],
  );

  return {
    member_of_edges_invalidated: edgeResult.rowsAffected,
    communities_invalidated: communityResult.rowsAffected,
  };
}
