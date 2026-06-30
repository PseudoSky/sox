// ── Error taxonomy for @adhd/sox-blob-store ───────────────────────────────────

export class BlobStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobStoreError';
  }
}

export class BlobNotFound extends BlobStoreError {
  constructor(public readonly hash: string) {
    super(`blob not found: ${hash}`);
    this.name = 'BlobNotFound';
  }
}

export class IntegrityMismatch extends BlobStoreError {
  constructor(
    public readonly hash: string,
    public readonly expectedHash: string,
    public readonly computedHash: string,
    public readonly size: number,
  ) {
    super(
      `integrity mismatch for ${hash}: computed ${computedHash}, expected ${expectedHash}`,
    );
    this.name = 'IntegrityMismatch';
  }
}

export class GCInProgress extends BlobStoreError {
  constructor(public readonly startedAt: string) {
    super(`GC already in progress (started at ${startedAt})`);
    this.name = 'GCInProgress';
  }
}

export class BlobStoreSystemError extends BlobStoreError {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'BlobStoreSystemError';
  }
}

export class BlobStoreNotOpenError extends BlobStoreError {
  constructor() {
    super('blob store is not open');
    this.name = 'BlobStoreNotOpenError';
  }
}
