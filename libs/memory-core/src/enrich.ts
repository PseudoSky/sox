/**
 * enrich.ts — write-path enrichment orchestrator (Tier 1, <5ms target).
 * CONTRACTS.md C1.2.
 *
 * Covers E1–E5, E8 (near-dup local KNN), E10 (extractive summary fallback), E12.
 * No LLM, no network. Synchronous (runs inside/after write transaction).
 *
 * Uses GraphBackend for node/edge CRUD — raw SQL only for memory-core-specific
 * columns (enrich_ver) and schema-incompatible edge inserts (no UNIQUE index
 * for writeEdge ON CONFLICT support).
 *
 * Determinism: given the same params and DB state, produces identical output.
 */

import { resolveProjectPath } from './provenance.js';
import { detectNearDup } from './neardup.js';
import { extractiveSummary } from './extractive.js';
import { computeImportance } from './importance.js';
import type { EnrichmentProvenance } from './enrich-types.js';
import type { NearDupResult } from './neardup.js';
import type { AdapterTransaction, VectorDialect } from '@adhd/sox-store-adapter';
import { ENRICH_VERSION } from './enrich-version.js';
import { log as tlog } from './telemetry.js';
import { getActiveEmbedModel } from './embed.js';

export type { NearDupResult } from './neardup.js';

export interface EnrichOnWriteParams {
  /** Raw write params as supplied by the caller (post-insert, pre-enrichment). */
  uid: string;
  rowid: number;
  content: string;
  /** Caller-supplied summary (E2). If present, no extractive fallback runs. */
  summary: string | undefined;
  /** Caller-supplied tags array (E4). */
  tags: string[] | undefined;
  /** Caller-supplied topic override (E5 priority 1). */
  topic: string | undefined;
  /** Caller-supplied metadata (E3). */
  metadata: Record<string, unknown> | undefined;
  /** Caller-supplied project_path override (E1 priority 1). */
  project_path: string | undefined;
  /** Explicit parent UID for DERIVED_FROM edge (E9). */
  derived_from_uid: string | undefined;
  /**
   * 768-dim L2-normalised embedding vector already computed by the write path.
   * OPTIONAL since the two-phase write split (2026-07-04): when absent (async
   * Phase-A write) the E8 near-dup pass is DEFERRED to Phase B
   * (embed-pipeline.ts applyEmbedding) and `near_dup` is null in the result.
   */
  embedding: Float32Array | undefined;
  /**
   * Caller-supplied importance (user-asserted). When present, it is respected and
   * the computed importance is NOT written. Batch enricher also will not overwrite it
   * (per CONTRACTS.md C2.1). undefined = compute importance from content.
   *
   * PERF-MEMORY-004: when a value is present, `userSuppliedImportance` distinguishes
   * a real caller-asserted value (true → user_override note, batch skip) from a
   * write-path pre-computed score (false → no note, batch will re-score when
   * link/access data is available). Defaults to true for backward compatibility with
   * callers that don't pass the flag (treating any non-undefined importance as
   * user-asserted, which was the pre-fix behaviour).
   */
  importance: number | undefined;
  userSuppliedImportance?: boolean;
  /**
   * BL-381: the adapter's VectorDialect, used to build the E8 KNN query. Only
   * consulted when `embedding` is present (the synchronous write path); the
   * async two-phase path defers near-dup to `applyEmbedding`.
   */
  vectorDialect?: VectorDialect;
}

export interface EnrichOnWriteResult {
  /** Final topic stored (may be from prefix, caller override, or null). */
  topic: string | null;
  /** Final project_path stored (auto-detected or caller-supplied). */
  project_path: string | null;
  /** Final summary stored (E2 caller-supplied or E10 extractive fallback). */
  summary: string | null;
  /** Resolved tags array (stored as JSON on node.tags). */
  tags: string[];
  /** Enrichment provenance stamp (E12). */
  enrich_ver: EnrichmentProvenance;
  /** Near-dup detection result (E8). null = no dup found OR detection deferred
   *  to Phase B (async two-phase write — no embedding available at write time). */
  near_dup: NearDupResult | null;
}

/** E8 near-dup cosine threshold. Exported for the Phase-B pipeline (embed-pipeline.ts). */
export const NEARDUP_THRESHOLD = 0.95;

function getNearDupThreshold(): number {
  return NEARDUP_THRESHOLD;
}

/**
 * Apply a detected near-dup outcome: insert the SAME_AS edge (guarded — never
 * duplicated), carrying the evidence (cosine, embed model, detector, status)
 * in its `meta`. Shared by the synchronous E8 pass (enrichOnWrite,
 * SOX_SYNC_EMBED composition) and the deferred Phase-B pass
 * (embed-pipeline.ts applyEmbedding).
 *
 * Q1-A (docs/reporting/memory/findings/2026-09-22-neardup-invalidation-fix-plan.md §2): this function used to also
 * bi-temporally invalidate the OLDER episode whenever `should_invalidate` was
 * set — which, per Q1-B, was every result it could ever produce. An automatic
 * pass has no user intent, and a sentence-embedding cosine is a
 * retrieval-ranking signal, not a calibrated measure of factual identity (the
 * live store measured false-positive SAME_AS pairs at cosine 0.9916–0.9985,
 * above the ceiling any threshold retune could exclude). Destruction now
 * requires intent: `t_invalid` is reachable only from `memoryInvalidate`
 * (write.ts) and `memory_curate merge_duplicates` (curate.ts), both of which
 * already call `gcOrphanedCommunityState` themselves — this function no
 * longer invalidates anything, so it has nothing to GC. The candidate pair
 * remains fully reachable via `memory_near_duplicates` and
 * `memory_curate merge_duplicates` for human/agent review — nothing here
 * removes the SAME_AS edge those surfaces already read.
 */
export async function applyNearDupResult(
  tx: AdapterTransaction,
  rowid: number,
  nearDup: NearDupResult,
): Promise<void> {
  const neighborRow = await tx.executeGet<{ rowid: number }>(
    `SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`,
    [nearDup.existing_uid],
  );
  if (!neighborRow) return;

  const now = new Date().toISOString();
  const meta = JSON.stringify({
    cosine_sim: nearDup.cosine_sim,
    status: nearDup.status,
    model: getActiveEmbedModel() ?? 'unknown',
    detected_at: now,
    detector: 'auto-neardup',
  });
  // Insert SAME_AS edge via raw SQL (memory-core schema lacks the UNIQUE index
  // on (src, dst, rel) that GraphBackend.writeEdge's ON CONFLICT requires).
  // `weight` stays the primary cosine read (BL-386, near-duplicates.ts:103
  // reads `e.weight` first); `meta` is additive evidence, not a replacement.
  await tx.executeRun(
    `INSERT INTO edge (src, dst, rel, origin, weight, t_created, meta)
     SELECT ?, ?, 'SAME_AS', 'inferred', ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM edge WHERE src = ? AND dst = ? AND rel = 'SAME_AS' AND t_expired IS NULL
     )`,
    [rowid, neighborRow.rowid, nearDup.cosine_sim, now, meta, rowid, neighborRow.rowid],
  );
}
/**
 * Run write-time enrichments (E1–E5, E8, E10, E12) on an already-inserted node.
 *
 * Side effects: UPDATE node SET topic=?, project_path=?, summary=?, tags=?, importance=?, enrich_ver=?
 *   and INSERT SAME_AS edge if near-dup found.
 *
 * @param db   Open better-sqlite3 Database (write-capable).
 * @param p    Write params including pre-computed embedding.
 * @returns    EnrichOnWriteResult describing what was stored.
 */
/** Every enrichment column the write path stores, resolved with zero DB access. */
export interface WriteEnrichmentValues {
  topic: string | null;
  project_path: string | null;
  summary: string | null;
  tags: string[];
  /** `node.tags` column form — NULL when empty (BL-325), never the literal '[]'. */
  tagsJson: string | null;
  importance: number;
  enrich_ver: EnrichmentProvenance;
}

/**
 * Pure (zero-DB) resolution of E1/E2/E4/E5/E7/E10/E12 — everything the write
 * path persists except the E8 near-dup pass, which genuinely needs the row and
 * its vector to exist.
 *
 * WHY THIS IS SEPARATE (PERF-MEMORY-003): the async Phase-A write used to INSERT
 * the node and then issue a SECOND UPDATE over the same row to store these
 * values. `summary` and `tags` are covered by `idx_fts_node` — a NATIVE Turso
 * FTS index maintained inside each statement, not a trigger — so that second
 * write redid FTS maintenance the INSERT had already done. Measured at ~134ms,
 * ~56% of Phase-A, while the computation below is ~3.7ms. Since the computation
 * is pure it reorders freely, so `memoryWritePhaseA` now folds these values
 * straight into the INSERT.
 *
 * SINGLE SOURCE OF TRUTH: `enrichOnWrite` delegates here too, so the folded
 * INSERT path and the UPDATE path cannot drift apart.
 */
export function computeWriteEnrichment(p: {
  content: string;
  summary: string | undefined;
  tags: string[] | undefined;
  topic: string | undefined;
  project_path: string | undefined;
  importance: number | undefined;
  userSuppliedImportance?: boolean;
}): WriteEnrichmentValues {
  // E1: resolve project_path (caller override → git root → cwd)
  const resolvedProjectPath = resolveProjectPath(p.project_path);

  // E5: resolve topic (caller param > [<topic>] prefix > null)
  let resolvedTopic: string | null = p.topic ?? null;
  if (resolvedTopic === null) {
    const prefixMatch = /^\s*\[([^\]\n]{1,64})\]/.exec(p.content);
    if (prefixMatch) resolvedTopic = prefixMatch[1] ?? null;
  }

  // E2/E10: resolve summary (caller-supplied wins; extractive fallback otherwise)
  const resolvedSummary: string | null =
    p.summary !== undefined ? p.summary : extractiveSummary(p.content);

  // E4: resolved tags
  const resolvedTags: string[] = p.tags ?? [];

  // E7: compute initial importance (length + tag score at write time; link/access on batch).
  // If caller supplied an explicit importance, respect it — do NOT override.
  // PERF-MEMORY-004: userSuppliedImportance distinguishes caller-asserted values
  // from write-path pre-computed scores. When the write path pre-computed importance
  // (userSuppliedImportance === false), use that value but do NOT set userOverride —
  // the batch enricher should still be allowed to update it with link/access data.
  // Defaults to true when the flag is absent (backward compatible).
  let initialImportance: number;
  let userOverride = false;
  if (p.importance !== undefined) {
    initialImportance = p.importance;
    // Only set userOverride when the caller explicitly asserted this importance value.
    // A pre-computed write-path score (userSuppliedImportance === false) is NOT a user
    // override — the batch enricher should update it on the next pass.
    if (p.userSuppliedImportance !== false) {
      userOverride = true;
    }
  } else {
    const wordCount = p.content.split(/\s+/).filter(Boolean).length;
    initialImportance = computeImportance({
      word_count: wordCount,
      link_degree: 0, // no edges yet; updated on batch pass
      access_count: 0,
      tag_count: resolvedTags.length,
    });
  }

  // E12: enrichment provenance stamp
  const enrichVer: EnrichmentProvenance = {
    pass: ENRICH_VERSION,
    ts: new Date().toISOString(),
    ...(userOverride ? { note: 'user_override' } : {}),
  };

  return {
    topic: resolvedTopic,
    project_path: resolvedProjectPath,
    summary: resolvedSummary,
    tags: resolvedTags,
    // BL-325: empty tags means "no tags", which the schema and every reader
    // (memory_recall's tags filter, etc.) represent as NULL, not '[]'.
    tagsJson: resolvedTags.length > 0 ? JSON.stringify(resolvedTags) : null,
    importance: initialImportance,
    enrich_ver: enrichVer,
  };
}

/**
 * E8: near-dup detection plus its side effect (SAME_AS edge, carrying cosine/
 * model/detector evidence in meta — never an automatic invalidation, see
 * `applyNearDupResult`). No-ops when no embedding is available — the async
 * two-phase write defers this to Phase B (embed-pipeline.ts).
 *
 * Split out of `enrichOnWrite` so the folded-INSERT path can run the near-dup
 * pass — which genuinely requires the inserted row — WITHOUT also paying for
 * the column UPDATE that fold made redundant.
 */
export async function detectAndApplyNearDup(
  tx: AdapterTransaction,
  rowid: number,
  embedding: Float32Array | undefined,
  vectorDialect: VectorDialect | undefined,
): Promise<NearDupResult | null> {
  if (embedding === undefined || vectorDialect === undefined) return null;

  let nearDup: NearDupResult | null = null;
  try {
    nearDup = await detectNearDup(tx, rowid, embedding, getNearDupThreshold(), vectorDialect);
  } catch (err) {
    // BL-381: NOT a silent swallow. A KNN query can legitimately fail on an
    // empty store, but for over a month this same bare `catch {}` also hid a
    // permanently-broken query — `no such column: k`, every write, on the
    // default backend — and "no duplicates found" is indistinguishable from
    // "near-dup detection is dead" in every surface we expose. Log it.
    tlog.warn('enrich.neardup.error', {
      rowid,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (nearDup !== null) await applyNearDupResult(tx, rowid, nearDup);
  return nearDup;
}

export async function enrichOnWrite(
  tx: AdapterTransaction,
  p: EnrichOnWriteParams,
): Promise<EnrichOnWriteResult> {
  const v = computeWriteEnrichment(p);
  const resolvedProjectPath = v.project_path;

  // Update enrichment fields directly via the AdapterTransaction.
  // Replaces the former createGraphBackend(wrapRawDbAsAdapter(db)).touch() pattern.
  //
  // NOTE: `tags` and `importance` are pushed unconditionally below, so the list
  // is never empty — the former `else` branch here was unreachable and has been
  // dropped. Column set and values are otherwise unchanged.
  const touchUpdates: string[] = [];
  const touchParams: unknown[] = [];
  const now = new Date().toISOString();

  if (v.topic !== null) { touchUpdates.push('topic = ?'); touchParams.push(v.topic); }
  if (v.summary !== null) { touchUpdates.push('summary = ?'); touchParams.push(v.summary); }
  touchUpdates.push('tags = ?'); touchParams.push(v.tagsJson);
  touchUpdates.push('importance = ?'); touchParams.push(v.importance);

  await tx.executeRun(
    `UPDATE node SET ${touchUpdates.join(', ')}, project_path = ?, enrich_ver = ?, t_updated = ? WHERE rowid = ?`,
    [...touchParams, resolvedProjectPath, JSON.stringify(v.enrich_ver), now, p.rowid],
  );

  // E8: near-dup detection + SAME_AS edge (+ optional invalidation).
  const nearDup = await detectAndApplyNearDup(tx, p.rowid, p.embedding, p.vectorDialect);

  return {
    topic: v.topic,
    project_path: resolvedProjectPath,
    summary: v.summary,
    tags: v.tags,
    enrich_ver: v.enrich_ver,
    near_dup: nearDup,
  };
}
