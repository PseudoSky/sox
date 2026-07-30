/**
 * turso-recall-listing.spec.ts — BUG A regression test.
 *
 * THE BUG (team-lead report): `handleToolCall` unconditionally did
 * `const rawDb = (adapter as any).unwrap() as Database.Database;` at the top
 * of every tool call, then several branches — most critically the no-query
 * `memory_recall` importance-ranked LISTING branch (`rawDb.prepare(...).all()`
 * at the old index.ts:1358) — called the SYNCHRONOUS better-sqlite3
 * `.prepare().all()`/`.get()` API on whatever `unwrap()` returned. On the
 * live server (`adapter_type=turso`), `unwrap()` returns the
 * `@tursodatabase/database` handle, whose query methods are ASYNC (return
 * Promises, not arrays/rows). `rows` therefore bound to an unawaited Promise,
 * and `for (const r of rows)` threw `TypeError: rows is not iterable` before
 * any SQL ran — reproduced live via `memory_recall({limit:3})`.
 *
 * THE FIX: every `rawDb.prepare(...)` call site in `index.ts` now goes
 * through the async `StoreAdapter` surface (`adapter.executeGet` /
 * `adapter.executeAll` / `adapter.executeRun`), which is correct for both
 * `SqliteAdapter` (sync under the hood, wrapped async) and `TursoAdapter`
 * (natively async).
 *
 * THIS TEST exercises the exact failing path — the no-query `memory_recall`
 * listing branch — against a REAL Turso-backed adapter (STORE_ADAPTER=turso,
 * local file mode via `@tursodatabase/database`; skipped automatically if the
 * optional native dependency is not installed). Both directions were verified
 * BY HAND (the standard pattern this repo uses for a single behavioral
 * revert/restore — see e.g. bdca8fd's commit message): the fix was
 * temporarily reverted to the raw-unwrap()-based implementation, this test
 * was run and observed to fail with the exact "rows is not iterable"
 * TypeError, then the fix was restored and the test observed to pass. See
 * the PR/commit description for both console outputs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleToolCall } from './index.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();

const tursoDescribe = hasTurso ? describe : describe.skip;

const cleanups: Array<() => void> = [];

function tmpStorePath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bug-a-turso-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

function parseResult(resp: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(resp.content[0]?.text ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  // Force the REAL TursoAdapter for every openDb/getDb call in this file —
  // this is the exact adapter type the live server runs
  // (adapter_type=turso) where the raw-unwrap() bug manifested. Set before
  // every test since vitest's fork pool may not carry a mutation made by a
  // different spec file's process.
  process.env['STORE_ADAPTER'] = 'turso';
  // SOX_SYNC_EMBED=1 is the suite-wide pin (vitest.setup.ts) — keep it so
  // Phase-B embedding is synchronous and this test isn't also exercising the
  // async embed pipeline; BUG A is orthogonal to that.
  process.env['SOX_SYNC_EMBED'] = '1';
});

afterEach(() => {
  process.env['STORE_ADAPTER'] = 'sqlite'; // restore the suite-wide pin
  for (const c of cleanups.splice(0)) c();
});

tursoDescribe('BUG A — memory_recall no-query listing against a Turso-backed adapter', () => {
  it('lists episodes without throwing "rows is not iterable" (the live-reproduced Turso failure)', async () => {
    const dbPath = tmpStorePath();

    const w1 = parseResult(await handleToolCall('memory_write', {
      db_path: dbPath,
      content: 'BUG A regression: first episode for the Turso no-query listing.',
      project_path: '/test/project',
      importance: 7,
    }));
    expect(typeof w1['episode_uid']).toBe('string');

    const w2 = parseResult(await handleToolCall('memory_write', {
      db_path: dbPath,
      content: 'BUG A regression: second episode, higher importance, for ordering.',
      project_path: '/test/project',
      importance: 9,
    }));
    expect(typeof w2['episode_uid']).toBe('string');

    // The exact call from the live incident report: no `query`, small limit —
    // routes into the importance-ranked listing branch (index.ts, no-query
    // fallback inside case 'memory_recall'), which is where the raw
    // rawDb.prepare().all() lived. Pre-fix, this call throws synchronously
    // inside handleToolCall (uncaught TypeError: rows is not iterable) rather
    // than resolving with a ToolResult at all.
    const resp = await handleToolCall('memory_recall', { db_path: dbPath, limit: 3 });
    expect(resp.isError).not.toBe(true);

    const out = parseResult(resp);
    expect(Array.isArray(out['results'])).toBe(true);
    const results = out['results'] as Array<{ uid: string; importance: number; content: string | null }>;
    expect(results.length).toBe(2);
    // Importance-ranked DESC ordering (n.importance DESC, n.t_created DESC) —
    // proves the query actually executed and returned real, ordered rows,
    // not just "didn't throw".
    expect(results[0]!.importance).toBe(9);
    expect(results[1]!.importance).toBe(7);
    expect(typeof out['provider_call_count']).toBe('number');
  });

  it('memory_get_community (another raw-unwrap() call site) resolves against Turso without a sync/async mismatch', async () => {
    const dbPath = tmpStorePath();
    // No community exists yet — this just proves the query path itself
    // (adapter.executeGet against a Turso adapter) completes and returns the
    // documented E_NOT_FOUND, rather than throwing a sync/async TypeError.
    const resp = await handleToolCall('memory_get_community', {
      db_path: dbPath,
      entity_uid: 'nonexistent-entity-uid',
    });
    expect(resp.isError).toBe(true);
    const out = parseResult(resp);
    expect(out['code']).toBe('E_NOT_FOUND');
  });
});
