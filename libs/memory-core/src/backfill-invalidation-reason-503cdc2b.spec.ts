/**
 * backfill-invalidation-reason-503cdc2b.spec.ts — backlog 503cdc2b.
 *
 * `memory_curate` op `backfill_invalidation_reason` gives the legacy
 * invalidated episodes that predate 9171d5cb (f7461993: "every episode
 * invalidation records its reason") a recorded, explicitly-unknown reason.
 *
 * Every assertion is driven through the public `memoryCurate` dispatcher so
 * this suite fails RED against the pre-change code (the op is unknown there:
 * `E_UNKNOWN_OP`) and GREEN once the op exists.
 *
 * Fixture DBs live in a tmpdir — never under ~/.memory. `backupStore` refuses
 * any path outside `~/.memory/**`, which the suite uses deliberately: the
 * default (real) backup path aborting on a tmpdir store IS the
 * abort-on-backup-failure test. Success-path applies inject a backup function
 * through the op's context seam (dependency injection, not an env toggle).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { openDb } from './db.js';
import { memoryCurate } from './curate.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest, _resetEmbedSingleton } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import { _resetTelemetryForTest } from './telemetry.js';
import type { BackupStoreResult, BackupStoreError } from './backup.js';
import { invalidateEpisodeInTx } from './invalidation-meta.js';

const OP = 'backfill_invalidation_reason';
const VIA = 'backfill_503cdc2b';
const REASON = 'unknown-legacy: invalidated before 9171d5cb; cause not recorded';

const T_A = '2026-03-01T10:00:00.000Z';
const T_B = '2026-04-02T11:30:00.000Z';
const T_C = '2026-05-03T12:45:00.000Z';

let dir: string;
let dbPath: string;
let db: StoreAdapter;

interface BackupCall { src: string; dst: string }
let backupCalls: BackupCall[];

/** Stub backup: records the call and reports success (no ~/.memory write). */
async function stubBackup(src: string, dst: string): Promise<BackupStoreResult | BackupStoreError> {
  backupCalls.push({ src, dst });
  const at = new Date().toISOString();
  return { sourcePath: src, destPath: dst, startedAt: at, completedAt: at, integrityCheck: 'ok' };
}

async function failingBackup(): Promise<BackupStoreResult | BackupStoreError> {
  return { code: 'E_IO', message: 'simulated backup failure', retryable: false };
}

beforeEach(async () => {
  _resetTelemetryForTest();
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-503cdc2b-')));
  dbPath = path.join(dir, 'm.db');
  db = await openDb(dbPath);
  await WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
  _setEmbedProviderForTest(new DeterministicTestProvider());
  backupCalls = [];
});

afterEach(async () => {
  _resetTelemetryForTest();
  _resetEmbedSingleton();
  await WriteQueue.clearInstances();
  await db.close().catch((err: unknown) => {
    console.debug('backfill-503cdc2b.spec: db.close failed (already closed?)', {
      dbPath,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function insertNode(
  uid: string,
  opts: { invalid?: string | null; meta?: unknown; kind?: string } = {},
): Promise<number> {
  const info = await db.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid, t_invalid, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uid,
      opts.kind ?? 'episode',
      `content of ${uid}`,
      crypto.createHash('sha256').update(uid).digest('hex'),
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      opts.invalid ?? null,
      opts.meta === undefined ? null : typeof opts.meta === 'string' ? opts.meta : JSON.stringify(opts.meta),
    ],
  );
  return Number(info.lastInsertRowid);
}

async function insertEdge(srcRowid: number, dstRowid: number, rel: string, live = true): Promise<void> {
  await db.executeRun(
    `INSERT INTO edge (src, dst, rel, origin, t_created, t_invalid) VALUES (?, ?, ?, ?, ?, ?)`,
    [srcRowid, dstRowid, rel, 'user_asserted', '2026-01-01T00:00:00.000Z', live ? null : T_C],
  );
}

async function rowOf(uid: string): Promise<{ t_invalid: string | null; meta: string | null }> {
  const row = await db.executeGet<{ t_invalid: string | null; meta: string | null }>(
    `SELECT t_invalid, meta FROM node WHERE uid = ?`,
    [uid],
  );
  if (!row) throw new Error(`fixture row ${uid} missing`);
  return row;
}

function parse(meta: string | null): Record<string, unknown> | null {
  return meta === null ? null : (JSON.parse(meta) as Record<string, unknown>);
}

async function snapshotAll(): Promise<Array<{ uid: string; t_invalid: string | null; meta: string | null }>> {
  const { rows } = await db.executeAll<{ uid: string; t_invalid: string | null; meta: string | null }>(
    `SELECT uid, t_invalid, meta FROM node ORDER BY uid`,
  );
  return rows;
}

/**
 * The fixture store:
 *   in-scope:  legacy-null   (invalid, meta NULL, no edges)
 *              legacy-meta   (invalid, meta {project:"x", nested:{a:1}}, no edges)
 *              legacy-dead-edge-other (invalid, only a MENTIONS edge — not SAME_AS/SUPERSEDES)
 *   excluded:  sameas-src / sameas-dst  (invalid, SAME_AS edge either direction)
 *              superseded    (invalid, dst of a SUPERSEDES edge)
 *              superseder    (invalid, src of a SUPERSEDES edge)
 *              expired-sameas (invalid, SAME_AS edge that is itself invalidated — still excluded)
 *              has-reason    (invalid, already carries invalidatedReason)
 *              has-via-only  (invalid, carries an invalidatedVia key — any `invalidated*` key excludes)
 *              live          (not invalid)
 *              claim-invalid (invalid, kind='claim' — not an episode)
 *              bad-meta      (invalid, meta is a JSON array, not an object — skipped and counted,
 *                             never touched; the schema's json_valid CHECK rules out malformed JSON)
 */
async function seed(): Promise<void> {
  await insertNode('legacy-null', { invalid: T_A });
  await insertNode('legacy-meta', { invalid: T_B, meta: { project: 'x', nested: { a: 1 } } });
  const otherRow = await insertNode('legacy-dead-edge-other', { invalid: T_C });

  const sa = await insertNode('sameas-src', { invalid: T_A });
  const sb = await insertNode('sameas-dst', { invalid: T_A });
  const live = await insertNode('live');
  await insertEdge(sa, live, 'SAME_AS');
  await insertEdge(live, sb, 'SAME_AS');

  const superseded = await insertNode('superseded', { invalid: T_B });
  const superseder = await insertNode('superseder', { invalid: T_B });
  await insertEdge(live, superseded, 'SUPERSEDES');
  await insertEdge(superseder, live, 'SUPERSEDES');

  const expired = await insertNode('expired-sameas', { invalid: T_C });
  await insertEdge(expired, live, 'SAME_AS', false);

  await insertNode('has-reason', { invalid: T_A, meta: { invalidatedReason: 'user said so', invalidatedAt: T_A, invalidatedVia: 'memory_invalidate' } });
  await insertNode('has-via-only', { invalid: T_A, meta: { invalidatedVia: 'something' } });
  await insertNode('claim-invalid', { invalid: T_A, kind: 'claim' });
  await insertNode('bad-meta', { invalid: T_A, meta: '[1,2]' });

  await insertEdge(otherRow, live, 'MENTIONS');
}

const IN_SCOPE = ['legacy-dead-edge-other', 'legacy-meta', 'legacy-null'];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('503cdc2b backfill_invalidation_reason — dry run', () => {
  it('dry_run defaults to TRUE: an omitted dry_run reports count + sample uids and changes nothing', async () => {
    await seed();
    const before = await snapshotAll();

    const res = (await memoryCurate(db, { op: OP }, undefined, { dbPath, backup: stubBackup })) as Record<string, unknown>;

    expect(res['code']).toBeUndefined();
    expect(res['op']).toBe(OP);
    expect(res['dry_run']).toBe(true);
    expect(res['mode']).toBe('apply');
    expect(res['candidates']).toBe(3);
    expect(res['sample_uids']).toEqual(IN_SCOPE);
    expect(res['rows_updated']).toBe(0);
    expect(res['skipped_non_object_meta']).toBe(1);
    expect(res['backup_path']).toBeNull();
    expect(backupCalls).toEqual([]);
    expect(await snapshotAll()).toEqual(before);
  });

  it('explicit dry_run:true is also a no-op', async () => {
    await seed();
    const before = await snapshotAll();
    const res = (await memoryCurate(db, { op: OP, dry_run: true }, undefined, { dbPath, backup: stubBackup })) as Record<string, unknown>;
    expect(res['dry_run']).toBe(true);
    expect(res['candidates']).toBe(3);
    expect(await snapshotAll()).toEqual(before);
  });
});

describe('503cdc2b backfill_invalidation_reason — apply', () => {
  it('fills ONLY in-scope rows; invalidatedAt == prior t_invalid; t_invalid unchanged; pre-existing meta preserved', async () => {
    await seed();
    const before = await snapshotAll();
    const beforeByUid = new Map(before.map((r) => [r.uid, r]));

    const res = (await memoryCurate(db, { op: OP, dry_run: false }, undefined, { dbPath, backup: stubBackup })) as Record<string, unknown>;

    expect(res['code']).toBeUndefined();
    expect(res['dry_run']).toBe(false);
    expect(res['candidates']).toBe(3);
    expect(res['rows_updated']).toBe(3);
    expect(typeof res['backup_path']).toBe('string');
    expect(backupCalls).toHaveLength(1);
    expect(backupCalls[0]!.src).toBe(dbPath);
    expect(backupCalls[0]!.dst).toBe(res['backup_path']);

    // t_invalid is never written — on ANY row.
    const after = await snapshotAll();
    for (const r of after) expect(r.t_invalid).toBe(beforeByUid.get(r.uid)!.t_invalid);

    // Out-of-scope rows are byte-identical.
    for (const r of after) {
      if (IN_SCOPE.includes(r.uid)) continue;
      expect(r.meta).toBe(beforeByUid.get(r.uid)!.meta);
    }

    const priorTInvalid: Record<string, string> = {
      'legacy-null': T_A,
      'legacy-meta': T_B,
      'legacy-dead-edge-other': T_C,
    };
    for (const uid of IN_SCOPE) {
      const m = parse((await rowOf(uid)).meta)!;
      expect(m['invalidatedReason']).toBe(REASON);
      expect(m['invalidatedVia']).toBe(VIA);
      expect(m['invalidatedAt']).toBe(priorTInvalid[uid]);
      expect(typeof m['invalidatedReasonBackfilledAt']).toBe('string');
      expect(Number.isNaN(Date.parse(m['invalidatedReasonBackfilledAt'] as string))).toBe(false);
    }
    const lm = parse((await rowOf('legacy-meta')).meta)!;
    expect(lm['project']).toBe('x');
    expect(lm['nested']).toEqual({ a: 1 });
  });

  it('is idempotent: a second apply touches 0 rows and leaves the store byte-identical', async () => {
    await seed();
    await memoryCurate(db, { op: OP, dry_run: false }, undefined, { dbPath, backup: stubBackup });
    const afterFirst = await snapshotAll();

    const second = (await memoryCurate(db, { op: OP, dry_run: false }, undefined, { dbPath, backup: stubBackup })) as Record<string, unknown>;
    expect(second['candidates']).toBe(0);
    expect(second['rows_updated']).toBe(0);
    expect(await snapshotAll()).toEqual(afterFirst);
  });

  it('aborts with ZERO mutation when the real backupStore fails (tmpdir store is outside the ~/.memory allowlist)', async () => {
    await seed();
    const before = await snapshotAll();
    // No `backup` injected → the default is the real backupStore, which
    // refuses a tmpdir source with E_ALLOWLIST. The op must abort.
    const res = (await memoryCurate(db, { op: OP, dry_run: false }, undefined, { dbPath })) as Record<string, unknown>;
    expect(res['code']).toBe('E_BACKUP_FAILED');
    expect(String(res['message'])).toContain('E_ALLOWLIST');
    expect(await snapshotAll()).toEqual(before);
  });

  it('aborts with ZERO mutation when an injected backup reports failure', async () => {
    await seed();
    const before = await snapshotAll();
    const res = (await memoryCurate(db, { op: OP, dry_run: false }, undefined, { dbPath, backup: failingBackup })) as Record<string, unknown>;
    expect(res['code']).toBe('E_BACKUP_FAILED');
    expect(await snapshotAll()).toEqual(before);
  });

  it('refuses to apply without a dbPath to back up — never skips the backup silently', async () => {
    await seed();
    const before = await snapshotAll();
    const res = (await memoryCurate(db, { op: OP, dry_run: false })) as Record<string, unknown>;
    expect(res['code']).toBe('E_BACKUP_UNAVAILABLE');
    expect(await snapshotAll()).toEqual(before);
  });
});

describe('503cdc2b backfill_invalidation_reason — reverse', () => {
  it('reverse (dry_run default TRUE) reports the backfilled rows and changes nothing', async () => {
    await seed();
    await memoryCurate(db, { op: OP, dry_run: false }, undefined, { dbPath, backup: stubBackup });
    const afterApply = await snapshotAll();

    const res = (await memoryCurate(db, { op: OP, reverse: true }, undefined, { dbPath, backup: stubBackup })) as Record<string, unknown>;
    expect(res['mode']).toBe('reverse');
    expect(res['dry_run']).toBe(true);
    expect(res['rows_matched']).toBe(3);
    expect(res['rows_reverted']).toBe(0);
    expect(await snapshotAll()).toEqual(afterApply);
  });

  it('reverse restores every row exactly (parsed meta deep-equal; NULL meta back to NULL; t_invalid untouched)', async () => {
    await seed();
    const before = await snapshotAll();
    await memoryCurate(db, { op: OP, dry_run: false }, undefined, { dbPath, backup: stubBackup });

    const res = (await memoryCurate(db, { op: OP, reverse: true, dry_run: false }, undefined, { dbPath, backup: stubBackup })) as Record<string, unknown>;
    expect(res['code']).toBeUndefined();
    expect(res['rows_matched']).toBe(3);
    expect(res['rows_reverted']).toBe(3);
    expect(typeof res['backup_path']).toBe('string');

    const after = await snapshotAll();
    expect(after.map((r) => r.uid)).toEqual(before.map((r) => r.uid));
    for (let i = 0; i < before.length; i++) {
      const b = before[i]!;
      const a = after[i]!;
      expect(a.t_invalid).toBe(b.t_invalid);
      if (b.uid === 'bad-meta') {
        expect(a.meta).toBe(b.meta);
        continue;
      }
      expect(parse(a.meta)).toEqual(parse(b.meta));
    }

    // And the backfill is re-appliable after a reversal.
    const again = (await memoryCurate(db, { op: OP }, undefined, { dbPath, backup: stubBackup })) as Record<string, unknown>;
    expect(again['candidates']).toBe(3);
  });

  it('reverse never strips a reason another writer recorded (only invalidatedVia == backfill_503cdc2b)', async () => {
    await seed();
    const before = parse((await rowOf('has-reason')).meta);
    const applied = (await memoryCurate(db, { op: OP, dry_run: false }, undefined, { dbPath, backup: stubBackup })) as Record<string, unknown>;
    expect(applied['rows_updated']).toBe(3);
    const reversed = (await memoryCurate(db, { op: OP, reverse: true, dry_run: false }, undefined, { dbPath, backup: stubBackup })) as Record<string, unknown>;
    expect(reversed['rows_reverted']).toBe(3);
    expect(parse((await rowOf('has-reason')).meta)).toEqual(before);
    expect(parse((await rowOf('has-via-only')).meta)).toEqual({ invalidatedVia: 'something' });
  });

  it('reverse aborts with ZERO mutation when the backup fails', async () => {
    await seed();
    await memoryCurate(db, { op: OP, dry_run: false }, undefined, { dbPath, backup: stubBackup });
    const afterApply = await snapshotAll();
    const res = (await memoryCurate(db, { op: OP, reverse: true, dry_run: false }, undefined, { dbPath, backup: failingBackup })) as Record<string, unknown>;
    expect(res['code']).toBe('E_BACKUP_FAILED');
    expect(await snapshotAll()).toEqual(afterApply);
  });
});

describe('503cdc2b backfill_invalidation_reason — interaction with a LATER real invalidation', () => {
  it('invalidateEpisodeInTx archives the whole backfill event (incl. invalidatedReasonBackfilledAt) into invalidationHistory', async () => {
    await seed();
    await memoryCurate(db, { op: OP, dry_run: false }, undefined, { dbPath, backup: stubBackup });
    const backfilled = parse((await rowOf('legacy-meta')).meta)!;

    // A later intent-carrying invalidation (e.g. merge_duplicates, which
    // invalidates unconditionally) re-invalidates the already-backfilled row.
    await db.transaction(async (tx) => {
      await invalidateEpisodeInTx(tx, { uid: 'legacy-meta', tInvalid: T_C, reason: 'later merge', via: 'merge_duplicates' });
    });

    const m = parse((await rowOf('legacy-meta')).meta)!;
    expect(m['invalidatedReason']).toBe('later merge');
    expect(m['invalidatedVia']).toBe('merge_duplicates');
    // The backfill marker must NOT be left at top level beside the new event —
    // that would read as "this merge reason was backfilled".
    expect(m['invalidatedReasonBackfilledAt']).toBeUndefined();
    const history = m['invalidationHistory'] as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      invalidatedReason: REASON,
      invalidatedVia: VIA,
      invalidatedAt: T_B,
      invalidatedReasonBackfilledAt: backfilled['invalidatedReasonBackfilledAt'],
    });

    // Reverse leaves a row alone once another writer owns its current event.
    const rev = (await memoryCurate(db, { op: OP, reverse: true, dry_run: false }, undefined, { dbPath, backup: stubBackup })) as Record<string, unknown>;
    expect(rev['rows_reverted']).toBe(2);
    expect(parse((await rowOf('legacy-meta')).meta)).toEqual(m);
  });
});
