/**
 * sidecar-retention.bl591.spec.ts — BL-591: stale `-tshm`/`-shm` sidecar
 * debris (renamed to `.stale-<stamp>` by BUG014.T3's content-deadness gate,
 * integrity.ts) is never pruned and grows without bound under sustained
 * write volume.
 *
 * RED→GREEN evidence for BL-591 (BL-225): every "prunes"/"bounded" assertion
 * below is run against `pruneStaleTshmSidecars` BEFORE it existed (git stash
 * of sidecar-retention.ts would show these failing to import) — the concrete
 * red/green pair captured in the backlog citation is:
 *   RED:   git checkout HEAD~ -- (module absent) → TypeError: not a function
 *   GREEN: this file, run against the committed sidecar-retention.ts
 *
 * All specs run against a disposable `mkdtemp` sandbox — NEVER against
 * ~/.memory or ~/.adhd/backlog, per the task's explicit prohibition.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STALE_SIDECAR_KEEP_N,
  DEFAULT_STALE_SIDECAR_MAX_AGE_MS,
  maybePruneStaleTshmSidecars,
  pruneStaleTshmSidecars,
  type StaleSidecarFs,
} from './sidecar-retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function stampFor(offsetFromNowMs: number): string {
  // Matches the `YYYY-MM-DD-HHMM` shape integrity.ts stamps into the
  // filename — the retention policy ranks by mtime, not by parsing this, but
  // real artefacts always carry a well-formed stamp so specs should too.
  const d = new Date(Date.now() - offsetFromNowMs);
  return d.toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
}

/** Write a fake `.stale-*` sidecar and backdate its mtime by `ageMs`. */
function writeStaleSidecar(dir: string, dbBase: string, kind: 'tshm' | 'shm', ageMs: number): string {
  const stamp = stampFor(ageMs);
  const p = join(dir, `${dbBase}-${kind}.stale-${stamp}`);
  writeFileSync(p, 'fake-sidecar-content');
  const t = new Date(Date.now() - ageMs);
  utimesSync(p, t, t);
  return p;
}

describe('pruneStaleTshmSidecars — BL-591 retention policy (mkdtemp sandbox, real fs)', () => {
  let dir: string;
  const dbBase = 'memory.db';
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sox-bl591-'));
    dbPath = join(dir, dbBase);
    // Live store files that must NEVER be touched by the sweep.
    writeFileSync(dbPath, 'fake-db-content');
    writeFileSync(`${dbPath}-wal`, 'fake-wal-content');
    writeFileSync(`${dbPath}-shm`, 'fake-shm-content');
    writeFileSync(`${dbPath}-tshm`, 'fake-tshm-content');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('RED→GREEN: a fresh sidecar within both caps survives a real sweep', () => {
    const fresh = writeStaleSidecar(dir, dbBase, 'tshm', 5_000); // 5s old
    const result = pruneStaleTshmSidecars(dbPath);
    expect(result.scanned).toBe(1);
    expect(result.pruned).toBe(0);
    expect(result.kept).toBe(1);
    expect(existsSync(fresh)).toBe(true);
  });

  it('RED→GREEN: a sidecar older than the age cap is pruned even though it is the only one (count cap never fires)', () => {
    const ancient = writeStaleSidecar(dir, dbBase, 'tshm', 21 * DAY_MS); // 3 weeks old
    const result = pruneStaleTshmSidecars(dbPath);
    expect(result.pruned).toBe(1);
    expect(result.entries[0]?.reason).toMatch(/age cap/);
    expect(existsSync(ancient)).toBe(false);
  });

  it('RED→GREEN: with more than keepRecentN fresh sidecars, only the newest N survive — the count cap bounds growth under sustained write pressure', () => {
    const keepN = 3;
    const paths: string[] = [];
    // Oldest first, all well within the age cap, so only the count cap can
    // fire. Offsets are spaced 90s apart (> the stamp's minute granularity,
    // `YYYY-MM-DD-HHMM`) so each fixture lands in a distinct minute and gets
    // a distinct filename — two real renames landing in the same minute
    // would otherwise collide on the stamp text; that collision is a
    // property of the (unrelated, pre-existing) rename-side stamp format in
    // integrity.ts, not of the retention policy under test here, so the test
    // sidesteps it rather than encoding it as an assertion.
    for (let i = 9; i >= 0; i--) {
      paths.push(writeStaleSidecar(dir, dbBase, 'tshm', i * 90_000));
    }
    const result = pruneStaleTshmSidecars(dbPath, { keepRecentN: keepN });
    expect(result.scanned).toBe(10);
    expect(result.pruned).toBe(10 - keepN);
    expect(result.kept).toBe(keepN);
    // The newest `keepN` (smallest offset i => 0,1,2) must survive.
    const survivors = readdirSync(dir).filter((f) => f.includes('.stale-'));
    expect(survivors.length).toBe(keepN);
  });

  it('RED→GREEN: default policy (keepRecentN=20, maxAgeMs=3d) matches the stated defaults', () => {
    expect(DEFAULT_STALE_SIDECAR_KEEP_N).toBe(20);
    expect(DEFAULT_STALE_SIDECAR_MAX_AGE_MS).toBe(3 * DAY_MS);
  });

  it('never touches the live db/-wal/-shm/-tshm files, only `.stale-*` debris', () => {
    writeStaleSidecar(dir, dbBase, 'tshm', 21 * DAY_MS);
    writeStaleSidecar(dir, dbBase, 'shm', 21 * DAY_MS);
    pruneStaleTshmSidecars(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);
    expect(existsSync(`${dbPath}-tshm`)).toBe(true);
    expect(readFileSync(dbPath, 'utf8')).toBe('fake-db-content');
  });

  it('does not match a similarly-prefixed sibling store\'s sidecars (basename-anchored pattern)', () => {
    // A sibling store `memory.db.bak` beside it must never be scanned as if
    // it were `memory.db`'s own debris.
    const siblingDbPath = join(dir, 'memory.db.bak');
    writeFileSync(siblingDbPath, 'sibling');
    const siblingStale = writeStaleSidecar(dir, 'memory.db.bak', 'tshm', 21 * DAY_MS);
    const result = pruneStaleTshmSidecars(dbPath);
    expect(result.scanned).toBe(0); // nothing matching `memory.db-tshm.stale-*`
    expect(existsSync(siblingStale)).toBe(true);
  });

  it('dry-run never deletes, but reports would-prune for out-of-window candidates', () => {
    const ancient = writeStaleSidecar(dir, dbBase, 'tshm', 21 * DAY_MS);
    const result = pruneStaleTshmSidecars(dbPath, { dryRun: true });
    expect(result.pruned).toBe(1);
    expect(result.entries[0]?.action).toBe('would-prune');
    expect(existsSync(ancient)).toBe(true); // untouched
  });

  it('swallows and logs an unlink failure rather than throwing', () => {
    writeStaleSidecar(dir, dbBase, 'tshm', 21 * DAY_MS);
    const logs: string[] = [];
    const fsSeal: StaleSidecarFs = {
      existsSync: (p) => existsSync(p),
      readdirSync: (d) => readdirSync(d),
      statSync: (p) => statSync(p),
      unlinkSync: () => {
        throw new Error('EACCES: permission denied (simulated)');
      },
      writeFileSync: (p, data) => writeFileSync(p, data),
    };
    expect(() => pruneStaleTshmSidecars(dbPath, { fsSeal, log: (m) => logs.push(m) })).not.toThrow();
    const result = pruneStaleTshmSidecars(dbPath, { fsSeal, log: (m) => logs.push(m) });
    expect(result.kept).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('FAILED to prune'))).toBe(true);
  });

  it('a missing directory is a safe no-op, not a throw', () => {
    const missing = join(dir, 'does-not-exist', 'x.db');
    expect(() => pruneStaleTshmSidecars(missing)).not.toThrow();
    expect(pruneStaleTshmSidecars(missing)).toEqual({ scanned: 0, pruned: 0, kept: 0, entries: [] });
  });
});

describe('maybePruneStaleTshmSidecars — BL-591 throttle (mkdtemp sandbox, real fs)', () => {
  let dir: string;
  const dbBase = 'memory.db';
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sox-bl591-throttle-'));
    dbPath = join(dir, dbBase);
    writeFileSync(dbPath, 'fake-db-content');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('RED→GREEN: first call sweeps and writes a marker; an immediate second call is throttled (returns null, does not re-scan)', () => {
    writeStaleSidecar(dir, dbBase, 'tshm', 21 * DAY_MS);
    const first = maybePruneStaleTshmSidecars(dbPath);
    expect(first).not.toBeNull();
    expect(first?.pruned).toBe(1);
    expect(existsSync(`${dbPath}.sidecar-sweep-marker`)).toBe(true);

    // A second candidate appears immediately after — within the throttle
    // window the sweep must NOT run again (this is what bounds the added
    // cost on the hot open path to a single stat()).
    writeStaleSidecar(dir, dbBase, 'tshm', 22 * DAY_MS);
    const second = maybePruneStaleTshmSidecars(dbPath);
    expect(second).toBeNull();
    // The second ancient candidate must still be sitting there, unpruned,
    // because the throttle window suppressed the scan that would have found it.
    const remaining = readdirSync(dir).filter((f) => f.includes('.stale-'));
    expect(remaining.length).toBe(1);
  });

  it('RED→GREEN: once the throttle window has elapsed, the next call sweeps again', () => {
    writeStaleSidecar(dir, dbBase, 'tshm', 21 * DAY_MS);
    const first = maybePruneStaleTshmSidecars(dbPath, { throttleMs: 1_000 });
    expect(first?.pruned).toBe(1);

    writeStaleSidecar(dir, dbBase, 'tshm', 22 * DAY_MS);
    // Simulate elapsed throttle window by backdating the marker itself.
    const markerPath = `${dbPath}.sidecar-sweep-marker`;
    const old = new Date(Date.now() - 5_000);
    utimesSync(markerPath, old, old);

    const second = maybePruneStaleTshmSidecars(dbPath, { throttleMs: 1_000 });
    expect(second).not.toBeNull();
    expect(second?.pruned).toBe(1);
  });

  it('never throws even when the fs seam misbehaves throughout', () => {
    const brokenFs: StaleSidecarFs = {
      existsSync: () => {
        throw new Error('boom');
      },
      readdirSync: () => {
        throw new Error('boom');
      },
      statSync: () => {
        throw new Error('boom');
      },
      unlinkSync: () => {
        throw new Error('boom');
      },
      writeFileSync: () => {
        throw new Error('boom');
      },
    };
    expect(() => maybePruneStaleTshmSidecars(dbPath, { fsSeal: brokenFs })).not.toThrow();
  });
});
