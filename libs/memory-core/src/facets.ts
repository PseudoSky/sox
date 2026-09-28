/**
 * facets.ts — D-C primitive (b): the open, orthogonal facet vocabulary.
 *
 * ## Why this exists
 *
 * A closed vocabulary (a frozen enum, or the researcher agent's hardcoded
 * Tools/Patterns/Use-Cases buckets) forces every new kind of finding to either
 * be miscategorised or to require a schema/code change. This is the residual-
 * category failure mode: a catch-all bucket silently corrupts as it shrinks.
 *
 * ## The model (SKOS + schema.org 'pending' + OBO Foundry)
 *
 * Terms are minted UNPROMOTED and promoted by a governed demand gate. A term is
 * NEVER redefined in place — a semantic change mints a NEW term id (K-I5). The
 * registry lives on existing `generic`-kind nodes at `meta.facet_term` (no new
 * node kind, so ADR-0010 D3 does not apply to this layer) and is queryable
 * through the SR-3 `meta.*` predicate.
 *
 * ## K-I5 — term stability (the one non-negotiable)
 *
 * `definitionHash` is immutable once minted. Admitting an EXISTING id with a
 * DIFFERENT definition throws `E_TERM_REDEFINED`; the same definition under a
 * NEW id succeeds. This is what keeps meaning from drifting under a stable name.
 *
 * [inv:no-mcp] — returns/throws plain results, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { hexSha256 } from '@adhd/sox-ingest/core';
import { getMemoryGraphBackend } from './graph-backend.js';
import { resolveKnowledgeConfig, type KnowledgeConfigOverrides } from './config.js';

export type FacetTermStatus = 'unpromoted' | 'promoted';

export interface FacetDemand {
  /** Live claims filed under this term. */
  count: number;
  /** Distinct claims (identical to `count` today; kept for the gate's semantics). */
  distinctClaims: number;
}

export interface FacetTerm {
  id: string;
  facet: string;
  term: string;
  definition: string;
  definitionHash: string;
  status: FacetTermStatus;
  origin: string;
  demand: FacetDemand;
  created_at: string;
  promoted_at?: string;
}

export type FacetErrorCode =
  | 'E_TERM_REDEFINED'
  | 'E_TERM_NOT_FOUND'
  | 'E_INVALID';

export class FacetError extends Error {
  public readonly code: FacetErrorCode;
  /**
   * StorageError-shaped (CONTRACTS §B): `wrapDbError` passes an error through
   * verbatim only when it already carries `code: 'E_…'` AND a boolean
   * `retryable`. Without this field the WriteQueue would re-wrap a thrown
   * FacetError as a generic `E_IO`, losing the typed code the caller branches
   * on. A facet governance refusal is not retryable.
   */
  public readonly retryable = false;
  constructor(code: FacetErrorCode, message: string) {
    super(message);
    this.name = 'FacetError';
    this.code = code;
  }
}

const REGISTRY_TOPIC = 'facet-registry';

/** A stable, URL-safe id fragment for a term. Not identity by itself — the id is `facet:slug`. */
function slug(term: string): string {
  return term
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function facetTermId(facet: string, term: string): string {
  return `${facet.trim()}:${slug(term)}`;
}

interface RegistryRow {
  uid: string;
  name: string | null;
  meta: string | null;
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed — treat as empty */
  }
  return {};
}

function readTerm(row: RegistryRow, demand: FacetDemand): FacetTerm | null {
  const raw = parseMeta(row.meta)['facet_term'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  const id = t['id'];
  const termLabel = t['term'];
  if (typeof id !== 'string' || typeof termLabel !== 'string') return null;
  const status: FacetTermStatus = t['status'] === 'promoted' ? 'promoted' : 'unpromoted';
  const term: FacetTerm = {
    id,
    facet: typeof t['facet'] === 'string' ? t['facet'] : '',
    term: termLabel,
    definition: typeof t['definition'] === 'string' ? t['definition'] : '',
    definitionHash: typeof t['definitionHash'] === 'string' ? t['definitionHash'] : '',
    status,
    origin: typeof t['origin'] === 'string' ? t['origin'] : '',
    demand,
    created_at: typeof t['created_at'] === 'string' ? t['created_at'] : '',
  };
  if (typeof t['promoted_at'] === 'string') term.promoted_at = t['promoted_at'];
  return term;
}

/** Count the distinct live claims filed under a term id (`meta.facet`). */
async function computeDemand(adapter: StoreAdapter, termId: string): Promise<FacetDemand> {
  const row = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(DISTINCT uid) AS cnt FROM node
      WHERE kind = 'claim' AND t_invalid IS NULL
        AND json_valid(meta) AND json_extract(meta, '$.facet') = ?`,
    [termId],
  );
  const n = row?.cnt ?? 0;
  return { count: n, distinctClaims: n };
}

async function findByTermId(
  adapter: StoreAdapter,
  termId: string,
): Promise<{ row: RegistryRow; term: FacetTerm } | null> {
  const row = await adapter.executeGet<RegistryRow>(
    `SELECT uid, name, meta FROM node
      WHERE kind = 'generic' AND topic = ? AND t_invalid IS NULL
        AND json_valid(meta) AND json_extract(meta, '$.facet_term.id') = ?
      LIMIT 1`,
    [REGISTRY_TOPIC, termId],
  );
  if (!row) return null;
  const demand = await computeDemand(adapter, termId);
  const term = readTerm(row, demand);
  if (!term) return null;
  return { row, term };
}

/**
 * Admit a facet term. A NEW id is minted `unpromoted`. Admitting an EXISTING id
 * with the same definition is idempotent; with a DIFFERENT definition it throws
 * `E_TERM_REDEFINED` (K-I5) — mint a new term id for a new meaning.
 */
export async function memoryFacetAdmit(
  adapter: StoreAdapter,
  p: { facet: string; term: string; definition: string; origin: string },
): Promise<FacetTerm> {
  const facet = typeof p.facet === 'string' ? p.facet.trim() : '';
  const term = typeof p.term === 'string' ? p.term.trim() : '';
  const definition = typeof p.definition === 'string' ? p.definition.trim() : '';
  const origin = typeof p.origin === 'string' ? p.origin.trim() : '';
  if (!facet || !term || !definition) {
    throw new FacetError('E_INVALID', 'facet, term and definition are required');
  }
  const id = facetTermId(facet, term);
  const definitionHash = hexSha256(definition);

  const existing = await findByTermId(adapter, id);
  if (existing) {
    if (existing.term.definitionHash !== definitionHash) {
      throw new FacetError(
        'E_TERM_REDEFINED',
        `Facet term "${id}" already exists with a different definition. ` +
          `Terms are never redefined in place (K-I5) — mint a NEW term id for the new meaning.`,
      );
    }
    return existing.term;
  }

  const backend = getMemoryGraphBackend(adapter);
  const createdAt = new Date().toISOString();
  await backend.writeNode(
    term,
    {
      kind: 'generic',
      name: term,
      topic: REGISTRY_TOPIC,
      source: 'observation',
      metadata: {
        facet_term: {
          id,
          facet,
          term,
          definition,
          definitionHash,
          status: 'unpromoted',
          origin,
          created_at: createdAt,
        },
      },
    },
    { skipDedupe: true },
  );

  return {
    id,
    facet,
    term,
    definition,
    definitionHash,
    status: 'unpromoted',
    origin,
    demand: { count: 0, distinctClaims: 0 },
    created_at: createdAt,
  };
}

/**
 * Promotion gate (schema.org 'pending' + OBO Foundry): promote an unpromoted
 * term once it is demanded by at least `minDistinctClaims` DISTINCT live claims
 * AND carries a non-empty origin tag. Idempotent — promoting an already-promoted
 * term returns it unchanged.
 *
 * Returns the term with its CURRENT status and demand; a term that does not meet
 * the gate is returned still `unpromoted` (the caller can read demand vs
 * threshold), not thrown — demand accrues over time.
 */
export async function memoryFacetPromote(
  adapter: StoreAdapter,
  p: { term_id: string; overrides?: KnowledgeConfigOverrides },
): Promise<FacetTerm> {
  const termId = typeof p.term_id === 'string' ? p.term_id.trim() : '';
  if (!termId) throw new FacetError('E_INVALID', 'term_id is required');

  const found = await findByTermId(adapter, termId);
  if (!found) throw new FacetError('E_TERM_NOT_FOUND', `No facet term with id: ${termId}`);

  const { row, term } = found;
  if (term.status === 'promoted') return term;

  const minDistinct = resolveKnowledgeConfig(p.overrides).facetPromotion.minDistinctClaims;
  const demand = await computeDemand(adapter, termId);
  const promoted = demand.distinctClaims >= minDistinct && term.origin.length > 0;

  if (!promoted) {
    return { ...term, demand };
  }

  const promotedAt = new Date().toISOString();
  const meta = parseMeta(row.meta);
  const current = meta['facet_term'] as Record<string, unknown>;
  const nextTerm = { ...current, status: 'promoted', promoted_at: promotedAt };
  // Idempotent single-row update guarded by the term id (ADR-0012: correctness
  // comes from the guarded predicate, not a lock — a concurrent promote simply
  // writes the same value).
  await adapter.executeRun(
    `UPDATE node SET meta = ?, t_updated = ?
      WHERE uid = ? AND t_invalid IS NULL
        AND json_valid(meta) AND json_extract(meta, '$.facet_term.id') = ?
        AND json_extract(meta, '$.facet_term.status') = 'unpromoted'`,
    [JSON.stringify({ ...meta, facet_term: nextTerm }), promotedAt, row.uid, termId],
  );

  const after = await findByTermId(adapter, termId);
  return after?.term ?? { ...term, status: 'promoted', demand, promoted_at: promotedAt };
}

/**
 * List facet terms — the readable catalog (AC2). Optionally narrowed to one
 * facet. Pure read.
 */
export async function memoryFacetList(
  adapter: StoreAdapter,
  p: { facet?: string } = {},
): Promise<FacetTerm[]> {
  const facet = typeof p.facet === 'string' && p.facet.length > 0 ? p.facet : undefined;
  const rows = (
    await adapter.executeAll<RegistryRow>(
      facet === undefined
        ? `SELECT uid, name, meta FROM node
            WHERE kind = 'generic' AND topic = ? AND t_invalid IS NULL
              AND json_valid(meta) AND json_extract(meta, '$.facet_term.id') IS NOT NULL
            ORDER BY json_extract(meta, '$.facet_term.id') ASC`
        : `SELECT uid, name, meta FROM node
            WHERE kind = 'generic' AND topic = ? AND t_invalid IS NULL
              AND json_valid(meta) AND json_extract(meta, '$.facet_term.facet') = ?
            ORDER BY json_extract(meta, '$.facet_term.id') ASC`,
      facet === undefined ? [REGISTRY_TOPIC] : [REGISTRY_TOPIC, facet],
    )
  ).rows;

  const terms: FacetTerm[] = [];
  for (const row of rows) {
    const id = (parseMeta(row.meta)['facet_term'] as Record<string, unknown> | undefined)?.['id'];
    const demand =
      typeof id === 'string'
        ? await computeDemand(adapter, id)
        : { count: 0, distinctClaims: 0 };
    const term = readTerm(row, demand);
    if (term) terms.push(term);
  }
  return terms;
}
