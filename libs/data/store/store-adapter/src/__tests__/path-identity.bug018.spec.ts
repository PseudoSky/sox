/**
 * BUG014.T4 — canonical path identity (SPEC §T4, INV-4).
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
import {
  mkdtempSync,
  symlinkSync,
  rmSync,
  realpathSync,
  mkdirSync,
  chmodSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import { storeQuiescence, leaseDirPath } from '../store-lease.js';
import {
  openMarkerPath,
  markStoreOpen,
  clearStoreOpenMarker,
} from '../preflight.js';
import { canonicalDbPath } from '../path-identity.js';
import { EPathIdentityUnresolvable } from '../errors.js';

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

describe('BUG014.T4 — canonicalDbPath (path-identity.ts, INV-4)', () => {
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

  // ── Review finding 1: the :memory:/file: passthrough guard (fixed the
  //    59-test regression: canonicalDbPath(':memory:') once materialized the
  //    in-memory name as a real file beside the caller's cwd) needs a DIRECT
  //    unit pin — previously only indirectly load-bearing via the full suite.
  it('passes :memory: through unchanged (never materializes a real file)', () => {
    expect(canonicalDbPath(':memory:')).toBe(':memory:');
    // The guard must not resolve `:memory:` against the fs: a broken guard
    // would return `<cwd>/:memory:` and a connect would silently create a
    // real file named ':memory:' next to the caller's cwd.
    expect(canonicalDbPath(':memory:')).not.toMatch(/\//);
    expect(existsSync(join(process.cwd(), ':memory:'))).toBe(false);
  });

  it('passes file: URI spellings through unchanged', () => {
    expect(canonicalDbPath('file:store.db')).toBe('file:store.db');
    expect(canonicalDbPath('file:/abs/path/store.db?mode=rwc')).toBe(
      'file:/abs/path/store.db?mode=rwc',
    );
  });

  // ── Review finding 2: the missing-parent FALLBACK must not be memoized —
  //    absence is transient fs-state. If a fallback were cached, a parent
  //    created after the first call would never be picked up (stale raw
  //    spelling forever, the same key-identity failure class BUG014.T4 fixes).
  it('does not memoize the missing-parent fallback (re-evaluated after parent creation)', () => {
    const { realDir } = aliasPair();
    const lateParent = join(realDir, 'late-created');
    const p = join(lateParent, 'store.db');
    // First call: parent missing → raw fallback.
    expect(canonicalDbPath(p)).toBe(p);
    // Now the parent appears (a symlink is retargeted, a dir is created…).
    mkdirSync(lateParent);
    try {
      // A memoized fallback would keep returning the raw spelling here; the
      // fix must re-evaluate and pick up the canonical form.
      expect(canonicalDbPath(p)).toBe(join(realpathSync(lateParent), 'store.db'));
    } finally {
      rmSync(lateParent, { recursive: true, force: true });
    }
  });

  // ── Review finding 3: the fallback catch is errno-aware (DEBT-003
  //    precedent — EACCES must not prove "absent"). ENOENT/ENOTDIR are plain
  //    absence → raw fallback; EACCES/EIO are uncertainty → typed error, no
  //    silent fallback. Skipped under root: a 0o000 parent does not deny
  //    root, so the EACCES arm is unprovable there.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const errnoDescribe = isRoot ? describe.skip : describe;

  errnoDescribe('BUG014.T4 — errno-aware fallback (DEBT-003 discipline)', () => {
    it('falls back on ENOENT but surfaces a typed error on EACCES', () => {
      const { realDir } = aliasPair();

      // ENOENT → plain absence → raw fallback, never throws.
      const missing = join(realDir, 'no-such-subdir', 'store.db');
      expect(canonicalDbPath(missing)).toBe(missing);

      // EACCES → parent exists but is unreadable → typed error, never a
      // silent raw fallback (a divergent coordination key under a live peer).
      // The dbPath sits BENEATH the locked dir, so dirname(dbPath) is
      // `realDir/locked/sub` — realpathSync must traverse INTO `locked`,
      // which 0o000 denies (a bare realpath of `locked` itself would succeed,
      // since lstat of a final component only needs execute on ITS parent).
      const locked = join(realDir, 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      const lockedDb = join(locked, 'sub', 'store.db');
      try {
        let thrown: unknown;
        try {
          canonicalDbPath(lockedDb);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(EPathIdentityUnresolvable);
        const typed = thrown as EPathIdentityUnresolvable;
        expect(typed.errno).toBe('EACCES');
        expect(typed.dbPath).toBe(lockedDb);
      } finally {
        chmodSync(locked, 0o755);
        rmSync(locked, { recursive: true, force: true });
      }
    });

    it('falls back on ENOTDIR (a path component is a file, not a dir)', () => {
      const { realDir } = aliasPair();
      // A dbPath BELOW a regular file: dirname resolves `/…/iamafile/sub`,
      // whose prefix `iamafile` is a file — realpathSync throws ENOTDIR.
      const fileAsParent = join(realDir, 'iamafile');
      writeFileSync(fileAsParent, 'x');
      const p = join(fileAsParent, 'sub', 'store.db');
      expect(canonicalDbPath(p)).toBe(p);
    });
  });
});

tursoDescribe('BUG014.T4 — TursoAdapter.connect canonicalizes once (SPEC §T4)', () => {
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
      // dbPath is `string | undefined` on AdapterConfig (the turso adapter can
      // be url-only); the assertion above proves it is defined here.
      expect(leaseDirPath(b.config.dbPath!)).toBe(leaseDirPath(canonicalDbPath(realDb)));

      // (DEBT-003, lazy-connect) `_lease` is only populated on the first real
      // open — `connect()` no longer acquires one eagerly. Force both here.
      await a.executeGet('SELECT 1');
      await b.executeGet('SELECT 1');

      // INV-4 integration lock: probed through B's own (canonical) key,
      // excluding B's own lease, A's lease is a visible live peer — the
      // false-quiescence failure mode BUG014.T4 exists to prevent.
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

  it('the per-connection marker path converges on the canonical identity (BUG014.T5)', async () => {
    const { realDir, aliasDir } = aliasPair();
    const realDb = join(realDir, 'store.db');
    const aliasDb = join(aliasDir, 'store.db');
    const token = 'bug018-token';

    // (BUG014.T5) The marker now lives in the lease dir as
    // `<leaseDir>/<token>.openmark` — keyed off the CANONICAL identity, so the
    // two spellings MUST produce the identical marker path string (the marker
    // path is `leaseDirPath(canonicalDbPath(dbPath))` composed).
    expect(openMarkerPath(canonicalDbPath(aliasDb), token)).toBe(
      openMarkerPath(canonicalDbPath(realDb), token),
    );

    // Write through the alias spelling, read through the real spelling.
    markStoreOpen(aliasDb, token);
    try {
      expect(existsSync(openMarkerPath(canonicalDbPath(realDb), token))).toBe(true);
    } finally {
      clearStoreOpenMarker(realDb, token);
    }
    expect(existsSync(openMarkerPath(canonicalDbPath(realDb), token))).toBe(false);
  });
});

describe('BUG014.T4 — SqliteAdapterImpl canonicalizes at open (SPEC §T4)', () => {
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
