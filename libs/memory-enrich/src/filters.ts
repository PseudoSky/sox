/**
 * filters.ts — structured filter type + SQL clause builder for episode subsets.
 *
 * Owned by @adhd/sox-memory-enrich so that `clusterSubset` is self-contained and
 * callable without any server-private code. `memory-server` imports and reuses
 * both the type and the builder instead of maintaining its own copy.
 *
 * The filter vocabulary is shared between `memory_recall` and `clusterSubset`
 * — same predicate builder, same structured type, stronger DRY than sharing a
 * raw SQL fragment across a package boundary.
 */

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

  const sql = parts.length > 0 ? ' AND ' + parts.join(' AND ') : '';
  return { sql, params };
}
