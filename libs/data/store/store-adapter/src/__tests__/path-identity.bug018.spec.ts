/**
 * BUG-018 — canonical path identity (SPEC §T4, INV-4).
 *
 * One physical store ⇒ ONE lease dir / marker / quiescence view, whatever
 * path spelling each caller used. Before the fix, `acquireStoreLease(dbPath)`
 * and every `storeQuiescence(dbPath, …)` call keyed off the RAW caller
 * spelling (`leaseDirPath = `${dbPath}.sox-lease.d``), so two processes
 * reaching the same physical db through different spellings (a symlinked
 * directory alias, `/tmp` vs `/private/tmp`, a relative path vs its absolute
 * form, a `~`-expansion difference between a published global CLI and a
 * worktree dist) computed DIFFERENT lease dirs and never saw each other's
 * leases — `storeQuiescence` could report `quiescent: true` while a live
 * peer held the store, and every quiescence-gated destructive op ran under a
 * live peer (BUG-014's poison, recreated).
 *
 * The fix (`path-identity.ts` `canonicalDbPath`, applied ONCE at
 * `TursoAdapter.connect` / `SqliteAdapterImpl`'s open): the canonical form
 * `realpathSync(dirname(dbPath)) + basename(dbPath)` is used for every
 * coordination key (lease, quiescence, open marker, sidecar probes) and
 * becomes the adapter's `config.dbPath`, so the close path and graph-store's
 * repair path inherit it.
 *
 * RED→GREEN staging (BL-225): the adapter-wiring assertions below FAIL with
 * the helper present but the adapters unwired (`config.dbPath` carries the
 * raw alias spelling — e.g. the raw `/var/...` form instead of the
 * `/private/var/...` canonical parent) and PASS once `connect`/the sqlite
 * open canonicalize. Note the divergence mechanism honestly: for a plain
 * DIRECTORY symlink the fs already converges lease dirs/markers (both
 * spellings resolve to the same physical files — verified empirically
 * 2026-08-12), so the observable RED is the coordination KEY strings
 * (`config.dbPath`, `leaseDirPath(config.dbPath)`) diverging; a FILE-level
 * db symlink diverges at the fs level but is deliberately OUT of scope (the
 * basename is preserved so sidecar naming stays aligned with the engines).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import { storeQuiescence, leaseDirPath } from '../store-lease.js';
import {
  storeOpenMarkerPath,
  markStoreOpen,
  hasStoreOpenMarker,
  clearStoreOpenMarker,
} from '../preflight.js';
import { canonicalDbPath } from '../path-identity.js';

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

const tempDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bug018-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** realDir + a sibling symlink `aliasDir` → realDir (the classic dir alias). */
function aliasPair(): { realDir: string; aliasDir: string } {
  const realDir = mkTemp();
  const parent = mkTemp();
  const aliasDir = join(parent, 'alias');
  symlinkSync(realDir, aliasDir, 'dir');
  return { realDir, aliasDir };
}

describe('BUG-018 — canonicalDbPath (path-identity.ts, INV-4)', () => {
  it('converges a parent-dir symlink alias onto the real parent', () => {
    const { realDir, aliasDir } = aliasPair();
    expect(canonicalDbPath(join(aliasDir, 'store.db'))).toBe(
      canonicalDbPath(join(realDir, 'store.db')),
    );
    expect(canonicalDbPath(join(realDir, 'store.db'))).toBe(
      join(realpathSync(realDir), 'store.db'),
    );
  });

  it('resolves the tmpdir symlink layer (e.g. /var → /private/var on macOS)', () => {
    expect(canonicalDbPath(join(tmpdir(), 'x.db'))).toBe(join(realpathSync(tmpdir()), 'x.db'));
  });

  it('normalises a relative spelling to an absolute canonical path', () => {
    expect(canonicalDbPath('store.db')).toBe(join(realpathSync('.'), 'store.db'));
  });

  it('tolerates a not-yet-created db file (parent must exist)', () => {
    const { realDir } = aliasPair();
    expect(canonicalDbPath(join(realDir, 'not-yet.db'))).toBe(
      join(realpathSync(realDir), 'not-yet.db'),
    );
  });

  it('falls back to the raw spelling (never throws) when the parent is missing', () => {
    const { realDir } = aliasPair();
    const missing = join(realDir, 'no-such-subdir', 'store.db');
    expect(canonicalDbPath(missing)).toBe(missing);
  });

  it('is memoized: repeated calls return the identical string', () => {
    const { realDir } = aliasPair();
    const p = join(realDir, 'store.db');
    expect(canonicalDbPath(p)).toBe(canonicalDbPath(p));
  });
});

tursoDescribe('BUG-018 — TursoAdapter.connect canonicalizes once (SPEC §T4)', () => {
  it('config.dbPath and every coordination key carry the canonical path', async () => {
    const { realDir, aliasDir } = aliasPair();
    const realDb = join(realDir, 'store.db');
    const aliasDb = join(aliasDir, 'store.db');

    // Create/open the store via the REAL path, then open the same store via
    // the symlinked-directory alias.
    const a = await TursoAdapterImpl.connect({ dbPath: realDb });
    const b = await TursoAdapterImpl.connect({ dbPath: aliasDb });
    try {
      // THE canonicalization assertions (RED before connect canonicalizes):
      // the adapter must store the canonical spelling, not the raw one.
      expect(a.config.dbPath).toBe(canonicalDbPath(realDb));
      expect(b.config.dbPath).toBe(canonicalDbPath(realDb));
      expect(leaseDirPath(b.config.dbPath)).toBe(leaseDirPath(canonicalDbPath(realDb)));

      // INV-4 integration lock: probed through B's own (canonical) key,
      // excluding B's own lease, A's lease is a visible live peer — the
      // false-quiescence failure mode BUG-018 exists to prevent.
      const aToken = (a as unknown as { _lease: { token: string } | null })._lease?.token;
      const bToken = (b as unknown as { _lease: { token: string } | null })._lease?.token;
      expect(aToken).toBeTruthy();
      expect(bToken).toBeTruthy();
      const q = storeQuiescence(canonicalDbPath(realDb), bToken);
      expect(q.quiescent).toBe(false);
      expect(q.livePeers.map((p) => p.token)).toContain(aToken);
    } finally {
      await a.close();
      await b.close();
    }

    // Both leases released through the canonical close path — the store is
    // quiescent again (exercises storeQuiescence(this.config.dbPath) in
    // close(), which must use the SAME canonical key).
    expect(storeQuiescence(canonicalDbPath(realDb)).quiescent).toBe(true);
  });

  it('marker written via the alias spelling is visible via the real spelling', async () => {
    const { realDir, aliasDir } = aliasPair();
    const realDb = join(realDir, 'store.db');
    const aliasDb = join(aliasDir, 'store.db');

    // The marker path is derived from the canonical identity — the two
    // spellings MUST produce the identical marker path string.
    expect(storeOpenMarkerPath(canonicalDbPath(aliasDb))).toBe(
      storeOpenMarkerPath(canonicalDbPath(realDb)),
    );

    // Write through the alias spelling, read through the real spelling.
    markStoreOpen(aliasDb);
    try {
      expect(hasStoreOpenMarker(realDb)).toBe(true);
    } finally {
      clearStoreOpenMarker(realDb);
    }
    expect(hasStoreOpenMarker(realDb)).toBe(false);
  });
});

describe('BUG-018 — SqliteAdapterImpl canonicalizes at open (SPEC §T4)', () => {
  it('config.dbPath carries the canonical path for an alias-spelled open', async () => {
    const { realDir, aliasDir } = aliasPair();
    const realSqlite = join(realDir, 'sqlite.db');
    const aliasSqlite = join(aliasDir, 'sqlite.db');

    const s = new SqliteAdapterImpl(aliasSqlite);
    try {
      expect(s.config.dbPath).toBe(canonicalDbPath(realSqlite));
    } finally {
      await s.close();
    }
  });
});
