/**
 * claim.spec.ts — SR-7: `memory_claim_upsert` + a memory-side, queryable claim.
 *
 * Covers the SR-7 acceptance exactly:
 *   - two callers racing for one node → exactly one claim;
 *   - the same caller re-claiming is idempotent;
 *   - a distinct caller is refused with a typed `E_CLAIM_HELD`;
 *   - the claim survives a store REOPEN (it is a persisted, queryable record).
 *
 * ## Negative control (SR7_NEGATIVE=1)
 *
 * The race test asserts the invariant "exactly one winner" unconditionally.
 * With `SR7_NEGATIVE=1` set, the test swaps the real guarded CAS for an
 * UNGUARDED read-modify-write (the pre-fix shape) and forces interleaving with
 * a latch between the read and the write — both writers then commit their own
 * claim, TWO winners exist, and the assertion goes RED. Without the flag the
 * guarded CAS yields exactly one winner and the test is GREEN. This proves the
 * guard is load-bearing, not decorative.
 *
 * Uses the real `openDb` schema (no synthetic table) and REAL independent
 * connections — no `sleep`, no wall-clock timing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryClaimUpsert, memoryClaimGet, memoryClaimList } from './claim.js';

let dir: string;
let dbPath: string;
let db: StoreAdapter;
let priorAdapterEnv: string | undefined;

beforeEach(async () => {
  // Pin sqlite: its `BEGIN IMMEDIATE` is a genuine cross-connection write lock,
  // so the CAS verdict is deterministic under a real two-connection race.
  // (Same convention as concurrency-harness.spec.ts.) The guard is
  // backend-agnostic; on Turso the adapter's own snapshot-conflict handling +
  // claim.ts's `withRetry` produce the same typed result.
  priorAdapterEnv = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = 'sqlite';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
  dbPath = path.join(dir, 'store.db');
  db = await openDb(dbPath);
});

afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = priorAdapterEnv;
});

async function seedEpisode(adapter: StoreAdapter, uid: string, content = 'seed content'): Promise<void> {
  const now = new Date().toISOString();
  await adapter.executeRun(
    `INSERT INTO node (uid, kind, content, t_created, t_valid) VALUES (?, 'episode', ?, ?, ?)`,
    [uid, content, now, now],
  );
}

describe('SR-7 — memory_claim_upsert (acquire / read / idempotent / conflict)', () => {
  it('acquires an unheld node; the claim is readable back', async () => {
    await seedEpisode(db, 'n1');
    const res = await memoryClaimUpsert(db, { uid: 'n1', caller: 'alpha' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.acquired).toBe(true);
    expect(res.refreshed).toBe(false);
    expect(res.claim.caller).toBe('alpha');
    expect(res.claim.revision).toBe(1);
    expect(res.updated_fields).toContain('meta');

    const got = await memoryClaimGet(db, 'n1');
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('unreachable');
    expect(got.claim?.caller).toBe('alpha');
    expect(got.claim?.claimed_at).toBe(res.claim.claimed_at);
  });

  it('the same caller re-claiming is IDEMPOTENT — same holder/claimed_at, one claim record', async () => {
    await seedEpisode(db, 'n1');
    const first = await memoryClaimUpsert(db, { uid: 'n1', caller: 'alpha' });
    if (!first.ok) throw new Error('first claim failed');
    const second = await memoryClaimUpsert(db, { uid: 'n1', caller: 'alpha' });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.refreshed).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.claim.caller).toBe('alpha');
    expect(second.claim.claimed_at).toBe(first.claim.claimed_at); // identity preserved
    expect(second.claim.revision).toBe(2); // upsert counter advances; identity does not

    const list = await memoryClaimList(db);
    expect(list.count).toBe(1);
    expect(list.claims[0]!.claim.caller).toBe('alpha');
  });

  it('a DISTINCT caller is refused with a typed E_CLAIM_HELD naming the holder', async () => {
    await seedEpisode(db, 'n1');
    await memoryClaimUpsert(db, { uid: 'n1', caller: 'alpha' });
    const res = await memoryClaimUpsert(db, { uid: 'n1', caller: 'beta' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.code).toBe('E_CLAIM_HELD');
    if (res.code !== 'E_CLAIM_HELD') throw new Error('unreachable');
    expect(res.held_by).toBe('alpha');

    // The loser's attempt did not steal or duplicate the claim.
    const got = await memoryClaimGet(db, 'n1');
    if (!got.ok) throw new Error('unreachable');
    expect(got.claim?.caller).toBe('alpha');
  });

  it('E_NOT_FOUND for a missing uid; E_INVALID for a blank caller', async () => {
    const missing = await memoryClaimUpsert(db, { uid: 'nope', caller: 'alpha' });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('unreachable');
    expect(missing.code).toBe('E_NOT_FOUND');

    await seedEpisode(db, 'n1');
    const blank = await memoryClaimUpsert(db, { uid: 'n1', caller: '   ' });
    expect(blank.ok).toBe(false);
    if (blank.ok) throw new Error('unreachable');
    expect(blank.code).toBe('E_INVALID');
  });

  it('a patch is deep-merged into meta alongside the claim; a patch cannot forge the claim key', async () => {
    await seedEpisode(db, 'n1');
    await db.executeRun(`UPDATE node SET meta = ? WHERE uid = ?`, [JSON.stringify({ keep: 1 }), 'n1']);
    const res = await memoryClaimUpsert(db, {
      uid: 'n1',
      caller: 'alpha',
      patch: { metadata: { work: { step: 2 }, claim: { caller: 'attacker' } } },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');

    const row = await db.executeGet<{ meta: string }>(`SELECT meta FROM node WHERE uid = ?`, ['n1']);
    const meta = JSON.parse(row!.meta) as Record<string, unknown>;
    expect(meta['keep']).toBe(1); // pre-existing meta preserved
    expect(meta['work']).toEqual({ step: 2 }); // patch merged
    // The claim key is owned by the op — the attempted forgery is overwritten.
    expect((meta['claim'] as { caller: string }).caller).toBe('alpha');
  });

  it('memoryClaimList({caller}) filters; an unheld node reads claim:null', async () => {
    await seedEpisode(db, 'a');
    await seedEpisode(db, 'b');
    await seedEpisode(db, 'c');
    await memoryClaimUpsert(db, { uid: 'a', caller: 'alpha' });
    await memoryClaimUpsert(db, { uid: 'b', caller: 'beta' });

    const alpha = await memoryClaimList(db, { caller: 'alpha' });
    expect(alpha.count).toBe(1);
    expect(alpha.claims[0]!.uid).toBe('a');

    const unheld = await memoryClaimGet(db, 'c');
    if (!unheld.ok) throw new Error('unreachable');
    expect(unheld.claim).toBeNull();
  });
});

describe('SR-7 — the claim SURVIVES A STORE REOPEN (persisted, queryable record)', () => {
  it('claim a node, close the store, reopen: the same holder is readable from a fresh process/connection', async () => {
    await seedEpisode(db, 'n1');
    const claimed = await memoryClaimUpsert(db, { uid: 'n1', caller: 'alpha' });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error('unreachable');
    const claimedAt = claimed.claim.claimed_at;

    // Close the writer, then read through a brand-new connection to the same file.
    await db.close();
    const reopened = await openDb(dbPath);
    try {
      const got = await memoryClaimGet(reopened, 'n1');
      expect(got.ok).toBe(true);
      if (!got.ok) throw new Error('unreachable');
      expect(got.claim?.caller).toBe('alpha');
      expect(got.claim?.claimed_at).toBe(claimedAt);

      // A distinct caller is still refused after the reopen — the guard reads
      // the persisted holder, not in-process state.
      const refused = await memoryClaimUpsert(reopened, { uid: 'n1', caller: 'beta' });
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.code).toBe('E_CLAIM_HELD');
    } finally {
      await reopened.close();
    }
    // Re-establish `db` for the afterEach close.
    db = await openDb(dbPath);
  });
});

// ── The race: two REAL independent connections, gated by a latch ──────────────

/**
 * The pre-fix shape: read meta, then write it, with NO conditional predicate.
 * `afterRead` is a barrier the test uses to hold BOTH readers at the
 * read/write boundary until both have read — the exact lost-update this guard
 * exists to prevent.
 */
async function claimUnguarded(
  adapter: StoreAdapter,
  uid: string,
  caller: string,
  afterRead: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; code: 'E_CLAIM_HELD' }> {
  const row = await adapter.executeGet<{ meta: string | null }>(
    `SELECT meta FROM node WHERE uid = ? AND t_invalid IS NULL`,
    [uid],
  );
  const meta = row?.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
  await afterRead(); // both readers are here before either writes
  const now = new Date().toISOString();
  meta['claim'] = { caller, claimed_at: now, updated_at: now, revision: 1 };
  await adapter.executeRun(`UPDATE node SET meta = ? WHERE uid = ?`, [JSON.stringify(meta), uid]);
  return { ok: true };
}

describe('SR-7 — CONCURRENCY: two real connections racing for one node', () => {
  it('exactly one caller wins; the loser gets E_CLAIM_HELD (negative control: SR7_NEGATIVE=1 → RED)', async () => {
    await seedEpisode(db, 'n1');
    await db.close(); // release the writer; the racers open their OWN connections

    const a = await openDb(dbPath);
    const b = await openDb(dbPath);
    try {
      const negative = process.env['SR7_NEGATIVE'] === '1';

      // A start latch both racers await, so neither begins before both are ready.
      let releaseStart!: () => void;
      const start = new Promise<void>((r) => (releaseStart = r));

      // A read barrier for the negative-control variant: each racer signals its
      // read and WAITS until both have read, guaranteeing the lost-update window.
      let reads = 0;
      let releaseReads!: () => void;
      const bothRead = new Promise<void>((r) => (releaseReads = r));
      const afterRead = async (): Promise<void> => {
        reads += 1;
        if (reads === 2) releaseReads();
        await bothRead;
      };

      const run = (adapter: StoreAdapter, caller: string) =>
        start.then(async () => {
          if (!negative) return memoryClaimUpsert(adapter, { uid: 'n1', caller });
          return claimUnguarded(adapter, 'n1', caller, afterRead);
        });

      const p1 = run(a, 'alpha');
      const p2 = run(b, 'beta');
      releaseStart();
      const [r1, r2] = await Promise.all([p1, p2]);

      const winners = [r1, r2].filter((r) => r.ok);
      // THE INVARIANT. Green with the guard (1 winner); RED under the unguarded
      // negative-control variant (2 winners — the claim was lost-updated).
      expect(winners.length).toBe(1);

      const loser = [r1, r2].find((r) => !r.ok);
      expect(loser).toBeDefined();
      if (loser && !loser.ok) expect(loser.code).toBe('E_CLAIM_HELD');
    } finally {
      await a.close();
      await b.close();
      db = await openDb(dbPath);
    }
  });
});
