// ── In-process FD guard ───────────────────────────────────────────────────────
// Prevents GC from deleting a blob that is currently open for read within the
// same process. Cross-process coordination is a future concern (spec gap §1).

export interface FdGuard {
  /** Register interest in a hash. Returns a release function.
   *  Pairs must be balanced: every acquire must result in exactly one release. */
  acquire(hash: string): Promise<() => void>;

  /** Returns true if at least one FD is currently held for this hash. */
  isHeld(hash: string): boolean;

  /** Returns all hashes that currently have open FDs (for diagnostics). */
  activeHashes(): string[];
}

import { BlobNotFound } from './errors.js';

export class InProcessFdGuard implements FdGuard {
  private held = new Map<string, number>();

  constructor(private existsChecker?: (hash: string) => Promise<boolean>) {}

  async acquire(hash: string): Promise<() => void> {
    if (this.existsChecker && !(await this.existsChecker(hash))) {
      throw new BlobNotFound(hash);
    }
    const count = this.held.get(hash) ?? 0;
    this.held.set(hash, count + 1);
    return () => {
      const c = this.held.get(hash) ?? 0;
      if (c <= 1) {
        this.held.delete(hash);
      } else {
        this.held.set(hash, c - 1);
      }
    };
  }

  isHeld(hash: string): boolean {
    return (this.held.get(hash) ?? 0) > 0;
  }

  activeHashes(): string[] {
    return [...this.held.keys()].filter((h) => this.isHeld(h));
  }
}
