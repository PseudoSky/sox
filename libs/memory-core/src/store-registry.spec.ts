/**
 * store-registry.spec.ts — SA-6 / BL-130: Named-store registry.
 *
 * Covers:
 *   - resolveStoreName: known name → ResolvedStore with path + fingerprint
 *   - resolveStoreName: unknown name → E_UNKNOWN_STORE (never creates a file)
 *   - resolveStoreOrDbPath: store wins over db_path with warning
 *   - resolveStoreOrDbPath: raw db_path accepted with deprecation warning
 *   - resolveStoreOrDbPath: null when neither param
 *   - computeFingerprint: returns `${size}:${mtimeMs}` for existing file
 *   - readStoreRegistry: returns {} for missing/malformed file
 *   - Negative control: unknown name never writes to disk
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveStoreName, resolveStoreOrDbPath, computeFingerprint, readStoreRegistry } from './store-registry.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a temp home dir with a registry.json and return the dir path. */
function createTempHomeWithRegistry(
  entries: Record<string, string>,
): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa6-'));
  const memDir = path.join(home, '.memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'registry.json'), JSON.stringify(entries, null, 2), 'utf8');
  // Create the actual db files so fingerprint works
  for (const [, dbPath] of Object.entries(entries)) {
    const absPath = path.resolve(dbPath.startsWith('~') ? path.join(home, dbPath.slice(2)) : dbPath);
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(absPath)) fs.writeFileSync(absPath, 'test', 'utf8');
  }
  return {
    home,
    cleanup: () => { fs.rmSync(home, { recursive: true, force: true }); },
  };
}

describe('resolveStoreName — SA-6 / BL-130 registry lookup', () => {
  let origHome: string | undefined;
  let testEnv: { home: string; cleanup: () => void };

  beforeEach(() => {
    origHome = process.env['HOME'];
    testEnv = createTempHomeWithRegistry({
      default: '~/.memory/memory.db',
      user: '~/.memory/user.db',
      project: '~/.memory/project.db',
    });
    process.env['HOME'] = testEnv.home;
  });

  afterEach(() => {
    testEnv.cleanup();
    if (origHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = origHome;
  });

  it('resolves a known store name to its path and fingerprint', () => {
    const result = resolveStoreName('default');
    expect(result).not.toHaveProperty('code');
    const resolved = result as Exclude<ReturnType<typeof resolveStoreName>, { code: string }>;
    expect(resolved.name).toBe('default');
    expect(resolved.path).toContain('.memory/memory.db');
    expect(resolved.path).toBe(path.resolve(testEnv.home, '.memory/memory.db'));
    expect(resolved.viaRegistry).toBe(true);
    // fingerprint: "4:<number>" (4 bytes of "test")
    expect(resolved.fingerprint).toMatch(/^4:/);
  });

  it('returns E_UNKNOWN_STORE for an unknown name (never creates file)', () => {
    const result = resolveStoreName('nonexistent');
    expect(result).toHaveProperty('code', 'E_UNKNOWN_STORE');
    const err = result as { code: string; message: string; name: string };
    expect(err.name).toBe('nonexistent');
    expect(err.message).toContain('not registered');
    // Prove no file was created at any guessed path
    expect(fs.existsSync(path.join(testEnv.home, '.memory', 'nonexistent.db'))).toBe(false);
    expect(fs.existsSync(path.join(testEnv.home, '.memory', 'nonexistent'))).toBe(false);
  });

  it('returns E_UNKNOWN_STORE for empty string', () => {
    const result = resolveStoreName('');
    expect(result).toHaveProperty('code', 'E_UNKNOWN_STORE');
  });
});

describe('resolveStoreOrDbPath — SA-6 precedence and deprecation', () => {
  let origHome: string | undefined;
  let testEnv: { home: string; cleanup: () => void };

  beforeEach(() => {
    origHome = process.env['HOME'];
    testEnv = createTempHomeWithRegistry({
      main: '~/.memory/main.db',
    });
    process.env['HOME'] = testEnv.home;
  });

  afterEach(() => {
    testEnv.cleanup();
    if (origHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = origHome;
  });

  it('store param takes precedence over db_path', () => {
    // Both given — store wins
    const result = resolveStoreOrDbPath('main', '~/some/other.db');
    expect(result).not.toHaveProperty('code');
    const resolved = result as Exclude<ReturnType<typeof resolveStoreOrDbPath>, { code: string }>;
    expect(resolved.name).toBe('main');
    expect(resolved.viaRegistry).toBe(true);
    expect(resolved.path).toContain('main.db');
  });

  it('raw db_path accepted with deprecation warning (returns viaRegistry:false)', () => {
    const dbPath = path.join(testEnv.home, '.memory', 'raw.db');
    fs.writeFileSync(dbPath, 'data', 'utf8');
    const result = resolveStoreOrDbPath(undefined, dbPath);
    expect(result).not.toHaveProperty('code');
    const resolved = result as Exclude<ReturnType<typeof resolveStoreOrDbPath>, { code: string }>;
    expect(resolved.viaRegistry).toBe(false);
    expect(resolved.path).toBe(dbPath);
    expect(resolved.fingerprint).toMatch(/^4:/);
  });

  it('returns null when neither store nor db_path is provided', () => {
    const result = resolveStoreOrDbPath(undefined, undefined);
    expect(result).toBeNull();
  });

  it('returns null for empty/whitespace params', () => {
    expect(resolveStoreOrDbPath('', '')).toBeNull();
    expect(resolveStoreOrDbPath('  ', undefined)).toBeNull();
  });
});

describe('computeFingerprint — SA-6 file identity', () => {
  it('returns empty string for non-existent file', () => {
    expect(computeFingerprint('/tmp/no-such-file-12345.db')).toBe('');
  });

  it('returns "${size}:${mtimeMs}" for an existing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa6-fp-'));
    const fp = path.join(dir, 'test.db');
    fs.writeFileSync(fp, 'hello world', 'utf8');
    const stat = fs.statSync(fp);
    const expected = `${stat.size}:${stat.mtimeMs}`;
    expect(computeFingerprint(fp)).toBe(expected);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('readStoreRegistry — SA-6 edge cases', () => {
  it('returns {} when no registry file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa6-empty-'));
    const origHome = process.env['HOME'];
    process.env['HOME'] = dir;
    try {
      expect(readStoreRegistry()).toEqual({});
    } finally {
      if (origHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = origHome;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns {} for malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa6-mal-'));
    const origHome = process.env['HOME'];
    process.env['HOME'] = dir;
    try {
      const memDir = path.join(dir, '.memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'registry.json'), '{not json}', 'utf8');
      expect(readStoreRegistry()).toEqual({});
    } finally {
      if (origHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = origHome;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
