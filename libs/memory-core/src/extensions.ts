/**
 * sox-memory extended functions (promotion, graphify, communities, entity search).
 *
 * These functions were previously in the hand-maintained root-dist mirror (now deleted).
 * They are now compiled TypeScript, exported through src/lib.ts.
 *
 * Invariants:
 *   R1: zero provider/LLM calls on the read path
 *   R3: ALL LLM calls originate in memory-organizer
 *   R5: bi-temporal — invalidation closes t_invalid, never deletes
 */

import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import { embed, vecToJson } from './embed.js';

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
export function detectPromotionCandidates(
  db: Database.Database,
  promotionConfig: PromotionConfig | null | undefined,
  fromScope: string,
  toScope: string,
): PromotionCandidateResult {
  const minOccurrences = promotionConfig?.min_occurrences ?? 3;
  const minAgeDays = promotionConfig?.min_age_days ?? 60;

  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const candidates = db
    .prepare(
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
    )
    .all(cutoff, minOccurrences) as Array<{
    uid: string;
    t_created: string;
    occ: number;
    age_days: number;
  }>;

  const now = new Date().toISOString();
  let inserted = 0;

  for (const row of candidates) {
    const existing = db
      .prepare(
        `SELECT id FROM promotion_queue WHERE node_uid = ? AND from_scope = ? AND to_scope = ? AND status NOT IN ('rejected','applied')`,
      )
      .get(row.uid, fromScope, toScope);

    if (!existing) {
      db.prepare(
        `INSERT INTO promotion_queue (node_uid, from_scope, to_scope, occurrences, first_seen, age_days, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(row.uid, fromScope, toScope, row.occ, now, row.age_days);
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
  db: Database.Database,
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
  const pending = db
    .prepare(
      `SELECT pq.id, pq.node_uid, n.content, n.kind, n.name, n.summary
       FROM promotion_queue pq
       LEFT JOIN node n ON n.uid = pq.node_uid
       WHERE pq.from_scope = ? AND pq.to_scope = ? AND pq.status = 'pending'`,
    )
    .all(fromScope, toScope) as Array<{
    id: number;
    node_uid: string;
    content: string | null;
    kind: string | null;
    name: string | null;
    summary: string | null;
  }>;

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
  db.prepare(
    `UPDATE promotion_queue SET status = 'proposed' WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).run(...ids);

  return { proposed: pending.length };
}

function _writePromotionQueueApplied(
  db: Database.Database,
  nodeUid: string,
  fromScope: string,
  toScope: string,
  _dstUid: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE promotion_queue SET status = 'applied', decided_at = ?, decided_by = ?
     WHERE node_uid = ? AND from_scope = ? AND to_scope = ? AND status IN ('proposed','pending','approved')`,
  ).run(now, `scope:${toScope}`, nodeUid, fromScope, toScope);
}

/**
 * Apply a promotion: copy node from source DB to destination (wider-scope) DB.
 * Writes SAME_AS edge in src DB (linking src node to promoted dst uid).
 * Sets status='applied' in src's promotion_queue.
 */
export async function applyPromotion(
  srcDb: Database.Database,
  dstDb: Database.Database,
  nodeUid: string,
  fromScope: string,
  toScope: string,
): Promise<ApplyPromotionResult> {
  const srcNode = srcDb
    .prepare(
      `SELECT uid, kind, content, name, summary, agent_id, session_id, source,
              importance, confidence, content_hash, level, t_created, t_occurred, t_valid
       FROM node WHERE uid = ? AND t_invalid IS NULL`,
    )
    .get(nodeUid) as {
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
  } | undefined;

  if (!srcNode) {
    return { ok: false, error: `Source node not found or invalidated: ${nodeUid}` };
  }

  // Check if already promoted (content_hash dedup)
  if (srcNode.content_hash) {
    const dstExisting = dstDb
      .prepare(`SELECT uid FROM node WHERE content_hash = ? AND t_invalid IS NULL`)
      .get(srcNode.content_hash) as { uid: string } | undefined;
    if (dstExisting) {
      _writePromotionQueueApplied(srcDb, nodeUid, fromScope, toScope, dstExisting.uid);
      return { ok: true, dst_uid: dstExisting.uid, note: 'already_exists' };
    }
  }

  const now = new Date().toISOString();
  const dstUid = `promoted-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const dstRow = dstDb
      .prepare(
        `INSERT INTO node (uid, kind, content, name, summary, agent_id, session_id, source,
                           importance, confidence, content_hash, level, t_created, t_occurred, t_valid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING rowid`,
      )
      .get(
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
      ) as { rowid: number } | undefined;

    if (!dstRow) throw new Error('Insert into dst DB failed');

    // Insert vec embedding for dst node (await outside transaction — safe here)
    if (srcNode.content || srcNode.name) {
      const text = [srcNode.content, srcNode.name].filter(Boolean).join(' ');
      const vec = await embed(text);
      const vecJson = vecToJson(vec);
      try {
        dstDb
          .prepare(
            'INSERT OR IGNORE INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
          )
          .run(dstRow.rowid, vecJson);
      } catch {
        /* non-fatal */
      }
    }

    // Write SAME_AS edge in src DB
    const srcRow = srcDb
      .prepare(`SELECT rowid FROM node WHERE uid = ?`)
      .get(nodeUid) as { rowid: number } | undefined;
    if (srcRow) {
      srcDb
        .prepare(
          `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
           VALUES (?, ?, 'SAME_AS', 'user_asserted', ?, ?)`,
        )
        .run(
          srcRow.rowid,
          srcRow.rowid,
          now,
          JSON.stringify({ promoted_to: dstUid, to_scope: toScope }),
        );
    }

    _writePromotionQueueApplied(srcDb, nodeUid, fromScope, toScope, dstUid);
    return { ok: true, dst_uid: dstUid };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Reject a promotion candidate.
 */
export function rejectPromotion(
  db: Database.Database,
  nodeUid: string,
  fromScope: string,
  toScope: string,
  decidedBy?: string,
): RejectPromotionResult {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE promotion_queue SET status = 'rejected', decided_at = ?, decided_by = ?
     WHERE node_uid = ? AND from_scope = ? AND to_scope = ? AND status IN ('proposed','pending')`,
  ).run(now, decidedBy ?? 'user', nodeUid, fromScope, toScope);
  return { ok: true };
}

/**
 * Get promotion queue entries for a scope pair.
 */
export function getPromotionQueue(
  db: Database.Database,
  fromScope: string,
  toScope: string,
  status?: string,
): unknown[] {
  let sql = `SELECT * FROM promotion_queue WHERE from_scope = ? AND to_scope = ?`;
  const args: unknown[] = [fromScope, toScope];
  if (status) {
    sql += ` AND status = ?`;
    args.push(status);
  }
  return db.prepare(sql).all(...args);
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
  db: Database.Database,
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
  //    Pre-compute embeddings before the transaction (better-sqlite3 transactions
  //    are synchronous — cannot await inside them).
  const now = new Date().toISOString();
  let importedNodes = 0;
  let importedEdges = 0;
  const uidMap = new Map<string, string>(); // original id/uid → internal uid

  // Pre-compute embeddings keyed by node index
  const nodeEmbedJsons: (string | null)[] = await Promise.all(
    nodes.map(async (node) => {
      const content = node['content'] as string | undefined;
      const name = (node['name'] as string | undefined) ?? null;
      const text = [content, name].filter(Boolean).join(' ');
      if (!text) return null;
      try {
        return vecToJson(await embed(text));
      } catch {
        return null;
      }
    }),
  );

  const tx = db.transaction(() => {
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

      const existing = db
        .prepare(`SELECT rowid, uid FROM node WHERE content_hash = ?`)
        .get(contentHash) as { rowid: number; uid: string } | undefined;
      if (existing) {
        uidMap.set(origId, existing.uid);
        continue;
      }

      const row = db
        .prepare(
          `INSERT INTO node (uid, kind, content, name, summary, agent_id, source, importance, content_hash, t_created, t_valid)
           VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)
           RETURNING rowid`,
        )
        .get(uid, kind, content, name, summary, agentId, importance, contentHash, now, now) as
        | { rowid: number }
        | undefined;

      if (row) {
        const vecJson = nodeEmbedJsons[nodeIdx] ?? null;
        try {
          db.prepare(
            'INSERT OR IGNORE INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
          ).run(row.rowid, vecJson);
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
      const srcRow = db
        .prepare(`SELECT rowid FROM node WHERE uid = ?`)
        .get(srcUid) as { rowid: number } | undefined;
      const dstRow = db
        .prepare(`SELECT rowid FROM node WHERE uid = ?`)
        .get(dstUid) as { rowid: number } | undefined;
      if (!srcRow || !dstRow) continue;
      const rel = _mapGraphifyRel(edge['rel'] as string | undefined);
      if (!rel) continue;
      try {
        db.prepare(
          `INSERT OR IGNORE INTO edge (src, dst, rel, weight, confidence, origin, t_created)
           VALUES (?, ?, ?, ?, ?, 'user_asserted', ?)`,
        ).run(
          srcRow.rowid,
          dstRow.rowid,
          rel,
          (edge['weight'] as number | undefined) ?? 1.0,
          (edge['confidence'] as number | null | undefined) ?? null,
          now,
        );
        importedEdges++;
      } catch {
        /* skip */
      }
    }
  });

  tx();
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
 * LLM community summary lives ONLY in memory-organizer (R3).
 * This function builds the structure; organizer fills in summary.
 */
export function buildCommunities(
  db: Database.Database,
  options?: BuildCommunitiesOptions,
): BuildCommunitiesResult {
  const maxIterations = options?.maxIterations ?? 20;
  const minSize = options?.minCommunitySize ?? 2;

  const nodes = db
    .prepare(
      `SELECT rowid, uid FROM node WHERE t_invalid IS NULL AND kind IN ('entity','episode','claim')`,
    )
    .all() as Array<{ rowid: number; uid: string }>;

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

  const edges = db
    .prepare(
      `SELECT n1.uid AS src_uid, n2.uid AS dst_uid
       FROM edge e
       JOIN node n1 ON n1.rowid = e.src
       JOIN node n2 ON n2.rowid = e.dst
       WHERE e.t_expired IS NULL
         AND n1.t_invalid IS NULL AND n2.t_invalid IS NULL
         AND n1.kind IN ('entity','episode','claim')
         AND n2.kind IN ('entity','episode','claim')`,
    )
    .all() as Array<{ src_uid: string; dst_uid: string }>;

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
  db.transaction(() => {
    db.prepare(
      `UPDATE node SET t_invalid = ? WHERE kind = 'community' AND level = 0 AND t_invalid IS NULL`,
    ).run(now);
  })();

  let commCreated = 0;
  let memberCount = 0;

  db.transaction(() => {
    for (const [label, memberUids] of validCommunities) {
      const commUid = `community-${label.substring(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const memberNames = memberUids.slice(0, 3).map((uid) => {
        const n = db
          .prepare(`SELECT name, content FROM node WHERE uid = ?`)
          .get(uid) as { name: string | null; content: string | null } | undefined;
        return n?.name ?? (n?.content ?? '').substring(0, 30) ?? uid.substring(0, 8);
      });
      const communityName = `Community: ${memberNames.filter(Boolean).join(', ')}`;

      // Insert community node (summary filled by organizer LLM — R3)
      const commRow = db
        .prepare(
          `INSERT INTO node (uid, kind, name, level, t_created, t_valid)
           VALUES (?, 'community', ?, 0, ?, ?)
           RETURNING rowid`,
        )
        .get(commUid, communityName, now, now) as { rowid: number } | undefined;

      if (!commRow) continue;
      commCreated++;

      for (const memberUid of memberUids) {
        const memberRowid = uidToRowid.get(memberUid);
        if (!memberRowid) continue;
        try {
          db.prepare(
            `INSERT OR IGNORE INTO edge (src, dst, rel, origin, t_created)
             VALUES (?, ?, 'MEMBER_OF', 'extracted', ?)`,
          ).run(memberRowid, commRow.rowid, now);
          memberCount++;
        } catch {
          /* skip */
        }
      }
    }
  })();

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
export function memoryGetCommunity(
  db: Database.Database,
  entity_uid: string,
  level?: number,
): GetCommunitySuccess | GetCommunityError {
  const targetLevel = level ?? 0;

  const node = db
    .prepare(`SELECT rowid, uid, name, content, kind FROM node WHERE uid = ? AND t_invalid IS NULL`)
    .get(entity_uid) as
    | { rowid: number; uid: string; name: string | null; content: string | null; kind: string }
    | undefined;

  if (!node) {
    return { code: 'E_NOT_FOUND', message: `Node not found: ${entity_uid}` };
  }

  const communityRow = db
    .prepare(
      `SELECT n_comm.uid, n_comm.name, n_comm.summary, n_comm.level
       FROM edge e
       JOIN node n_comm ON n_comm.rowid = e.dst
       WHERE e.src = ? AND e.rel = 'MEMBER_OF'
         AND n_comm.kind = 'community'
         AND n_comm.level = ?
         AND e.t_expired IS NULL
         AND n_comm.t_invalid IS NULL
       LIMIT 1`,
    )
    .get(node.rowid, targetLevel) as
    | { uid: string; name: string | null; summary: string | null; level: number }
    | undefined;

  if (!communityRow) {
    return {
      code: 'E_NOT_FOUND',
      message: `No community at level ${targetLevel} for node: ${entity_uid}`,
    };
  }

  const commNode = db
    .prepare(`SELECT rowid FROM node WHERE uid = ?`)
    .get(communityRow.uid) as { rowid: number } | undefined;

  const members = commNode
    ? (db
        .prepare(
          `SELECT n.uid, n.name, n.content, n.kind
           FROM edge e
           JOIN node n ON n.rowid = e.src
           WHERE e.dst = ? AND e.rel = 'MEMBER_OF'
             AND e.t_expired IS NULL AND n.t_invalid IS NULL`,
        )
        .all(commNode.rowid) as Array<{
        uid: string;
        name: string | null;
        content: string | null;
        kind: string;
      }>)
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
}

/**
 * memory_search_entities — tool 3 (design.md §2.3).
 * Hybrid FTS + LIKE search for entity nodes. Zero LLM calls (R1).
 */
export function memorySearchEntities(
  db: Database.Database,
  params: SearchEntitiesParams,
): SearchEntitiesResult {
  const { query, limit = 10 } = params;

  if (!query?.trim()) return { entities: [] };

  const ftsQuery = query
    .replace(/['"*\-()\[\]]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .join(' ');

  let entities: Array<{
    uid: string;
    name: string | null;
    content: string | null;
    summary: string | null;
    kind: string;
    importance: number;
  }> = [];

  if (ftsQuery) {
    try {
      const ftsRows = db
        .prepare(
          `SELECT n.uid, n.name, n.content, n.summary, n.kind, n.importance
           FROM fts_node f
           JOIN node n ON n.rowid = f.rowid
           WHERE fts_node MATCH ? AND n.t_invalid IS NULL AND n.kind = 'entity'
           ORDER BY f.rank LIMIT ?`,
        )
        .all(ftsQuery, limit) as typeof entities;
      entities.push(...ftsRows);
    } catch {
      /* fall through */
    }
  }

  if (entities.length === 0) {
    try {
      const nameRows = db
        .prepare(
          `SELECT uid, name, content, summary, kind, importance
           FROM node WHERE t_invalid IS NULL AND kind = 'entity'
             AND (name LIKE ? OR content LIKE ?)
           ORDER BY importance DESC LIMIT ?`,
        )
        .all(`%${query}%`, `%${query}%`, limit) as typeof entities;
      entities.push(...nameRows);
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
  };
}
