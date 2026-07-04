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

import type { Database } from 'better-sqlite3';
import { createGraphBackend } from '@adhd/sox-graph-store';
import { resolveProjectPath } from './provenance.js';
import { detectNearDup } from './neardup.js';
import { extractiveSummary } from './extractive.js';
import { computeImportance } from './importance.js';
import type { EnrichmentProvenance } from './enrich-types.js';
import type { NearDupResult } from './neardup.js';
import { ENRICH_VERSION } from './enrich-version.js';

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

const NEARDUP_THRESHOLD = 0.95;

function getNearDupThreshold(): number {
  return NEARDUP_THRESHOLD;
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
  // Create GraphBackend for node/edge CRUD (pattern: sibling read-path modules)
  const graph = createGraphBackend(db);

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

  // Update standard enrichment fields via GraphBackend.touch()
  // (topic, summary, tags, importance — supported by NodeMeta)
  // Conditionally include optional fields to satisfy exactOptionalPropertyTypes
  graph.touch(p.rowid, {
    ...(resolvedTopic !== null ? { topic: resolvedTopic } : {}),
    ...(resolvedSummary !== null ? { summary: resolvedSummary } : {}),
    tags: resolvedTags,
    importance: initialImportance,
  });

  // Update memory-core-specific columns (project_path, enrich_ver) via raw SQL
  // project_path IS in NodeMeta but graph.touch() does not handle it yet.
  db.prepare(
    `UPDATE node SET project_path = ?, enrich_ver = ? WHERE rowid = ?`,
  ).run(resolvedProjectPath, JSON.stringify(enrichVer), p.rowid);

  // E8: insert SAME_AS edge if near-dup found and should_invalidate
  if (nearDup !== null) {
    const neighborRow = db
      .prepare<[string], { rowid: number }>(
        `SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`,
      )
      .get(nearDup.existing_uid);

    if (neighborRow) {
      const now = new Date().toISOString();
      // Insert SAME_AS edge via raw SQL (memory-core schema lacks the UNIQUE index
      // on (src, dst, rel) that GraphBackend.writeEdge's ON CONFLICT requires)
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
