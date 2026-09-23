/**
 * permission-guard.spec.ts — Unit tests for the mcp-path-guard enforcement.
 *
 * These tests exercise the policy guard inserted in handleToolCall BEFORE the
 * getDb/openDb sink. They set [def:policy-env] directly in process.env so no
 * live supervisor is required.
 *
 * Covers:
 *   [mcp-path-guard.1] denied db_path → isError: true AND no file/dir created
 *   [mcp-path-guard.2] allowed db_path → succeeds (no isError)
 *   [mcp-path-guard.3] guard runs BEFORE getDb/openDb — no DB file/dir on denial
 *   [mcp-path-guard.4] legacy/dev compat — no SOX_PERM_ENFORCE → any path opens
 *   [mcp-path-guard.5] compilePolicyFromEnv sourced consistently with policy-core
 *
 * [ref:guard-before-sink]: the guard MUST run before openDb, which does mkdirSync
 * then opens. A denied call that reaches the sink would CREATE a directory as a
 * side effect. We assert the path does NOT exist afterward on denial.
 *
 * [def:enforcement-opt-in]: when SOX_PERM_ENFORCE is absent the legacy path is
 * unchanged — any db_path is opened as before. This keeps the pre-existing tests
 * green ([inv:no-regress]).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// These tests assert db_path permission ENFORCEMENT, not embedding quality.
//
// BL-412-adjacent fix: this comment used to claim the suite "pin[s] the
// fast, deterministic hash backend so a memory_write's cold real-ONNX model
// load never tips the default 5s test timeout" — but no code anywhere in
// this file ever set that (and the "hash backend" it describes was removed
// entirely by BL-250; `EmbedBackend` is `'auto' | 'real'` only, see
// libs/memory-core/src/embed.ts). The claim was false: every `memory_write`
// call in this file ran the REAL bge-base-en-v1.5 ONNX backend, cold-loading
// it repeatedly. Harmless on an idle machine; under concurrent load
// (multiple agents/processes competing for CPU — exactly BL-405's own
// finding about this repo) that cold load blew the 30s test timeout outright
// (`Error: Test timed out in 30000ms`, observed on 5 of this file's tests in
// a loaded run). Fixed for real via the BL-161 deterministic provider seam
// (`_setEmbedProviderForTest` / `DeterministicTestProvider`, the same
// mechanism async-embed.spec.ts uses) — no ONNX, no wall-clock dependency,
// no permission-guard/ONNX-worker-thread interaction.

// ── Import the testable internals ─────────────────────────────────────────────
// We test via the exported handleToolCall and compilePolicyFromEnv. The guard
// logic lives in index.ts; compilePolicyFromEnv comes from policy-guard.ts (the
// vendored minimal implementation inside this extension, [mcp-path-guard.5]).
import { DeterministicTestProvider, openDb, _setEmbedProviderForTest } from '@adhd/sox-memory-core';
import { compilePolicyFromEnv, handleToolCall } from './index.js';

beforeAll(() => {
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterAll(() => {
  _setEmbedProviderForTest(null);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Set [def:policy-env] on process.env and return a cleanup function.
 * fsWritePatterns controls SOX_PERM_FS_WRITE (deny-by-default when declared).
 */
function setEnforceEnv(opts: {
  fsWrite: string[];
  fsRead?: string[];
  socket?: string[];
  network?: string[];
}): () => void {
  const saved: Record<string, string | undefined> = {};
  const set = (k: string, v: string) => {
    saved[k] = process.env[k];
    process.env[k] = v;
  };
  set('SOX_PERM_ENFORCE', '1');
  set('SOX_PERM_FS_WRITE', JSON.stringify(opts.fsWrite));
  set('SOX_PERM_FS_READ', JSON.stringify(opts.fsRead ?? opts.fsWrite));
  set('SOX_PERM_SOCKET', JSON.stringify(opts.socket ?? []));
  set('SOX_PERM_NETWORK', JSON.stringify(opts.network ?? []));
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  };
}

/** Remove SOX_PERM_* env from process.env and return cleanup. */
function clearEnforceEnv(): () => void {
  const keys = ['SOX_PERM_ENFORCE', 'SOX_PERM_FS_WRITE', 'SOX_PERM_FS_READ', 'SOX_PERM_SOCKET', 'SOX_PERM_NETWORK'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
  };
}

/** A db_path OUTSIDE the declared allowlist — [fix:evil-db] */
const EVIL_DB = `/tmp/sox-c6-evil-${process.pid}.db`;

/**
 * BL-412-adjacent fix: the "allowed db_path" test proves the `~/.memory/**`
 * ALLOW branch of the permission guard by writing a real, non-guessed
 * `db_path` — but that path used to be computed against the REAL
 * `os.homedir()`, so "prove the allowlist admits a `~/.memory/**` path"
 * meant literally writing a scratch `.db`/`.db-wal`/`.db-shm` file into the
 * user's actual live `~/.memory` directory on every test run. Caught by the
 * whole-suite BL-412 guard in vitest.setup.ts (which fails on ANY fs touch
 * under the real `~/.memory`, not just the memory_ping default-guess path
 * BL-412 itself was filed against).
 *
 * Fix: point `os.homedir()` at a scratch directory for the lifetime of this
 * file by overriding `process.env.HOME` — Node's `os.homedir()` honors
 * `$HOME` on POSIX, and `~/.memory/**` allowlist-pattern expansion plus the
 * real `expandTilde`/`resolveDbPath` code paths all resolve through
 * `os.homedir()`, so this exercises the EXACT SAME allow-path logic against
 * a directory that just happens not to be the user's real one. Restored in
 * the outer `afterAll` below.
 */
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), `sox-c6-fakehome-${process.pid}-`));
const REAL_HOME = process.env['HOME'];
process.env['HOME'] = FAKE_HOME;

const ALLOWED_DB = path.join(os.homedir(), '.memory', `c6-allowed-${process.pid}.db`);
const ALLOWED_DIR = path.dirname(ALLOWED_DB);

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('permission-guard — mcp-path-guard enforcement', () => {
  // Restore the real HOME and remove the fake-home scratch dir once this
  // file's tests are done. See the FAKE_HOME comment above ALLOWED_DB.
  afterAll(() => {
    if (REAL_HOME === undefined) delete process.env['HOME'];
    else process.env['HOME'] = REAL_HOME;
    try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // BL-53: clean up allowed DB AND its SQLite WAL/SHM sidecars after each test.
  // The sidecars are created by SQLite in WAL mode; they linger when the process
  // is killed before the connection is closed, polluting the fake-home
  // `.memory/` scratch dir with orphaned *.db-wal / *.db-shm files whose
  // base .db is absent.
  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(ALLOWED_DB + suffix, { force: true }); } catch { /* ignore */ }
    }
    // ALLOWED_DIR is inside FAKE_HOME (a scratch dir), not the user's real
    // ~/.memory — the whole FAKE_HOME tree is removed in the outer afterAll.
  });

  // ── [mcp-path-guard.1] + [mcp-path-guard.3] ──────────────────────────────────
  describe('[mcp-path-guard.1] denied db_path returns isError AND creates no file', () => {
    let restoreEnv: () => void;

    beforeEach(() => {
      // Ensure the evil path doesn't exist before the call
      try { fs.rmSync(EVIL_DB, { force: true }); } catch { /* ignore */ }
      // Note: /tmp exists, so we only need to verify the .db file is not created
      restoreEnv = setEnforceEnv({ fsWrite: ['~/.memory/**'], fsRead: ['~/.memory/**'] });
    });

    afterEach(() => {
      restoreEnv();
      try { fs.rmSync(EVIL_DB, { force: true }); } catch { /* ignore */ }
    });

    it('returns isError: true for memory_write with db_path outside allowlist', async () => {
      const result = await handleToolCall('memory_write', {
        db_path: EVIL_DB,
        content: 'should-be-denied',
      }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content).toBeDefined();
      expect(result.content![0]?.text).toMatch(/permission denied/i);
      expect(result.content![0]?.text).toContain(EVIL_DB);
    });

    it('[mcp-path-guard.3] guard runs BEFORE sink: evil db file does NOT exist after denied call', async () => {
      // Call handleToolCall with the forbidden path
      await handleToolCall('memory_write', { db_path: EVIL_DB, content: 'should-be-denied' });

      // The file must NOT exist — openDb was never reached so mkdirSync+open
      // never ran for the evil path ([ref:guard-before-sink])
      expect(fs.existsSync(EVIL_DB), `Evil DB file must not be created at ${EVIL_DB}`).toBe(false);
    });

    it('returns isError: true for memory_recall with db_path outside allowlist', async () => {
      const result = await handleToolCall('memory_recall', {
        db_path: EVIL_DB,
        query: 'should-be-denied',
      }) as { isError?: boolean };

      expect(result.isError).toBe(true);
    });

    it('evil db does not exist after denied memory_recall call', async () => {
      await handleToolCall('memory_recall', { db_path: EVIL_DB, query: 'denied' });
      expect(fs.existsSync(EVIL_DB)).toBe(false);
    });
  });

  // ── [mcp-path-guard.2] ───────────────────────────────────────────────────────
  describe('[mcp-path-guard.2] allowed db_path succeeds', () => {
    let restoreEnv: () => void;

    beforeEach(() => {
      // Ensure the allowed dir exists (it normally does; create if missing)
      fs.mkdirSync(ALLOWED_DIR, { recursive: true });
      restoreEnv = setEnforceEnv({ fsWrite: ['~/.memory/**'], fsRead: ['~/.memory/**'] });
    });

    afterEach(() => {
      restoreEnv();
    });

    it('memory_write with db_path inside allowlist returns no isError', async () => {
      const result = await handleToolCall('memory_write', {
        db_path: ALLOWED_DB,
        content: 'allowed write test',
        project_path: '/test/project',
      }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

      // Should NOT be a permission error — content array has the episode_uid
      expect(result.isError).not.toBe(true);
      expect(result.content).toBeDefined();
      // The result text should contain episode_uid from memoryWrite
      expect(result.content![0]?.text).toContain('episode_uid');
    });
  });

  // ── [mcp-path-guard.4] ───────────────────────────────────────────────────────
  describe('[mcp-path-guard.4] legacy/dev compat — no SOX_PERM_ENFORCE means any path opens', () => {
    let tmpDir: string;
    let tmpDb: string;
    let restoreEnv: () => void;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-c6-legacy-'));
      tmpDb = path.join(tmpDir, 'legacy.db');
      restoreEnv = clearEnforceEnv();
    });

    afterEach(() => {
      restoreEnv();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('memory_write with any db_path succeeds when SOX_PERM_ENFORCE is absent ([inv:no-regress])', async () => {
      const result = await handleToolCall('memory_write', {
        db_path: tmpDb,
        content: 'legacy compat test',
        project_path: '/test/project',
      }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

      // Legacy path: no guard, opens fine
      expect(result.isError).not.toBe(true);
      expect(result.content![0]?.text).toContain('episode_uid');
    });

    it('db file IS created in legacy mode (openDb runs normally)', async () => {
      await handleToolCall('memory_write', { db_path: tmpDb, content: 'legacy' });
      // The file must exist — openDb was reached normally
      expect(fs.existsSync(tmpDb)).toBe(true);
    });
  });

  // ── [mcp-path-guard.5] ───────────────────────────────────────────────────────
  // compilePolicyFromEnv reads from process.env (stable in production; set in
  // beforeEach/afterEach for isolation here — same pattern as the other guard tests).
  describe('[mcp-path-guard.5] compilePolicyFromEnv consistent with policy-core [shape:policy-env]', () => {
    it('denies /tmp/... when allowlist is ~/.memory/**', () => {
      const restore = setEnforceEnv({ fsWrite: ['~/.memory/**'], fsRead: ['~/.memory/**'] });
      try {
        const policy = compilePolicyFromEnv();
        expect(policy.enforced).toBe(true);
        expect(policy.allowsFsWrite('/tmp/sox-evil.db')).toBe(false);
        expect(policy.allowsFsRead('/tmp/sox-evil.db')).toBe(false);
      } finally { restore(); }
    });

    it('allows ~/.memory/... when allowlist is ~/.memory/**', () => {
      const restore = setEnforceEnv({ fsWrite: ['~/.memory/**'], fsRead: ['~/.memory/**'] });
      try {
        const policy = compilePolicyFromEnv();
        const allowedPath = path.join(os.homedir(), '.memory', 'test.db');
        expect(policy.allowsFsWrite(allowedPath)).toBe(true);
        expect(policy.allowsFsRead(allowedPath)).toBe(true);
      } finally { restore(); }
    });

    it('returns enforced=false when enforce flag is absent', () => {
      const restore = clearEnforceEnv();
      try {
        const policy = compilePolicyFromEnv();
        expect(policy.enforced).toBe(false);
        expect(policy.allowsFsWrite('/tmp/anything.db')).toBe(true);
      } finally { restore(); }
    });

    it('deny-by-default: empty fs.write array denies all paths when enforced', () => {
      const restore = setEnforceEnv({ fsWrite: [], fsRead: [] });
      try {
        const policy = compilePolicyFromEnv();
        expect(policy.enforced).toBe(true);
        expect(policy.allowsFsWrite(path.join(os.homedir(), '.memory', 'test.db'))).toBe(false);
      } finally { restore(); }
    });
  });
});

// ── BL-13 auto_chunk ──────────────────────────────────────────────────────────

describe('memory_write auto_chunk — BL-13', () => {
  let tmpDir: string;
  let tmpDb: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-chunk-'));
    tmpDb = path.join(tmpDir, 'chunk.db');
    restoreEnv = clearEnforceEnv();
  });

  afterEach(() => {
    restoreEnv();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('short content returns single episode_uid (below chunk threshold)', async () => {
    const result = await handleToolCall('memory_write', {
      db_path: tmpDb,
      content: 'Short content that does not need chunking.',
      project_path: '/test/project',
    }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content![0]!.text);
    expect(parsed).toHaveProperty('episode_uid');
    // No chunk_uids for short content
    expect(parsed.chunk_uids).toBeUndefined();
  });

  it('long content auto-chunks into parent + chunks with DERIVED_FROM edges, inheriting topic/tags (backlog 29f3a4d5)', async () => {
    // Craft content long enough to be split at chunk_size=20 tokens (~80 chars per chunk)
    const longContent =
      'The first sentence covers topic A. ' +
      'The second sentence covers topic B. ' +
      'The third sentence covers topic C. ' +
      'The fourth sentence covers topic D. ' +
      'The fifth sentence covers topic E.';

    const explicitTOccurred = '2020-01-01T00:00:00.000Z';
    const result = await handleToolCall('memory_write', {
      db_path: tmpDb,
      content: longContent,
      chunk_size: 20, // small chunk size to force splitting
      project_path: '/test/project',
      topic: 'chunk-inherit-test',
      tags: ['inherit-tag-a', 'inherit-tag-b'],
      importance: 8,
      t_occurred: explicitTOccurred,
      name: 'parent-title-must-not-leak-to-chunks',
    }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content![0]!.text) as {
      episode_uid: string;
      chunk_uids: string[];
      chunk_count: number;
    };

    // Must have a parent uid and at least 2 chunks
    expect(parsed).toHaveProperty('episode_uid');
    expect(parsed).toHaveProperty('chunk_uids');
    expect(parsed).toHaveProperty('chunk_count');
    expect(parsed.chunk_count).toBeGreaterThan(1);
    expect(parsed.chunk_uids.length).toBe(parsed.chunk_count);

    // Verify DERIVED_FROM edges exist in the DB, and every chunk inherited the
    // parent's topic/tags/importance/t_occurred (backlog 29f3a4d5: chunks
    // previously landed with topic:null, tags:[], making them unreachable by
    // filtered recall) — but NOT the parent's name (re-review 2026-09-22,
    // item 3: dropped, see index.ts's chunkParams comment for why).
    //
    // NOTE: this assumes none of the chunks took the E_DEDUP path (memoryWrite
    // returning a pre-existing uid instead of inserting a new row). A row
    // reached via E_DEDUP carries whatever fields its ORIGINAL write set, not
    // these inherited values, so if a future edit to `longContent` makes any
    // chunk collide by content_hash with a pre-existing row from an earlier
    // test/run, these per-chunk assertions will fail confusingly on THAT
    // chunk alone rather than on a real inheritance regression — check
    // content_hash / dedup before assuming the fix broke.
    const adapter = await openDb(tmpDb);
    try {
      const db = adapter.unwrap() as Database.Database;
      const edgeCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM edge WHERE rel = 'DERIVED_FROM' AND t_expired IS NULL`,
      ).get() as { cnt: number };
      expect(edgeCount.cnt).toBe(parsed.chunk_count);

      // Every chunk row must carry the parent's topic, tags, importance, and
      // t_occurred — and must NOT carry the parent's name.
      const placeholders = parsed.chunk_uids.map(() => '?').join(',');
      const chunkRows = db.prepare(
        `SELECT uid, topic, tags, importance, t_occurred, name, enrich_ver FROM node WHERE uid IN (${placeholders})`,
      ).all(...parsed.chunk_uids) as Array<{
        uid: string;
        topic: string | null;
        tags: string | null;
        importance: number | null;
        t_occurred: string | null;
        name: string | null;
        enrich_ver: string | null;
      }>;
      expect(chunkRows.length).toBe(parsed.chunk_uids.length);
      for (const row of chunkRows) {
        expect(row.topic).toBe('chunk-inherit-test');
        expect(row.tags).not.toBeNull();
        // Exact match, not arrayContaining — arrayContaining would also pass
        // if a chunk picked up EXTRA or reordered tags from somewhere else.
        const parsedTags = JSON.parse(row.tags!) as string[];
        expect(parsedTags).toEqual(['inherit-tag-a', 'inherit-tag-b']);

        expect(row.importance).toBe(8);
        // The importance inheritance freezes the chunk out of batch importance
        // recompute the same way it does the parent (enrich.ts's userOverride
        // path) — assert the stamp that IS the mechanism making that freeze
        // permanent, not just the surface importance value.
        expect(row.enrich_ver).not.toBeNull();
        const enrichVer = JSON.parse(row.enrich_ver!) as { note?: string };
        expect(enrichVer.note).toBe('user_override');

        expect(row.t_occurred).toBe(explicitTOccurred);

        // name must NOT be inherited (re-review 2026-09-22, item 3).
        expect(row.name).toBeNull();
      }

      // Guard against a derived_from_uid/edge regression while fixing this:
      // each chunk must still have a live DERIVED_FROM edge to the parent.
      const parentRow = db.prepare('SELECT rowid FROM node WHERE uid = ?').get(parsed.episode_uid) as { rowid: number };
      for (const chunkUid of parsed.chunk_uids) {
        const chunkRow = db.prepare('SELECT rowid FROM node WHERE uid = ?').get(chunkUid) as { rowid: number };
        const edge = db.prepare(
          `SELECT 1 FROM edge WHERE src = ? AND dst = ? AND rel = 'DERIVED_FROM' AND t_expired IS NULL`,
        ).get(chunkRow.rowid, parentRow.rowid);
        expect(edge).toBeTruthy();
      }
    } finally {
      (adapter.unwrap() as Database.Database).close();
    }
  }, 30_000);

  it('auto-chunks resolve topic from a `[prefix]` on content (not just a caller-supplied topic arg) on every chunk (backlog 29f3a4d5 blocker 1)', async () => {
    // No `topic` arg supplied — topic must be resolved from the leading
    // `[prefix]` on the PARENT's full content (enrich.ts E5) and that
    // RESOLVED value must land on every chunk, not just chunk 0 (which could
    // otherwise coincidentally rescue it from its own leading text — chunks
    // 1..N never start with the prefix and have no other way to resolve it).
    const longContentWithPrefix =
      '[prefix-topic] The first sentence covers topic A. ' +
      'The second sentence covers topic B. ' +
      'The third sentence covers topic C. ' +
      'The fourth sentence covers topic D. ' +
      'The fifth sentence covers topic E.';

    const result = await handleToolCall('memory_write', {
      db_path: tmpDb,
      content: longContentWithPrefix,
      chunk_size: 20,
      project_path: '/test/project',
      // topic intentionally omitted — must be resolved from the prefix.
    }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content![0]!.text) as {
      episode_uid: string;
      chunk_uids: string[];
      chunk_count: number;
    };
    expect(parsed.chunk_count).toBeGreaterThan(1);

    const adapter = await openDb(tmpDb);
    try {
      const db = adapter.unwrap() as Database.Database;
      const parentRow = db.prepare('SELECT topic FROM node WHERE uid = ?').get(parsed.episode_uid) as { topic: string | null };
      expect(parentRow.topic).toBe('prefix-topic');

      const placeholders = parsed.chunk_uids.map(() => '?').join(',');
      const chunkRows = db.prepare(
        `SELECT uid, topic FROM node WHERE uid IN (${placeholders})`,
      ).all(...parsed.chunk_uids) as Array<{ uid: string; topic: string | null }>;
      expect(chunkRows.length).toBe(parsed.chunk_uids.length);
      for (const row of chunkRows) {
        // Every chunk — not just chunk 0 — must carry the RESOLVED topic.
        expect(row.topic).toBe('prefix-topic');
      }
    } finally {
      (adapter.unwrap() as Database.Database).close();
    }
  }, 30_000);

  it('custom chunk_size controls the split threshold', async () => {
    // chunk_size=1000 means ~4000 chars before splitting — this short content won't split
    const result = await handleToolCall('memory_write', {
      db_path: tmpDb,
      content: 'Normal write with large chunk_size. Should not be split.',
      chunk_size: 1000,
      project_path: '/test/project',
    }) as { isError?: boolean; content?: Array<{ type: string; text: string }> };

    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content![0]!.text);
    expect(parsed).toHaveProperty('episode_uid');
    expect(parsed.chunk_uids).toBeUndefined();
  });
});
