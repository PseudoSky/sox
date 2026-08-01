/**
 * bl384-search-entities-fts-dialect.spec.ts — BL-384 regression.
 *
 * `memorySearchEntities` issued raw SQLite FTS5 shadow-table SQL directly:
 *
 *     SELECT n.uid, ... FROM fts_node f JOIN node n ON n.rowid = f.rowid
 *      WHERE fts_node MATCH ? AND n.t_invalid IS NULL AND n.kind = 'entity'
 *      ORDER BY f.rank LIMIT ?
 *
 * `fts_node` is the SQLite FTS5 shadow table. `openDb()` DROPS it on the
 * Turso branch (residue cleanup, BL-347) — Turso's Tantivy FTS index lives
 * directly on `node`, with no `fts_node` table at all. The statement above
 * therefore always throws on Turso. The bare `catch {}` around it swallowed
 * that and fell through to a `name LIKE ? OR content LIKE ?` substring scan
 * ordered by `importance DESC` — worse relevance, and a false-positive-prone
 * substring match instead of a tokenized full-text match — with no signal
 * anywhere that the degrade had happened.
 *
 * The differentiator used below is real-FTS-vs-LIKE tokenization, not
 * ranking-score direction (which is dialect-internal and not something this
 * spec should assert on): FTS5/Tantivy MATCH is token-based — a query for
 * "gizmo" does NOT match a document containing only the compound word
 * "widgetgizmoid" (a different token). A `LIKE '%gizmo%'` substring scan DOES
 * match it. So a decoy entity containing the query term only embedded inside
 * a longer word is a hit under the (buggy) LIKE fallback and correctly
 * excluded under real FTS — a genuinely different, worse result set, not
 * merely a different field on an otherwise-identical response.
 *
 * RED (fix reverted — restore the raw `fts_node`/`MATCH` statement in
 * extensions.ts, dropping the `ftsDialectFor` routing):
 *   - `finds only the tokenized match, not the substring decoy (turso)` FAILS:
 *     the raw statement throws (`no such table: fts_node`), is swallowed, and
 *     the LIKE fallback returns BOTH the target and the decoy.
 *   - `reports search_mode: 'fts'` FAILS on turso: `search_mode` degrades to
 *     `'like'` because the FTS branch never runs to completion.
 * GREEN (as shipped): both backends match by real FTS, excluding the decoy,
 *   and report `search_mode: 'fts'`.
 *
 * Gate: npx nx test memory-core --skip-nx-cache -- bl384-search-entities
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, closeAllAdapters } from './db.js';
import { memorySearchEntities } from './extensions.js';
import { log as tlog } from './telemetry.js';

const BACKENDS = ['sqlite', 'turso'] as const;

describe('BL-384 — memory_search_entities goes through the FTSDialect on both backends', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
    vi.restoreAllMocks();
  });

  const seedEntity = async (
    adapter: Awaited<ReturnType<typeof openDb>>,
    uid: string,
    name: string,
    content: string,
    importance: number,
  ): Promise<void> => {
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, name, content, content_hash, importance, t_created, t_valid)
       VALUES (?, 'entity', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [uid, name, content, `hash-${uid}`, importance],
    );
  };

  for (const backend of BACKENDS) {
    it(`finds only the tokenized match, not the substring decoy, and reports search_mode: 'fts' (${backend})`, async () => {
      dir = fsSync.mkdtempSync(path.join(os.tmpdir(), `bl384-${backend}-`));
      const dbPath = path.join(dir, 'm.db');
      process.env['STORE_ADAPTER'] = backend;

      const adapter = await openDb(dbPath);
      expect(adapter.config.type).toBe(backend);

      // TARGET: name does not contain the query term; content does, as a
      // standalone token — a real full-text match. Low importance so a
      // LIKE-fallback (ordered by importance DESC) would NOT explain it
      // landing first.
      await seedEntity(
        adapter,
        'bl384-target',
        'Calibration Tool',
        'Uses a special gizmo for calibration.',
        1,
      );

      // DECOY: contains the query term only embedded inside a longer,
      // different token ("widgetgizmoid") — NOT a real FTS token match, but
      // a LIKE '%gizmo%' substring scan matches it. High importance, so the
      // old importance-ranked LIKE fallback would surface it (incorrectly,
      // ahead of the real match).
      await seedEntity(
        adapter,
        'bl384-decoy',
        'Legacy Systems Overview',
        'Explains widgetgizmoid behavior in legacy systems.',
        9,
      );

      const result = await memorySearchEntities(adapter, { query: 'gizmo', limit: 10 });

      const uids = result.entities.map((e) => e.uid).sort();
      expect(uids).toEqual(['bl384-target']);
      expect(result.search_mode).toBe('fts');
    }, 60_000);
  }

  it('the old raw fts_node/MATCH statement is rejected by Turso — this is the defect', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bl384-vec0-'));
    const dbPath = path.join(dir, 'm.db');
    process.env['STORE_ADAPTER'] = 'turso';
    const adapter = await openDb(dbPath);

    // Verbatim the pre-fix SQL from extensions.ts. If a future change makes
    // this succeed on Turso, the dialect indirection can be revisited —
    // until then this is exactly why the feature silently degraded.
    await expect(
      adapter.executeAll(
        `SELECT n.uid, n.name, n.content, n.summary, n.kind, n.importance
         FROM fts_node f
         JOIN node n ON n.rowid = f.rowid
         WHERE fts_node MATCH ? AND n.t_invalid IS NULL AND n.kind = 'entity'
         ORDER BY f.rank LIMIT ?`,
        ['gizmo', 10],
      ),
    ).rejects.toThrow();
  }, 60_000);

  it('a genuine FTS query failure is logged, not silently swallowed', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bl384-logfail-'));
    const dbPath = path.join(dir, 'm.db');
    process.env['STORE_ADAPTER'] = 'sqlite';
    const adapter = await openDb(dbPath);
    await seedEntity(adapter, 'bl384-logfail', 'Whatever Thing', 'contains gizmo somewhere', 1);

    const warnSpy = vi.spyOn(tlog, 'warn').mockImplementation(() => {});

    // Force the FTS branch itself to fail (not "unsupported", a genuine
    // runtime error) by making executeAll reject only for the FTS-shaped
    // query, while leaving the subsequent LIKE fallback query untouched.
    const realExecuteAll = adapter.executeAll.bind(adapter);
    const spy = vi
      .spyOn(adapter, 'executeAll')
      .mockImplementation(async (sql: string, args?: unknown[]) => {
        if (sql.includes('fts_node') || sql.includes('fts_match')) {
          throw new Error('bl384-injected FTS failure');
        }
        return realExecuteAll(sql, args as never);
      });

    const result = await memorySearchEntities(adapter, { query: 'gizmo', limit: 10 });

    // The fallback still returns a result (degraded, not broken)...
    expect(result.entities.map((e) => e.uid)).toEqual(['bl384-logfail']);
    expect(result.search_mode).toBe('like');
    // ...but the genuine failure was reported, not swallowed.
    expect(warnSpy).toHaveBeenCalledWith(
      'search_entities.fts.error',
      expect.objectContaining({ error: expect.stringContaining('bl384-injected FTS failure') }),
    );

    spy.mockRestore();
  }, 60_000);
});
