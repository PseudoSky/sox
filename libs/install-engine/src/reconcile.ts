/**
 * libs/install-engine/src/reconcile.ts — lockfile ↔ installed-set reconciliation
 * (D-B / substrate DESIGN §2 D3; invariant B-I7; SR-16).
 *
 * It reports the difference between the `extensions.lock` claims and what the
 * ownership index says is actually installed — in BOTH directions — and it is
 * READ-ONLY (B-I7): it never repairs. Remediation is `soxe repair`, a separate act.
 *
 * Reuses `verifyIntegrity` (the ADR-0003 checksum authority) rather than
 * re-implementing a hash comparison, per its own docstring ("the scope-parity
 * suite tests THIS primitive, not four divergent paths").
 */

import * as fs from 'node:fs';
import { scopeConfigPaths, ownershipPathFor, type DataScope } from './data-paths.js';
import { loadLockfile } from './install.js';
import { readOwnership, type OwnedEntry } from './ownership.js';
import { verifyIntegrity } from './verify-integrity.js';

export type ReconcileStatus = 'installed' | 'missing' | 'drifted' | 'foreign';

export interface ReconcileExtensionEntry {
  id: string;
  status: ReconcileStatus;
  /** Present as a key in the scope lockfile. */
  lock: boolean;
  /** Present as a record in the ownership index. */
  installed: boolean;
  /** verifyIntegrity().current — null when it could not be computed (not installed / unresolvable). */
  checksumMatch: boolean | null;
}

export interface ReconcileReport {
  perExtension: ReconcileExtensionEntry[];
  /** In the lockfile, not installed (ownership has no record). */
  lockOnly: string[];
  /** Installed (ownership record), not in the lockfile. */
  installedOnly: string[];
  /** Installed with no resolvable artifact — a manifest-less stub. */
  stubs: string[];
}

/** An owned entry whose target is meant to exist on disk. */
function isOnDiskKind(e: OwnedEntry): e is Extract<OwnedEntry, { kind: 'file-drop' | 'materialize' }> {
  return e.kind === 'file-drop' || e.kind === 'materialize';
}

/**
 * reconcile — READ-ONLY (B-I7). Builds the union of lockfile keys and installed
 * (ownership) ids, then classifies each. `stubs` = an installed id with no lock
 * entry AND no file-drop/materialize target present on disk (nothing to resume).
 */
export async function reconcile(scope: DataScope, root?: string): Promise<ReconcileReport> {
  const lockPath = scopeConfigPaths(scope, root).lockfile;
  const lock = loadLockfile(lockPath);
  const lockIds = new Set(lock ? Object.keys(lock.resolved) : []);

  const index = readOwnership(ownershipPathFor(scope, root)); // ENOENT → empty; corrupt → throws
  const installedIds = new Set(index.owned.map((r) => r.extId));

  const ids = [...new Set([...lockIds, ...installedIds])].sort();
  const perExtension: ReconcileExtensionEntry[] = [];
  const lockOnly: string[] = [];
  const installedOnly: string[] = [];
  const stubs: string[] = [];

  for (const id of ids) {
    const inLock = lockIds.has(id);
    const installed = installedIds.has(id);

    if (inLock && !installed) {
      lockOnly.push(id);
      perExtension.push({ id, status: 'missing', lock: true, installed: false, checksumMatch: null });
      continue;
    }

    if (!inLock && installed) {
      installedOnly.push(id);
      const rec = index.owned.find((r) => r.extId === id)!;
      const hasArtifact = rec.entries.some((e) => isOnDiskKind(e) && fs.existsSync(e.path));
      if (!hasArtifact) stubs.push(id);
      perExtension.push({
        id, status: hasArtifact ? 'installed' : 'foreign', lock: false, installed: true, checksumMatch: null,
      });
      continue;
    }

    // Both present — the checksum authority decides installed vs drifted.
    let checksumMatch: boolean | null = null;
    try {
      const result = await verifyIntegrity(scope, id, { lockfilePath: lockPath });
      checksumMatch = result.status === 'current' ? true : result.status === 'stale' ? false : null;
    } catch {
      checksumMatch = null; // unresolvable artifact — reported as a plain present entry
    }
    perExtension.push({
      id,
      status: checksumMatch === false ? 'drifted' : 'installed',
      lock: true, installed: true, checksumMatch,
    });
  }

  return { perExtension, lockOnly, installedOnly, stubs };
}
