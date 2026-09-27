/**
 * bl-7e575717.spec.ts — regression test for BL-7e575717.
 *
 * Production incident (2026-09-27, memory-server.live-service log, 5 occurrences
 * 20:29Z–20:32Z): `memory_write` with an omitted/non-string `content` argument
 * reached `splitIntoChunksSentence(content, chunkSize)`
 * (extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:1798)
 * with `content === undefined`, which crashed deep in ingest's
 * `splitIntoChunksSentence` (libs/data/ingest/ingest/src/core.ts:160,
 * `text.length` on `undefined`) as an unhandled TypeError, instead of failing
 * cleanly at the tool boundary.
 *
 * Root cause: the tool's `inputSchema` declares `content` as `required`, but
 * the MCP layer never enforces required-ness server-side — that's advisory
 * for a well-behaved client, not a runtime guard in this handler. Chunking
 * ran BEFORE any content-presence check, so the existing downstream guard in
 * write.ts (`!content || !content.trim()`, write.ts:254) was never reached.
 *
 * Fix: reject with a typed `E_MISSING_CONTENT` error at the tool boundary
 * before chunking is attempted, mirroring the existing `E_MISSING_PROJECT_PATH`
 * pattern for the sibling required field.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleToolCall } from './index.js';

const TEST_DIR = path.join(os.tmpdir(), `sox-bl-7e575717-${process.pid}`);
const DB_PATH = path.join(TEST_DIR, 'test.db');

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function parseError(result: Awaited<ReturnType<typeof handleToolCall>>): { code?: string; message?: string } {
  return JSON.parse((result.content[0] as { type: string; text: string }).text) as { code?: string; message?: string };
}

describe('BL-7e575717: memory_write rejects missing/invalid content instead of crashing', () => {
  it('returns a typed E_MISSING_CONTENT error when content is omitted entirely', async () => {
    const result = await handleToolCall('memory_write', {
      db_path: DB_PATH,
      project_path: '/tmp/some-project',
      // content intentionally omitted — this is the exact production shape
      // that reached splitIntoChunksSentence() with `undefined`.
    });

    expect(result.isError).toBe(true);
    const parsed = parseError(result);
    expect(parsed.code).toBe('E_MISSING_CONTENT');
  });

  it('returns a typed E_MISSING_CONTENT error when content is not a string', async () => {
    const result = await handleToolCall('memory_write', {
      db_path: DB_PATH,
      project_path: '/tmp/some-project',
      content: 12345 as unknown as string,
    });

    expect(result.isError).toBe(true);
    const parsed = parseError(result);
    expect(parsed.code).toBe('E_MISSING_CONTENT');
  });

  it('returns a typed E_MISSING_CONTENT error when content is whitespace-only', async () => {
    const result = await handleToolCall('memory_write', {
      db_path: DB_PATH,
      project_path: '/tmp/some-project',
      content: '   \n\t  ',
    });

    expect(result.isError).toBe(true);
    const parsed = parseError(result);
    expect(parsed.code).toBe('E_MISSING_CONTENT');
  });

  it('still succeeds for well-formed content (no regression on the happy path)', async () => {
    const result = await handleToolCall('memory_write', {
      db_path: DB_PATH,
      project_path: '/tmp/some-project',
      content: 'A perfectly ordinary memory episode about nothing in particular.',
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text) as { episode_uid?: string };
    expect(typeof parsed.episode_uid).toBe('string');
  });
});
