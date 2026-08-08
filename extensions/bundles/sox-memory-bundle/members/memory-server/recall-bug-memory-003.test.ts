/**
 * recall-bug-memory-003.test.ts — AC5 (BUG-MEMORY-003): proves the MCP-seam
 * wiring for `filters.kinds` — the tool-schema field actually survives
 * `index.ts`'s hand-written per-key filter-forwarding loop and reaches
 * `memoryRecall()` in `@adhd/sox-memory-core`, rather than being silently
 * dropped before it gets there.
 *
 * A memory-core-level test alone (recall.spec.ts) proves `memoryRecall()`
 * is fixed but does NOT prove the tool-schema field survives this
 * translation layer — that loop only forwards keys it explicitly knows
 * about, so a schema addition with no matching forwarding branch is a
 * field that LOOKS accepted but is silently dropped. This is exactly the
 * failure mode this file's RED arm reproduces (see the second `it` below).
 *
 * Modeled on clustering-e2e.test.ts's `handleToolCall(...)` + real scratch
 * SQLite DB pattern (no mocked adapter) — see clustering-e2e.test.ts:60-70,
 * 150-181.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleToolCall } from './src/index.js';

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function textOf(result: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('BUG-MEMORY-003 (AC5) — filters.kinds MCP-seam wiring', () => {
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempDir('sox-bug-memory-003-');
    dbPath = path.join(tmp.dir, 'test.db');
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  async function writeTaggedEpisodes(): Promise<void> {
    const episodes = [
      { content: 'gadget calibration procedure alpha revision', name: 'gadget-alpha', tags: ['gadget-alpha-tag'] },
      { content: 'gadget calibration procedure beta revision', name: 'gadget-beta', tags: ['gadget-beta-tag'] },
    ];
    for (const ep of episodes) {
      const result = await handleToolCall('memory_write', {
        db_path: dbPath,
        content: ep.content,
        name: ep.name,
        tags: ep.tags,
        project_path: '/test/bug-memory-003',
      });
      expect(result.isError, `write failed: ${JSON.stringify(result)}`).toBeFalsy();
      const body = textOf(result);
      expect(body['episode_uid'], `no episode_uid in write response: ${JSON.stringify(body)}`).toBeTruthy();
    }
  }

  it('default memory_recall call excludes non-episode kinds; opt-in filters.kinds re-admits them', async () => {
    await writeTaggedEpisodes();

    // Default path (no `filters`) — must exclude the tag-created entity nodes.
    const defaultResult = await handleToolCall('memory_recall', {
      db_path: dbPath,
      query: 'gadget calibration procedure',
      limit: 10,
    });
    expect(defaultResult.isError, `default recall failed: ${JSON.stringify(defaultResult)}`).toBeFalsy();
    const defaultBody = textOf(defaultResult);
    const defaultResults = defaultBody['results'] as Array<{ content: string | null }>;
    expect(defaultResults.every((r) => r.content !== null)).toBe(true);

    // Opt-in via filters.kinds — proves index.ts's forwarding loop actually
    // threads `kinds` through to recall.ts instead of silently dropping it.
    const optInResult = await handleToolCall('memory_recall', {
      db_path: dbPath,
      query: 'gadget calibration procedure',
      limit: 20,
      filters: { kinds: ['episode', 'entity'] },
    });
    expect(optInResult.isError, `opt-in recall failed: ${JSON.stringify(optInResult)}`).toBeFalsy();
    const optInBody = textOf(optInResult);
    const optInResults = optInBody['results'] as Array<{ content: string | null }>;
    expect(optInResults.some((r) => r.content === null)).toBe(true);
  });
});
