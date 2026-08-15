import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';
import {
  BlobStore,
  createBlobStore,
  BlobNotFound,
  GCInProgress,
  BlobStoreNotOpenError,
  BlobStoreSystemError,
  sha256Hex,
} from './index.js';

function randomHex(len: number): string {
  const chars = 'abcdef0123456789';
  let r = '';
  for (let i = 0; i < len; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

describe('BlobStore', () => {
  let basePath: string;
  let store: BlobStore;

  beforeEach(async () => {
    basePath = path.join(tmpdir(), `blob-test-${randomHex(8)}`);
    store = createBlobStore({ basePath });
    await store.open();
  });

  afterEach(async () => {
    await store.close();
    await fsp.rm(basePath, { recursive: true, force: true });
  });

  describe('lifecycle', () => {
    it('throws when used before open', async () => {
      const s = createBlobStore({ basePath: path.join(tmpdir(), `blob-test-${randomHex(8)}`) });
      await expect(s.has('abc')).rejects.toThrow(BlobStoreNotOpenError);
    });

    it('isOpen reflects state', () => {
      const s = createBlobStore({ basePath: path.join(tmpdir(), `blob-test-${randomHex(8)}`) });
      expect(s.isOpen).toBe(false);
    });

    it('open and close cycle', async () => {
      const s = createBlobStore({ basePath: path.join(tmpdir(), `blob-test-${randomHex(8)}`) });
      await s.open();
      expect(s.isOpen).toBe(true);
      await s.close();
      expect(s.isOpen).toBe(false);
    });
  });

  describe('put and get', () => {
    it('stores a blob and retrieves it', async () => {
      const data = new TextEncoder().encode('hello world');
      const hash = await store.put(data);
      expect(hash).toHaveLength(64);
      const retrieved = await store.get(hash);
      expect(retrieved).not.toBeNull();
      expect(new TextDecoder().decode(retrieved!)).toBe('hello world');
    });

    it('put is idempotent - same content returns same hash', async () => {
      const data = new TextEncoder().encode('hello world');
      const hash1 = await store.put(data);
      const hash2 = await store.put(data);
      expect(hash1).toBe(hash2);
    });

    it('get returns null for non-existent hash', async () => {
      const result = await store.get(randomHex(64));
      expect(result).toBeNull();
    });

    it('getStream returns a readable stream', async () => {
      const data = new TextEncoder().encode('stream test data');
      const hash = await store.put(data);
      const stream = await store.getStream(hash);
      expect(stream).not.toBeNull();
      const reader = stream!.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const combined = chunks.reduce((acc, c) => {
        const tmp = new Uint8Array(acc.length + c.length);
        tmp.set(acc);
        tmp.set(c, acc.length);
        return tmp;
      }, new Uint8Array(0));
      expect(new TextDecoder().decode(combined)).toBe('stream test data');
    });

    it('getStream returns null for non-existent hash', async () => {
      const stream = await store.getStream(randomHex(64));
      expect(stream).toBeNull();
    });
  });

  describe('putStream', () => {
    it('stores blob from a stream', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
      const hash = await store.putStream(stream);
      expect(hash).toHaveLength(64);
      const retrieved = await store.get(hash);
      expect(retrieved).not.toBeNull();
      expect([...retrieved!]).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('has and exists', () => {
    it('returns true for existing blob', async () => {
      const data = new TextEncoder().encode('exists test');
      const hash = await store.put(data);
      expect(await store.has(hash)).toBe(true);
      expect(await store.exists(hash)).toBe(true);
    });

    it('returns false for non-existing hash', async () => {
      expect(await store.has(randomHex(64))).toBe(false);
    });
  });

  describe('delete', () => {
    it('deletes an existing blob', async () => {
      const data = new TextEncoder().encode('delete me');
      const hash = await store.put(data);
      expect(await store.delete(hash)).toBe(true);
      expect(await store.has(hash)).toBe(false);
    });

    it('returns false for non-existing hash', async () => {
      expect(await store.delete(randomHex(64))).toBe(false);
    });
  });

  describe('count, totalSize, sizeOf', () => {
    it('count returns correct blob count', async () => {
      const data1 = new TextEncoder().encode('a');
      const data2 = new TextEncoder().encode('b');
      await store.put(data1);
      await store.put(data2);
      expect(await store.count()).toBe(2);
    });

    it('totalSize returns correct sum', async () => {
      const data1 = new TextEncoder().encode('hello');
      const data2 = new TextEncoder().encode('world');
      const h1 = await store.put(data1);
      const h2 = await store.put(data2);
      expect(await store.totalSize()).toBe(10);
      expect(await store.sizeOf(h1)).toBe(5);
      expect(await store.sizeOf(h2)).toBe(5);
    });

    it('sizeOf returns 0 for non-existent hash', async () => {
      expect(await store.sizeOf(randomHex(64))).toBe(0);
    });
  });

  describe('reference tracking', () => {
    it('addRef and getReferrersForBlob', async () => {
      const data = new TextEncoder().encode('ref test');
      const hash = await store.put(data);
      await store.addRef(hash, 'post:42', { role: 'avatar' });
      const referrers = await store.getReferrersForBlob(hash);
      expect(referrers).toEqual(['post:42']);
    });

    it('addRef throws BlobNotFound for non-existent hash', async () => {
      await expect(store.addRef(randomHex(64), 'test')).rejects.toThrow(BlobNotFound);
    });

    it('removeRef is idempotent', async () => {
      const data = new TextEncoder().encode('remove ref');
      const hash = await store.put(data);
      await store.addRef(hash, 'post:1');
      await store.removeRef(hash, 'post:1');
      await store.removeRef(hash, 'post:1'); // no error
      expect(await store.refCount(hash)).toBe(0);
    });

    it('addRefs atomically adds multiple refs', async () => {
      const data = new TextEncoder().encode('multi ref');
      const hash = await store.put(data);
      await store.addRefs([hash], 'batch:1');
      expect(await store.refCount(hash)).toBe(1);
    });

    it('removeAllRefs clears all refs for a referrer', async () => {
      const d1 = new TextEncoder().encode('a');
      const d2 = new TextEncoder().encode('b');
      const h1 = await store.put(d1);
      const h2 = await store.put(d2);
      await store.addRef(h1, 'user:1');
      await store.addRef(h2, 'user:1');
      await store.removeAllRefs('user:1');
      expect(await store.getRefsForReferrer('user:1')).toEqual([]);
    });
  });

  describe('pin / unpin', () => {
    it('pin and isPinned', async () => {
      const data = new TextEncoder().encode('pin test');
      const hash = await store.put(data);
      await store.pin(hash);
      expect(await store.isPinned(hash)).toBe(true);
      await store.unpin(hash);
      expect(await store.isPinned(hash)).toBe(false);
    });

    it('pin throws BlobNotFound for non-existent hash', async () => {
      await expect(store.pin(randomHex(64))).rejects.toThrow(BlobNotFound);
    });
  });

  describe('integrity verification', () => {
    it('verify returns match for intact blob', async () => {
      const data = new TextEncoder().encode('verify me');
      const hash = await store.put(data);
      const result = await store.verify(hash);
      expect(result.match).toBe(true);
      expect(result.hash).toBe(hash);
    });

    it('verify throws BlobNotFound for non-existent hash', async () => {
      await expect(store.verify(randomHex(64))).rejects.toThrow(BlobNotFound);
    });
  });

  describe('GC', () => {
    it('gc does not fail on empty store', async () => {
      const result = await store.gc({ dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.deleted).toBe(0);
    });

    it('gc does not delete referenced blobs', async () => {
      const data = new TextEncoder().encode('keep me');
      const hash = await store.put(data);
      await store.addRef(hash, 'pin:1');
      const result = await store.gc({ dryRun: true });
      const orphaned = result.orphans.find((o) => o.hash === hash);
      expect(orphaned).toBeUndefined();
    });
  });

  describe('metrics', () => {
    it('returns approximate metrics', async () => {
      const data = new TextEncoder().encode('metrics test');
      await store.put(data);
      const m = await store.metrics();
      expect(m.totalBlobs).toBeGreaterThanOrEqual(1);
      expect(m.readCount).toBeGreaterThanOrEqual(0);
      expect(m.writeCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GCInProgress guard on delete', () => {
    it('delete throws GCInProgress during gc', async () => {
      const data = new TextEncoder().encode('gc guard');
      await store.put(data);
      const gcPromise = store.gc();
      await expect(store.delete(randomHex(64))).rejects.toThrow(GCInProgress);
      await gcPromise;
    });
  });
});

// ── BUG-EPIC-BLOBSTORE-WRITE-ORDER-INVERSION-001 ──────────────────────────────
//
// Every mutation path used to perform the filesystem write BEFORE the DB
// record write. A crash/failure between the two left the store inconsistent
// in the dangerous direction: an orphan (file, no record) for creates that
// no DB-driven scan could ever find, and — far worse — a dangling reference
// (record, no file) for deletes/GC, where every subsequent read fails
// against a record that claims to exist.
//
// The fix flips the order everywhere (DB record first, then file) so the
// only residue a crash between the two operations can leave is the
// recoverable direction, and adds checkConsistency()/repairDangling() as the
// detection + safe-reclaim tooling the store previously had none of.
//
// A `faultInjectingAdapter` wraps the real StoreAdapter and can be armed to
// throw the NEXT time a specific SQL statement (optionally matching a
// specific first bind argument) is issued — a one-shot fault exactly at the
// DB half of a create/delete/GC-sweep operation. Because the DB and FS
// operations swap positions between the old and new orderings, arming the
// SAME fault surfaces the SAME bug: under the old (file-first) ordering the
// FS half has already committed by the time the DB half is reached, so the
// injected failure leaves exactly the residue the epic describes; under the
// fixed (DB-first) ordering the DB half is reached FIRST, so the injected
// failure fires before the FS half ever runs and nothing is left behind.

interface FaultPlan {
  failNextMatching?: { sqlPattern: RegExp; arg0?: string };
}

function faultInjectingAdapter(real: StoreAdapter, plan: FaultPlan): StoreAdapter {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'executeRun') {
        return async (sql: string, args?: unknown[]) => {
          const fault = plan.failNextMatching;
          if (
            fault &&
            fault.sqlPattern.test(sql) &&
            (fault.arg0 === undefined || args?.[0] === fault.arg0)
          ) {
            delete plan.failNextMatching; // one-shot
            throw new Error('injected fault: db operation failed');
          }
          return (target.executeRun as StoreAdapter['executeRun'])(sql, args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

describe('write-order invariants (BUG-EPIC-BLOBSTORE-WRITE-ORDER-INVERSION-001)', () => {
  let woBasePath: string;
  let realAdapter: StoreAdapter;
  let faultPlan: FaultPlan;
  let woStore: BlobStore;

  beforeEach(async () => {
    woBasePath = path.join(tmpdir(), `blob-wo-${randomHex(8)}`);
    await fsp.mkdir(woBasePath, { recursive: true });
    realAdapter = createSqliteAdapter({ dbPath: path.join(woBasePath, 'refs.db') });
    faultPlan = {};
    woStore = createBlobStore({
      basePath: woBasePath,
      adapter: faultInjectingAdapter(realAdapter, faultPlan),
    });
    await woStore.open();
  });

  afterEach(async () => {
    await woStore.close();
    await fsp.rm(woBasePath, { recursive: true, force: true });
  });

  describe('put() — create path (site: store.ts put(), rename+upsertMeta)', () => {
    it('a DB-insert failure leaves zero orphans and zero dangling references', async () => {
      const data = new TextEncoder().encode('put create fault');
      const hash = sha256Hex(data);
      faultPlan.failNextMatching = { sqlPattern: /INSERT INTO blob_meta/, arg0: hash };

      await expect(woStore.put(data)).rejects.toThrow();

      const report = await woStore.checkConsistency();
      expect(report.orphanCount).toBe(0);
      expect(report.danglingCount).toBe(0);
      expect(await woStore.has(hash)).toBe(false);
    });
  });

  describe('putStream() — create path (site: store.ts putStream(), rename+upsertMeta)', () => {
    it('a DB-insert failure leaves zero orphans and zero dangling references', async () => {
      const data = new Uint8Array([9, 9, 9, 1, 2, 3]);
      const hash = sha256Hex(data);
      faultPlan.failNextMatching = { sqlPattern: /INSERT INTO blob_meta/, arg0: hash };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
      await expect(woStore.putStream(stream)).rejects.toThrow();

      const report = await woStore.checkConsistency();
      expect(report.orphanCount).toBe(0);
      expect(report.danglingCount).toBe(0);
      expect(await woStore.has(hash)).toBe(false);
    });
  });

  describe('delete() — the critical direction (site: store.ts delete(), unlink+DELETE)', () => {
    it('a DB-delete failure never leaves a dangling reference — blob stays fully present', async () => {
      const data = new TextEncoder().encode('delete fault');
      const hash = await woStore.put(data);
      faultPlan.failNextMatching = { sqlPattern: /DELETE FROM blob_meta/, arg0: hash };

      await expect(woStore.delete(hash)).rejects.toThrow(BlobStoreSystemError);

      const report = await woStore.checkConsistency();
      expect(report.danglingCount).toBe(0);
      // Failed cleanly rather than leaving a record with no file: the blob is
      // still fully present (both DB row and file untouched).
      expect(await woStore.has(hash)).toBe(true);
    });
  });

  describe('gc() sweep — same inversion (site: store.ts gc() sweep phase, unlink+DELETE)', () => {
    it('a DB-delete failure mid-sweep never leaves a dangling reference', async () => {
      const data = new TextEncoder().encode('gc fault');
      const hash = await woStore.put(data); // unreferenced -> immediately GC-eligible
      faultPlan.failNextMatching = { sqlPattern: /DELETE FROM blob_meta/, arg0: hash };

      const result = await woStore.gc();
      expect(result.errors.some((e) => e.hash === hash)).toBe(true);

      const report = await woStore.checkConsistency();
      expect(report.danglingCount).toBe(0);
      // Deletion failed cleanly: the blob survives, eligible for the next GC pass.
      expect(await woStore.has(hash)).toBe(true);
    });
  });

  describe('checkConsistency() + repairDangling() — detection and safe reclaim', () => {
    it('detects a dangling record (simulated crash between DB commit and file placement) and reclaims it', async () => {
      const data = new TextEncoder().encode('simulated crash residue');
      const hash = sha256Hex(data);

      // Simulate a genuine process crash: perform ONLY the DB-commit half of
      // put()'s write order — the file is never placed. This is exactly the
      // residue a hard process kill between put()'s two operations leaves,
      // which no catchable-exception rollback can ever run for.
      await realAdapter.executeRun('INSERT INTO blob_meta(hash, size) VALUES(?, ?)', [
        hash,
        data.byteLength,
      ]);

      const before = await woStore.checkConsistency();
      expect(before.dangling.some((d) => d.hash === hash)).toBe(true);
      expect(await woStore.has(hash)).toBe(false);

      const repair = await woStore.repairDangling();
      expect(repair.reclaimed).toBeGreaterThanOrEqual(1);
      expect(repair.unreclaimed).toHaveLength(0);

      const after = await woStore.checkConsistency();
      expect(after.dangling.some((d) => d.hash === hash)).toBe(false);
      expect(after.danglingCount).toBe(0);
    });

    it('detects an orphan file and leaves it alone (reclaimable via GC, never via repairDangling)', async () => {
      const data = new TextEncoder().encode('orphan file');
      const hash = sha256Hex(data);
      const fp = path.join(woBasePath, hash.slice(0, 2), hash);
      await fsp.mkdir(path.dirname(fp), { recursive: true });
      await fsp.writeFile(fp, data);

      const report = await woStore.checkConsistency();
      expect(report.orphans.some((o) => o.hash === hash)).toBe(true);

      const repair = await woStore.repairDangling();
      expect(repair.reclaimed).toBe(0);

      const after = await woStore.checkConsistency();
      expect(after.orphans.some((o) => o.hash === hash)).toBe(true);
    });

    it('never deletes a dangling record that still has a live ref — real data loss is surfaced, not hidden', async () => {
      const data = new TextEncoder().encode('dangling with live ref');
      const hash = sha256Hex(data);
      await realAdapter.executeRun('INSERT INTO blob_meta(hash, size) VALUES(?, ?)', [
        hash,
        data.byteLength,
      ]);
      await realAdapter.executeRun('INSERT INTO refs(blob_hash, referrer) VALUES(?, ?)', [
        hash,
        'test:referrer',
      ]);

      const repair = await woStore.repairDangling();
      expect(repair.reclaimed).toBe(0);
      expect(repair.unreclaimed).toEqual([{ hash, refCount: 1 }]);

      const after = await woStore.checkConsistency();
      expect(after.dangling.some((d) => d.hash === hash)).toBe(true);
    });
  });
});
