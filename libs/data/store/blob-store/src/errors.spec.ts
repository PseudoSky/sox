import { describe, it, expect } from 'vitest';
import {
  BlobStoreError,
  BlobNotFound,
  IntegrityMismatch,
  GCInProgress,
  BlobStoreSystemError,
  BlobStoreNotOpenError,
} from './errors.js';

describe('BlobStoreError', () => {
  it('is the base error class', () => {
    const err = new BlobStoreError('generic error');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BlobStoreError');
    expect(err.message).toBe('generic error');
  });
});

describe('BlobNotFound', () => {
  it('stores the hash and formats a message', () => {
    const hash = 'a'.repeat(64);
    const err = new BlobNotFound(hash);
    expect(err).toBeInstanceOf(BlobStoreError);
    expect(err.name).toBe('BlobNotFound');
    expect(err.hash).toBe(hash);
    expect(err.message).toContain(hash);
  });
});

describe('IntegrityMismatch', () => {
  it('stores hash, expected, computed, size', () => {
    const hash = 'a'.repeat(64);
    const err = new IntegrityMismatch(hash, hash, 'b'.repeat(64), 100);
    expect(err).toBeInstanceOf(BlobStoreError);
    expect(err.name).toBe('IntegrityMismatch');
    expect(err.hash).toBe(hash);
    expect(err.expectedHash).toBe(hash);
    expect(err.computedHash).toBe('b'.repeat(64));
    expect(err.size).toBe(100);
    expect(err.message).toContain(hash);
  });
});

describe('GCInProgress', () => {
  it('stores the startedAt timestamp', () => {
    const ts = '2026-06-29T12:00:00.000Z';
    const err = new GCInProgress(ts);
    expect(err).toBeInstanceOf(BlobStoreError);
    expect(err.name).toBe('GCInProgress');
    expect(err.startedAt).toBe(ts);
    expect(err.message).toContain(ts);
  });
});

describe('BlobStoreSystemError', () => {
  it('stores cause when provided', () => {
    const cause = new Error('disk full');
    const err = new BlobStoreSystemError('write failed', cause);
    expect(err).toBeInstanceOf(BlobStoreError);
    expect(err.name).toBe('BlobStoreSystemError');
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('write failed');
  });

  it('works without cause', () => {
    const err = new BlobStoreSystemError('permission denied');
    expect(err.cause).toBeUndefined();
  });
});

describe('BlobStoreNotOpenError', () => {
  it('has a descriptive message', () => {
    const err = new BlobStoreNotOpenError();
    expect(err).toBeInstanceOf(BlobStoreError);
    expect(err.name).toBe('BlobStoreNotOpenError');
    expect(err.message).toContain('not open');
  });
});
