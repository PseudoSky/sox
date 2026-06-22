/**
 * Shared type definitions for @sox/memory-enrich.
 * Matches CONTRACTS.md C1.1, C3.1–C3.4.
 */

// ── C1.1 ─────────────────────────────────────────────────────────────────────

/** Minimum node fields required by enrichment functions. */
export interface EnrichableNode {
  rowid: number;
  uid: string;
  content: string;
  /** Pre-enrichment: may be null. Post-E10: populated. */
  summary: string | null;
  /** Pre-enrichment: may be null. Post-E5: populated. */
  topic: string | null;
  /** Pre-enrichment: may be null. Post-E4: JSON string array. */
  tags: string | null;
  /** Pre-enrichment: may be null. Post-E1: populated. */
  project_path: string | null;
  /** Pre-enrichment: may be null. Post-E3: JSON object. */
  meta: string | null;
  /** Pre-enrichment: may be null. Post-E12: JSON { pass, ts }. */
  enrich_ver: string | null;
  importance: number;
  agent_id: string | null;
  session_id: string | null;
  t_created: string;
  t_invalid: string | null;
}

/** Enrichment provenance stamp written by every pass (E12). */
export interface EnrichmentProvenance {
  /** Semver of @sox/memory-enrich that produced this. e.g. "1.0.0" */
  pass: string;
  /** ISO timestamp of enrichment run. */
  ts: string;
  /** Optional: "legacy" for pre-enrichment nodes backfilled on first batch. */
  note?: string;
}

// ── C3.1 ─────────────────────────────────────────────────────────────────────

export interface EpisodeSummary {
  uid: string;
  content: string | null;
  summary: string | null;
  topic: string | null;
  tags: string[];              // empty array if node.tags IS NULL
  project_path: string | null;
  importance: number;
  t_created: string;
  agent_id: string | null;
  is_superseded: boolean;      // t_invalid IS NOT NULL AND EXISTS SUPERSEDES edge pointing here
  supersedes_uid: string | null; // UID this episode explicitly supersedes, if any
  community_uid: string | null;  // community the episode belongs to, if clustered
}

// ── C3.2 ─────────────────────────────────────────────────────────────────────

/** Full node row shape post-migration. Matches the node table schema after D3.1 migration. */
export interface NodeV1 {
  rowid: number;
  uid: string;
  kind: 'episode' | 'entity' | 'community' | 'session' | 'chunk';
  name: string | null;
  content: string | null;
  summary: string | null;
  content_hash: string | null;
  importance: number;
  access_count: number;
  agent_id: string | null;
  session_id: string | null;
  source: string | null;
  t_created: string;
  t_occurred: string | null;
  t_valid: string | null;
  t_invalid: string | null;
  last_access: string | null;
  resume_state: string | null;
  level: number | null;
  // Enrichment columns (new in v1, nullable for pre-migration rows):
  tags: string | null;          // JSON string[]; parse with JSON.parse
  topic: string | null;
  project_path: string | null;
  meta: string | null;          // JSON Record<string, unknown>; parse with JSON.parse
  enrich_ver: string | null;    // JSON EnrichmentProvenance
}

// ── C3.3 ─────────────────────────────────────────────────────────────────────

/** Community node as stored in the node table (kind='community'). */
export interface CommunityNodeV1 {
  rowid: number;
  uid: string;          // sha256(sorted member rowids) prefix (D1.2)
  kind: 'community';
  name: string | null;  // label (D1.4)
  summary: string | null;
  level: number;
  t_created: string;
  t_invalid: string | null;
  // Enrichment columns on community nodes:
  meta: string | null;  // JSON: { mean_intra_sim, centroid_rowid, member_count }
  enrich_ver: string | null;
}
