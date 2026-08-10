/**
 * debt-soxgraph-001.spec.ts — DEBT-SOXGRAPH-001 regression (P5).
 *
 * Before this change, memory-core's FTS arms (recall.ts, extensions.ts)
 * hand-assembled per-backend FTS SQL above store-adapter: matchClause /
 * scoreClause / supportsShadowTable branches, `n.`-alias stripping
 * (`validityPred.replace(/\bn\./g, '')`), raw `fts_node MATCH ?` /
 * `fts_match(...)` / `fts_score(...)` usage. The weave's hard requirement is
 * NO custom SQL above store-adapter; the A2 API (`adapter.ftsSearch`) now
 * owns all of it.
 *
 * This spec proves the delegation is RESULT-IDENTICAL to the pre-delegation
 * hand-assembled SQL — same rowids AND same order — for a multi-term query on
 * BOTH the real sqlite and real turso backends. The pre-delegation reference
 * is embedded below verbatim (the old arms' exact SQL shape, via
 * createFTSDialect + normalizeFtsTokens + buildMatchQuery), so a future
 * change that re-introduces hand-assembled SQL — or breaks the delegation
 * (e.g. a wrong column list drops the summary/name-only matches, or a wrong
 * where/params set) — turns this spec red.
 *
 * RED→GREEN (BL-225): with the delegation deliberately broken — recall.ts or
 * extensions.ts passing `['content', 'name']` instead of the full
 * `['content', 'name', 'summary']` column list — the summary-only seeded rows
 * stop matching and `post !== pre` (plus the end-to-end
 * memorySearchEntities assertion loses the summary-only entity). Restored,
 * both pass.
 *
 * Gate: npx nx test memory-core --skip-nx-cache -- debt-soxgraph-001
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb, closeAllAdapters } from './db.js';
import { memorySearchEntities } from './extensions.js';

// ── Turso availability — resolved SYNCHRONOUSLY at module load (see
// fts-query-parity.spec.ts's file header for why this must not be an async
// beforeAll + `{ skip }` pattern).
const TURSO_DRIVER_PATH = path.resolve(
  __dirname,
  '../../../node_modules/@tursodatabase/database/dist/promise.js',
);
const HAS_TURSO = (() => {
  try {
    return fsSync.existsSync(TURSO_DRIVER_PATH);
  } catch {
    return false;
  }
})();

const BACKENDS = ['sqlite', 'turso'] as const;
const FTS_COLUMNS = ['content', 'name', 'summary'] as const;

/** The pre-delegation FTS arm SQL — the verbatim shape of the old
 *  recall.ts / extensions.ts arms (dialect match/score clauses, shadow-table
 *  join on SQLite, `n.`-alias stripping on the non-shadow Turso branch,
 *  `ORDER BY rank` ascending). Returns rowids in result order. */
async function preDelegationRowids(
  adapter: StoreAdapter,
  query: string,
  where: string,
  params: unknown[],
  limit: number,
): Promise<number[]> {
  const { createFTSDialect, normalizeFtsTokens } = await import('@adhd/sox-store-adapter');
  const dial = createFTSDialect(adapter.config.type);
  const { sql: matchSql } = dial.matchClause([...FTS_COLUMNS], '?');
  const scoreExpr = dial.scoreClause([...FTS_COLUMNS], '?');
  const q = dial.buildMatchQuery(normalizeFtsTokens(query));
  if (dial.supportsShadowTable) {
    const res = await adapter.executeAll<{ rowid: number }>(
      `SELECT fts_node.rowid, ${scoreExpr} AS rank
       FROM fts_node
       JOIN node n ON n.rowid = fts_node.rowid
       WHERE ${matchSql} AND ${where}
       ORDER BY rank LIMIT ?`,
      [q, ...params, limit],
    );
    return res.rows.map((r) => r.rowid);
  }
  const res = await adapter.executeAll<{ rowid: number }>(
    `SELECT rowid, ${scoreExpr} AS rank
     FROM node
     WHERE ${matchSql} AND ${where.replace(/\bn\./g, '')}
     ORDER BY rank LIMIT ?`,
    [q, q, ...params, limit],
  );
  return res.rows.map((r) => r.rowid);
}

/** The delegated path — the exact `adapter.ftsSearch` call recall.ts and
 *  extensions.ts now make. */
async function delegatedRowids(
  adapter: StoreAdapter,
  query: string,
  where: string,
  params: unknown[],
  limit: number,
): Promise<number[]> {
  const rows = await adapter.ftsSearch<{ rowid: number }>(
    'node',
    ['content', 'name', 'summary'],
    query,
    { limit, where, params },
  );
  return rows.map((r) => r.rowid);
}

describe('DEBT-SOXGRAPH-001 — FTS arm delegates to store-adapter ftsSearch, result-identical to the pre-delegation SQL', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  const seedNode = async (
    adapter: StoreAdapter,
    row: { uid: string; kind: string; content?: string | null; name?: string | null; summary?: string | null },
  ): Promise<void> => {
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, name, content, summary, content_hash, importance, t_created, t_valid)
       VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
      [row.uid, row.kind, row.name ?? null, row.content ?? null, row.summary ?? null, `hash-${row.uid}`],
    );
  };

  for (const backend of BACKENDS) {
    const itB = backend === 'turso' ? (HAS_TURSO ? it : it.skip) : it;

    itB(`recall-arm shape: delegated ftsSearch == pre-delegation SQL — same rowids/order, multi-term (${backend})`, async () => {
      dir = fsSync.mkdtempSync(path.join(os.tmpdir(), `d-sg-001-recall-${backend}-`));
      const dbPath = path.join(dir, 'm.db');
      process.env['STORE_ADAPTER'] = backend;
      const adapter = await openDb(dbPath);
      expect(adapter.config.type).toBe(backend);

      // The multi-term query is 'alpha charlie' (tokens: alpha, charlie).
      //   e1 → 'alpha' via CONTENT only
      //   e2 → 'charlie' via NAME only (content does not carry it)
      //   e3 → BOTH via SUMMARY only (content/name deliberately unrelated)
      //   e4 → neither token anywhere (negative control)
      //   e5 → both tokens, but kind 'entity' — the where must exclude it
      await seedNode(adapter, { uid: 'e1', kind: 'episode', content: 'alpha bravo delta', name: 'thing one' });
      await seedNode(adapter, { uid: 'e2', kind: 'episode', content: 'foxtrot golf hotel', name: 'charlie echo' });
      await seedNode(adapter, { uid: 'e3', kind: 'episode', content: 'unrelated zzz words', summary: 'alpha charlie' });
      await seedNode(adapter, { uid: 'e4', kind: 'episode', content: 'hiking and camping in the mountains' });
      await seedNode(adapter, { uid: 'e5', kind: 'entity', content: 'alpha charlie sneaky' });

      // The recall arm's delegated where: validityPred + kindClause (default
      // kinds = ['episode']), n.-prefixed exactly as recall.ts builds them.
      const where = `n.t_invalid IS NULL AND n.kind IN (?)`;
      const params: unknown[] = ['episode'];
      const limit = 20; // DEFAULT_FTS_LIMIT, no filters active

      const pre = await preDelegationRowids(adapter, 'alpha charlie', where, params, limit);
      const post = await delegatedRowids(adapter, 'alpha charlie', where, params, limit);

      // The delegation returns IDENTICAL rowids in IDENTICAL order.
      expect(post).toEqual(pre);
      // e1 (content), e2 (name), e3 (summary) must all match — this is what
      // breaks when a delegation drops a column ('summary' or 'name') from
      // the FTS column list. e5 must NOT appear (the where bound param).
      expect(new Set(pre).size).toBe(3);
      for (const uid of ['e1', 'e2', 'e3']) {
        const rowid = (await adapter.executeGet<{ rowid: number }>(`SELECT rowid FROM node WHERE uid = ?`, [uid]))?.rowid;
        expect(pre).toContain(rowid);
      }
      expect(pre).not.toContain((await adapter.executeGet<{ rowid: number }>(`SELECT rowid FROM node WHERE uid = ?`, ['e4']))?.rowid);
    }, 60_000);

    itB(`entity-arm shape: delegated ftsSearch == pre-delegation SQL, and memorySearchEntities end-to-end (${backend})`, async () => {
      dir = fsSync.mkdtempSync(path.join(os.tmpdir(), `d-sg-001-entity-${backend}-`));
      const dbPath = path.join(dir, 'm.db');
      process.env['STORE_ADAPTER'] = backend;
      const adapter = await openDb(dbPath);
      expect(adapter.config.type).toBe(backend);

      //   en1 → 'alpha' via CONTENT
      //   en2 → 'charlie' via NAME only
      //   en3 → BOTH via SUMMARY only
      //   en4 → no tokens (negative control)
      //   ep1 → both tokens, kind 'episode' — must be excluded by the where
      await seedNode(adapter, { uid: 'en1', kind: 'entity', content: 'alpha bravo', name: 'thing one' });
      await seedNode(adapter, { uid: 'en2', kind: 'entity', content: 'nonsense zzz', name: 'charlie delta' });
      await seedNode(adapter, { uid: 'en3', kind: 'entity', content: 'nonsense zzz', name: 'thing three', summary: 'alpha charlie' });
      await seedNode(adapter, { uid: 'en4', kind: 'entity', content: 'camping gear review' });
      await seedNode(adapter, { uid: 'ep1', kind: 'episode', content: 'alpha charlie episode' });

      // The entity arm's delegated where — unqualified, exactly as
      // extensions.ts passes it. The pre reference uses the old arm's
      // n.-prefixed equivalent (stripped on the non-shadow branch).
      const where = `t_invalid IS NULL AND kind = 'entity'`;
      const pre = await preDelegationRowids(adapter, 'alpha charlie', `n.${where}`, [], 10);
      const post = await delegatedRowids(adapter, 'alpha charlie', where, [], 10);

      expect(post).toEqual(pre);
      expect(new Set(pre).size).toBe(3);
      expect(pre).not.toContain((await adapter.executeGet<{ rowid: number }>(`SELECT rowid FROM node WHERE uid = ?`, ['ep1']))?.rowid);

      // End-to-end through the production path (extensions.ts): all three
      // entities, real FTS mode, and the episode excluded.
      const result = await memorySearchEntities(adapter, { query: 'alpha charlie', limit: 10 });
      expect(result.search_mode).toBe('fts');
      expect(result.entities.map((e) => e.uid).sort()).toEqual(['en1', 'en2', 'en3']);
    }, 60_000);
  }
});
