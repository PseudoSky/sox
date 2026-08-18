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
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl, TursoAdapterImpl, ESqliteNativeStore } from '@adhd/sox-store-adapter';
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
  it('BL-580: a fresh (never-opened) turso store reads engineIdentity as null and does NOT permanently cache that null — it resolves once the first real operation stamps the marker', async () => {
    const dbPath = tempPath('identity');
    // (DEBT-003, lazy-connect) connect() opens no driver connection and stamps
    // NO `_sox_engine` marker — that now happens on the adapter's first real
    // operation. createGraphBackend() still reads `engineIdentity` eagerly
    // right after construction (BL-508's fail-at-open contract), so on this
    // never-opened instance the marker genuinely does not exist yet: `null`
    // here means "not yet known", not "confirmed unmarked". The original
    // BL-508 expectation — non-null immediately after connect(), with no
    // operation ever performed — encoded a guarantee lazy-connect no longer
    // makes and that BL-508 never actually needed: its real guarantee is
    // fail-CLOSED on a genuine marker MISMATCH (covered by the next test
    // below), which is unaffected because that check reads the
    // `application_id` header eagerly at `connect()` time, independent of
    // whether `_sox_engine` has been stamped.
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    openAdapters.push(adapter);

    const backend = createGraphBackend(adapter);
    expect(backend.engineIdentity).toBeNull();

    // Before the BL-580 fix, that `null` read above was memoised forever in
    // `_engineIdentity`, so `engineIdentity` would keep returning `null` even
    // after the adapter opened for real and stamped the marker. Force the
    // adapter's first real operation (this is what stamps `_sox_engine`) and
    // assert the getter recovers instead of staying permanently stuck.
    await adapter.executeGet('SELECT 1');

    expect(backend.engineIdentity).not.toBeNull();
    expect(backend.engineIdentity!.engine).toBe('turso');
    expect(typeof backend.engineIdentity!.sox_version).toBe('string');
    expect(Number.isNaN(Date.parse(backend.engineIdentity!.first_opened_at))).toBe(false);

    // Now that identity is genuinely resolved, it must be cached — a second
    // read must be the SAME object, not a fresh probe.
    expect(backend.engineIdentity).toBe(backend.engineIdentity);
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
});
