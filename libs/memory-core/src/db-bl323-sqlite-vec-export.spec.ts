/**
 * db-bl323-sqlite-vec-export.spec.ts — BL-323 regression.
 *
 * `sqlite-vec` (installed 0.1.9) has NO default export — only the named
 * exports `load` and `getLoadablePath`:
 *
 *   $ node -e "import('sqlite-vec').then(m=>console.log(Object.keys(m), typeof m.default))"
 *   keys: [ 'getLoadablePath', 'load' ] | default: undefined
 *
 * `db.ts` used to destructure a non-existent default export at three call
 * sites (`dropVec0ViaBetterSqlite3`, the sqlite branch of `openDb`, and
 * `openDbReadOnly`):
 *
 *   const { default: sqliteVec } = await import('sqlite-vec');
 *   sqliteVec.load(rawDb);   // TypeError: Cannot read properties of undefined
 *
 * This pinned every sqlite-backed `openDb()`/`openDbReadOnly()` call —
 * fix-recall identified it as the dominant cause of the ~266 memory-core
 * test failures observed after the Turso wiring restore (separate from the
 * pre-existing unawaited-openDb test debt).
 *
 * This spec asserts the installed package's actual export shape (so a
 * future sqlite-vec upgrade that reintroduces/removes a default export is
 * caught immediately) AND exercises the real `openDb()`/`openDbReadOnly()`
 * sqlite path end-to-end — which is exactly the path that threw before the
 * fix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, openDbReadOnly, closeAllAdapters } from './db.js';

describe('BL-323 — sqlite-vec has no default export', () => {
  it('the installed sqlite-vec package exports load/getLoadablePath as named exports, not a default', async () => {
    const mod = await import('sqlite-vec');
    expect(typeof mod.load).toBe('function');
    expect(typeof mod.getLoadablePath).toBe('function');
    // This is the crux of BL-323: `{ default: sqliteVec }` silently binds
    // `sqliteVec` to `undefined` for this package — no destructure of a
    // nonexistent default should ever be trusted to throw at import time.
    expect((mod as Record<string, unknown>)['default']).toBeUndefined();
  });
});

describe('BL-323 regression — openDb()/openDbReadOnly() on the sqlite path load sqlite-vec without throwing', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  it('openDb() on a fresh sqlite store does not throw (regression: TypeError reading .load of undefined)', async () => {
    process.env['STORE_ADAPTER'] = 'sqlite';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl323-openDb-'));
    const dbPath = path.join(dir, 'm.db');

    const adapter = await openDb(dbPath);
    expect(adapter.config.type).toBe('sqlite');

    // Prove sqlite-vec actually loaded: vec_node is a real usable virtual
    // table, not a table whose extension silently failed to attach.
    const row = await adapter.executeGet<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vec_node'`,
    );
    expect(row?.name).toBe('vec_node');
  });

  it('openDbReadOnly() on an existing sqlite store does not throw (regression: same undefined .load bug)', async () => {
    process.env['STORE_ADAPTER'] = 'sqlite';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl323-openDbRO-'));
    const dbPath = path.join(dir, 'm.db');

    // Create the store for-write first so there's something to reopen read-only.
    await openDb(dbPath);

    const roAdapter = await openDbReadOnly(dbPath);
    expect(roAdapter.config.type).toBe('sqlite');
    const row = await roAdapter.executeGet<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='node'`,
    );
    expect(row?.name).toBe('node');
  });
});
