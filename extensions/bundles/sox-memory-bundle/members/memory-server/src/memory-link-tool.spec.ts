/**
 * memory-link-tool.spec.ts — regression coverage for BL-249.
 *
 * `memoryLinkNode` (libs/memory-core/src/link.ts) is an `export async function`
 * returning `Promise<LinkResult>`. The `memory_link` MCP handler in index.ts
 * previously called it WITHOUT awaiting inside the WriteQueue task:
 *
 *   return wq.enqueue('memory_link', (writeDb) => {
 *     const result = memoryLinkNode(writeDb, args);   // Promise<LinkResult>, not LinkResult
 *     if (result.isError) { ... }                     // always undefined — dead branch
 *     return { content: [{ type: 'text', text: JSON.stringify(result) }] };
 *   });
 *
 * Two observable bugs followed:
 *   1. `JSON.stringify(result)` serializes a Promise object, which stringifies
 *      to `"{}"` — every successful memory_link call returned an EMPTY payload
 *      instead of `{ edge_uid: "..." }`.
 *   2. The `result.isError` check was permanently dead (a Promise object never
 *      has an `.isError` property), so a bad `src_uid`/`dst_uid` never surfaced
 *      as `isError: true` — the caller got a false-success `{}` instead of an
 *      error.
 *   3. The write itself was NOT awaited before the WriteQueue task's slot
 *      returned — a floating promise outside the queue's serial-ordering
 *      guarantee (a later queued task could observe a not-yet-committed edge
 *      insert race, or the process could exit before the insert lands).
 *
 * This file proves the fix: `memory_link` must return the REAL edge payload on
 * success, and `isError: true` on a bad uid — not `{}` either way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteQueue } from '@adhd/sox-memory-core';
import { handleToolCall } from './index.js';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-memory-link-tool-'));
const DB_PATH = path.join(TEST_DIR, 'test.db');

function parseResult(resp: { content: Array<{ text?: string }>; isError?: boolean }): {
  body: Record<string, unknown>;
  isError: boolean | undefined;
} {
  return {
    body: JSON.parse(resp.content[0]?.text ?? '{}') as Record<string, unknown>,
    isError: resp.isError,
  };
}

let srcUid: string;
let dstUid: string;

beforeAll(async () => {
  const a = parseResult(
    await handleToolCall('memory_write', {
      db_path: DB_PATH,
      content: 'BL-249 regression fixture: source episode.',
    }),
  );
  const b = parseResult(
    await handleToolCall('memory_write', {
      db_path: DB_PATH,
      content: 'BL-249 regression fixture: destination episode.',
    }),
  );
  srcUid = a.body['episode_uid'] as string;
  dstUid = b.body['episode_uid'] as string;
  expect(srcUid).toBeTruthy();
  expect(dstUid).toBeTruthy();
});

afterAll(() => {
  WriteQueue.clearInstances();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('memory_link (BL-249 — missing await)', () => {
  it('(a) a successful link returns the REAL edge payload, not an empty {}', async () => {
    const resp = await handleToolCall('memory_link', {
      db_path: DB_PATH,
      src_uid: srcUid,
      dst_uid: dstUid,
      rel: 'RELATES_TO',
    });
    const { body, isError } = parseResult(resp);

    expect(isError).toBeUndefined();
    // The pre-fix bug serialized a Promise object → JSON.stringify(result) === "{}".
    // A real LinkResult has `edge_uid` (a non-empty string) and nothing else missing.
    expect(body).not.toEqual({});
    expect(typeof body['edge_uid']).toBe('string');
    expect((body['edge_uid'] as string).length).toBeGreaterThan(0);
  });

  it('(b) a bad uid surfaces isError: true (not a false-success {})', async () => {
    const resp = await handleToolCall('memory_link', {
      db_path: DB_PATH,
      src_uid: 'uid-does-not-exist-bl249',
      dst_uid: dstUid,
      rel: 'RELATES_TO',
    });
    const { body, isError } = parseResult(resp);

    // Pre-fix, `result.isError` read off a Promise was always `undefined` — the
    // dead branch never fired and the MCP response never carried isError:true.
    expect(isError).toBe(true);
    expect(body['isError']).toBe(true);
    expect(String(body['message'])).toMatch(/src_uid not found/);
  });

  it('rejects an unknown rel with isError: true (memoryLinkNode validation still reachable)', async () => {
    const resp = await handleToolCall('memory_link', {
      db_path: DB_PATH,
      src_uid: srcUid,
      dst_uid: dstUid,
      rel: 'NOT_A_REAL_REL',
    });
    const { body, isError } = parseResult(resp);
    expect(isError).toBe(true);
    expect(String(body['message'])).toMatch(/Unknown rel/);
  });
});
