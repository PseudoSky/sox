/**
 * Canonical store identity — consistency invariant for coordination call sites.
 *
 * ## What this is NOT (read this first — it corrects a filed claim)
 *
 * This suite began life as a regression test for an alleged CRITICAL defect:
 * that `turso-adapter.ts` takes its lease under the CANONICAL path while several
 * coordination sites (close-time quiescence gate, `clearStoreOpenMarker`,
 * `resetTshmAfterTruncate`, the repair gate) read `this.config.dbPath` — the RAW
 * caller spelling — and that the two therefore address DIFFERENT lease
 * directories, letting a close-time `wal_checkpoint(TRUNCATE)` fire while a live
 * peer held the store (the turso #7833 trigger) with no race required.
 *
 * **That claim is false, and this suite is the evidence.** It was written to fail
 * against the unfixed adapter and it PASSED, which under the BL-225 red→green
 * rule disqualifies it as a regression test for that defect. The reason is
 * simple and was confirmed directly:
 *
 *     /tmp/pathprobe/real/store.db.sox-lease.d   (created here)
 *     /tmp/pathprobe/link/store.db.sox-lease.d   (read through a symlinked parent)
 *     -> same directory listing, and statSync(...).ino IDENTICAL
 *
 * The lease directory is derived by string concatenation (`dbPath + '.sox-lease.d'`),
 * but every subsequent operation on it is a FILESYSTEM operation, and the OS
 * resolves symlinks, `..` segments, doubled separators and cwd-relative prefixes
 * during that resolution. Two spellings that name one file therefore always name
 * one lease directory. Divergence is not reachable through path spelling.
 *
 * So the raw/canonical split is a CONSISTENCY and HYGIENE issue, not a data-loss
 * one. It is still worth fixing and worth pinning, for reasons that survive the
 * correction:
 *
 *   - The adapter states the rule in its own source ("use `canonicalDb` at every
 *     coordination call site below — never `opts.dbPath` again"). Code that
 *     contradicts its own stated invariant is a trap for the next reader.
 *   - `emitIntegrityReport` is keyed by this string. Two spellings of one store
 *     fragment its integrity history into two unrelated-looking timelines — a
 *     real observability defect, just not a corruption one.
 *   - Any FUTURE consumer that compares these paths as STRINGS (a map key, a
 *     dedup set, a cache) rather than resolving them through the filesystem WOULD
 *     diverge. Pinning the invariant now is what keeps that from becoming true.
 *
 * What follows therefore asserts the invariant honestly: one store has one
 * canonical identity, and coordination behaves identically through any spelling.
 * These arms pass before and after the change, and they are labelled as such
 * rather than dressed up as a regression proof.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { leaseDirPath, storeQuiescence } from '../store-lease.js';
import { canonicalDbPath } from '../path-identity.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try {
      fn?.();
    } catch (err) {
      // Repo rule: never an empty catch. A teardown failure must not mask a real
      // assertion failure, but must not vanish either.
      console.warn('[canonical-identity] cleanup failed:', err);
    }
  }
});

function makeAliasedStore(): { realPath: string; aliasPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'canon-identity-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const realDir = join(root, 'real');
  mkdirSync(realDir);
  symlinkSync(realDir, join(root, 'link'), 'dir');
  return { realPath: join(realDir, 'store.db'), aliasPath: join(root, 'link', 'store.db') };
}

function markers(dbPath: string): string[] {
  const dir = leaseDirPath(dbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.openmark'));
}

describe('canonical store identity', () => {
  it('DOCUMENTS why spelling divergence is unreachable: aliased lease dirs share an inode', () => {
    const { realPath, aliasPath } = makeAliasedStore();
    expect(aliasPath).not.toBe(realPath); // the strings genuinely differ

    const realLease = leaseDirPath(realPath);
    const aliasLease = leaseDirPath(aliasPath);
    expect(aliasLease).not.toBe(realLease); // ...and so do the derived dir strings

    mkdirSync(realLease, { recursive: true });

    // But they are ONE directory on disk. This is the fact that falsified the
    // original CRITICAL claim; it is asserted here so nobody re-derives it.
    expect(existsSync(aliasLease)).toBe(true);
    expect(statSync(aliasLease).ino).toBe(statSync(realLease).ino);
  });

  it('maps every spelling of one store to a single canonical identity', () => {
    const { realPath, aliasPath } = makeAliasedStore();
    expect(canonicalDbPath(aliasPath)).toBe(canonicalDbPath(realPath));
    expect(canonicalDbPath(join(realPath, '..', 'store.db'))).toBe(canonicalDbPath(realPath));
  });

  it('sees a peer opened via either spelling in a quiescence check via the other', async () => {
    const { realPath, aliasPath } = makeAliasedStore();

    const peer = await TursoAdapterImpl.connect({ dbPath: aliasPath });
    cleanups.push(() => void peer.close().catch(() => undefined));

    // Both spellings must agree that the store is busy.
    expect(storeQuiescence(realPath).quiescent).toBe(false);
    expect(storeQuiescence(aliasPath).quiescent).toBe(false);
    expect(storeQuiescence(canonicalDbPath(realPath)).quiescent).toBe(false);

    await peer.close();
    expect(storeQuiescence(realPath).quiescent).toBe(true);
  });

  it('clears its open marker on an orderly close, whichever spelling opened it', async () => {
    const { realPath, aliasPath } = makeAliasedStore();

    const a = await TursoAdapterImpl.connect({ dbPath: aliasPath });
    expect(markers(canonicalDbPath(realPath)).length).toBe(1);
    await a.close();
    expect(markers(canonicalDbPath(realPath))).toEqual([]);

    const b = await TursoAdapterImpl.connect({ dbPath: realPath });
    expect(markers(canonicalDbPath(realPath)).length).toBe(1);
    await b.close();
    expect(markers(canonicalDbPath(realPath))).toEqual([]);
  });

  it('keeps a live peer readable across a sibling close opened by the other spelling', async () => {
    const { realPath, aliasPath } = makeAliasedStore();

    const peer = await TursoAdapterImpl.connect({ dbPath: realPath });
    cleanups.push(() => void peer.close().catch(() => undefined));
    await peer.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
    await peer.exec("INSERT INTO t (v) VALUES ('peer-durable')");

    const shortLived = await TursoAdapterImpl.connect({ dbPath: aliasPath });
    await shortLived.exec("INSERT INTO t (v) VALUES ('short-lived')");
    await shortLived.close();

    const rows = await peer.executeAll<{ v: string }>('SELECT v FROM t ORDER BY id');
    const vals = rows.rows.map((r) => r.v);
    expect(vals).toContain('peer-durable');
    expect(vals).toContain('short-lived');

    await peer.close();
  });

  it('holds one lease directory across concurrent opens through both spellings', async () => {
    const { realPath, aliasPath } = makeAliasedStore();

    const viaReal = await TursoAdapterImpl.connect({ dbPath: realPath });
    const viaAlias = await TursoAdapterImpl.connect({ dbPath: aliasPath });
    cleanups.push(() => void viaReal.close().catch(() => undefined));
    cleanups.push(() => void viaAlias.close().catch(() => undefined));

    const dir = leaseDirPath(canonicalDbPath(realPath));
    expect(readdirSync(dir).filter((n) => !n.endsWith('.openmark')).length).toBe(2);

    await viaAlias.close();
    await viaReal.close();

    expect(storeQuiescence(canonicalDbPath(realPath)).quiescent).toBe(true);
    expect(markers(canonicalDbPath(realPath))).toEqual([]);
  });
});
