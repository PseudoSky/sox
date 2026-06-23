/**
 * enrich.ts — write-path enrichment orchestrator (Tier 1, <5ms target).
 * CONTRACTS.md C1.2.
 *
 * Covers E1–E5, E8 (near-dup local KNN), E10 (extractive summary fallback), E12.
 * No LLM, no network. Synchronous (runs inside/after write transaction).
 *
 * Determinism: given the same params and DB state, produces identical output.
 */

import type { Database } from 'better-sqlite3';
import { resolveProjectPath } from './provenance.js';
import { detectNearDup } from './neardup.js';
import { extractiveSummary } from './extractive.js';
import { computeImportance } from './importance.js';
import type { EnrichmentProvenance } from './types.js';
import type { NearDupResult } from './neardup.js';
import { ENRICH_VERSION } from './index.js';

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
  /** 768-dim L2-normalised embedding vector already computed by the write path. */
  embedding: Float32Array;
  /**
   * Caller-supplied importance (user-asserted). When present, it is respected and
   * the computed importance is NOT written. Batch enricher also will not overwrite it
   * (per CONTRACTS.md C2.1). undefined = compute importance from content.
   */
  importance: number | undefined;
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
  /** Near-dup detection result (E8). null = no dup found. */
  near_dup: NearDupResult | null;
}

/**
 * Near-dup threshold constants per backend.
 * D2 E8: 0.95 for real, 0.98 for hash.
 */
const NEARDUP_THRESHOLD_REAL = 0.95;
const NEARDUP_THRESHOLD_HASH = 0.98;

function getNearDupThreshold(): number {
  // Detect hash backend via environment (same approach as neardup.ts)
  const backend = process.env['SOX_EMBED_BACKEND'];
  if (backend === 'hash') return NEARDUP_THRESHOLD_HASH;
  if (backend === 'real') return NEARDUP_THRESHOLD_REAL;
  // 'auto' or undefined: assume hash for conservative false-positive prevention
  return NEARDUP_THRESHOLD_HASH;
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
export function enrichOnWrite(
  db: Database,
  p: EnrichOnWriteParams,
): EnrichOnWriteResult {
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
    p.summary !== undefined
      ? p.summary
      : extractiveSummary(p.content);

  // E4: resolved tags (already stored as JSON in P1; here we return the array)
  const resolvedTags: string[] = p.tags ?? [];

  // E7: compute initial importance (length + tag score at write time; link/access on batch).
  // If caller supplied an explicit importance, respect it — do NOT override.
  let initialImportance: number;
  let userOverride = false;
  if (p.importance !== undefined) {
    initialImportance = p.importance;
    userOverride = true;
  } else {
    const wordCount = p.content.split(/\s+/).filter(Boolean).length;
    initialImportance = computeImportance({
      word_count: wordCount,
      link_degree: 0, // no edges yet; updated on batch pass
      access_count: 0,
      tag_count: resolvedTags.length,
    });
  }

  // E8: near-dup detection (KNN-20 from vec_node)
  const dupThreshold = getNearDupThreshold();
  let nearDup: NearDupResult | null = null;
  try {
    nearDup = detectNearDup(db, p.rowid, p.embedding, dupThreshold);
  } catch {
    // KNN query may fail on empty stores — treat as no dup
    nearDup = null;
  }

  // E12: enrichment provenance stamp
  const enrichVer: EnrichmentProvenance = {
    pass: ENRICH_VERSION,
    ts: new Date().toISOString(),
    ...(userOverride ? { note: 'user_override' } : {}),
  };

  // Update node row with all enriched fields
  db.prepare(
    `UPDATE node SET
       topic = ?,
       project_path = ?,
       summary = ?,
       tags = ?,
       importance = ?,
       enrich_ver = ?
     WHERE rowid = ?`,
  ).run(
    resolvedTopic,
    resolvedProjectPath,
    resolvedSummary,
    resolvedTags.length > 0 ? JSON.stringify(resolvedTags) : null,
    initialImportance,
    JSON.stringify(enrichVer),
    p.rowid,
  );

  // E8: insert SAME_AS edge if near-dup found and should_invalidate
  if (nearDup !== null) {
    const neighborRow = db
      .prepare<[string], { rowid: number }>(
        `SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`,
      )
      .get(nearDup.existing_uid);

    if (neighborRow) {
      const now = new Date().toISOString();
      // Insert SAME_AS edge (idempotent)
      db.prepare(
        `INSERT INTO edge (src, dst, rel, origin, weight, t_created, meta)
         SELECT ?, ?, 'SAME_AS', 'inferred', ?, ?, NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM edge WHERE src = ? AND dst = ? AND rel = 'SAME_AS' AND t_expired IS NULL
         )`,
      ).run(p.rowid, neighborRow.rowid, nearDup.cosine_sim, now, p.rowid, neighborRow.rowid);

      // If should_invalidate: invalidate the older episode (set t_invalid on the neighbour)
      if (nearDup.should_invalidate) {
        db.prepare(
          `UPDATE node SET t_invalid = ? WHERE uid = ? AND t_invalid IS NULL`,
        ).run(now, nearDup.existing_uid);
      }
    }
  }

  return {
    topic: resolvedTopic,
    project_path: resolvedProjectPath,
    summary: resolvedSummary,
    tags: resolvedTags,
    enrich_ver: enrichVer,
    near_dup: nearDup,
  };
}
