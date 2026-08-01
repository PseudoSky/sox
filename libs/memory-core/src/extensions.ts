/**
 * sox-memory extended functions (promotion, graphify, communities, entity search).
 *
 * These functions were previously in the hand-maintained root-dist mirror (now deleted).
 * They are now compiled TypeScript, exported through src/lib.ts.
 *
 * Invariants:
 *   R1: zero provider/LLM calls on the read path
 *   R3: zero LLM calls — all enrichment is deterministic via memory-core enrich-batch
 *   R5: bi-temporal — invalidation closes t_invalid, never deletes
 */

import type { StoreAdapter, AdapterTransaction } from '@adhd/sox-store-adapter';
import * as crypto from 'node:crypto';
import { embed, vecToJson, vecToBuffer } from './embed.js';
import { ftsDialectFor } from './dialect.js';
import { log as tlog } from './telemetry.js';

// ── P4: Scope Promotion (design.md §2.5, docs/scope-promotion.md) ─────────────

const PROMOTION_CONFIG_KEYS = new Set([
  'auto_approve',
  'min_occurrences',
  'min_age_days',
  'approver_scope',
]);
const VALID_APPROVER_SCOPES = new Set(['user', 'org', 'project']);

export interface PromotionConfig {
  auto_approve?: boolean;
  min_occurrences?: number;
  min_age_days?: number;
  approver_scope?: string;
}

export interface PromotionConfigValidation {
  ok: boolean;
  errors?: string[];
}

export interface PromotionCandidateResult {
  candidates: number;
  inserted: number;
}

export interface ProposePendingResult {
  proposed: number;
}

export interface ApplyPromotionResult {
  ok: boolean;
  dst_uid?: string;
  note?: string;
  error?: string;
}

export interface RejectPromotionResult {
  ok: boolean;
}

/**
 * Validate config.promotion shape (catch typos at promote time — design.md R-promotion-policy).
 * Returns { ok: true } or { ok: false, errors: string[] }.
 */
export function validatePromotionConfig(config: unknown): PromotionConfigValidation {
  if (!config || typeof config !== 'object') {
    return { ok: false, errors: ['config.promotion must be an object'] };
  }
  const errors: string[] = [];
  const cfg = config as Record<string, unknown>;
  const unknownKeys = Object.keys(cfg).filter((k) => !PROMOTION_CONFIG_KEYS.has(k));
  if (unknownKeys.length > 0) {
    errors.push(`Unknown config.promotion keys (typo?): ${unknownKeys.join(', ')}`);
  }
  if (
    'min_occurrences' in cfg &&
    (typeof cfg['min_occurrences'] !== 'number' || (cfg['min_occurrences'] as number) < 1)
  ) {
    errors.push('config.promotion.min_occurrences must be a positive number');
  }
  if (
    'min_age_days' in cfg &&
    (typeof cfg['min_age_days'] !== 'number' || (cfg['min_age_days'] as number) < 0)
  ) {
    errors.push('config.promotion.min_age_days must be a non-negative number');
  }
  if ('auto_approve' in cfg && typeof cfg['auto_approve'] !== 'boolean') {
    errors.push('config.promotion.auto_approve must be a boolean');
  }
  if (
    'approver_scope' in cfg &&
    !VALID_APPROVER_SCOPES.has(cfg['approver_scope'] as string)
  ) {
    errors.push(
      `config.promotion.approver_scope must be one of: ${[...VALID_APPROVER_SCOPES].join(', ')}`,
    );
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Detect promotion candidates from the DB using config.promotion policy.
 * A "candidate" is a live node that has been seen >= min_occurrences times
 * and is older than min_age_days.
 *
 * Occurrence model: access_count (recall hits) + 1 (write) + MENTIONS edge count.
 * For simulated aging in tests: caller pre-sets t_created in the past.
 *
 * Returns { candidates, inserted }.
 */
export async function detectPromotionCandidates(
  adapter: StoreAdapter,
  promotionConfig: PromotionConfig | null | undefined,
  fromScope: string,
  toScope: string,
): Promise<PromotionCandidateResult> {
  const minOccurrences = promotionConfig?.min_occurrences ?? 3;
  const minAgeDays = promotionConfig?.min_age_days ?? 60;

  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const candidatesResult = await adapter.executeAll<{
    uid: string;
    t_created: string;
    occ: number;
    age_days: number;
  }>(
    `SELECT n.uid, n.t_created,
            (COALESCE(n.access_count, 0) + 1 +
             (SELECT COUNT(*) FROM edge e WHERE e.dst = n.rowid AND e.rel = 'MENTIONS' AND e.t_expired IS NULL)) AS occ,
            CAST((julianday('now') - julianday(n.t_created)) AS INTEGER) AS age_days
     FROM node n
     WHERE n.t_invalid IS NULL
       AND n.kind IN ('entity', 'claim', 'episode')
       AND n.t_created <= ?
       AND (COALESCE(n.access_count, 0) + 1 +
            (SELECT COUNT(*) FROM edge e WHERE e.dst = n.rowid AND e.rel = 'MENTIONS' AND e.t_expired IS NULL)) >= ?`,
    [cutoff, minOccurrences],
  );
  const candidates = candidatesResult.rows;

  const now = new Date().toISOString();
  let inserted = 0;

  for (const row of candidates) {
    const existing = await adapter.executeGet<{ id: number }>(
      `SELECT id FROM promotion_queue WHERE node_uid = ? AND from_scope = ? AND to_scope = ? AND status NOT IN ('rejected','applied')`,
      [row.uid, fromScope, toScope],
    );

    if (!existing) {
      await adapter.executeRun(
        `INSERT INTO promotion_queue (node_uid, from_scope, to_scope, occurrences, first_seen, age_days, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [row.uid, fromScope, toScope, row.occ, now, row.age_days],
      );
      inserted++;
    }
  }

  return { candidates: candidates.length, inserted };
}

/**
 * Propose pending promotion_queue entries via the host API.
 * Calls proposePromotionFn(extension_id, from_scope, to_scope, items) which fires
 * ScopePromotionProposed — the ONLY notification path (no bespoke channel).
 * Sets status='proposed' for each proposed row.
 */
export async function proposePendingCandidates(
  adapter: StoreAdapter,
  fromScope: string,
  toScope: string,
  proposePromotionFn: (
    extensionId: string,
    fromScope: string,
    toScope: string,
    items: Array<{
      uid: string;
      content: string | null;
      kind: string | null;
      name: string | null;
      summary: string | null;
    }>,
  ) => Promise<void>,
  extensionId: string,
): Promise<ProposePendingResult> {
  const pending = (await adapter.executeAll<{
    id: number;
    node_uid: string;
    content: string | null;
    kind: string | null;
    name: string | null;
    summary: string | null;
  }>(
    `SELECT pq.id, pq.node_uid, n.content, n.kind, n.name, n.summary
     FROM promotion_queue pq
     LEFT JOIN node n ON n.uid = pq.node_uid
     WHERE pq.from_scope = ? AND pq.to_scope = ? AND pq.status = 'pending'`,
    [fromScope, toScope],
  )).rows;

  if (pending.length === 0) return { proposed: 0 };

  const items = pending.map((row) => ({
    uid: row.node_uid,
    content: row.content ?? null,
    kind: row.kind ?? null,
    name: row.name ?? null,
    summary: row.summary ?? null,
  }));

  // Call the HOST API — fires ScopePromotionProposed (generic event path, no bespoke channel)
  await proposePromotionFn(extensionId, fromScope, toScope, items);

  // Mark rows as proposed
  const ids = pending.map((r) => r.id);
  await adapter.executeRun(
    `UPDATE promotion_queue SET status = 'proposed' WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );

  return { proposed: pending.length };
}

async function _writePromotionQueueApplied(
  adapter: StoreAdapter,
  nodeUid: string,
  fromScope: string,
  toScope: string,
  _dstUid: string,
): Promise<void> {
  const now = new Date().toISOString();
  await adapter.executeRun(
    `UPDATE promotion_queue SET status = 'applied', decided_at = ?, decided_by = ?
     WHERE node_uid = ? AND from_scope = ? AND to_scope = ? AND status IN ('proposed','pending','approved')`,
    [now, `scope:${toScope}`, nodeUid, fromScope, toScope],
  );
}

/**
 * Apply a promotion: copy node from source DB to destination (wider-scope) DB.
 * Writes SAME_AS edge in src DB (linking src node to promoted dst uid).
 * Sets status='applied' in src's promotion_queue.
 */
export async function applyPromotion(
  srcAdapter: StoreAdapter,
  dstAdapter: StoreAdapter,
  nodeUid: string,
  fromScope: string,
  toScope: string,
): Promise<ApplyPromotionResult> {
  const srcNode = await srcAdapter.executeGet<{
    uid: string;
    kind: string;
    content: string | null;
    name: string | null;
    summary: string | null;
    agent_id: string | null;
    session_id: string | null;
    source: string | null;
    importance: number;
    confidence: number | null;
    content_hash: string | null;
    level: number | null;
    t_created: string;
    t_occurred: string | null;
    t_valid: string | null;
  }>(
    `SELECT uid, kind, content, name, summary, agent_id, session_id, source,
            importance, confidence, content_hash, level, t_created, t_occurred, t_valid
     FROM node WHERE uid = ? AND t_invalid IS NULL`,
    [nodeUid],
  );

  if (!srcNode) {
    return { ok: false, error: `Source node not found or invalidated: ${nodeUid}` };
  }

  // Check if already promoted (content_hash dedup)
  if (srcNode.content_hash) {
    const dstExisting = await dstAdapter.executeGet<{ uid: string }>(
      `SELECT uid FROM node WHERE content_hash = ? AND t_invalid IS NULL`,
      [srcNode.content_hash],
    );
    if (dstExisting) {
      await _writePromotionQueueApplied(srcAdapter, nodeUid, fromScope, toScope, dstExisting.uid);
      return { ok: true, dst_uid: dstExisting.uid, note: 'already_exists' };
    }
  }

  const now = new Date().toISOString();
  const dstUid = `promoted-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const dstRow = await dstAdapter.executeGet<{ rowid: number }>(
      `INSERT INTO node (uid, kind, content, name, summary, agent_id, session_id, source,
                         importance, confidence, content_hash, level, t_created, t_occurred, t_valid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING rowid`,
      [
        dstUid,
        srcNode.kind,
        srcNode.content,
        srcNode.name,
        srcNode.summary,
        srcNode.agent_id,
        srcNode.session_id,
        srcNode.source ?? 'import',
        srcNode.importance,
        srcNode.confidence,
        srcNode.content_hash,
        srcNode.level,
        srcNode.t_created,
        srcNode.t_occurred,
        srcNode.t_valid ?? now,
      ],
    );

    if (!dstRow) throw new Error('Insert into dst DB failed');

    // Insert vec embedding for dst node (await outside transaction — safe here)
    if (srcNode.content || srcNode.name) {
      const text = [srcNode.content, srcNode.name].filter(Boolean).join(' ');
      const vec = await embed(text);
      const useBinaryFormat = dstAdapter.capabilities.nativeVectors;
      const serialized = useBinaryFormat ? vecToBuffer(vec) : vecToJson(vec);
      try {
        await dstAdapter.executeRun(
          'INSERT OR IGNORE INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
          [dstRow.rowid, serialized],
        );
      } catch {
        /* non-fatal */
      }
    }

    // Write SAME_AS edge in src DB
    const srcRow = await srcAdapter.executeGet<{ rowid: number }>(
      `SELECT rowid FROM node WHERE uid = ?`,
      [nodeUid],
    );
    if (srcRow) {
      await srcAdapter.executeRun(
        `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
         VALUES (?, ?, 'SAME_AS', 'user_asserted', ?, ?)`,
        [
          srcRow.rowid,
          srcRow.rowid,
          now,
          JSON.stringify({ promoted_to: dstUid, to_scope: toScope }),
        ],
      );
    }

    await _writePromotionQueueApplied(srcAdapter, nodeUid, fromScope, toScope, dstUid);
    return { ok: true, dst_uid: dstUid };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Reject a promotion candidate.
 */
export async function rejectPromotion(
  adapter: StoreAdapter,
  nodeUid: string,
  fromScope: string,
  toScope: string,
  decidedBy?: string,
): Promise<RejectPromotionResult> {
  const now = new Date().toISOString();
  await adapter.executeRun(
    `UPDATE promotion_queue SET status = 'rejected', decided_at = ?, decided_by = ?
     WHERE node_uid = ? AND from_scope = ? AND to_scope = ? AND status IN ('proposed','pending')`,
    [now, decidedBy ?? 'user', nodeUid, fromScope, toScope],
  );
  return { ok: true };
}

/**
 * Get promotion queue entries for a scope pair.
 */
export async function getPromotionQueue(
  adapter: StoreAdapter,
  fromScope: string,
  toScope: string,
  status?: string,
): Promise<unknown[]> {
  let sql = `SELECT * FROM promotion_queue WHERE from_scope = ? AND to_scope = ?`;
  const args: unknown[] = [fromScope, toScope];
  if (status) {
    sql += ` AND status = ?`;
    args.push(status);
  }
  return (await adapter.executeAll(sql, args)).rows;
}

// ── P4: Graphify import bridge (design.md §4 G4) ─────────────────────────────

export interface GraphifyShapeSpec {
  description: string;
  topLevelKeys: string[];
  nodeRequiredKeys: string[];
  nodeOptionalKeys: string[];
  edgeRequiredKeys: string[];
  edgeOptionalKeys: string[];
}

/**
 * Supported graphify shape fingerprints.
 * A fingerprint is derived from the top-level keys + first node/edge key set.
 * NEVER partial-import on unknown shape (G4 invariant).
 */
export const SUPPORTED_GRAPHIFY_SHAPES: Record<string, GraphifyShapeSpec> = {
  v1: {
    description: 'Graphify v1: {nodes:[{id,type,content}], edges:[{src,dst,rel}]}',
    topLevelKeys: ['nodes', 'edges'],
    nodeRequiredKeys: ['id', 'type', 'content'],
    nodeOptionalKeys: ['name', 'summary', 'importance', 'metadata'],
    edgeRequiredKeys: ['src', 'dst', 'rel'],
    edgeOptionalKeys: ['weight', 'confidence', 'metadata'],
  },
  v2: {
    description: 'Graphify v2: {version:2, nodes:[{uid,kind,content}], edges:[{src,dst,rel}]}',
    topLevelKeys: ['version', 'nodes', 'edges'],
    nodeRequiredKeys: ['uid', 'kind', 'content'],
    nodeOptionalKeys: ['name', 'summary', 'importance', 'agent_id', 'metadata'],
    edgeRequiredKeys: ['src', 'dst', 'rel'],
    edgeOptionalKeys: ['weight', 'confidence', 'metadata'],
  },
};

/**
 * Derive the shape fingerprint of a graphify graph JSON.
 * Returns shape name ('v1', 'v2') or null if unrecognized.
 */
export function fingerprintGraphifyShape(graph: unknown): string | null {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return null;
  const g = graph as Record<string, unknown>;
  const topKeys = new Set(Object.keys(g));

  // v2: has explicit version:2 field
  if (topKeys.has('version') && g['version'] === 2 && topKeys.has('nodes') && topKeys.has('edges')) {
    return 'v2';
  }
  // v1: exactly nodes + edges, first node has id+type+content
  if (!topKeys.has('version') && topKeys.has('nodes') && topKeys.has('edges')) {
    const nodes = g['nodes'];
    const firstNode =
      Array.isArray(nodes) && nodes.length > 0 ? nodes[0] : null;
    if (firstNode && typeof firstNode === 'object') {
      const nodeKeys = new Set(Object.keys(firstNode as Record<string, unknown>));
      if (nodeKeys.has('id') && nodeKeys.has('type') && nodeKeys.has('content')) return 'v1';
      // Has nodes but wrong key structure → unknown
      return null;
    }
    // No nodes → treat as v1 (edges-only graph)
    return 'v1';
  }

  return null;
}

function _validateGraphifyRecord(
  record: Record<string, unknown>,
  required: string[],
  optional: string[],
  recordType: string,
  index: number,
): string[] {
  const errors: string[] = [];
  const all = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  for (const req of required) {
    if (!(req in record)) {
      errors.push(`${recordType}[${index}] missing required field: ${req}`);
    }
  }
  const unknown = keys.filter((k) => !all.has(k));
  if (unknown.length > 0) {
    errors.push(
      `${recordType}[${index}] has unknown fields (fail-loud G4): ${unknown.join(', ')}`,
    );
  }
  return errors;
}

export interface GraphifyImportResult {
  ok: true;
  imported: number;
  edges_imported: number;
  shape: string;
}

export interface GraphifyImportError {
  ok: false;
  error: string;
  partial: false;
}

/**
 * graphify import — version-defensive bridge (design.md §4 G4).
 *
 * Rules:
 *   1. Shape fingerprint → check SUPPORTED_GRAPHIFY_SHAPES → FAIL LOUD if unknown.
 *   2. Validate every field → FAIL LOUD on unknown fields.
 *   3. Atomic import only after full validation.
 */
export async function graphifyImport(
  adapter: StoreAdapter,
  graphJson: unknown,
  options?: { agent_id?: string },
): Promise<GraphifyImportResult | GraphifyImportError> {
  const agentId = options?.agent_id ?? null;

  // Parse if string
  let graph: unknown;
  try {
    graph = typeof graphJson === 'string' ? JSON.parse(graphJson) : graphJson;
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON: ${(err as Error).message}`,
      partial: false,
    };
  }

  // 1. Shape fingerprint
  const shapeName = fingerprintGraphifyShape(graph);
  if (!shapeName) {
    return {
      ok: false,
      error:
        `Unknown graphify shape — REFUSING import (G4: fail-loud, no partial write). ` +
        `Supported shapes: ${Object.keys(SUPPORTED_GRAPHIFY_SHAPES).join(', ')}. ` +
        `Got top-level keys: ${Object.keys((graph as Record<string, unknown>) ?? {}).join(', ')}`,
      partial: false,
    };
  }

  const shapeSpec = SUPPORTED_GRAPHIFY_SHAPES[shapeName]!;
  const g = graph as Record<string, unknown>;
  const nodes = Array.isArray(g['nodes']) ? (g['nodes'] as Record<string, unknown>[]) : [];
  const edges = Array.isArray(g['edges']) ? (g['edges'] as Record<string, unknown>[]) : [];

  // 2. Validate ALL nodes and edges before any write
  const validationErrors: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    validationErrors.push(
      ..._validateGraphifyRecord(
        nodes[i]!,
        shapeSpec.nodeRequiredKeys,
        shapeSpec.nodeOptionalKeys,
        'node',
        i,
      ),
    );
  }
  for (let i = 0; i < edges.length; i++) {
    validationErrors.push(
      ..._validateGraphifyRecord(
        edges[i]!,
        shapeSpec.edgeRequiredKeys,
        shapeSpec.edgeOptionalKeys,
        'edge',
        i,
      ),
    );
  }

  if (validationErrors.length > 0) {
    return {
      ok: false,
      error:
        `Graphify validation failed (G4: fail-loud, no partial write):\n` +
        validationErrors.map((e) => `  - ${e}`).join('\n'),
      partial: false,
    };
  }

  // 3. Atomic import — all validation passed.
  //    Pre-compute embeddings before the transaction (StoreAdapter transactions
  //    are async, and embed is async — safe to pre-compute).
  const now = new Date().toISOString();
  let importedNodes = 0;
  let importedEdges = 0;
  const uidMap = new Map<string, string>(); // original id/uid → internal uid

  // Pre-compute embeddings keyed by node index
  // Serialization format: TursoAdapter (nativeVectors) uses F32_BLOB (Buffer),
  // SqliteAdapter (vec0) uses JSON array string.
  const useBinaryFormat = adapter.capabilities.nativeVectors;
  const nodeEmbedSerialized: (string | Buffer | null)[] = await Promise.all(
    nodes.map(async (node) => {
      const content = node['content'] as string | undefined;
      const name = (node['name'] as string | undefined) ?? null;
      const text = [content, name].filter(Boolean).join(' ');
      if (!text) return null;
      try {
        const vec = await embed(text);
        return useBinaryFormat ? vecToBuffer(vec) : vecToJson(vec);
      } catch {
        return null;
      }
    }),
  );

  await adapter.transaction(async (tx: AdapterTransaction) => {
    for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
      const node = nodes[nodeIdx]!;
      const origId = (shapeName === 'v2' ? node['uid'] : node['id']) as string;
      const uid = shapeName === 'v2' ? (node['uid'] as string) : `import-${node['id'] as string}`;
      const kind =
        shapeName === 'v2'
          ? (node['kind'] as string)
          : _mapGraphifyType(node['type'] as string | undefined);
      const content = node['content'] as string;
      const name = (node['name'] as string | undefined) ?? null;
      const summary = (node['summary'] as string | undefined) ?? null;
      const importance = (node['importance'] as number | undefined) ?? 1.0;
      const contentHash = crypto
        .createHash('sha256')
        .update((content ?? '').trim().toLowerCase())
        .digest('hex');

      const existing = await tx.executeGet<{ rowid: number; uid: string }>(
        `SELECT rowid, uid FROM node WHERE content_hash = ?`,
        [contentHash],
      );
      if (existing) {
        uidMap.set(origId, existing.uid);
        continue;
      }

      const row = await tx.executeGet<{ rowid: number }>(
        `INSERT INTO node (uid, kind, content, name, summary, agent_id, source, importance, content_hash, t_created, t_valid)
         VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)
         RETURNING rowid`,
        [uid, kind, content, name, summary, agentId, importance, contentHash, now, now],
      );

      if (row) {
        const serialized = nodeEmbedSerialized[nodeIdx] ?? null;
        try {
          await tx.executeRun(
            'INSERT OR IGNORE INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
            [row.rowid, serialized],
          );
        } catch {
          /* non-fatal */
        }
        uidMap.set(origId, uid);
        importedNodes++;
      }
    }

    for (const edge of edges) {
      const srcOrigId = edge['src'] as string;
      const dstOrigId = edge['dst'] as string;
      const srcUid = uidMap.get(srcOrigId) ?? srcOrigId;
      const dstUid = uidMap.get(dstOrigId) ?? dstOrigId;
      const srcRow = await tx.executeGet<{ rowid: number }>(
        `SELECT rowid FROM node WHERE uid = ?`,
        [srcUid],
      );
      const dstRow = await tx.executeGet<{ rowid: number }>(
        `SELECT rowid FROM node WHERE uid = ?`,
        [dstUid],
      );
      if (!srcRow || !dstRow) continue;
      const rel = _mapGraphifyRel(edge['rel'] as string | undefined);
      if (!rel) continue;
      try {
        await tx.executeRun(
          `INSERT OR IGNORE INTO edge (src, dst, rel, weight, confidence, origin, t_created)
           VALUES (?, ?, ?, ?, ?, 'user_asserted', ?)`,
          [
            srcRow.rowid,
            dstRow.rowid,
            rel,
            (edge['weight'] as number | undefined) ?? 1.0,
            (edge['confidence'] as number | null | undefined) ?? null,
            now,
          ],
        );
        importedEdges++;
      } catch {
        /* skip */
      }
    }
  });

  return { ok: true, imported: importedNodes, edges_imported: importedEdges, shape: shapeName };
}

function _mapGraphifyType(type: string | undefined): string {
  const t = (type ?? '').toLowerCase();
  if (t === 'entity' || t === 'person' || t === 'place' || t === 'concept') return 'entity';
  if (t === 'claim' || t === 'fact' || t === 'statement') return 'claim';
  return 'episode';
}

const VALID_RELS = new Set([
  'MENTIONS',
  'SUPPORTS',
  'RELATES_TO',
  'SUPERSEDES',
  'DERIVED_FROM',
  'MEMBER_OF',
  'PART_OF',
  'SAME_AS',
]);

function _mapGraphifyRel(rel: string | undefined): string | null {
  const r = (rel ?? '').toUpperCase();
  if (VALID_RELS.has(r)) return r;
  if (r === 'KNOWS' || r === 'CONNECTED_TO') return 'RELATES_TO';
  if (r === 'IS_A' || r === 'INSTANCE_OF') return 'PART_OF';
  if (r === 'REPLACES' || r === 'UPDATES') return 'SUPERSEDES';
  return null;
}

// ── P4: Communities (design.md §2.3) ─────────────────────────────────────────

export interface BuildCommunitiesOptions {
  maxIterations?: number;
  minCommunitySize?: number;
}

export interface BuildCommunitiesResult {
  communities: number;
  members: number;
}

/**
 * Deterministic label-propagation community detection (design.md §2.3, P4).
 * Community labels are derived deterministically from centroid member names.
 * Batch clustering runs in-process inside memory-server via memory-core runBatchEnrich
 * (ADR-0007 single-writer architecture — no separate daemon process).
 */
export async function buildCommunities(
  adapter: StoreAdapter,
  options?: BuildCommunitiesOptions,
): Promise<BuildCommunitiesResult> {
  const maxIterations = options?.maxIterations ?? 20;
  const minSize = options?.minCommunitySize ?? 2;

  const nodes = (await adapter.executeAll<{ rowid: number; uid: string }>(
    `SELECT rowid, uid FROM node WHERE t_invalid IS NULL AND kind IN ('entity','episode','claim')`,
  )).rows;

  if (nodes.length === 0) return { communities: 0, members: 0 };

  const rowidToUid = new Map<number, string>();
  const uidToRowid = new Map<string, number>();
  for (const n of nodes) {
    rowidToUid.set(n.rowid, n.uid);
    uidToRowid.set(n.uid, n.rowid);
  }

  // Build adjacency from live edges
  const adj = new Map<string, Set<string>>();
  for (const uid of rowidToUid.values()) adj.set(uid, new Set());

  const edges = (await adapter.executeAll<{ src_uid: string; dst_uid: string }>(
    `SELECT n1.uid AS src_uid, n2.uid AS dst_uid
     FROM edge e
     JOIN node n1 ON n1.rowid = e.src
     JOIN node n2 ON n2.rowid = e.dst
     WHERE e.t_expired IS NULL
       AND n1.t_invalid IS NULL AND n2.t_invalid IS NULL
       AND n1.kind IN ('entity','episode','claim')
       AND n2.kind IN ('entity','episode','claim')`,
  )).rows;

  for (const e of edges) {
    if (adj.has(e.src_uid)) adj.get(e.src_uid)!.add(e.dst_uid);
    if (adj.has(e.dst_uid)) adj.get(e.dst_uid)!.add(e.src_uid);
  }

  // Initialize labels (sorted by uid for determinism)
  const sortedUids = [...rowidToUid.values()].sort();
  const labels = new Map<string, string>();
  for (const uid of sortedUids) labels.set(uid, uid);

  // Label propagation
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = 0;
    for (const uid of sortedUids) {
      const neighbors = [...(adj.get(uid) ?? [])];
      if (neighbors.length === 0) continue;
      const freq = new Map<string, number>();
      for (const nb of neighbors) {
        const lbl = labels.get(nb) ?? nb;
        freq.set(lbl, (freq.get(lbl) ?? 0) + 1);
      }
      let bestLabel = labels.get(uid)!;
      let bestCount = 0;
      for (const [lbl, cnt] of freq) {
        if (cnt > bestCount || (cnt === bestCount && lbl < bestLabel)) {
          bestLabel = lbl;
          bestCount = cnt;
        }
      }
      if (bestLabel !== labels.get(uid)) {
        labels.set(uid, bestLabel);
        changed++;
      }
    }
    if (changed === 0) break;
  }

  // Group by label
  const communities = new Map<string, string[]>();
  for (const [uid, label] of labels) {
    if (!communities.has(label)) communities.set(label, []);
    communities.get(label)!.push(uid);
  }
  const validCommunities = [...communities.entries()].filter(
    ([, members]) => members.length >= minSize,
  );
  if (validCommunities.length === 0) return { communities: 0, members: 0 };

  // Invalidate old community nodes
  const now = new Date().toISOString();
  await adapter.transaction(async (tx: AdapterTransaction) => {
    await tx.executeRun(
      `UPDATE node SET t_invalid = ? WHERE kind = 'community' AND level = 0 AND t_invalid IS NULL`,
      [now],
    );
  });

  let commCreated = 0;
  let memberCount = 0;

  await adapter.transaction(async (tx: AdapterTransaction) => {
    for (const [label, memberUids] of validCommunities) {
      const commUid = `community-${label.substring(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const memberNames = [];
      for (const uid of memberUids.slice(0, 3)) {
        const n = await tx.executeGet<{ name: string | null; content: string | null }>(
          `SELECT name, content FROM node WHERE uid = ?`,
          [uid],
        );
        memberNames.push(n?.name ?? (n?.content ?? '').substring(0, 30) ?? uid.substring(0, 8));
      }
      const communityName = `Community: ${memberNames.filter(Boolean).join(', ')}`;

      // Insert community node (label derived from member names — deterministic)
      const commRow = await tx.executeGet<{ rowid: number }>(
        `INSERT INTO node (uid, kind, name, level, t_created, t_valid)
         VALUES (?, 'community', ?, 0, ?, ?)
         RETURNING rowid`,
        [commUid, communityName, now, now],
      );

      if (!commRow) continue;
      commCreated++;

      for (const memberUid of memberUids) {
        const memberRowid = uidToRowid.get(memberUid);
        if (!memberRowid) continue;
        try {
          await tx.executeRun(
            `INSERT OR IGNORE INTO edge (src, dst, rel, origin, t_created)
             VALUES (?, ?, 'MEMBER_OF', 'extracted', ?)`,
            [memberRowid, commRow.rowid, now],
          );
          memberCount++;
        } catch {
          /* skip */
        }
      }
    }
  });

  return { communities: commCreated, members: memberCount };
}

export interface GetCommunitySuccess {
  community: {
    uid: string;
    name: string | null;
    summary: string | null;
    level: number;
    member_count: number;
    members: Array<{
      uid: string;
      name: string | null;
      content: string | null;
      kind: string;
    }>;
  };
}

export interface GetCommunityError {
  code: 'E_NOT_FOUND';
  message: string;
}

/**
 * memory_get_community — tool 6 (design.md §2.3).
 * Returns the community a node belongs to at the given level.
 */
export async function memoryGetCommunity(
  adapter: StoreAdapter,
  entity_uid: string,
  level?: number,
): Promise<GetCommunitySuccess | GetCommunityError> {
  const targetLevel = level ?? 0;

  const node = await adapter.executeGet<{
    rowid: number;
    uid: string;
    name: string | null;
    content: string | null;
    kind: string;
  }>(
    `SELECT rowid, uid, name, content, kind FROM node WHERE uid = ? AND t_invalid IS NULL`,
    [entity_uid],
  );

  if (!node) {
    return { code: 'E_NOT_FOUND', message: `Node not found: ${entity_uid}` };
  }

  const communityRow = await adapter.executeGet<{
    uid: string;
    name: string | null;
    summary: string | null;
    level: number;
  }>(
    `SELECT n_comm.uid, n_comm.name, n_comm.summary, n_comm.level
     FROM edge e
     JOIN node n_comm ON n_comm.rowid = e.dst
     WHERE e.src = ? AND e.rel = 'MEMBER_OF'
       AND n_comm.kind = 'community'
       AND n_comm.level = ?
       AND e.t_expired IS NULL
       AND n_comm.t_invalid IS NULL
     LIMIT 1`,
    [node.rowid, targetLevel],
  );

  if (!communityRow) {
    return {
      code: 'E_NOT_FOUND',
      message: `No community at level ${targetLevel} for node: ${entity_uid}`,
    };
  }

  const commNode = await adapter.executeGet<{ rowid: number }>(
    `SELECT rowid FROM node WHERE uid = ?`,
    [communityRow.uid],
  );

  const members = commNode
    ? (await adapter.executeAll<{
        uid: string;
        name: string | null;
        content: string | null;
        kind: string;
      }>(
        `SELECT n.uid, n.name, n.content, n.kind
         FROM edge e
         JOIN node n ON n.rowid = e.src
         WHERE e.dst = ? AND e.rel = 'MEMBER_OF'
           AND e.t_expired IS NULL AND n.t_invalid IS NULL`,
        [commNode.rowid],
      )).rows
    : [];

  return {
    community: {
      uid: communityRow.uid,
      name: communityRow.name,
      summary: communityRow.summary ?? null,
      level: communityRow.level,
      member_count: members.length,
      members: members.map((m) => ({
        uid: m.uid,
        name: m.name,
        content: m.content,
        kind: m.kind,
      })),
    },
  };
}

export interface SearchEntitiesParams {
  query: string;
  entity_type?: string;
  limit?: number;
}

export interface SearchEntitiesResult {
  entities: Array<{
    uid: string;
    name: string | null;
    content: string | null;
    summary: string | null;
    kind: string;
    importance: number;
  }>;
  /**
   * BL-384: which path produced `entities` — `'fts'` for a real BM25/Tantivy
   * ranked full-text match, `'like'` when the search degraded to a substring
   * scan (FTS unsupported on this backend, or the FTS query matched nothing).
   * A silent degrade-to-LIKE with no visible signal is exactly what hid this
   * bug for a month on the Turso backend (BL-334: a degraded search must be
   * visible, not just "results happened to come back").
   */
  search_mode: 'fts' | 'like';
}

/**
 * memory_search_entities — tool 3 (design.md §2.3).
 * Hybrid FTS + LIKE search for entity nodes. Zero LLM calls (R1).
 *
 * BL-384: FTS goes through `ftsDialectFor(adapter)` — never a raw
 * `fts_node`/`MATCH` statement, and never a branch on `adapter.config.type`.
 * `fts_node` is the SQLite FTS5 shadow table; `openDb()` drops it entirely on
 * the Turso branch (BL-347 residue cleanup), so the old unconditional
 * `FROM fts_node ... MATCH` statement could never resolve there — it always
 * threw, was swallowed by a bare `catch`, and fell through to a LIKE
 * substring scan ranked by importance instead of relevance. See
 * `recall.ts`'s FTS block (~L519-566) for the pattern this mirrors.
 */
export async function memorySearchEntities(
  adapter: StoreAdapter,
  params: SearchEntitiesParams,
): Promise<SearchEntitiesResult> {
  const { query, limit = 10 } = params;

  if (!query?.trim()) return { entities: [], search_mode: 'like' };

  const ftsTokens = query
    .replace(/['"*\-()\[\]]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  const entityRow = {
    uid: '',
    name: '' as string | null,
    content: '' as string | null,
    summary: '' as string | null,
    kind: '',
    importance: 0,
  };
  type EntityRow = typeof entityRow;
  let entities: EntityRow[] = [];
  let searchMode: 'fts' | 'like' = 'like';

  if (ftsTokens.length > 0) {
    const ftsDialect = await ftsDialectFor(adapter);
    // BL-367: build the bound MATCH-query text via the dialect, NOT a bare
    // space-join. SQLite FTS5 ANDs bareword tokens (all must be present);
    // Turso's Tantivy `fts_match` matches on ANY token (effectively OR). A
    // space-joined query therefore silently returned far fewer/zero SQLite
    // hits for multi-term queries than Turso for the same corpus.
    // `buildMatchQuery` makes both dialects build the identical explicit
    // `"tok1" OR "tok2" OR ...` form — see `recall.ts`'s FTS block and the
    // doc comment on `FTSDialect.buildMatchQuery` (store-adapter/src/types.ts).
    const ftsQuery = ftsDialect.supported ? ftsDialect.buildMatchQuery(ftsTokens) : '';
    if (ftsQuery) {
      try {
        // Both branches ask the dialect for match/score SQL and bind the
        // query text as a normal parameter (`?`) — never inlined as a string
        // literal. The two differ only in table shape: SQLite FTS5 keeps a
        // separate `fts_node` shadow table joined back to `node`; Turso's
        // Tantivy index lives directly on `node` — decided via
        // `ftsDialect.supportsShadowTable`, never `adapter.config.type`.
        const { sql: matchSql } = ftsDialect.matchClause(['content', 'name', 'summary'], '?');
        const scoreExpr = ftsDialect.scoreClause(['content', 'name', 'summary'], '?');
        let ftsRows: EntityRow[];
        if (ftsDialect.supportsShadowTable) {
          ftsRows = (await adapter.executeAll<EntityRow>(
            `SELECT n.uid, n.name, n.content, n.summary, n.kind, n.importance
             FROM fts_node
             JOIN node n ON n.rowid = fts_node.rowid
             WHERE ${matchSql} AND n.t_invalid IS NULL AND n.kind = 'entity'
             ORDER BY ${scoreExpr} LIMIT ?`,
            [ftsQuery, limit],
          )).rows;
        } else {
          ftsRows = (await adapter.executeAll<EntityRow>(
            `SELECT uid, name, content, summary, kind, importance
             FROM node
             WHERE ${matchSql} AND t_invalid IS NULL AND kind = 'entity'
             ORDER BY ${scoreExpr} LIMIT ?`,
            [ftsQuery, ftsQuery, limit],
          )).rows;
        }
        if (ftsRows.length > 0) {
          entities.push(...ftsRows);
          searchMode = 'fts';
        }
      } catch (err) {
        // BL-384: a genuine FTS query failure must be visible, not a silent
        // swallow. The prior bare `catch {}` here hid a permanently-broken
        // statement on the Turso backend for a month — every entity search
        // silently degraded to a LIKE substring scan, with zero signal
        // anywhere that it had happened.
        tlog.warn('search_entities.fts.error', {
          dialect: ftsDialect.dialect,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (entities.length === 0) {
    try {
      const nameRows = (await adapter.executeAll<EntityRow>(
        `SELECT uid, name, content, summary, kind, importance
         FROM node WHERE t_invalid IS NULL AND kind = 'entity'
           AND (name LIKE ? OR content LIKE ?)
         ORDER BY importance DESC LIMIT ?`,
        [`%${query}%`, `%${query}%`, limit],
      )).rows;
      entities.push(...nameRows);
      searchMode = 'like';
    } catch {
      /* ignore */
    }
  }

  const seen = new Set<string>();
  const dedup = entities
    .filter((e) => {
      if (seen.has(e.uid)) return false;
      seen.add(e.uid);
      return true;
    })
    .slice(0, limit);

  return {
    entities: dedup.map((e) => ({
      uid: e.uid,
      name: e.name ?? null,
      content: e.content ?? null,
      summary: e.summary ?? null,
      kind: e.kind,
      importance: e.importance ?? 1.0,
    })),
    search_mode: searchMode,
  };
}
