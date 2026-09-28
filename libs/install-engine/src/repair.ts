/**
 * libs/install-engine/src/repair.ts — `soxe repair` migration primitives
 * (D-B Migration §3 / §5).
 *
 * The ONLY write here is the one-time hash backfill: compute `contentHash` for
 * every file-drop/materialize ownership entry that predates the field, so the
 * drift pass can stop reporting them `unverifiable`. Until then, those entries
 * are honestly `unverifiable` (never `still-valid`). The migration is complete
 * when the unverifiable count reaches zero for managed entries.
 *
 * A partial migration is never bricked: readers accept both hash-bearing and
 * hash-less entries (Migration §5 rollback note).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ownershipPathFor, type DataScope } from './data-paths.js';
import { readOwnership, writeOwnershipAtomic, type OwnedEntry } from './ownership.js';

export interface BackfillReport {
  /** file-drop/materialize entries without a contentHash BEFORE the backfill. */
  before: number;
  /** …AFTER. Zero means the managed set is fully hash-bearing. */
  after: number;
  /** Entries that gained a contentHash in this run. */
  filled: number;
  /** Entries still hash-less because their target is absent (`gone`). */
  missingTargets: number;
}

function sha256File(p: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function isHashless(e: OwnedEntry): e is Extract<OwnedEntry, { kind: 'file-drop' | 'materialize' }> {
  return (e.kind === 'file-drop' || e.kind === 'materialize') && e.contentHash === undefined;
}

/** Count of managed entries still lacking a contentHash (the migration metric). */
export function countUnverifiable(scope: DataScope, root?: string): number {
  const data = readOwnership(ownershipPathFor(scope, root)); // ENOENT → empty; corrupt → throws
  let n = 0;
  for (const rec of data.owned) for (const e of rec.entries) if (isHashless(e)) n++;
  return n;
}

/**
 * backfillHashes — compute and persist `contentHash` for every file-drop /
 * materialize entry that lacks one and whose target exists on disk. Idempotent.
 * Returns before/after counts so a caller can report the migration delta.
 */
export function backfillHashes(scope: DataScope, root?: string): BackfillReport {
  const filePath = ownershipPathFor(scope, root);
  const data = readOwnership(filePath); // ENOENT → empty; corrupt → throws (loud)
  let before = 0;
  let filled = 0;
  let missingTargets = 0;

  for (const rec of data.owned) {
    for (const e of rec.entries) {
      if (!isHashless(e)) continue;
      before++;
      const target = path.isAbsolute(e.path) ? e.path : path.join(root ?? process.cwd(), e.path);
      if (!fs.existsSync(target)) {
        missingTargets++;
        continue;
      }
      e.contentHash = sha256File(target);
      filled++;
    }
  }

  if (filled > 0) writeOwnershipAtomic(filePath, data);
  return { before, after: before - filled, filled, missingTargets };
}
