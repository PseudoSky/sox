/**
 * dc-knowledge-host.spec.ts — the D-C knowledge layer driven through the REAL
 * MCP tool surface, as a consumer uses it (a host loads these tools and calls
 * them). Proves the tool wiring, the request/response shape, and the derived
 * verdict end-to-end — not the library internals (those are proven in
 * memory-core's dc-knowledge.spec.ts).
 *
 * Default-running (no env gate). Embedding-free: the claim/outcome/facet ops do
 * not touch the embed pipeline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeCachedAdapter, getDb } from '@adhd/sox-memory-core';
import { handleToolCall } from './index.js';

const cleanups: Array<() => void> = [];
function tmpStorePath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-host-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

function parseResult(resp: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(resp.content[0]?.text ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  cleanups.length = 0;
});

afterEach(async () => {
  for (const c of cleanups) c();
  cleanups.length = 0;
});

describe('D-C — knowledge layer through the real MCP tools', () => {
  it('claim_assert → outcome_append ×2 → memory_back reports the derived tier', async () => {
    const dbPath = tmpStorePath();
    await getDb(dbPath);

    const asserted = parseResult(
      (await handleToolCall('memory_claim_assert', {
        db_path: dbPath,
        text: 'the sky is blue',
        facet: 'observation:colour',
        project_path: '/test/dc',
        expectation: { expected_outcome: 'blue', confidence: 'low' },
        asserted_by: 'alice',
      })) as { content: Array<{ text?: string }> },
    );
    expect(asserted['ok']).toBe(true);
    const uid = asserted['uid'] as string;
    expect(typeof uid).toBe('string');

    for (const [by, indep] of [['alice', 'self'], ['bob', 'independent']] as const) {
      const o = parseResult(
        (await handleToolCall('memory_outcome_append', {
          db_path: dbPath,
          claim_uid: uid,
          observed_result: 'blue',
          observed_by: by,
          method: 'observe',
          independence: indep,
        })) as { content: Array<{ text?: string }> },
      );
      expect(o['ok']).toBe(true);
    }

    const back = parseResult(
      (await handleToolCall('memory_back', { db_path: dbPath, uid })) as {
        content: Array<{ text?: string }>;
      },
    );
    expect(back['ok']).toBe(true);
    expect((back['verdict'] as { tier: string }).tier).toBe('independently-reproduced');
    expect((back['outcomes'] as unknown[]).length).toBe(2);

    await closeCachedAdapter(dbPath);
  });

  it('facet_admit → facet_list catalog → promotion gate → E_TERM_REDEFINED on redefine', async () => {
    const dbPath = tmpStorePath();
    await getDb(dbPath);

    const admit = parseResult(
      (await handleToolCall('memory_facet_admit', {
        db_path: dbPath,
        facet: 'technique',
        term: 'bisection',
        definition: 'halve the interval',
        origin: 'researcher',
      })) as { content: Array<{ text?: string }> },
    );
    expect(admit['id']).toBe('technique:bisection');
    expect(admit['status']).toBe('unpromoted');

    const list = parseResult(
      (await handleToolCall('memory_facet_list', { db_path: dbPath, facet: 'technique' })) as {
        content: Array<{ text?: string }>;
      },
    );
    expect(Array.isArray(list)).toBe(true);
    expect((list as unknown as Array<{ id: string }>).some((t) => t.id === 'technique:bisection')).toBe(true);

    // A different definition under the SAME id is refused.
    const refused = parseResult(
      (await handleToolCall('memory_facet_admit', {
        db_path: dbPath,
        facet: 'technique',
        term: 'bisection',
        definition: 'something else entirely',
        origin: 'researcher',
      })) as { content: Array<{ text?: string }> },
    );
    expect(refused['code']).toBe('E_TERM_REDEFINED');

    await closeCachedAdapter(dbPath);
  });

  it('memory_back on an unknown uid is a typed E_NOT_FOUND (never a fabricated record)', async () => {
    const dbPath = tmpStorePath();
    await getDb(dbPath);
    const resp = parseResult(
      (await handleToolCall('memory_back', { db_path: dbPath, uid: 'no-such-claim' })) as {
        content: Array<{ text?: string }>;
      },
    );
    expect(resp['code']).toBe('E_NOT_FOUND');
    await closeCachedAdapter(dbPath);
  });
});
