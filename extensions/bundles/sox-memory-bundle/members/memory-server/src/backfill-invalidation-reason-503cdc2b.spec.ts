/**
 * backfill-invalidation-reason-503cdc2b.spec.ts (memory-server) — backlog
 * 503cdc2b, the MCP surface.
 *
 * The op's behavior is covered in memory-core's spec of the same name. This
 * suite proves the wiring an operator actually uses:
 *   - `backfill_invalidation_reason` is in the `memory_curate` schema enum;
 *   - `memory_curate` with the op and NO dry_run is a dry run (count + sample
 *     uids, store unchanged);
 *   - an apply reaches the REAL `backupStore` with this store's db path — the
 *     dispatcher threads `dbPath` into the op. The fixture store lives in a
 *     tmpdir, outside the `~/.memory/**` backup allowlist, so the real backup
 *     refuses with E_ALLOWLIST and the op aborts with zero mutation. Without
 *     the threaded dbPath the op would instead return E_BACKUP_UNAVAILABLE.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDb, closeAllAdapters, WriteQueue } from '@adhd/sox-memory-core';
import { handleToolCall, TOOLS } from './index.js';

const cleanups: Array<() => void> = [];

afterEach(async () => {
  await closeAllAdapters();
  WriteQueue.clearInstances();
  for (const c of cleanups.splice(0)) c();
});

function tmpDbPath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-503cdc2b-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

function parse(resp: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(resp.content[0]?.text ?? '{}') as Record<string, unknown>;
}

const T_LEGACY = '2026-05-01T00:00:00.000Z';

async function seedLegacyInvalidated(dbPath: string): Promise<void> {
  const adapter = await getDb(dbPath);
  await adapter.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid, t_invalid)
     VALUES (?, 'episode', ?, ?, ?, ?, ?)`,
    ['legacy-503', 'legacy invalidated episode', 'hash-503', T_LEGACY, T_LEGACY, T_LEGACY],
  );
}

async function rowOf(dbPath: string): Promise<{ t_invalid: string | null; meta: string | null }> {
  const adapter = await getDb(dbPath);
  const row = await adapter.executeGet<{ t_invalid: string | null; meta: string | null }>(
    `SELECT t_invalid, meta FROM node WHERE uid = 'legacy-503'`,
  );
  if (!row) throw new Error('fixture row missing');
  return row;
}

describe('503cdc2b memory_curate backfill_invalidation_reason — MCP surface', () => {
  it('the op is declared in the memory_curate schema enum', () => {
    const tool = TOOLS.find((t) => t.name === 'memory_curate');
    const props = (tool?.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props['op']?.enum).toContain('backfill_invalidation_reason');
  });

  it('an omitted dry_run is a dry run: count + sample uids, store unchanged', async () => {
    const dbPath = tmpDbPath();
    await handleToolCall('memory_ping', { db_path: dbPath });
    await seedLegacyInvalidated(dbPath);
    const before = await rowOf(dbPath);

    const resp = await handleToolCall('memory_curate', { db_path: dbPath, op: 'backfill_invalidation_reason' });
    expect(resp.isError).not.toBe(true);
    const res = parse(resp);
    expect(res['op']).toBe('backfill_invalidation_reason');
    expect(res['dry_run']).toBe(true);
    expect(res['candidates']).toBe(1);
    expect(res['sample_uids']).toEqual(['legacy-503']);
    expect(await rowOf(dbPath)).toEqual(before);
  });

  it('apply reaches the real backupStore with this store\'s dbPath and aborts on its refusal, zero mutation', async () => {
    const dbPath = tmpDbPath();
    await handleToolCall('memory_ping', { db_path: dbPath });
    await seedLegacyInvalidated(dbPath);
    const before = await rowOf(dbPath);

    const resp = await handleToolCall('memory_curate', {
      db_path: dbPath,
      op: 'backfill_invalidation_reason',
      dry_run: false,
    });
    expect(resp.isError).toBe(true);
    const res = parse(resp);
    expect(res['code']).toBe('E_BACKUP_FAILED');
    expect(String(res['message'])).toContain('E_ALLOWLIST');
    expect(await rowOf(dbPath)).toEqual(before);
  });
});
