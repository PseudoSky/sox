/**
 * filters.ts — structured filter type + SQL clause builder for episode subsets.
 *
 * Owned by memory-core so that `clusterSubset` is self-contained and
 * callable without any server-private code. `memory-server` imports and reuses
 * both the type and the builder instead of maintaining its own copy.
 *
 * The filter vocabulary is shared between `memory_recall` and `clusterSubset`
 * — same predicate builder, same structured type, stronger DRY than sharing a
 * raw SQL fragment across a package boundary.
 */

/**
 * SR-3 / D-C: a predicate against a `meta.*` value. `path` is a dotted path
 * into the node's metadata (e.g. `case.outcome.result`); `in` matches any of a
 * value set, `eq` a single value. Applied store-side (never a client-side join).
 */
export interface MetadataPredicate {
  path: string;
  in?: unknown[];
  eq?: unknown;
}

/**
 * Structured filter for episode subsets. All fields are optional and additive
 * (AND-combined). Mirrors the `filters` object accepted by `memory_recall`.
 */
export interface MemoryFilter {
  /**
   * Exact project_path match, or prefix object `{ prefix: string }` which
   * matches the path itself or any sub-path.
   */
  project_path?: string | { prefix: string };
  /** Episode topic — single value or array (IN-match). */
  topic?: string | string[];
  /**
   * Concept tags — any-match by default; all-match when `tags_match_all:true`.
   * Must be a string array. A bare string is coerced to `[string]`.
   */
  tags?: string | string[];
  /**
   * When true, ALL supplied tags must be present (AND). Default false = ANY.
   */
  tags_match_all?: boolean;
  /** Minimum importance score (inclusive). */
  importance_min?: number;
  /** Only episodes created AFTER this ISO timestamp. */
  t_created_after?: string;
  /** Only episodes created BEFORE this ISO timestamp. */
  t_created_before?: string;
  /** SR-3: a `meta.*` predicate (store-side). */
  metadata?: MetadataPredicate;
}

/**
 * Build the SQL fragment + params for an SR-3 metadata predicate against node
 * alias `alias`. Returns `null` when no usable predicate is supplied. The JSON
 * path is passed as a BOUND param (sqlite `json_extract(X, P)` accepts one), so
 * there is no injection surface; `path` is additionally charset-validated so a
 * malformed path fails closed (returns null) rather than producing broken SQL.
 */
export function buildMetadataPredicate(
  metadata: MetadataPredicate | undefined,
  alias = 'n',
): { sql: string; params: unknown[] } | null {
  if (!metadata || typeof metadata.path !== 'string' || metadata.path.length === 0) return null;
  if (!/^[A-Za-z0-9_.]+$/.test(metadata.path)) return null;
  const jsonPath = `$.${metadata.path}`;
  const valid = `${alias}.meta IS NOT NULL AND json_valid(${alias}.meta)`;
  const extract = `json_extract(${alias}.meta, ?)`;

  if (Array.isArray(metadata.in)) {
    if (metadata.in.length === 0) return null; // an empty IN resolves to nothing
    const ph = metadata.in.map(() => '?').join(', ');
    return { sql: `(${valid} AND ${extract} IN (${ph}))`, params: [jsonPath, ...metadata.in] };
  }
  if ('eq' in metadata) {
    return { sql: `(${valid} AND ${extract} = ?)`, params: [jsonPath, metadata.eq] };
  }
  return null;
}

/**
 * Build the WHERE clause fragment and params array for a `MemoryFilter`.
 *
 * The returned `sql` is an AND-prefixed fragment (or empty string) referencing
 * node alias `n`. Append it to a query that already has a WHERE clause:
 *
 *   `SELECT … FROM node n WHERE n.kind = 'episode'${clause.sql}`
 *
 * All caller-supplied values are pushed to `params` as SQLite bind values —
 * none are interpolated, so there is no SQL injection surface.
 */
export function buildFiltersClause(
  filters: MemoryFilter | Record<string, unknown> | undefined,
): { sql: string; params: unknown[] } {
  if (!filters) return { sql: '', params: [] };

  const parts: string[] = [];
  const params: unknown[] = [];

  // project_path filter — exact string or { prefix: string }
  const pp = (filters as Record<string, unknown>)['project_path'];
  if (pp !== undefined && pp !== null) {
    if (typeof pp === 'string') {
      parts.push('n.project_path = ?');
      params.push(pp);
    } else if (typeof pp === 'object' && 'prefix' in (pp as object)) {
      const prefix = (pp as { prefix: string }).prefix;
      parts.push('(n.project_path = ? OR n.project_path LIKE ?)');
      params.push(prefix, `${prefix}/%`);
    }
  }

  // topic filter — single string or string[]
  const topicFilter = (filters as Record<string, unknown>)['topic'];
  if (topicFilter !== undefined && topicFilter !== null) {
    if (typeof topicFilter === 'string') {
      parts.push('n.topic = ?');
      params.push(topicFilter);
    } else if (Array.isArray(topicFilter) && topicFilter.length > 0) {
      const placeholders = topicFilter.map(() => '?').join(', ');
      parts.push(`n.topic IN (${placeholders})`);
      params.push(...topicFilter);
    }
  }

  // tags filter — any-match (default) or all-match
  // Guard: coerce a bare string to [string]; reject non-array non-string (ignore silently).
  let rawTags = (filters as Record<string, unknown>)['tags'];
  if (typeof rawTags === 'string') rawTags = [rawTags]; // coerce bare string
  const tagsFilter: string[] | undefined =
    Array.isArray(rawTags) && rawTags.every((t) => typeof t === 'string')
      ? (rawTags as string[])
      : undefined;

  const tagsMatchAll = (filters as Record<string, unknown>)['tags_match_all'] === true;
  if (tagsFilter && tagsFilter.length > 0) {
    if (tagsMatchAll) {
      // ALL tags must be present
      const tagClauses = tagsFilter.map(
        () => `EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)`,
      );
      parts.push(`(${tagClauses.join(' AND ')})`);
      params.push(...tagsFilter);
    } else {
      // ANY tag must be present
      const tagClauses = tagsFilter.map(
        () => `EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)`,
      );
      parts.push(`(${tagClauses.join(' OR ')})`);
      params.push(...tagsFilter);
    }
  }

  // importance_min
  const impMin = (filters as Record<string, unknown>)['importance_min'];
  if (typeof impMin === 'number') {
    parts.push('n.importance >= ?');
    params.push(impMin);
  }

  // t_created_after
  const tAfter = (filters as Record<string, unknown>)['t_created_after'];
  if (typeof tAfter === 'string') {
    parts.push('n.t_created > ?');
    params.push(tAfter);
  }

  // t_created_before
  const tBefore = (filters as Record<string, unknown>)['t_created_before'];
  if (typeof tBefore === 'string') {
    parts.push('n.t_created < ?');
    params.push(tBefore);
  }

  // SR-3: meta.* predicate (store-side)
  const metaPred = buildMetadataPredicate(
    (filters as Record<string, unknown>)['metadata'] as MetadataPredicate | undefined,
    'n',
  );
  if (metaPred) {
    parts.push(metaPred.sql);
    params.push(...metaPred.params);
  }

  const sql = parts.length > 0 ? ' AND ' + parts.join(' AND ') : '';
  return { sql, params };
}
