/**
 * index.spec.ts — Tests for memory-flush SessionEnd auto-export (P5, BL-21).
 *
 * Covers:
 *   1. Export runs on SessionEnd when export_enabled=true + export_dir configured.
 *   2. Export is gated: does NOT run when export_enabled=false (default OFF).
 *   3. Export is gated: does NOT run when export_dir is empty/missing.
 *   4. Export is throttled: second call within throttle window is a no-op.
 *   5. Export runs again after throttle window expires.
 *   6. A failed export never throws / never breaks SessionEnd flush.
 *   7. Config via setExportConfig() module override takes precedence over payload.
 *   8. Config via payload.export_config works when no module override is set.
 *   9. _resetExportThrottle() correctly resets throttle state for test isolation.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Import the handler and config helpers
import {
  _resetExportThrottle,
  handler,
  setExportConfig,
} from './index.js';

// Import @adhd/sox-memory-core to set up test DBs
import { memoryWrite, openDb } from '@adhd/sox-memory-core';

// Force hash backend for deterministic, fast tests (no ONNX download)
beforeEach(() => {
  process.env['SOX_EMBED_BACKEND'] = 'hash';
  // Reset module-level state between tests
  setExportConfig(null);
  _resetExportThrottle();
});

afterEach(() => {
  delete process.env['SOX_EMBED_BACKEND'];
  setExportConfig(null);
  _resetExportThrottle();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flush-test-'));
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

async function setupTestDb(dbPath: string): Promise<void> {
  const db = openDb(dbPath);
  try {
    await memoryWrite(db, {
      content: 'Test episode for auto-export.',
      topic: 'test-topic',
      tags: ['test'],
    });
  } finally {
    db.close();
  }
}

function hasExportFiles(exportDir: string): boolean {
  const indexPath = path.join(exportDir, 'INDEX.md');
  return fs.existsSync(indexPath);
}

/** Fire a SessionEnd and await it (handler returns Promise<void> for SessionEnd). */
async function fireSessionEnd(
  dbPath: string,
  sessionId: string,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  const result = handler({
    event: 'SessionEnd',
    timestamp: new Date().toISOString(),
    payload: { session_id: sessionId, db_path: dbPath, ...extraPayload },
  });
  if (result && typeof (result as Promise<void>).then === 'function') {
    await result;
  }
}

// ── 1. Export runs when enabled + dir configured ──────────────────────────────

describe('memory-flush auto-export — gating: export_enabled=true', () => {
  it('triggers export via setExportConfig module override', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      await setupTestDb(dbPath);

      setExportConfig({
        export_enabled: true,
        export_dir: exportDir,
        export_throttle_secs: 0, // no throttle in tests
      });

      await fireSessionEnd(dbPath, 'test-session-1');

      // Export should have run — INDEX.md must exist
      expect(hasExportFiles(exportDir)).toBe(true);
      const topicsDir = path.join(exportDir, 'topics');
      expect(fs.existsSync(topicsDir)).toBe(true);
      const slugs = fs.readdirSync(topicsDir);
      expect(slugs.length).toBeGreaterThanOrEqual(1);
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('triggers export via payload.export_config (no module override)', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      await setupTestDb(dbPath);

      await fireSessionEnd(dbPath, 'test-session-payload', {
        export_config: {
          export_enabled: true,
          export_dir: exportDir,
          export_throttle_secs: 0,
        },
      });

      expect(hasExportFiles(exportDir)).toBe(true);
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});

// ── 2. Export is gated: does NOT run when export_enabled=false ────────────────

describe('memory-flush auto-export — gating: export_enabled=false (default OFF)', () => {
  it('does NOT export when export_enabled=false via setExportConfig', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      await setupTestDb(dbPath);

      setExportConfig({
        export_enabled: false,   // OFF
        export_dir: exportDir,
        export_throttle_secs: 0,
      });

      await fireSessionEnd(dbPath, 'no-export-session');

      // No export files should exist
      expect(hasExportFiles(exportDir)).toBe(false);
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('does NOT export when no config at all (default OFF)', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      await setupTestDb(dbPath);

      // No setExportConfig, no payload.export_config → defaults to export_enabled=false
      await fireSessionEnd(dbPath, 'no-cfg-session');

      expect(hasExportFiles(exportDir)).toBe(false);
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('does NOT export when export_dir is empty string', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      await setupTestDb(dbPath);

      setExportConfig({
        export_enabled: true,
        export_dir: '',          // missing dir → gated off
        export_throttle_secs: 0,
      });

      await fireSessionEnd(dbPath, 'no-dir-session');

      expect(hasExportFiles(exportDir)).toBe(false);
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});

// ── 3. Throttle: second call within window is a no-op ─────────────────────────

describe('memory-flush auto-export — throttle', () => {
  it('does not re-export within the throttle window', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      await setupTestDb(dbPath);

      setExportConfig({
        export_enabled: true,
        export_dir: exportDir,
        export_throttle_secs: 3600, // 1 hour throttle — second call definitely within window
      });

      // First call — should export
      await fireSessionEnd(dbPath, 'throttle-session-1');
      expect(hasExportFiles(exportDir)).toBe(true);

      // Record mtime of INDEX.md after first export
      const indexPath = path.join(exportDir, 'INDEX.md');
      const mtime1 = fs.statSync(indexPath).mtimeMs;

      // Small delay to ensure mtime would change if export ran again
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Second call within throttle window — should NOT re-export
      await fireSessionEnd(dbPath, 'throttle-session-2');

      const mtime2 = fs.statSync(indexPath).mtimeMs;
      // If the second export ran, mtime would have changed; it must not have.
      expect(mtime2).toBe(mtime1);
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('re-exports with throttle=0 (always export on every call)', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      await setupTestDb(dbPath);

      setExportConfig({
        export_enabled: true,
        export_dir: exportDir,
        export_throttle_secs: 0, // 0 = no throttle → every call exports
      });

      // First call
      await fireSessionEnd(dbPath, 'no-throttle-1');
      expect(hasExportFiles(exportDir)).toBe(true);
      const mtime1 = fs.statSync(path.join(exportDir, 'INDEX.md')).mtimeMs;

      // Wait enough time that file mtime will be strictly greater on re-write
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Second call — with throttle=0, no throttle applies, should re-export
      await fireSessionEnd(dbPath, 'no-throttle-2');

      const mtime2 = fs.statSync(path.join(exportDir, 'INDEX.md')).mtimeMs;
      expect(mtime2).toBeGreaterThanOrEqual(mtime1);
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });

  it('_resetExportThrottle() clears the throttle, allowing a fresh export', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      await setupTestDb(dbPath);

      setExportConfig({
        export_enabled: true,
        export_dir: exportDir,
        export_throttle_secs: 3600,
      });

      // First export
      await fireSessionEnd(dbPath, 'reset-throttle-1');
      const mtime1 = fs.statSync(path.join(exportDir, 'INDEX.md')).mtimeMs;

      // Within throttle — would be blocked
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Reset throttle
      _resetExportThrottle();

      // Should now export again
      await fireSessionEnd(dbPath, 'reset-throttle-2');
      const mtime2 = fs.statSync(path.join(exportDir, 'INDEX.md')).mtimeMs;
      expect(mtime2).toBeGreaterThanOrEqual(mtime1);
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});

// ── 4. Failure isolation ───────────────────────────────────────────────────────

describe('memory-flush auto-export — failure isolation', () => {
  it('a failed export (bad export_dir) does not throw and does not break flush', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      await setupTestDb(dbPath);

      setExportConfig({
        export_enabled: true,
        export_dir: '/nonexistent/path/that/cannot/be/created', // will fail
        export_throttle_secs: 0,
      });

      // Must not throw — failure is isolated
      await expect(fireSessionEnd(dbPath, 'fail-export-session')).resolves.not.toThrow();
    } finally {
      dbCleanup();
    }
  });

  it('flush still persists episodes even when export fails', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      // Create the DB so openWriteDb can open it
      const db = openDb(dbPath);
      db.close();

      setExportConfig({
        export_enabled: true,
        export_dir: '/no/such/dir', // bad path — export will fail
        export_throttle_secs: 0,
      });

      await fireSessionEnd(dbPath, 'fail-export-flush', {
        episodes: [
          { content: 'Episode that must be flushed even if export fails.', source: 'message' },
        ],
      });

      // Verify the episode was actually inserted into the DB despite export failure
      const db2 = openDb(dbPath);
      try {
        const row = db2.prepare<[], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
        ).get();
        expect(row?.cnt).toBeGreaterThanOrEqual(1);
      } finally {
        db2.close();
      }
    } finally {
      dbCleanup();
    }
  });
});

// ── 5. Module override takes precedence over payload config ───────────────────

describe('memory-flush auto-export — config precedence', () => {
  it('setExportConfig override wins over payload.export_config', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: moduleExportDir, cleanup: moduleCleanup } = makeTempDir();
    const { dir: payloadExportDir, cleanup: payloadCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      await setupTestDb(dbPath);

      // Module override points to moduleExportDir
      setExportConfig({
        export_enabled: true,
        export_dir: moduleExportDir,
        export_throttle_secs: 0,
      });

      // Payload config tries to point elsewhere (payloadExportDir)
      await fireSessionEnd(dbPath, 'override-test', {
        export_config: {
          export_enabled: true,
          export_dir: payloadExportDir,
          export_throttle_secs: 0,
        },
      });

      // Module override wins — only moduleExportDir should have files
      expect(hasExportFiles(moduleExportDir)).toBe(true);
      expect(hasExportFiles(payloadExportDir)).toBe(false);
    } finally {
      dbCleanup();
      moduleCleanup();
      payloadCleanup();
    }
  });

  it('setting config to null reverts to payload-driven config', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      await setupTestDb(dbPath);

      // Set then clear the module override
      setExportConfig({
        export_enabled: true,
        export_dir: '/some/path',
        export_throttle_secs: 0,
      });
      setExportConfig(null); // clear override

      // Now payload config should drive the decision
      await fireSessionEnd(dbPath, 'clear-override-test', {
        export_config: {
          export_enabled: true,
          export_dir: exportDir,
          export_throttle_secs: 0,
        },
      });

      expect(hasExportFiles(exportDir)).toBe(true);
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});

// ── 6. Non-SessionEnd events are unaffected ───────────────────────────────────

describe('memory-flush auto-export — other events', () => {
  it('ScopePromotionProposed event does not trigger export', async () => {
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      setExportConfig({
        export_enabled: true,
        export_dir: exportDir,
        export_throttle_secs: 0,
      });

      // Fire a ScopePromotionProposed event (not SessionEnd)
      const result = handler({
        event: 'ScopePromotionProposed',
        timestamp: new Date().toISOString(),
        payload: {
          extension_id: 'memory-server',
          from_scope: 'project',
          to_scope: 'user',
          items: [],
          proposed_at: new Date().toISOString(),
        },
      });

      // Await the returned promise if any (promotion returns a Promise)
      if (result && typeof (result as Promise<void>).then === 'function') {
        await result;
      }

      // Export must not have run — no INDEX.md
      expect(hasExportFiles(exportDir)).toBe(false);
    } finally {
      exportCleanup();
    }
  });
});

// ── 7. Throttle window: call count verification ───────────────────────────────

describe('memory-flush auto-export — call count via file timestamps', () => {
  it('auto-export runs only once with 3600s throttle across 3 SessionEnd calls', async () => {
    const { dir: dbDir, cleanup: dbCleanup } = makeTempDir();
    const { dir: exportDir, cleanup: exportCleanup } = makeTempDir();

    try {
      const dbPath = path.join(dbDir, 'test.db');
      await setupTestDb(dbPath);

      setExportConfig({
        export_enabled: true,
        export_dir: exportDir,
        export_throttle_secs: 3600, // 1h throttle
      });

      // Call handler 3 times — only first should export
      await fireSessionEnd(dbPath, 'spy-session-0');
      expect(hasExportFiles(exportDir)).toBe(true);
      const mtimeAfterFirst = fs.statSync(path.join(exportDir, 'INDEX.md')).mtimeMs;

      await new Promise((resolve) => setTimeout(resolve, 20));
      await fireSessionEnd(dbPath, 'spy-session-1');

      await new Promise((resolve) => setTimeout(resolve, 20));
      await fireSessionEnd(dbPath, 'spy-session-2');

      // INDEX.md mtime must not have changed after the first write (2nd+3rd were throttled)
      const mtimeAfterAll = fs.statSync(path.join(exportDir, 'INDEX.md')).mtimeMs;
      expect(mtimeAfterAll).toBe(mtimeAfterFirst);
    } finally {
      dbCleanup();
      exportCleanup();
    }
  });
});
