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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Import the testable internals ─────────────────────────────────────────────
// We test via the exported handleToolCall and compilePolicyFromEnv. The guard
// logic lives in index.ts; compilePolicyFromEnv comes from policy-guard.ts (the
// vendored minimal implementation inside this extension, [mcp-path-guard.5]).
import { handleToolCall, compilePolicyFromEnv } from './index.js';

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

/** A db_path INSIDE the declared allowlist — [fix:allowed-db] */
const ALLOWED_DB = path.join(os.homedir(), '.memory', `c6-allowed-${process.pid}.db`);
const ALLOWED_DIR = path.dirname(ALLOWED_DB);

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('permission-guard — mcp-path-guard enforcement', () => {
  // Clean up allowed DB after tests to leave no test artefacts
  afterEach(() => {
    try { fs.rmSync(ALLOWED_DB, { force: true }); } catch { /* ignore */ }
    // Do NOT remove ALLOWED_DIR (~/.memory/) — it is the user's own dir
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
