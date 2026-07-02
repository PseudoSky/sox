/**
 * Shared utilities for the MCP-agnostic memory tool client.
 *
 * These helpers bridge between index.ts (the MCP server) and the individual
 * tool backing functions. They operate on raw Database handles and return
 * plain objects — no MCP ToolResult wrapping, no policy enforcement.
 *
 * [inv:no-mcp] — never imports from @adhd/sox-mcp-runtime.
 */

import Database from 'better-sqlite3';
import { openDb } from '@adhd/sox-memory-core';
import * as os from 'node:os';

// ── DB connection cache (singleton map keyed by resolved path) ────────────────

const dbCache = new Map<string, Database.Database>();

/**
 * Return a cached Database handle for the given `dbPath`, or open a new
 * connection and cache it.
 *
 * The caller is responsible for resolving tilde/relative paths before
 * calling (e.g. via `expandTilde` + `path.resolve`).
 */
export function getDb(dbPath: string): Database.Database {

  const cached = dbCache.get(dbPath);
  if (cached) return cached;
  const db = openDb(dbPath);
  dbCache.set(dbPath, db);
  return db;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Expand a leading ~/ to the user's home directory.
 * If `p` is exactly `~`, returns the home directory.
 * Otherwise returns `p` unchanged.
 */
export function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return os.homedir() + p.slice(1);
  }
  return p;
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

/**
 * Parse a JSON tags column value. Returns [] if null, undefined, or malformed.
 */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    /* malformed */
  }
  return [];
}

// ── Enrichment helper queries ─────────────────────────────────────────────────

/**
 * Check whether an episode is superseded (i.e. some other episode's SUPERSEDES
 * edge points to it via rowid).
 */
export function isSuperseded(db: Database.Database, rowid: number): boolean {
  const row = db
    .prepare<[number], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM edge WHERE dst = ? AND rel = 'SUPERSEDES' AND t_expired IS NULL`,
    )
    .get(rowid);
  return (row?.cnt ?? 0) > 0;
}

/**
 * Return the UID of the episode that `rowid` supersedes (outbound SUPERSEDES
 * edge from src=rowid to dst). Returns null if no such edge exists.
 */
export function supersedesUidForRowid(
  db: Database.Database,
  rowid: number,
): string | null {
  const row = db
    .prepare<[number], { uid: string }>(
      `SELECT n.uid FROM edge e
       JOIN node n ON n.rowid = e.dst AND n.t_invalid IS NULL
       WHERE e.src = ? AND e.rel = 'SUPERSEDES' AND e.t_expired IS NULL
       LIMIT 1`,
    )
    .get(rowid);
  return row?.uid ?? null;
}

/**
 * Resolve the GLOBAL MEMBER_OF community uid for an episode rowid.
 *
 * Defaults to `cluster_scope.kind='global'` (treating legacy NULL scope as
 * global) so that persisted subset lenses never leak into recall's
 * `community_uid` field.
 */
export function communityUidForRowid(
  db: Database.Database,
  rowid: number,
): string | null {
  const row = db
    .prepare<[number], { uid: string }>(
      `SELECT n2.uid FROM edge e
       JOIN node n2 ON n2.rowid = e.dst AND n2.kind = 'community' AND n2.t_invalid IS NULL
         AND (json_extract(n2.meta, '$.cluster_scope.kind') IS NULL
              OR json_extract(n2.meta, '$.cluster_scope.kind') = 'global')
       WHERE e.src = ? AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
       ORDER BY e.rowid ASC
       LIMIT 1`,
    )
    .get(rowid);
  return row?.uid ?? null;
}

/**
 * Resolve episode rowids → uids, preserving the input order.
 */
export function rowidsToUids(
  db: Database.Database,
  rowids: number[],
): string[] {
  if (rowids.length === 0) return [];
  const ph = rowids.map(() => '?').join(',');
  const rows = db
    .prepare<unknown[], { rowid: number; uid: string }>(
      `SELECT rowid, uid FROM node WHERE rowid IN (${ph})`,
    )
    .all(...rowids);
  const byRowid = new Map(rows.map((r) => [r.rowid, r.uid]));
  return rowids
    .map((r) => byRowid.get(r))
    .filter((u): u is string => typeof u === 'string');
}
