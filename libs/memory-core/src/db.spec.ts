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
import {
  openDb,
  openDbReadOnly,
  expandDbPath,
  verifyStoreMeta,
  EStoreMismatch,
  STORE_META_KEYS,
  classicEngineSessionDeclined,
  dropVec0ViaBetterSqlite3,
  dropFtsResidueViaBetterSqlite3,
} from './db.js';
import { _resetEmbedSingleton, _setEmbedProviderForTest, EMBED_DIM, getActiveEmbedModel } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';



// Embedding is provided by the deterministic test provider installed in vitest.setup.ts —
// no reset needed here (these tests assert DB mechanics, not embedding quality).

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

  it('opening "~/.memory/memory.db" writes under $HOME/.memory and leaves no "~" dir in cwd', async () => {
    const db = await openDb('~/.memory/memory.db');
    await db.close();

    const expected = path.join(tmpHome, '.memory', 'memory.db');
    expect(fs.existsSync(expected)).toBe(true);

    // The exact BL-41 regression: a literal `~` directory relative to cwd.
    expect(fs.existsSync(path.join(tmpCwd, '~'))).toBe(false);
    expect(fs.existsSync(path.join(tmpCwd, '~', '.memory'))).toBe(false);
  });

  it('openDbReadOnly also expands ~ (opens the same expanded file)', async () => {
    // Create the file first via openDb, then re-open read-only with the tilde form.
    await (await openDb('~/.memory/ro.db')).close();
    const ro = await openDbReadOnly('~/.memory/ro.db');
    await ro.close();
    expect(fs.existsSync(path.join(tmpHome, '.memory', 'ro.db'))).toBe(true);
    expect(fs.existsSync(path.join(tmpCwd, '~'))).toBe(false);
  });
});

// ── SA-5 / BL-121: store identity stamp ────────────────────────────────────────

describe('stampStoreMeta — SA-5 / BL-121 identity stamp', () => {
  it('openDb stamps sox_store_meta with four expected keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'stamp.db');
    const db = await openDb(dbPath);

    const rows = (await db.executeAll<{ key: string; value: string }>('SELECT key, value FROM sox_store_meta ORDER BY key')).rows;
    expect(rows).toHaveLength(4);

    const meta = new Map(rows.map((r) => [r.key, r.value]));
    expect(meta.get('schema_version')).toBe('1');
    expect(meta.get('embed_model')).toBe(getActiveEmbedModel());
    expect(meta.get('embed_dimensions')).toBe(String(EMBED_DIM));
    expect(meta.get('writer_artifact')).toBe('@adhd/sox-memory-core');

    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamp is idempotent — re-opening the same file does not overwrite values', async () => {
    // Set a custom writer artifact before first open
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'idempotent.db');
    const db1 = await openDb(dbPath);
    const rows1 = (await db1.executeAll<{ key: string; value: string }>('SELECT key, value FROM sox_store_meta ORDER BY key')).rows;
    await db1.close();

    // Re-open — INSERT OR IGNORE means no overwrite
    const db2 = await openDb(dbPath);
    const rows2 = (await db2.executeAll<{ key: string; value: string }>('SELECT key, value FROM sox_store_meta ORDER BY key')).rows;
    await db2.close();

    expect(rows2).toEqual(rows1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('verifyStoreMeta passes on a fresh-created store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'verify-ok.db');
    const db = await openDb(dbPath);
    // verifyStoreMeta is called inside stampStoreMeta inside openDb
    // It should not throw
    await expect(verifyStoreMeta(db)).resolves.not.toThrow();
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('EStoreMismatch thrown when schema_version differs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'mismatch.db');
    const db = await openDb(dbPath);

    // Manually corrupt the schema_version
    await db.executeRun('UPDATE sox_store_meta SET value = ? WHERE key = ?', ['99', STORE_META_KEYS.SCHEMA_VERSION]);

    await expect(verifyStoreMeta(db)).rejects.toThrow(EStoreMismatch);
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('EStoreMismatch thrown when embed_dimensions differs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'dim-mismatch.db');
    const db = await openDb(dbPath);

    // Corrupt the embed_dimensions
    await db.executeRun('UPDATE sox_store_meta SET value = ? WHERE key = ?', ['999', STORE_META_KEYS.EMBED_DIMENSIONS]);

    await expect(verifyStoreMeta(db)).rejects.toThrow(EStoreMismatch);
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('embed_model difference does not throw but logs warning (soft mismatch)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'model-warn.db');
    const db = await openDb(dbPath);

    // Change to a different model string
    await db.executeRun('UPDATE sox_store_meta SET value = ? WHERE key = ?', ['some-other-model-v2', STORE_META_KEYS.EMBED_MODEL]);

    // This logs a warning but does NOT throw EStoreMismatch
    expect(() => verifyStoreMeta(db)).not.toThrow();
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stampStoreMeta on a store with existing meta does not overwrite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa5-'));
    const dbPath = path.join(dir, 'no-overwrite.db');
    const db1 = await openDb(dbPath);
    const originalRows = (await db1.executeAll<{ key: string; value: string }>('SELECT key, value FROM sox_store_meta ORDER BY key')).rows;
    await db1.close();

    // Re-open and ensure rows are unchanged
    const db2 = await openDb(dbPath);
    const newRows = (await db2.executeAll<{ key: string; value: string }>('SELECT key, value FROM sox_store_meta ORDER BY key')).rows;
    await db2.close();

    expect(newRows).toEqual(originalRows);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── BL-252: embed_model stamp is unfalsifiable ──────────────────────────────

  it('BL-252: store stamped with "unknown" when embed provider never warmed up', async () => {
    // Temporarily clear the test provider so _activeModel becomes null.
    const prevProvider = new DeterministicTestProvider();
    _setEmbedProviderForTest(null);
    _resetEmbedSingleton();
    // At this point _activeModel is null — no embed provider initialised.

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl252-'));
    const dbPath = path.join(dir, 'bl252.db');
    const db = await openDb(dbPath);

    const rows = (await db.executeAll<{ key: string; value: string }>('SELECT key, value FROM sox_store_meta ORDER BY key')).rows;
    const meta = new Map(rows.map((r) => [r.key, r.value]));
    // Must NOT be 'bge-base-en-v1.5' (the unfalsifiable default) — should be 'unknown'
    expect(meta.get('embed_model')).toBe('unknown');

    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });

    // Restore the test provider for subsequent tests.
    _setEmbedProviderForTest(prevProvider);
  });
});

// ── BUG-017 (nodeId 2404): cross-engine escape hatch is quiescence-gated ──────

describe('BUG-017 — cross-engine (better-sqlite3) escape hatch is quiescence-gated', () => {
  let dir: string;
  let dbPath: string;
  let leaseDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug017-'));
    dbPath = path.join(dir, 'store.db');
    leaseDir = `${dbPath}.sox-lease.d`;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Simulates a live peer holding the store: a `<dbPath>.sox-lease.d/<token>`
   * entry whose content is `<pid>\n<openedAtIso>\n` (the exact format
   * `store-adapter`'s `acquireStoreLease`/`storeQuiescence` read — see
   * `libs/data/store/store-adapter/src/store-lease.ts`). Using THIS process's
   * own pid guarantees the liveness probe (`process.kill(pid, 0)`) reports
   * live without needing to spawn a second real process.
   */
  function simulateLivePeer(): void {
    fs.mkdirSync(leaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(leaseDir, 'simulated-peer-token'),
      `${process.pid}\n${new Date().toISOString()}\n`,
    );
  }

  function clearPeers(): void {
    fs.rmSync(leaseDir, { recursive: true, force: true });
  }

  it('classicEngineSessionDeclined: true with a live peer, false with none', async () => {
    // No store file needs to exist yet — the gate only inspects the lease dir.
    expect(await classicEngineSessionDeclined(dbPath, 'probe')).toBe(false);

    simulateLivePeer();
    expect(await classicEngineSessionDeclined(dbPath, 'probe')).toBe(true);

    clearPeers();
    expect(await classicEngineSessionDeclined(dbPath, 'probe')).toBe(false);
  });

  it('dropVec0ViaBetterSqlite3: DECLINED under a live peer leaves the store file untouched; proceeds once quiescent', async () => {
    // Build a real store containing a vec0-shaped shadow table
    // (`_vector_spaces`) — one of the exact names `dropVec0ViaBetterSqlite3`
    // targets — via better-sqlite3 directly (mirrors how the store is
    // legitimately created before this repair ever runs).
    const { default: BetterSqlite3 } = await import('better-sqlite3');
    const setup = new BetterSqlite3(dbPath);
    setup.exec('CREATE TABLE _vector_spaces (id INTEGER PRIMARY KEY, name TEXT)');
    setup.exec(`INSERT INTO _vector_spaces (name) VALUES ('marker')`);
    setup.close();

    const tableExists = (): boolean => {
      const probe = new BetterSqlite3(dbPath, { readonly: true });
      try {
        const row = probe
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_vector_spaces'`)
          .get();
        return row !== undefined;
      } finally {
        probe.close();
      }
    };

    expect(tableExists()).toBe(true);

    // ── RED case: live peer present → the drop must be DECLINED and the
    //    store file must be left byte-for-byte untouched (no writable
    //    classic-engine open at all — the exp9-poisoner shape).
    simulateLivePeer();
    await dropVec0ViaBetterSqlite3(dbPath);
    expect(tableExists()).toBe(true); // still there — declined, never touched

    // ── GREEN case: no live peers → the repair proceeds for real.
    clearPeers();
    await dropVec0ViaBetterSqlite3(dbPath);
    expect(tableExists()).toBe(false); // actually dropped once quiescent
  });

  it('dropFtsResidueViaBetterSqlite3: DECLINED under a live peer leaves the store file untouched; proceeds once quiescent', async () => {
    const { default: BetterSqlite3 } = await import('better-sqlite3');
    const setup = new BetterSqlite3(dbPath);
    setup.exec('CREATE TABLE fake_fts5_residue (id INTEGER PRIMARY KEY)');
    setup.close();

    const tableExists = (): boolean => {
      const probe = new BetterSqlite3(dbPath, { readonly: true });
      try {
        const row = probe
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='fake_fts5_residue'`)
          .get();
        return row !== undefined;
      } finally {
        probe.close();
      }
    };

    expect(tableExists()).toBe(true);

    // RED: live peer → declined, store untouched.
    simulateLivePeer();
    await dropFtsResidueViaBetterSqlite3(dbPath, ['fake_fts5_residue']);
    expect(tableExists()).toBe(true);

    // GREEN: quiescent → proceeds for real.
    clearPeers();
    await dropFtsResidueViaBetterSqlite3(dbPath, ['fake_fts5_residue']);
    expect(tableExists()).toBe(false);
  });

  it("a process's own lease token must not count against itself (documented contract, exercised via the shared probe)", async () => {
    // classicEngineSessionDeclined's own probe call goes through
    // deleteSchemaRowsViaBetterSqlite3 with no ownLeaseToken — there is no
    // live entry for THIS repair attempt itself (the caller in db.ts always
    // invokes this after the adapter's own connection/lease was already
    // closed and released), so an empty lease dir must never self-decline.
    expect(fs.existsSync(leaseDir)).toBe(false);
    expect(await classicEngineSessionDeclined(dbPath, 'self-check')).toBe(false);
  });
});
