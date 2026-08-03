/**
 * bl399-autolink-scope-meta-swallow.spec.ts — regression test for BL-399 / BL-383.
 *
 * THE BUG (both items, one root cause): `buildAutoLinks()` tried to persist an
 * entity stoplist to a `memory_scope.meta` column that has never existed in any
 * schema (libs/memory-core/src/schema.ts declares `memory_scope` with exactly
 * six columns — scope, scope_id, embed_model, embed_dim, schema_ver,
 * created_at — no `meta`). The write failed on EVERY call, at
 * autolink.ts:58-67 (pre-fix), and was swallowed by a bare `catch {}`.
 *
 * Live production impact (BL-399): 154-162 occurrences/day of
 * `store.error: "prepare failed: Parse error: no such column: meta"` —
 * 14% of every memory-core log event on a representative day — all silently
 * discarded, on a store whose integrity surface reported `overall: ok`.
 *
 * `entity_stoplist` (the value being persisted) has zero readers anywhere in
 * the repo — grep-confirmed. The stoplist is recomputed from scratch on every
 * pass regardless of whether the persist succeeds. So the correct fix is not
 * a migration adding the column back — nothing legitimately needs it — it is
 * deleting the dead write entirely (BL-383's fix sketch #1).
 *
 * THIS TEST proves the fix red -> green using the REAL production adapter
 * (openDb, not a hand-rolled fixture) so the schema actually matches
 * libs/memory-core/src/schema.ts:
 *
 *   RED (pre-fix):  buildAutoLinks() against a fresh, real store produces at
 *                    least one `store.error` telemetry record whose `sql`
 *                    references `memory_scope` and whose `error` is
 *                    "no such column: meta" — the exact live production
 *                    signature — even though buildAutoLinks() itself does not
 *                    throw (the bare catch swallows it).
 *
 *   GREEN (post-fix): zero `store.error` records are emitted by
 *                    buildAutoLinks() at all, and no executeGet/executeAll/
 *                    executeRun call it issues ever references
 *                    `memory_scope` — the dead code path is gone, not just
 *                    silently re-caught differently.
 *
 * Gate: npx nx test memory-core --skip-nx-cache
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openDb } from './db.js';
import { buildAutoLinks } from './autolink.js';
import { memoryWritePhaseA } from './write.js';
import type { PhaseAOutcome } from './write.js';
import { applyEmbedding } from './embed-pipeline.js';
import { vectorDialectFor } from './dialect.js';
import { _setEmbedProviderForTest, embed } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import {
  currentLogFilePath,
  _resetTelemetryForTest,
  _flushTelemetryForTest,
} from './telemetry.js';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

function readLines(filePath: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function tmpLogDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl399-autolink-log-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

interface TestContext {
  dbDir: string;
  logDir: string;
  adapter: StoreAdapter;
  cleanup: () => void;
}

async function tmpDb(): Promise<TestContext> {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl399-autolink-db-'));
  const { dir: logDir, cleanup: logCleanup } = tmpLogDir();
  const dbPath = path.join(dbDir, 'm.db');
  const adapter = await openDb(dbPath);
  return {
    dbDir,
    logDir,
    adapter,
    cleanup: () => {
      fs.rmSync(dbDir, { recursive: true, force: true });
      logCleanup();
    },
  };
}

let ctx: TestContext;

/** Force SqliteAdapter — matches the sibling autolink/enrich specs' pattern
 *  (memory-core's own vector-dialect resolver is pinned to sqlite here). */
function forceSqliteAdapter(): void {
  process.env.STORE_ADAPTER = 'sqlite';
}

beforeEach(async () => {
  forceSqliteAdapter();
  ctx = await tmpDb();
  process.env['SOX_MEMORY_LOG_DIR'] = ctx.logDir;
  process.env['SOX_MEMORY_LOG_COMPONENT'] = 'bl399-autolink-test';
  delete process.env['SOX_MEMORY_LOG_DISABLE'];
  delete process.env['SOX_MEMORY_LOG_LEVEL'];
  _resetTelemetryForTest();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  await _flushTelemetryForTest();
  _resetTelemetryForTest();
  delete process.env['SOX_MEMORY_LOG_DIR'];
  delete process.env['SOX_MEMORY_LOG_COMPONENT'];
  ctx.cleanup();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

/** Insert >=2 episodes carrying a shared entity mention so buildAutoLinks()
 *  actually walks the `totalEpisodes >= 2` branch that used to contain the
 *  dead memory_scope.meta write (autolink.ts:40-67 pre-fix). */
async function seedTwoLinkedEpisodes(adapter: StoreAdapter): Promise<void> {
  for (const [uid, content] of [
    ['bl399-ep-1', 'bl399 regression: distinctive zeppelin narwhal content one'],
    ['bl399-ep-2', 'bl399 regression: distinctive zeppelin narwhal content two'],
  ] as const) {
    const r = await memoryWritePhaseA(adapter, { content, project_path: '/test/project' });
    expect('code' in r).toBe(false);
    const pending = (r as PhaseAOutcome).pending!;
    const vec = await embed(pending.text);
    const vectorDialect = await vectorDialectFor(adapter);
    await adapter.transaction((tx) =>
      applyEmbedding(tx, pending, vec, adapter.capabilities.nativeVectors, vectorDialect),
    );
    // Give both episodes a shared MENTIONS edge to a common entity node so
    // the entity-frequency query (autolink.ts:41-48) returns a row and the
    // `totalEpisodes >= 2` branch — which used to reach the dead
    // memory_scope.meta write — actually executes.
    const entRow = await adapter.executeGet<{ rowid: number }>(
      `SELECT rowid FROM node WHERE uid = 'bl399-shared-entity' AND kind = 'entity'`,
    );
    let entRowid = entRow?.rowid;
    if (!entRowid) {
      const now = new Date().toISOString();
      const ins = await adapter.executeGet<{ rowid: number }>(
        `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'entity', ?, ?, ?) RETURNING rowid`,
        ['bl399-shared-entity', 'shared entity', now, now],
      );
      entRowid = ins!.rowid;
    }
    const epRow = await adapter.executeGet<{ rowid: number }>(
      `SELECT rowid FROM node WHERE uid = ?`,
      [pending.uid],
    );
    const now = new Date().toISOString();
    await adapter.executeRun(
      `INSERT INTO edge (src, dst, rel, t_created) VALUES (?, ?, 'MENTIONS', ?)`,
      [epRow!.rowid, entRowid, now],
    );
  }
}

describe('buildAutoLinks — BL-399/BL-383: memory_scope.meta is no longer queried or swallowed', () => {
  it('GREEN: emits zero store.error records and never touches memory_scope', async () => {
    await seedTwoLinkedEpisodes(ctx.adapter);

    // Must not throw — buildAutoLinks never threw even pre-fix (the bug was
    // a SILENT swallow, not a crash); the fix must not change that contract.
    const result = await buildAutoLinks(ctx.adapter);
    expect(result).toBeDefined();

    await _flushTelemetryForTest();
    const lines = readLines(currentLogFilePath());
    const storeErrors = lines.filter((l) => l['event'] === 'store.error');

    // THE FIX: pre-fix this array contains at least one record with
    // sql containing "memory_scope" and error "no such column: meta" —
    // the exact live production signature (154-162/day). Post-fix it is
    // empty because the query no longer exists.
    const scopeMetaErrors = storeErrors.filter(
      (l) =>
        typeof l['sql'] === 'string' &&
        (l['sql'] as string).includes('memory_scope') &&
        typeof l['error'] === 'string' &&
        (l['error'] as string).includes('no such column: meta'),
    );
    expect(scopeMetaErrors).toHaveLength(0);
    expect(storeErrors).toHaveLength(0);
  });

  it('GREEN: never issues a memory_scope SQL statement at all', async () => {
    await seedTwoLinkedEpisodes(ctx.adapter);

    const calls: string[] = [];
    const spiedAdapter = new Proxy(ctx.adapter, {
      get(target, prop, receiver): unknown {
        if (prop === 'executeGet' || prop === 'executeAll' || prop === 'executeRun') {
          const orig = Reflect.get(target, prop, target) as (...a: unknown[]) => unknown;
          return (sql: string, ...rest: unknown[]) => {
            calls.push(sql);
            return orig.apply(target, [sql, ...rest]);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await buildAutoLinks(spiedAdapter);

    const scopeCalls = calls.filter((sql) => sql.includes('memory_scope'));
    expect(scopeCalls).toEqual([]);
  });
});
