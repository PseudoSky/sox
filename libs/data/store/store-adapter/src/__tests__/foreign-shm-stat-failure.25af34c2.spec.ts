/**
 * 25af34c2 — a non-ENOENT stat failure on the `-shm` sidecar must NOT escalate
 * into `EForeignSqliteSidecar` via the open path's bounded retry loop.
 *
 * 41c8ba34 made `reconcileForeignSqliteShm` trace a non-ENOENT stat failure and
 * return a `declined` result. The caller (`TursoAdapterImpl._openReal`) treated
 * EVERY decline as "retry, then refuse", so an EACCES/EIO stat on a sidecar that
 * may not even exist made an otherwise-healthy store unopenable. The fix
 * discriminates the decline kinds (`declineKind`) and routes the open through
 * `foreignShmOpenAction`: `stat_unprovable` proceeds, a PROVEN live classic
 * holder (`locked`) still refuses.
 *
 * RED (fix disabled — caller back to `if (shm.declined === undefined) break;`):
 * the integration arm throws EForeignSqliteSidecar after the retry bound.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const forced = vi.hoisted(() => ({ mode: 'passthrough' as 'passthrough' | 'stat_unprovable' | 'locked' }));

vi.mock('../wal-ownership.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wal-ownership.js')>();
  return {
    ...actual,
    reconcileForeignSqliteShm: (dbPath: string, opts?: Parameters<typeof actual.reconcileForeignSqliteShm>[1]) => {
      if (forced.mode === 'stat_unprovable') {
        return {
          reconciled: false,
          declined: 'stat of the -shm sidecar failed unexpectedly (EACCES): forced by 25af34c2 spec',
          declineKind: 'stat_unprovable' as const,
        };
      }
      if (forced.mode === 'locked') {
        return {
          reconciled: false,
          declined: 'a LIVE classic SQLite connection holds the -shm (forced by 25af34c2 spec)',
          declineKind: 'locked' as const,
          lockState: 'locked' as const,
        };
      }
      return actual.reconcileForeignSqliteShm(dbPath, opts);
    },
  };
});

import { TursoAdapterImpl } from '../turso-adapter.js';
import { EForeignSqliteSidecar, foreignShmOpenAction, reconcileForeignSqliteShm } from '../wal-ownership.js';

const require = createRequire(import.meta.url);
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
  tmpDir = mkdtempSync(join(tmpdir(), '25af34c2-'));
});
afterAll(() => {
  forced.mode = 'passthrough';
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('25af34c2 — foreignShmOpenAction distinguishes the decline kinds', () => {
  it('stat_unprovable proceeds; locked / in_use / rename_failed retry; reconciled and absent are not declines', () => {
    expect(foreignShmOpenAction({ reconciled: false })).toBe('proceed');
    expect(foreignShmOpenAction({ reconciled: true, renamedTo: '/x-shm.stale' })).toBe('reconciled');
    expect(
      foreignShmOpenAction({ reconciled: false, declined: 'stat failed', declineKind: 'stat_unprovable' }),
    ).toBe('proceed');
    for (const kind of ['locked', 'in_use', 'rename_failed'] as const) {
      expect(foreignShmOpenAction({ reconciled: false, declined: kind, declineKind: kind })).toBe('retry');
    }
  });

  it('the real reconcile tags a proven-locked decline as `locked` (unchanged refusal path)', () => {
    // Passthrough: the real function. A -shm is needed for the lock branch.
    const dbPath = join(tmpDir, 'locked-kind.db');
    require('node:fs').writeFileSync(dbPath + '-shm', Buffer.alloc(32768));
    const r = reconcileForeignSqliteShm(dbPath, { foreignHolderLock: 'locked' });
    expect(r.reconciled).toBe(false);
    expect(r.declineKind).toBe('locked');
    const inUse = reconcileForeignSqliteShm(dbPath, { foreignHolderLock: 'indeterminate', storeInUse: true });
    expect(inUse.declineKind).toBe('in_use');
  });
});

tursoDescribe('25af34c2 — adapter open path', () => {
  it('a stat_unprovable decline does NOT throw EForeignSqliteSidecar — the open proceeds', async () => {
    const dbPath = join(tmpDir, 'stat-unprovable.db');
    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await seed.close();

    forced.mode = 'stat_unprovable';
    try {
      const a = await TursoAdapterImpl.connect({ dbPath });
      try {
        const row = await a.executeGet<{ one: number }>('SELECT 1 AS one');
        expect(row!.one).toBe(1);
      } finally {
        await a.close();
      }
    } finally {
      forced.mode = 'passthrough';
    }
  }, 60_000);

  it('a proven-locked decline still refuses with EForeignSqliteSidecar (negative control)', async () => {
    const dbPath = join(tmpDir, 'locked.db');
    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await seed.close();

    forced.mode = 'locked';
    try {
      // connect() defers the real open to first use (lazy), so the refusal
      // surfaces on the first statement.
      const a = await TursoAdapterImpl.connect({ dbPath });
      try {
        await expect(a.executeGet('SELECT 1 AS one')).rejects.toBeInstanceOf(EForeignSqliteSidecar);
      } finally {
        await a.close().catch((err: unknown) => {
          // A refused open may leave nothing to close — record, don't swallow.
          console.warn('[25af34c2 spec] close after refused open:', err);
        });
      }
    } finally {
      forced.mode = 'passthrough';
    }
  }, 60_000);
});
