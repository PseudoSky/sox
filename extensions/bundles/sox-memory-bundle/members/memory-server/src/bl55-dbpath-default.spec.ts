/**
 * bl55-dbpath-default.spec.ts — BL-55 + BL 0c3522c2: db_path is OPTIONAL per call,
 * but the server NEVER infers a store path.
 *
 * BL-55 made `db_path` optional on every tool so callers stop guessing magic paths
 * — the host injects the configured store as `SOX_CONFIG_DB_PATH`.
 *
 * BL 0c3522c2 (fail closed): the old third tier — a hard-coded
 * `~/.memory/memory.db` (or `~/.memory/memory-dev.db` under `SOX_SCOPE=project`)
 * — is gone. A bare process with no explicit `store`/`db_path` and no
 * host-injected `SOX_CONFIG_DB_PATH` used to silently open the user's REAL store
 * (a plain `nx test`, a stray SIGTERM, a mis-spawned backend). It now returns the
 * typed error `E_STORE_NOT_CONFIGURED` and opens nothing.
 *
 * Contract pinned here:
 *   resolveDbPath(arg) = arg → SOX_CONFIG_DB_PATH → null
 *   handleToolCall(<store tool>, {no store/db_path}) with no SOX_CONFIG_DB_PATH
 *     → isError, code E_STORE_NOT_CONFIGURED, no file created under ~/.memory
 *
 * Deterministic: hash embed backend, no enforcement, tmp dbs only. HOME is
 * redirected to a scratch dir for the refusal cases so that even the pre-fix
 * code (which guessed `~/.memory/memory.db`) can never touch the real store.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleToolCall, resolveDbPath } from './index.js';

const TEST_DIR = path.join(os.tmpdir(), `sox-bl55-${process.pid}`);
const CONFIG_DB = path.join(TEST_DIR, 'configured.db');
const OVERRIDE_DB = path.join(TEST_DIR, 'override.db');
const FAKE_HOME = path.join(TEST_DIR, 'home');

beforeAll(() => {
  fs.mkdirSync(FAKE_HOME, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Snapshot + restore the env keys these tests mutate. */
function envGuard(keys: readonly string[]): { restore: () => void } {
  const saved = new Map(keys.map((k) => [k, process.env[k]] as const));
  return {
    restore: () => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

const ENV_KEYS = ['SOX_CONFIG_DB_PATH', 'SOX_SCOPE', 'HOME'] as const;

// ── resolveDbPath precedence (pure, no db opened) ─────────────────────────────

describe('resolveDbPath — BL-55 precedence, BL 0c3522c2 no inferred default', () => {
  let guard: { restore: () => void };
  beforeEach(() => { guard = envGuard(ENV_KEYS); });
  afterEach(() => { guard.restore(); });

  it('BL 0c3522c2: returns null (E_STORE_NOT_CONFIGURED) when nothing is supplied — no ~/.memory/memory.db guess', () => {
    delete process.env['SOX_CONFIG_DB_PATH'];
    delete process.env['SOX_SCOPE'];
    expect(resolveDbPath(undefined)).toBeNull();
  });

  it('BL 0c3522c2: SOX_SCOPE=project no longer infers ~/.memory/memory-dev.db', () => {
    delete process.env['SOX_CONFIG_DB_PATH'];
    process.env['SOX_SCOPE'] = 'project';
    expect(resolveDbPath(undefined)).toBeNull();
  });

  it('uses the host-injected bundle config (SOX_CONFIG_DB_PATH) when no arg given', () => {
    process.env['SOX_CONFIG_DB_PATH'] = '/Users/x/.memory/memory.db';
    expect(resolveDbPath(undefined)).toBe('/Users/x/.memory/memory.db');
  });

  it('explicit arg overrides the configured store', () => {
    process.env['SOX_CONFIG_DB_PATH'] = '/Users/x/.memory/memory.db';
    expect(resolveDbPath('~/.memory/other.db')).toBe('~/.memory/other.db');
  });

  it('treats a blank/whitespace arg as absent (falls through to config)', () => {
    process.env['SOX_CONFIG_DB_PATH'] = '/Users/x/.memory/memory.db';
    expect(resolveDbPath('   ')).toBe('/Users/x/.memory/memory.db');
    expect(resolveDbPath('')).toBe('/Users/x/.memory/memory.db');
  });

  it('BL 0c3522c2: a blank config is absent, and absent means null — not a default', () => {
    process.env['SOX_CONFIG_DB_PATH'] = '   ';
    expect(resolveDbPath(undefined)).toBeNull();
  });

  it('BL 0c3522c2: a non-string arg with no config resolves to null', () => {
    delete process.env['SOX_CONFIG_DB_PATH'];
    expect(resolveDbPath(42)).toBeNull();
    expect(resolveDbPath(null)).toBeNull();
  });
});

// ── End-to-end: no configured store → typed refusal, nothing opened ───────────

describe('handleToolCall — BL 0c3522c2 unconfigured store returns E_STORE_NOT_CONFIGURED', () => {
  let guard: { restore: () => void };
  beforeEach(() => {
    guard = envGuard(ENV_KEYS);
    delete process.env['SOX_CONFIG_DB_PATH'];
    delete process.env['SOX_SCOPE'];
    // Redirect ~ so the pre-fix guess (~/.memory/memory.db) lands in scratch.
    process.env['HOME'] = FAKE_HOME;
    fs.rmSync(path.join(FAKE_HOME, '.memory'), { recursive: true, force: true });
  });
  afterEach(() => { guard.restore(); });

  const guessedStores = (): string[] =>
    ['memory.db', 'memory-dev.db']
      .map((f) => path.join(FAKE_HOME, '.memory', f))
      .filter((p) => fs.existsSync(p));

  for (const [tool, args] of [
    ['memory_recall', { query: 'anything' }],
    ['memory_write', { project_path: '/test/project', content: 'BL 0c3522c2 must not land anywhere' }],
    ['memory_stats', {}],
  ] as const) {
    it(`BL 0c3522c2: ${tool} without store/db_path/SOX_CONFIG_DB_PATH → E_STORE_NOT_CONFIGURED, opens nothing`, async () => {
      const res = await handleToolCall(tool, { ...args });
      expect(res.isError).toBe(true);
      const body = JSON.parse((res.content[0] as { text: string }).text) as { code?: string; message?: string };
      expect(body.code).toBe('E_STORE_NOT_CONFIGURED');
      expect(body.message).toMatch(/SOX_CONFIG_DB_PATH/);
      expect(guessedStores()).toEqual([]);
    });
  }

  it('BL 0c3522c2: SOX_SCOPE=project still refuses (no memory-dev.db inference)', async () => {
    process.env['SOX_SCOPE'] = 'project';
    const res = await handleToolCall('memory_recall', { query: 'anything' });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content[0] as { text: string }).text) as { code?: string };
    expect(body.code).toBe('E_STORE_NOT_CONFIGURED');
    expect(guessedStores()).toEqual([]);
  });

  it('BL 0c3522c2: memory_ping still answers (store.configured:false), it does not refuse', async () => {
    const res = await handleToolCall('memory_ping', {});
    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content[0] as { text: string }).text) as {
      ok: boolean; store_ok: boolean; store: { configured?: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.store_ok).toBe(false);
    expect(body.store.configured).toBe(false);
    expect(guessedStores()).toEqual([]);
  });
});

// ── End-to-end: omitting db_path uses the configured store ────────────────────

describe('handleToolCall — BL-55 db_path omitted uses SOX_CONFIG_DB_PATH', () => {
  let guard: { restore: () => void };
  beforeEach(() => {
    guard = envGuard(ENV_KEYS);
    process.env['SOX_CONFIG_DB_PATH'] = CONFIG_DB;
  });
  afterEach(() => { guard.restore(); });

  it('memory_write WITHOUT db_path lands in the configured store, recallable WITHOUT db_path', async () => {
    const writeRes = await handleToolCall('memory_write', {
      project_path: '/test/project',
      content: 'BL-55 configured-default episode — recall me without a db_path',
    });
    expect(writeRes.isError).toBeFalsy();
    const written = JSON.parse((writeRes.content[0] as { text: string }).text);
    expect(written.episode_uid).toBeTruthy();

    // The configured db file was actually created/used.
    expect(fs.existsSync(CONFIG_DB)).toBe(true);

    const recallRes = await handleToolCall('memory_recall', {
      query: 'configured default episode recall',
      limit: 5,
    });
    expect(recallRes.isError).toBeFalsy();
    const recalled = JSON.parse((recallRes.content[0] as { text: string }).text);
    expect(recalled.results.some((r: { uid: string }) => r.uid === written.episode_uid)).toBe(true);
  });

  it('NO LONGER returns "db_path is required" when db_path is omitted', async () => {
    const res = await handleToolCall('memory_recall', { query: 'anything' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain('db_path is required');
    expect(text).not.toContain('E_STORE_NOT_CONFIGURED');
  });

  it('explicit db_path overrides the configured store (write to override, absent from config store)', async () => {
    const w = await handleToolCall('memory_write', {
      project_path: '/test/project',
      db_path: OVERRIDE_DB,
      content: 'BL-55 override-only episode — should not appear in the configured store',
    });
    expect(w.isError).toBeFalsy();
    const wj = JSON.parse((w.content[0] as { text: string }).text);

    const fromOverride = await handleToolCall('memory_recall', {
      db_path: OVERRIDE_DB,
      query: 'override only episode',
      limit: 10,
    });
    const oj = JSON.parse((fromOverride.content[0] as { text: string }).text);
    expect(oj.results.some((r: { uid: string }) => r.uid === wj.episode_uid)).toBe(true);

    const fromConfig = await handleToolCall('memory_recall', {
      query: 'override only episode',
      limit: 10,
    });
    const cj = JSON.parse((fromConfig.content[0] as { text: string }).text);
    expect(cj.results.some((r: { uid: string }) => r.uid === wj.episode_uid)).toBe(false);
  });
});
