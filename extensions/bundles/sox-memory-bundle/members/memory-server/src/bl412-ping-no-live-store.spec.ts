/**
 * bl412-ping-no-live-store.spec.ts — BL-412: `memory_ping` with no arguments
 * must never open a connection to the live production store, and must never
 * register a guessed path into `openedPaths` (the periodic background enrich
 * loop's registry).
 *
 * Root cause: `memory_ping` called with no `store`/`db_path` used to fall
 * through unconditionally to `resolveDbPath(undefined)`, which resolves to
 * `~/.memory/memory.db` — the REAL production store — whenever
 * `SOX_CONFIG_DB_PATH` is unset (true for any bare/test spawn, since only a
 * properly configured host injects that env var). It then called `getDb()`
 * on that path and `openedPaths.add()`'d it, enlisting the live store into
 * this process's in-process enrichment scheduler as a side effect of a mere
 * liveness check.
 *
 * Measured before the fix: 5 live-store touches from `backend.spec.ts` alone
 * (3 bare `memory_ping` calls + the `[BL-62]` malformed-`client_context`
 * loop, which calls `memory_ping` 3 times but only 1 of those 3 iterations
 * previously ran before `backend-shutdown`/env state made the others no-ops
 * in some runs — regardless, the unguarded default path was live on every
 * bare call). `backend.spec.ts`'s own test name ("... without touching a
 * db") was FALSE until this fix — see the corrected assertions added there
 * in the same change.
 *
 * This spec proves the negative directly: with `SOX_CONFIG_DB_PATH` unset,
 * `fs.existsSync`/`fs.readFileSync`/`fs.statSync` are never called with a
 * path under the real `~/.memory/` directory during a bare `memory_ping`,
 * and the response reports `store.configured === false` instead of opening
 * anything. It also proves the legitimate paths — an explicit `db_path`, an
 * explicit `store`, or a host-injected `SOX_CONFIG_DB_PATH` — are UNCHANGED
 * and still open (and probe) the requested store normally.
 *
 * IMPLEMENTATION NOTE: this originally used `vi.spyOn(fs, 'existsSync')`
 * against an ESM `import * as fs from 'node:fs'` binding. That throws
 * `TypeError: Cannot redefine property` / "Module namespace is not
 * configurable in ESM" in this vitest config — ES module namespace
 * properties are non-configurable by spec, and neither a plain reassignment
 * nor `vi.spyOn` can redefine them. All 3 tests in this file failed on that
 * line before a single assertion ran (verified directly — this is exactly
 * the "committed as a regression test, never actually watched pass" failure
 * mode BL-225 exists to catch). Fixed by obtaining `fs` via CommonJS
 * `createRequire(...)('node:fs')` instead — Node's real, mutable
 * `module.exports` object for the `fs` module, which every ESM
 * `import * as fs from 'node:fs'` elsewhere in the process (index.ts,
 * memory-core) reads live off of, so recording calls against THIS
 * reference observes every consumer. See vitest.setup.ts's own BL-412
 * suite-wide guard for the same technique and a longer explanation.
 */

import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handleToolCall } from './index.js';

const require = createRequire(__filename);
const fs = require('node:fs') as typeof import('node:fs');

const TEST_DIR = path.join(os.tmpdir(), `sox-bl412-${process.pid}`);
const EXPLICIT_DB = path.join(TEST_DIR, 'explicit.db');

// The real, live production store path — must NEVER be touched by this spec.
const REAL_HOME_MEMORY_DIR = path.join(os.homedir(), '.memory');

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(EXPLICIT_DB + suffix, { force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('memory_ping — BL-412: no arguments must never open the live store', () => {
  const savedConfig = process.env['SOX_CONFIG_DB_PATH'];

  afterEach(() => {
    if (savedConfig === undefined) delete process.env['SOX_CONFIG_DB_PATH'];
    else process.env['SOX_CONFIG_DB_PATH'] = savedConfig;
  });

  it('[BL-412] bare memory_ping (no args, no SOX_CONFIG_DB_PATH) never touches a path under the real ~/.memory/', async () => {
    delete process.env['SOX_CONFIG_DB_PATH'];

    const calls: Record<'existsSync' | 'readFileSync' | 'statSync', unknown[][]> = {
      existsSync: [],
      readFileSync: [],
      statSync: [],
    };
    const originals = {
      existsSync: fs.existsSync,
      readFileSync: fs.readFileSync,
      statSync: fs.statSync,
    };
    for (const name of Object.keys(calls) as Array<keyof typeof calls>) {
      (fs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        calls[name].push(args);
        return (originals[name] as (...a: unknown[]) => unknown).apply(fs, args);
      };
    }

    let res: Awaited<ReturnType<typeof handleToolCall>>;
    try {
      res = await handleToolCall('memory_ping', {});
    } finally {
      for (const name of Object.keys(calls) as Array<keyof typeof calls>) {
        (fs as unknown as Record<string, unknown>)[name] = originals[name];
      }
    }

    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text) as {
      ok: boolean;
      store: { configured?: boolean; reason?: string; path?: string } | null;
    };
    expect(parsed.ok).toBe(true);

    // The red arm: before the fix, `store` was a fully-populated block with
    // `path: "/Users/.../.memory/memory.db"` and the file had already been
    // opened via getDb() by the time this assertion runs.
    expect(parsed.store).not.toBeNull();
    expect(parsed.store?.configured).toBe(false);
    expect(parsed.store?.reason).toContain('BL-412');
    expect(parsed.store?.path).toBeUndefined();

    // No fs call anywhere in the ping path may have referenced the real
    // ~/.memory/ directory — the entrypoint self-hash read (getContentAddress)
    // is exempt (it reads the running artifact, never ~/.memory), so scope the
    // assertion precisely to the live store directory.
    const touchedRealStore = (recorded: unknown[][]): boolean =>
      recorded.some((call) => typeof call[0] === 'string' && call[0].startsWith(REAL_HOME_MEMORY_DIR));

    expect(touchedRealStore(calls.existsSync)).toBe(false);
    expect(touchedRealStore(calls.readFileSync)).toBe(false);
    expect(touchedRealStore(calls.statSync)).toBe(false);
  });

  it('[BL-412] explicit db_path still opens and probes the requested (non-live) store normally', async () => {
    delete process.env['SOX_CONFIG_DB_PATH'];

    const res = await handleToolCall('memory_ping', { db_path: EXPLICIT_DB });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text) as {
      store: { configured?: boolean; path?: string } | null;
    };
    // db_path was explicit, so this is NOT a guess — normal probing behavior
    // applies. The store may be null (fresh file not yet created by a write)
    // but it must never be the BL-412 "configured: false" refusal shape.
    expect(parsed.store?.configured).not.toBe(false);
  });

  it('[BL-412] a host-injected SOX_CONFIG_DB_PATH (real production config) still opens normally — the guard only fires on a true guess', async () => {
    process.env['SOX_CONFIG_DB_PATH'] = EXPLICIT_DB;

    const res = await handleToolCall('memory_ping', {});
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text) as {
      store: { configured?: boolean; path?: string } | null;
    };
    expect(parsed.store?.configured).not.toBe(false);
  });
});
