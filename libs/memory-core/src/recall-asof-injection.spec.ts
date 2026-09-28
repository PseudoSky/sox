/**
 * recall-asof-injection.spec.ts — H1 (SECURITY): `memory_recall.as_of` is a
 * public MCP tool parameter (forwarded from the memory-server bundle) and MUST
 * be bound as a SQL parameter, never interpolated into the query string.
 *
 * Pre-fix, `recall.ts` embedded `as_of` raw into the bi-temporal validity
 * predicate:
 *   `(n.t_valid IS NULL OR n.t_valid <= '${as_of}') AND …`
 * A crafted value containing a single quote breaks out of the string literal;
 * here the payload closes the literal and appends `OR '1'='1'`, making the
 * predicate ALWAYS TRUE, so a tombstoned (superseded) node — invisible to a
 * legitimate window — is admitted. That is a data-exfiltration primitive, not a
 * cosmetic bug. The SAME parameter is already handled correctly one function
 * away in the bundle server (`memory-server/src/index.ts`, BL-240) by binding
 * `?`; this spec proves recall.ts follows the identical pattern.
 *
 * The test drives the REAL `memoryRecall` on a real store. It asserts the
 * malicious value is treated as a literal: the result set and the SR-3 match
 * count are IDENTICAL to a legitimate `as_of`, and no channel SQL is corrupted.
 *
 * RED→GREEN: pre-fix the malicious call counts/includes the tombstoned node
 * (the second assertion `count === 1` goes RED); post-fix it is a bound literal
 * and the count is 1.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryRecall } from './recall.js';
import { _setEmbedProviderForTest, _shutdownEmbedWorker } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

const LEGIT_AS_OF = '2021-01-01T00:00:00.000Z';
/**
 * A malicious `as_of`: a single-quote breakout that closes the interpolated
 * literal early and appends `OR '1'='1'` (always-true) plus a UNION-style
 * token. Concatenated into the template `'${as_of}'` it forms syntactically
 * valid, always-true SQL — a real injection. Post-fix the whole string is a
 * bound literal and entirely inert.
 */
const MALICIOUS_AS_OF = `x' OR '1'='1' OR 'UNION SELECT'='x`;

let dir: string;
let dbPath: string;
let db: StoreAdapter;
let priorAdapterEnv: string | undefined;

beforeEach(async () => {
  priorAdapterEnv = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = 'sqlite';
  _setEmbedProviderForTest(new DeterministicTestProvider());
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asof-injection-'));
  dbPath = path.join(dir, 'store.db');
  db = await openDb(dbPath);
});

afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = priorAdapterEnv;
});

afterAll(async () => {
  await _shutdownEmbedWorker();
});

/**
 * Seed one episode via a raw INSERT so `t_valid`/`t_invalid` can be set
 * directly (the graph backend's writeNode always stamps a live row). The FTS
 * index is synced by the node-table triggers on both backends.
 */
async function seedEpisode(
  uid: string,
  content: string,
  tValid: string | null,
  tInvalid: string | null,
): Promise<void> {
  await db.executeRun(
    `INSERT INTO node (uid, kind, name, content, summary, content_hash, importance,
       project_path, t_created, t_valid, t_invalid)
     VALUES (?, 'episode', ?, ?, NULL, ?, 1, '/p', datetime('now'), ?, ?)`,
    [uid, `seed-${uid}`, content, `hash-${uid}`, tValid, tInvalid],
  );
}

describe('H1 — memory_recall.as_of is bound, never interpolated (SQL injection)', () => {
  it('treats a malicious as_of as a literal: same rows and match count as a legitimate window', async () => {
    // One live record and one tombstoned record, both matching the query text.
    await seedEpisode('live1', 'widget alpha assembly notes for the LIVE record', '2020-01-01T00:00:00.000Z', null);
    await seedEpisode('dead1', 'widget alpha assembly notes for the TOMBSTONED record', '2020-01-01T00:00:00.000Z', '2020-06-01T00:00:00.000Z');

    // A legitimate 2021 window: live1 is valid, dead1 (invalidated 2020-06) is not.
    const legit = await memoryRecall(db, 'project', {
      query: 'widget alpha',
      as_of: LEGIT_AS_OF,
      limit: 10,
      depth: 0,
    });
    expect(legit.results.map((r) => r.uid)).toContain('live1');
    expect(legit.results.map((r) => r.uid)).not.toContain('dead1');
    expect(legit.count!.value).toBe(1);

    // The malicious window must behave IDENTICALLY — the payload is a literal.
    const evil = await memoryRecall(db, 'project', {
      query: 'widget alpha',
      as_of: MALICIOUS_AS_OF,
      limit: 10,
      depth: 0,
    });
    // Pre-fix: `OR '1'='1'` makes the validity predicate always-true, so the
    // tombstoned node is admitted — count becomes 2 and dead1 leaks in.
    expect(evil.count!.value).toBe(1);
    expect(evil.results.map((r) => r.uid)).toContain('live1');
    expect(evil.results.map((r) => r.uid)).not.toContain('dead1');

    // The payload must not have corrupted any channel's SQL.
    expect((evil.degradations ?? []).filter((d) => d.startsWith('fts:') || d.startsWith('vec:'))).toEqual([]);
  });
});
