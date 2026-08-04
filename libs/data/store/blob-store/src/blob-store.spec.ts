import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  BlobStore,
  createBlobStore,
  BlobNotFound,
  GCInProgress,
  BlobStoreNotOpenError,
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
