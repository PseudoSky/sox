/**
 * (FEAT-SOX-001 constraint / publish-readiness B6) Regression test —
 * `multiprocess_wal` must be **opt-in**, not opt-out.
 *
 * `TursoAdapterImpl.connect()` shipped it opt-OUT:
 *
 *     if (opts.experimental?.multiprocessWal !== false) experiments.push('multiprocess_wal');
 *     multiprocessWrite: opts.experimental?.multiprocessWal ?? true
 *
 * so every caller that never mentioned the flag — which is every caller, and
 * every third-party consumer of the published `@adhd/sox-store-adapter` —
 * silently got an experimental, format-versioned, MVCC-incompatible
 * cross-process WAL coordination layer. FEAT-SOX-001's own constraint list
 * says verbatim: *"Multi-process WAL must be opt-in (experimental, not
 * default)."*
 *
 * The risk is measured, not theoretical: BL-373 is a real incident in which a
 * stale `-tshm` sidecar made a store **permanently unopenable** after an
 * ordinary restart and crash-looped the backend, requiring the bespoke
 * recovery path that now lives in `connect()`. Turso additionally rejects
 * `VACUUM` on a multiprocess-WAL store and refuses MVCC alongside it.
 *
 * This suite pins three things, because the defect is a *default* and defaults
 * regress silently:
 *   1. an unspecified `experimental` gets `multiprocessWrite: false`;
 *   2. an explicit `true` still works end-to-end (the capability is intact —
 *      this was a default change, not a removal);
 *   3. `index_method` survives both branches, so FTS is never collateral
 *      damage of the opt-in decision (the BL-321 failure mode).
 *
 * Watched red→green (BL-225): with `!== false` / `?? true` restored in
 * `turso-adapter.ts`, cases 1 and the `undefined`/`false` rows of the table
 * fail with `expected true to be false`. With the opt-in fix, 5/5 green.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-mpwal-optin-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

const openAdapters: TursoAdapterImpl[] = [];

async function connect(
  dbPath: string,
  experimental?: { multiprocessWal?: boolean },
): Promise<TursoAdapterImpl> {
  const adapter = await TursoAdapterImpl.connect(
    experimental === undefined ? { dbPath } : { dbPath, experimental },
  );
  openAdapters.push(adapter);
  return adapter;
}

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

tursoDescribe('TursoAdapterImpl — multiprocess_wal is opt-in (FEAT-SOX-001)', () => {
  it('a caller that never mentions the flag does NOT get multiprocess_wal', async () => {
    const adapter = await connect(tempPath('default-off'));
    expect(adapter.capabilities.multiprocessWrite).toBe(false);
  });

  it.each([
    { label: 'experimental omitted entirely', experimental: undefined, expected: false },
    { label: 'experimental: {} (present but silent)', experimental: {}, expected: false },
    {
      label: 'multiprocessWal: undefined (explicitly unset)',
      experimental: { multiprocessWal: undefined },
      expected: false,
    },
    {
      label: 'multiprocessWal: false (explicit opt-out)',
      experimental: { multiprocessWal: false },
      expected: false,
    },
    {
      label: 'multiprocessWal: true (explicit opt-in)',
      experimental: { multiprocessWal: true },
      expected: true,
    },
  ])(
    'capabilities.multiprocessWrite is $expected when $label',
    async ({ experimental, expected }) => {
      const adapter = await connect(
        tempPath(`caps-${String(expected)}`),
        experimental as { multiprocessWal?: boolean } | undefined,
      );
      expect(adapter.capabilities.multiprocessWrite).toBe(expected);
    },
  );

  it('opting in still works end-to-end — this was a default change, not a removal', async () => {
    const dbPath = tempPath('optin-roundtrip');
    const adapter = await connect(dbPath, { multiprocessWal: true });
    expect(adapter.capabilities.multiprocessWrite).toBe(true);

    await adapter.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
    await adapter.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [1, 'hello world']);
    const rows = await adapter.executeAll<{ id: number }>('SELECT id FROM node');
    expect(rows.rows.map((r) => r.id)).toEqual([1]);

    // The reported capability must describe the connection that actually
    // opened, so a `config` round-trip carries the caller's opt-in.
    expect(adapter.config.experimental).toEqual({ multiprocessWal: true });
  });

  it('index_method survives BOTH branches — FTS is never collateral damage of the default flip', async () => {
    for (const experimental of [undefined, { multiprocessWal: true }]) {
      const adapter = await connect(
        tempPath(`fts-${experimental ? 'optin' : 'default'}`),
        experimental,
      );
      await adapter.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
      await adapter.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [1, 'hello world']);
      // Throws "index method is an experimental feature" if index_method was
      // clobbered by the multiprocess_wal branch.
      await adapter.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")');
      const hit = await adapter.executeAll<{ id: number }>(
        'SELECT id FROM node WHERE fts_match(content, ?)',
        ['hello'],
      );
      expect(hit.rows.map((r) => r.id)).toEqual([1]);
    }
  });
});
