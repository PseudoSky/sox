/**
 * BL-c5249cdd — `memory fts-rebuild` (offline VACUUM INTO compaction) and
 * `memory restore` (its undo).
 *
 * On `@tursodatabase/database` 0.7.x every interleaved insert + `OPTIMIZE INDEX`
 * round orphans the merged-away FTS segments; the store grows with the number
 * of in-service optimize passes and nothing reuses the pages. `DROP INDEX`
 * orphans the FTS directory btree too, so only `VACUUM INTO` reclaims. These
 * specs build a leaked store the same way (interleaved rounds on the real
 * memory-core schema), then drive the CLI.
 *
 * Isolation: HOME is a fresh temp dir for every test and every invocation
 * passes `--db`, so nothing here can resolve `~/.memory/memory.db`.
 *
 * Corpus: every row carries a unique LETTER-ONLY token (`zq<base26>word`).
 * The open-time FTS probe extracts whole letter runs as sentinels; a token like
 * `hippo7` is indexed whole but probed as `hippo`, reads as damage, and the
 * writable open "repairs" it with `DROP INDEX` — the very operation that
 * orphans pages. Letter-only tokens keep every reopen honest.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '@adhd/sox-memory-core';
import { readStoreGrowthMeta, TursoAdapterImpl } from '@adhd/sox-store-adapter';
import { runCli } from './index.js';

const cleanups: Array<() => void | Promise<void>> = [];
let logs: string[];
let errs: string[];
let savedHome: string | undefined;

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  logs = [];
  errs = [];
  savedHome = process.env['HOME'];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-c5249cdd-home-'));
  process.env['HOME'] = home;
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  cleanups.push(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
});

/** Unique letter-only token for row i. */
function tok(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return `zq${s}word`;
}

const ROUNDS = 12;
const PER_ROUND = 100;
const SENTINELS = [0, 377, ROUNDS * PER_ROUND - 1].map(tok);

/** A leaked store: the real memory-core schema, ROUNDS × (PER_ROUND inserts + OPTIMIZE). */
async function seedLeakedStore(): Promise<string> {
  // realpath: the store reports its canonical path (macOS /var → /private/var).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-c5249cdd-')));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'memory.db');
  const a = await openDb(dbPath);
  try {
    let i = 0;
    for (let r = 0; r < ROUNDS; r++) {
      for (let j = 0; j < PER_ROUND; j++, i++) {
        await a.executeRun(
          'INSERT INTO node (uid, kind, content, name, summary, t_created) VALUES (?, ?, ?, ?, ?, ?)',
          [`u${i}`, 'episode', `alpha beta gamma delta ${tok(i)} epsilon`, `name ${tok(i)}`, 'summary text', new Date().toISOString()],
        );
      }
      await (a.unwrap() as import('@tursodatabase/database').Database).exec('OPTIMIZE INDEX idx_fts_node');
    }
  } finally {
    await a.close();
  }
  return dbPath;
}

function sha(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

interface Facts {
  counts: Record<string, number>;
  hits: Record<string, number>;
  pageCount: number;
  pageSize: number;
}

/** Independent read of a closed store (soft-readonly: leaves its bytes unchanged). */
async function readFacts(dbPath: string): Promise<Facts> {
  const a = await TursoAdapterImpl.connect({ dbPath, readonly: true, allowFtsInReadonly: true, idleFlushMs: 3_600_000 });
  try {
    const counts: Record<string, number> = {};
    for (const t of ['node', 'edge', 'vec_node']) {
      counts[t] = Number((await a.executeGet<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))?.n);
    }
    const hits: Record<string, number> = {};
    for (const s of SENTINELS) {
      hits[s] = Number(
        (await a.executeGet<{ n: number }>('SELECT COUNT(*) AS n FROM node WHERE fts_match(content, name, summary, ?)', [s]))?.n,
      );
    }
    const pageCount = Number(Object.values((await a.executeGet<Record<string, number>>('PRAGMA page_count')) ?? {})[0]);
    const pageSize = Number(Object.values((await a.executeGet<Record<string, number>>('PRAGMA page_size')) ?? {})[0]);
    return { counts, hits, pageCount, pageSize };
  } finally {
    await a.close();
  }
}

async function growthMeta(dbPath: string) {
  const a = await TursoAdapterImpl.connect({ dbPath, readonly: true, allowFtsInReadonly: true, idleFlushMs: 3_600_000 });
  try {
    return await readStoreGrowthMeta(a);
  } finally {
    await a.close();
  }
}

/** Directory listing, excluding lease-dir internals (per-open, pid-named). */
function listing(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => !n.includes('-tshm.stale-')).sort();
}

/** An idle-released peer: holds an opener entry but NO store lease — the
 *  shape of a running-but-idle memory-server. */
async function idleReleasedPeer(dbPath: string): Promise<TursoAdapterImpl> {
  const peer = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 3_600_000 });
  await peer.executeGet('SELECT 1 AS one');
  expect(await peer.releaseIdleConnection()).toBe(true);
  cleanups.push(() => peer.close());
  return peer;
}

const T = 600_000;

describe('BL-c5249cdd — memory fts-rebuild / memory restore', () => {
  it('BL-c5249cdd: rebuild reclaims on a leaked scratch store, keeps the byte-exact pre-swap file as the backup', async () => {
    const db = await seedLeakedStore();
    const before = await readFacts(db);
    const preSha = sha(db);
    const preBytes = fs.statSync(db).size;
    // Closed store: the file is exactly page_count × page_size.
    expect(preBytes).toBe(before.pageCount * before.pageSize);

    await runCli(['fts-rebuild', '--db', db]);

    const out = logs.join('\n');
    expect(errs.join('\n')).toBe('');
    expect(out).toContain('[fts-rebuild] complete');
    expect(out).toMatch(/before: \d+ bytes, page_count \d+/);
    expect(out).toMatch(/after: {2}\d+ bytes, page_count \d+/);
    expect(out).toMatch(/reclaimed: \d+ bytes/);

    const after = await readFacts(db);
    expect(after.pageCount).toBeLessThan(before.pageCount * 0.6);
    expect(fs.statSync(db).size).toBeLessThan(preBytes * 0.6);

    const backup = fs.readdirSync(path.dirname(db)).find((n) => n.startsWith('memory.db.pre-rebuild-'));
    expect(backup).toBeDefined();
    expect(sha(path.join(path.dirname(db), backup!))).toBe(preSha);
    expect(out).toContain(`undo:   memory restore ${path.join(path.dirname(db), backup!)}`);
    // No copy left behind.
    expect(fs.readdirSync(path.dirname(db)).filter((n) => n.includes('.rebuild-'))).toEqual([]);
  }, T);

  it('BL-c5249cdd: rebuild refuses (exit 2) while an idle-released opener exists — dry-run included — and runs nothing', async () => {
    const db = await seedLeakedStore();
    await idleReleasedPeer(db);
    // After the peer: its own open stamps meta and its release checkpoints.
    const preSha = sha(db);

    // The dry-run never reaches the swap's own re-check, so only the
    // up-front gate can refuse it.
    await expect(runCli(['fts-rebuild', '--db', db, '--dry-run'])).rejects.toMatchObject({ code: 2 });
    expect(errs.join('\n')).toMatch(/REFUSED: \d+ live process\(es\) have the store open/);
    expect(logs.join('\n')).not.toMatch(/before:|DRY-RUN/);

    await expect(runCli(['fts-rebuild', '--db', db])).rejects.toMatchObject({ code: 2 });
    expect(sha(db)).toBe(preSha);
    expect(fs.readdirSync(path.dirname(db)).filter((n) => /\.(rebuild|pre-rebuild)-/.test(n))).toEqual([]);
  }, T);

  it('BL-c5249cdd: the swap preserves every row and every FTS result, and resets the growth counter', async () => {
    const db = await seedLeakedStore();
    const before = await readFacts(db);
    expect(before.counts['node']).toBe(ROUNDS * PER_ROUND);
    for (const s of SENTINELS) expect(before.hits[s]).toBe(1);

    await runCli(['fts-rebuild', '--db', db]);

    const after = await readFacts(db);
    expect(after.counts).toEqual(before.counts);
    expect(after.hits).toEqual(before.hits);
    const meta = await growthMeta(db);
    expect(meta.ftsOptimizePassesSinceRebuild).toBe(0);
    expect(meta.lastRebuildAt).not.toBeNull();
    expect(logs.join('\n')).toMatch(/fts: {8}3\/3 sentinel round-trips equal/);
    // The store opens WRITABLE afterwards and serves FTS.
    const w = await openDb(db);
    try {
      const n = await w.executeGet<{ n: number }>(
        'SELECT COUNT(*) AS n FROM node WHERE fts_match(content, name, summary, ?)',
        [SENTINELS[1]],
      );
      expect(Number(n?.n)).toBe(1);
    } finally {
      await w.close();
    }
  }, T);

  it('BL-c5249cdd: --dry-run verifies the copy and leaves the store untouched', async () => {
    const db = await seedLeakedStore();
    const dir = path.dirname(db);
    const preSha = sha(db);
    const preList = listing(dir);

    await runCli(['fts-rebuild', '--db', db, '--dry-run']);

    const out = logs.join('\n');
    expect(out).toContain('[fts-rebuild] DRY-RUN');
    expect(out).toMatch(/would reclaim: \d+ bytes/);
    expect(out).toContain('verification: ok');
    expect(sha(db)).toBe(preSha);
    expect(listing(dir)).toEqual(preList);
    expect((await growthMeta(db)).lastRebuildAt).toBeNull();
  }, T);

  it('BL-c5249cdd: backup/restore round-trips byte-exactly, and restore refuses while an opener exists', async () => {
    const db = await seedLeakedStore();
    const dir = path.dirname(db);
    const preSha = sha(db);
    const before = await readFacts(db);

    await runCli(['fts-rebuild', '--db', db]);
    const rebuiltSha = sha(db);
    expect(rebuiltSha).not.toBe(preSha);
    const backup = path.join(dir, fs.readdirSync(dir).find((n) => n.startsWith('memory.db.pre-rebuild-'))!);

    // Refused while a process has the store open; nothing replaced.
    // (The peer's own open stamps meta + checkpoints, so the "untouched" sha
    // is taken after it is established.)
    const peer = await idleReleasedPeer(db);
    const withPeerSha = sha(db);
    await expect(runCli(['restore', backup, '--db', db])).rejects.toMatchObject({ code: 2 });
    expect(errs.join('\n')).toMatch(/\[restore\] REFUSED: \d+ live process\(es\) have the store open/);
    expect(sha(db)).toBe(withPeerSha);
    await peer.close();
    const rebuiltAfterPeerSha = sha(db);

    logs.length = 0;
    await runCli(['restore', backup, '--db', db]);
    expect(logs.join('\n')).toContain('[restore] complete');
    expect(sha(db)).toBe(preSha);
    expect(sha(backup)).toBe(preSha); // the backup is cloned, never consumed
    const replaced = fs.readdirSync(dir).find((n) => n.startsWith('memory.db.pre-restore-'));
    expect(replaced).toBeDefined();
    expect(sha(path.join(dir, replaced!))).toBe(rebuiltAfterPeerSha);
    const after = await readFacts(db);
    expect(after).toEqual(before);
  }, T);

  it('BL-c5249cdd: restore --dry-run leaves the store untouched; a missing backup exits 1', async () => {
    const db = await seedLeakedStore();
    await runCli(['fts-rebuild', '--db', db]);
    const dir = path.dirname(db);
    const backup = path.join(dir, fs.readdirSync(dir).find((n) => n.startsWith('memory.db.pre-rebuild-'))!);
    const rebuiltSha = sha(db);
    await runCli(['restore', backup, '--db', db, '--dry-run']);
    expect(logs.join('\n')).toContain('[restore] DRY-RUN');
    expect(sha(db)).toBe(rebuiltSha);
    await expect(runCli(['restore', path.join(dir, 'no-such-backup.db'), '--db', db])).rejects.toMatchObject({ code: 1 });
  }, T);

  // fts-migrate is the v1→v2 store-FORMAT migration (BL-89849d2a). Its driver
  // gate is `driverIsV2Aware` — under the installed @tursodatabase/database
  // 0.7.1 pin, `migrateStoreFormatOffline` refuses `driver_not_v2_aware` BEFORE
  // any open/transform/dry-run. The full transform/plan/dry-run path is covered
  // at the store-adapter unit level (fts-format-migration.bl-89849d2a.spec.ts
  // injects `_tursoVersion: '0.8.0'`); the CLI cannot reach it until the pin is
  // bumped (a separate, owner-authorized step). These tests pin the refusal
  // contract and the "writes nothing" guarantee under the installed driver.
  it('BL-c5249cdd: fts-migrate refuses (exit 2) under the installed 0.7.x driver without opening or modifying the store', async () => {
    const db = await seedLeakedStore();
    const dir = path.dirname(db);
    const preSha = sha(db);
    const preList = listing(dir);

    await expect(runCli(['fts-migrate', '--db', db])).rejects.toMatchObject({ code: 2 });

    const err = errs.join('\n');
    expect(err).toMatch(/\[fts-migrate\] REFUSED: driver_not_v2_aware/);
    expect(err).toMatch(/NOT opened or modified/);
    expect(sha(db)).toBe(preSha);
    expect(listing(dir)).toEqual(preList);
  }, T);

  it('BL-c5249cdd: fts-migrate --dry-run also refuses (exit 2) under 0.7.x — the driver gate precedes the plan', async () => {
    const db = await seedLeakedStore();
    const dir = path.dirname(db);
    const preSha = sha(db);
    const preList = listing(dir);

    await expect(runCli(['fts-migrate', '--db', db, '--dry-run'])).rejects.toMatchObject({ code: 2 });

    expect(errs.join('\n')).toMatch(/\[fts-migrate\] REFUSED: driver_not_v2_aware/);
    expect(sha(db)).toBe(preSha);
    expect(listing(dir)).toEqual(preList);
  }, T);

  it('BL-c5249cdd: fts-migrate on a missing db exits 1', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bl-c5249cdd-migrate-')));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    await expect(runCli(['fts-migrate', '--db', path.join(dir, 'no-such.db')])).rejects.toMatchObject({ code: 1 });
    expect(errs.join('\n')).toMatch(/\[fts-migrate\] db not found/);
  }, T);
});
