/**
 * (BL-508) Foreign-engine guard + engine identity — graph-store open path.
 *
 * `createGraphBackend` (the graph-store open path; the backlog store's
 * `openGraphBacklogStore` wires through it on the debt-soxgraph branches) is
 * fail-closed against a foreign-engine marker: a turso-owned store whose
 * marker claims SQLite ownership refuses at open with the typed
 * `ESqliteNativeStore`. The open result carries the store's engine identity
 * (`engineIdentity` — engine, sox_version, driver_version, first_opened_at,
 * last_opened_at) so graph-store consumers surface client/engine version
 * tracking without re-probing.
 *
 * Marker mechanics (write-once, refusal, version-mismatch warning) are pinned
 * by the store-adapter suite; this suite pins the graph-store surface with
 * real engines.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl, TursoAdapterImpl, ESqliteNativeStore, readEngineIdentityViaAdapter } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from './index.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bl508-gs-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

const openAdapters: StoreAdapter[] = [];
afterEach(async () => {
  while (openAdapters.length > 0) {
    const a = openAdapters.pop()!;
    try {
      await a.close();
    } catch {
      // already closed
    }
  }
});

tursoDescribe('BL-508 graph-store open path — engine identity + guard (f, d)', () => {
  it('BL-580/BUG-026: a turso store reads engineIdentity as null on the sync getter (no poisoner open) and resolves identity through the async adapter path once the first operation stamps the marker', async () => {
    const dbPath = tempPath('identity');
    // (DEBT-003, lazy-connect) connect() opens no driver connection and stamps
    // NO `_sox_engine` marker — that now happens on the adapter's first real
    // operation. createGraphBackend() still reads `engineIdentity` eagerly
    // right after construction (BL-508's fail-at-open contract), so on this
    // never-opened instance the marker genuinely does not exist yet: `null`
    // here means "not yet known", not "confirmed unmarked".
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    openAdapters.push(adapter);

    const backend = createGraphBackend(adapter);
    expect(backend.engineIdentity).toBeNull();

    // (BUG-026) The sync getter NEVER opens better-sqlite3 against a turso
    // store — that readonly open was the 'exp9 poisoner' (it created the
    // classic `-shm` on the turso store on every construction). Turso identity
    // resolution is async-only via `readEngineIdentityViaAdapter`, so the sync
    // getter stays null even after the marker is stamped.
    await adapter.executeGet('SELECT 1');

    expect(backend.engineIdentity).toBeNull();
    const identity = await readEngineIdentityViaAdapter(adapter);
    expect(identity).not.toBeNull();
    expect(identity!.engine).toBe('turso');
    expect(typeof identity!.sox_version).toBe('string');
    expect(Number.isNaN(Date.parse(identity!.first_opened_at))).toBe(false);
  });

  it('a sqlite-marked store opened by a turso adapter fails closed at open (E_SQLITE_NATIVE_STORE)', async () => {
    const dbPath = tempPath('fail-closed');
    // SQLite-owned store (stamps the SOXS marker on init).
    const sqliteAdapter = new SqliteAdapterImpl(dbPath);
    await sqliteAdapter.init();
    await sqliteAdapter.close();

    // Simulate a bypassed connect-time refusal: the deliberate-migration
    // escape hatch opens the foreign store — graph-store's own fail-closed
    // guard must still refuse, defense-in-depth for direct-adapter consumers.
    const tursoAdapter = await TursoAdapterImpl.connect({ dbPath, allowForeignEngine: true });
    openAdapters.push(tursoAdapter);

    expect(() => createGraphBackend(tursoAdapter)).toThrow(ESqliteNativeStore);
  });

  it('an in-memory sqlite backend has no engine identity (dbPath absent) and is unaffected', async () => {
    const adapter = new SqliteAdapterImpl(':memory:');
    openAdapters.push(adapter);
    const backend = createGraphBackend(adapter);
    expect(backend.engineIdentity).toBeNull();
  });

  it('BUG-026 poisoner closed: a turso GraphBackendImpl creates NO db-shm', async () => {
    const dbPath = tempPath('poisoner-closed');
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    openAdapters.push(adapter);
    await adapter.executeGet('SELECT 1'); // real open, stamps the marker

    expect(existsSync(dbPath + '-shm')).toBe(false);
    // The former poisoner: reading `engineIdentity` used to open better-sqlite3
    // readonly against the turso store, creating the classic `-shm` sidecar.
    const backend = createGraphBackend(adapter);
    void backend.engineIdentity;
    expect(existsSync(dbPath + '-shm')).toBe(false);
  });
});
