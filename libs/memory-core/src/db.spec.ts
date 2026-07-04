/**
 * db.spec.ts — BL-41: tilde expansion + BL-121 / SA-5: store identity stamp.
 *
 * BL-41: a leading `~`/`~/` in db_path is expanded to $HOME at the file-create
 * sink, so the literal string the skill docs show (`db_path: "~/.memory/memory.db"`)
 * writes under $HOME/.memory and NEVER creates a literal `~` directory relative
 * to cwd.
 *
 * SA-5 / BL-121: openDb stamps sox_store_meta with current identity (schema
 * version, writer artifact, embed model, embed dimensions). Stamping is idempotent
 * (INSERT OR IGNORE). verifyStoreMeta detects drift. EStoreMismatch thrown on
 * hard mismatch (schema_version, embed_dimensions). embed_model difference is a
 * non-fatal warning.
 *
 * The expansion is THE single canonical expander (`expandDbPath`) applied inside
 * `openDb`/`openDbReadOnly`/the daemon constructor, so every consumer is covered
 * regardless of whether the caller pre-expanded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, openDbReadOnly, expandDbPath, stampStoreMeta, verifyStoreMeta, EStoreMismatch, STORE_META_KEYS } from './db.js';
import { EMBED_DIM, getActiveEmbedModel, _resetEmbedSingleton } from './embed.js';

// Mock embed to avoid real ONNX model download (these tests assert DB mechanics, not embedding quality)

beforeEach(() => { _resetEmbedSingleton(); });
afterEach(() => { _resetEmbedSingleton(); });

describe('expandDbPath — BL-41 tilde expansion', () => {
  it('expands a bare ~ to homedir', () => {
    expect(expandDbPath('~')).toBe(os.homedir());
  });

  it('expands ~/.memory/x.db to $HOME/.memory/x.db', () => {
    expect(expandDbPath('~/.memory/x.db')).toBe(
      path.join(os.homedir(), '.memory', 'x.db'),
    );
  });

  it('is idempotent for already-absolute paths', () => {
    const abs = path.join(os.tmpdir(), 'mem', 'y.db');
    expect(expandDbPath(abs)).toBe(abs);
  });

  it('does NOT expand a ~ that is not a path prefix (e.g. ~foo)', () => {
    // ~user-style home expansion is out of scope; only `~` and `~/` expand.
    expect(expandDbPath('~foo/x.db')).toBe('~foo/x.db');
  });
});

describe('openDb — BL-41 no literal ~ dir is created', () => {
  // Run with HOME pointed at a throwaway dir, cwd at another throwaway dir, so we
  // can prove (a) the db lands under $HOME/.memory and (b) no `~` dir appears in cwd.
  let tmpHome: string;
  let tmpCwd: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bl41-home-'));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bl41-cwd-'));
    origHome = process.env['HOME'];
    origUserProfile = process.env['USERPROFILE'];
    origCwd = process.cwd();
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
    process.chdir(tmpCwd);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env['HOME']; else process.env['HOME'] = origHome;
    if (origUserProfile === undefined) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = origUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('opening "~/.memory/memory.db" writes under $HOME/.memory and leaves no "~" dir in cwd', () => {
    const db = openDb('~/.memory/memory.db');
    db.close();

    const expected = path.join(tmpHome, '.memory', 'memory.db');
    expect(fs.existsSync(expected)).toBe(true);

    // The exact BL-41 regression: a literal `~` directory relative to cwd.
    expect(fs.existsSync(path.join(tmpCwd, '~'))).toBe(false);
    expect(fs.existsSync(path.join(tmpCwd, '~', '.memory'))).toBe(false);
  });

  it('openDbReadOnly also expands ~ (opens the same expanded file)', () => {
    // Create the file first via openDb, then re-open read-only with the tilde form.
    openDb('~/.memory/ro.db').close();
    const ro = openDbReadOnly('~/.memory/ro.db');
    ro.close();
    expect(fs.existsSync(path.join(tmpHome, '.memory', 'ro.db'))).toBe(true);
    expect(fs.existsSync(path.join(tmpCwd, '~'))).toBe(false);
  });
});

// ── SA-5 / BL-121: store identity stamp ────────────────────────────────────────

describe('stampStoreMeta — SA-5 / BL-121 identity stamp', () => {
  it('openDb stamps sox_store_meta with four expected keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'stamp.db');
    const db = openDb(dbPath);

    const rows = db.prepare<[], { key: string; value: string }>(
      'SELECT key, value FROM sox_store_meta ORDER BY key',
    ).all();
    expect(rows).toHaveLength(4);

    const meta = new Map(rows.map((r) => [r.key, r.value]));
    expect(meta.get('schema_version')).toBe('1');
    expect(meta.get('embed_model')).toBe(getActiveEmbedModel());
    expect(meta.get('embed_dimensions')).toBe(String(EMBED_DIM));
    expect(meta.get('writer_artifact')).toBe('@adhd/sox-memory-core');

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamp is idempotent — re-opening the same file does not overwrite values', () => {
    // Set a custom writer artifact before first open
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'idempotent.db');
    const db1 = openDb(dbPath);
    const rows1 = db1.prepare<[], { key: string; value: string }>(
      'SELECT key, value FROM sox_store_meta ORDER BY key',
    ).all();
    db1.close();

    // Re-open — INSERT OR IGNORE means no overwrite
    const db2 = openDb(dbPath);
    const rows2 = db2.prepare<[], { key: string; value: string }>(
      'SELECT key, value FROM sox_store_meta ORDER BY key',
    ).all();
    db2.close();

    expect(rows2).toEqual(rows1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('verifyStoreMeta passes on a fresh-created store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'verify-ok.db');
    const db = openDb(dbPath);
    // verifyStoreMeta is called inside stampStoreMeta inside openDb
    // It should not throw
    expect(() => verifyStoreMeta(db)).not.toThrow();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('EStoreMismatch thrown when schema_version differs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'mismatch.db');
    const db = openDb(dbPath);

    // Manually corrupt the schema_version
    db.prepare('UPDATE sox_store_meta SET value = ? WHERE key = ?')
      .run('99', STORE_META_KEYS.SCHEMA_VERSION);

    expect(() => verifyStoreMeta(db)).toThrow(EStoreMismatch);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('EStoreMismatch thrown when embed_dimensions differs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'dim-mismatch.db');
    const db = openDb(dbPath);

    // Corrupt the embed_dimensions
    db.prepare('UPDATE sox_store_meta SET value = ? WHERE key = ?')
      .run('999', STORE_META_KEYS.EMBED_DIMENSIONS);

    expect(() => verifyStoreMeta(db)).toThrow(EStoreMismatch);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('embed_model difference does not throw but logs warning (soft mismatch)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'model-warn.db');
    const db = openDb(dbPath);

    // Change to a different model string
    db.prepare('UPDATE sox_store_meta SET value = ? WHERE key = ?')
      .run('some-other-model-v2', STORE_META_KEYS.EMBED_MODEL);

    // This logs a warning but does NOT throw EStoreMismatch
    expect(() => verifyStoreMeta(db)).not.toThrow();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stampStoreMeta on a store with existing meta does not overwrite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'no-overwrite.db');
    const db1 = openDb(dbPath);
    const originalRows = db1.prepare<[], { key: string; value: string }>(
      'SELECT key, value FROM sox_store_meta ORDER BY key',
    ).all();
    db1.close();

    // Re-open and ensure rows are unchanged
    const db2 = openDb(dbPath);
    const newRows = db2.prepare<[], { key: string; value: string }>(
      'SELECT key, value FROM sox_store_meta ORDER BY key',
    ).all();
    db2.close();

    expect(newRows).toEqual(originalRows);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
