/**
 * BL-33e3a8e5 — `close()` is re-entrant: concurrent callers share ONE teardown.
 *
 * Before the fix both adapters opened `close()` with `if (this.closed) return;`
 * and then awaited `releaseDeepVerify(this)` before anything set `closed`. That
 * await is a microtask gap even when no verifier runs, so a second concurrent
 * `close()` passed the guard too and ran the whole teardown again: a second
 * checkpoint, a second driver close, a second open-marker clear.
 *
 * RED (fix disabled — `close()` reverted to the bare `closed` guard): the
 * teardown entry below is observed twice. GREEN: exactly once, and both
 * callers' promises resolve.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import { TursoAdapterImpl } from '../turso-adapter.js';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    process.stderr.write(`[bl-33e3a8e5 test] turso driver unavailable: ${String(err)}\n`);
    return false;
  }
})();

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bl-33e3a8e5-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('BL-33e3a8e5 — concurrent close() runs the teardown exactly once', () => {
  it('SqliteAdapterImpl: two concurrent close() calls close the driver once', async () => {
    const adapter = new SqliteAdapterImpl(join(tmpDir, 'sqlite.db'), {});
    await adapter.init();
    await adapter.executeRun('CREATE TABLE IF NOT EXISTS t (x INTEGER)');
    const db = (adapter as unknown as { db: { close: () => unknown } }).db;
    const realClose = db.close.bind(db);
    let driverCloses = 0;
    db.close = () => {
      driverCloses++;
      return realClose();
    };
    await Promise.all([adapter.close(), adapter.close(), adapter.close()]);
    expect(driverCloses).toBe(1);
    // A later call after settlement is still a no-op.
    await adapter.close();
    expect(driverCloses).toBe(1);
  });

  (hasTurso ? it : it.skip)('TursoAdapterImpl: two concurrent close() calls run the connection teardown once', async () => {
    const adapter = await TursoAdapterImpl.connect({ dbPath: join(tmpDir, 'turso.db') });
    await adapter.executeRun('CREATE TABLE IF NOT EXISTS t (x INTEGER)'); // first use = real open
    const inst = adapter as unknown as { _closeConnection: () => Promise<void> };
    const realTeardown = inst._closeConnection.bind(adapter);
    let teardowns = 0;
    inst._closeConnection = () => {
      teardowns++;
      return realTeardown();
    };
    await Promise.all([adapter.close(), adapter.close(), adapter.close()]);
    expect(teardowns).toBe(1);
    await adapter.close();
    expect(teardowns).toBe(1);
  });
});
