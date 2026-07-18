/**
 * bl55-dbpath-default.spec.ts — BL-55: db_path is OPTIONAL and defaults to the
 * bundle-configured store.
 *
 * Before BL-55 every memory_* tool listed `db_path` in its `required` schema array
 * and the handler returned `"db_path is required"` when it was omitted — so callers
 * had to *know* the magic path and routinely guessed wrong (e.g. `~/.sox/memory`).
 * The bundle config DID inject the right path as `SOX_CONFIG_DB_PATH`, but the tools
 * never read it.
 *
 * These tests pin the resolution contract:
 *   resolveDbPath(arg) = arg → SOX_CONFIG_DB_PATH → DEFAULT_DB_PATH
 * and prove the config-injected default works end-to-end through handleToolCall
 * (write then recall WITHOUT db_path lands in the configured store).
 *
 * Deterministic: hash embed backend, no enforcement, tmp dbs only — the canonical
 * DEFAULT_DB_PATH (~/.memory/memory.db) is asserted as a STRING and never opened.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DB_PATH, handleToolCall, resolveDbPath } from './index.js';

const TEST_DIR = path.join(os.tmpdir(), `sox-bl55-${process.pid}`);
const CONFIG_DB = path.join(TEST_DIR, 'configured.db');
const OVERRIDE_DB = path.join(TEST_DIR, 'override.db');

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  for (const base of [CONFIG_DB, OVERRIDE_DB]) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(base + suffix, { force: true }); } catch { /* ignore */ }
    }
  }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── resolveDbPath precedence (pure, no db opened) ─────────────────────────────

describe('resolveDbPath — BL-55 precedence', () => {
  const saved = process.env['SOX_CONFIG_DB_PATH'];
  afterEach(() => {
    if (saved === undefined) delete process.env['SOX_CONFIG_DB_PATH'];
    else process.env['SOX_CONFIG_DB_PATH'] = saved;
  });

  it('falls back to DEFAULT_DB_PATH (~/.memory/memory.db) when nothing is supplied', () => {
    delete process.env['SOX_CONFIG_DB_PATH'];
    expect(resolveDbPath(undefined)).toBe(DEFAULT_DB_PATH);
    expect(DEFAULT_DB_PATH).toBe('~/.memory/memory.db');
  });

  it('uses the host-injected bundle config (SOX_CONFIG_DB_PATH) when no arg given', () => {
    process.env['SOX_CONFIG_DB_PATH'] = '/Users/x/.memory/memory.db';
    expect(resolveDbPath(undefined)).toBe('/Users/x/.memory/memory.db');
  });

  it('explicit arg overrides the configured default', () => {
    process.env['SOX_CONFIG_DB_PATH'] = '/Users/x/.memory/memory.db';
    expect(resolveDbPath('~/.memory/other.db')).toBe('~/.memory/other.db');
  });

  it('treats a blank/whitespace arg as absent (falls through to config)', () => {
    process.env['SOX_CONFIG_DB_PATH'] = '/Users/x/.memory/memory.db';
    expect(resolveDbPath('   ')).toBe('/Users/x/.memory/memory.db');
    expect(resolveDbPath('')).toBe('/Users/x/.memory/memory.db');
  });

  it('treats a blank config as absent (falls through to DEFAULT)', () => {
    process.env['SOX_CONFIG_DB_PATH'] = '   ';
    expect(resolveDbPath(undefined)).toBe(DEFAULT_DB_PATH);
  });

  it('trims a non-string arg to the next source', () => {
    delete process.env['SOX_CONFIG_DB_PATH'];
    expect(resolveDbPath(42)).toBe(DEFAULT_DB_PATH);
    expect(resolveDbPath(null)).toBe(DEFAULT_DB_PATH);
  });
});

// ── End-to-end: omitting db_path uses the configured store ────────────────────

describe('handleToolCall — BL-55 db_path omitted uses SOX_CONFIG_DB_PATH', () => {
  const saved = process.env['SOX_CONFIG_DB_PATH'];
  beforeEach(() => { process.env['SOX_CONFIG_DB_PATH'] = CONFIG_DB; });
  afterEach(() => {
    if (saved === undefined) delete process.env['SOX_CONFIG_DB_PATH'];
    else process.env['SOX_CONFIG_DB_PATH'] = saved;
  });

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
  });

  it('explicit db_path overrides the configured store (write to override, absent from config store)', async () => {
    const w = await handleToolCall('memory_write', {
      project_path: '/test/project',
      db_path: OVERRIDE_DB,
      content: 'BL-55 override-only episode — should not appear in the configured store',
    });
    expect(w.isError).toBeFalsy();
    const wj = JSON.parse((w.content[0] as { text: string }).text);

    // Present when recalling from the explicit override db.
    const fromOverride = await handleToolCall('memory_recall', {
      db_path: OVERRIDE_DB,
      query: 'override only episode',
      limit: 10,
    });
    const oj = JSON.parse((fromOverride.content[0] as { text: string }).text);
    expect(oj.results.some((r: { uid: string }) => r.uid === wj.episode_uid)).toBe(true);

    // Absent when recalling from the configured (default) store.
    const fromConfig = await handleToolCall('memory_recall', {
      query: 'override only episode',
      limit: 10,
    });
    const cj = JSON.parse((fromConfig.content[0] as { text: string }).text);
    expect(cj.results.some((r: { uid: string }) => r.uid === wj.episode_uid)).toBe(false);
  });
});
