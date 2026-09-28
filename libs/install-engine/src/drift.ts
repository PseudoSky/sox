/**
 * libs/install-engine/src/drift.ts — the READ-ONLY drift pass (D-B / substrate
 * DESIGN §2 D3; invariants B-I4, B-I5; SR-11).
 *
 * It recomputes CONTENT HASHES for every owned file-drop/materialize entry and
 * emits an explicit verdict. It NEVER writes (B-I5 — detect ≠ remediate), it
 * NEVER uses mtime/size as a verdict input (B-I4 — a same-size, same-mtime edit
 * must still read `drifted`), and it is honest about what it cannot prove:
 *
 *   still-valid   recomputed sha256 === recorded contentHash
 *   drifted       target present, hash differs from contentHash
 *   gone          a declared target is not on disk
 *   foreign       a filesystem entry under a managed owned root with NO record
 *   unverifiable  a pre-hash legacy entry (no contentHash) — NEVER `still-valid`
 *
 * The fifth verdict exists only so a migration can be TRUTHFUL rather than
 * silently optimistic; SR-11 names the first four.
 *
 * A corrupt ownership index is a loud typed error (readOwnership throws); a
 * genuinely absent index is simply "nothing owned".
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ownershipPathFor, type DataScope } from './data-paths.js';
import { readOwnership, type OwnedEntry } from './ownership.js';

export type DriftVerdict = 'still-valid' | 'drifted' | 'gone' | 'foreign' | 'unverifiable';

export interface DriftEntry {
  extId: string;
  scope: string;
  kind: OwnedEntry['kind'];
  target: string;
  verdict: DriftVerdict;
  expected: string | null;
  actual: string | null;
}

export interface DriftReport {
  scope: string;
  entries: DriftEntry[];
  counts: Record<DriftVerdict, number>;
}

/** sha256 of a file's bytes as `sha256:<hex>` — the ONLY verdict input (B-I4). */
function sha256File(p: string): string {
  const data = fs.readFileSync(p);
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

/** Resolve an owned target to an absolute path (ownership paths are absolute). */
function resolveTarget(target: string, root?: string): string {
  return path.isAbsolute(target) ? target : path.join(root ?? process.cwd(), target);
}

/** Directories too broad to scan for `foreign` entries (would flag the whole home). */
function isTooBroadToScan(dir: string): boolean {
  const parsed = path.parse(dir);
  return dir === os.homedir() || dir === parsed.root || dir === '' ;
}

/**
 * detectDrift — READ-ONLY (B-I5). Compares recomputed content hashes only.
 * Never throws on a missing index; DOES throw on a corrupt one (B-I3).
 */
export async function detectDrift(scope: DataScope, root?: string): Promise<DriftReport> {
  const filePath = ownershipPathFor(scope, root);
  const index = readOwnership(filePath); // ENOENT → empty; corrupt → OwnershipCorruptError
  const entries: DriftEntry[] = [];
  const ownedTargets = new Set<string>();
  const managedDirs = new Set<string>();

  for (const rec of index.owned) {
    for (const e of rec.entries) {
      if (e.kind !== 'file-drop' && e.kind !== 'materialize') continue;
      const target = resolveTarget(e.path, root);
      ownedTargets.add(target);
      const dir = path.dirname(target);
      if (!isTooBroadToScan(dir)) managedDirs.add(dir);

      if (e.contentHash === undefined) {
        // Pre-hash legacy row — honest fifth verdict, never `still-valid`.
        entries.push({
          extId: rec.extId, scope: rec.scope, kind: e.kind, target,
          verdict: 'unverifiable', expected: null,
          actual: fs.existsSync(target) ? sha256File(target) : null,
        });
        continue;
      }
      if (!fs.existsSync(target)) {
        entries.push({
          extId: rec.extId, scope: rec.scope, kind: e.kind, target,
          verdict: 'gone', expected: e.contentHash, actual: null,
        });
        continue;
      }
      const actual = sha256File(target);
      entries.push({
        extId: rec.extId, scope: rec.scope, kind: e.kind, target,
        verdict: actual === e.contentHash ? 'still-valid' : 'drifted',
        expected: e.contentHash, actual,
      });
    }
  }

  // `foreign`: an entry under a managed owned root with NO ownership record.
  for (const dir of managedDirs) {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // dir vanished between the owned-target check and the scan — skip
    }
    for (const child of children) {
      const childPath = path.join(dir, child.name);
      if (ownedTargets.has(childPath)) continue;
      // A `foreign` verdict needs a stable attributed root; use the managed dir.
      let actual: string | null = null;
      if (child.isFile()) {
        try { actual = sha256File(childPath); } catch { actual = null; }
      }
      entries.push({
        extId: '(none)', scope, kind: 'file-drop', target: childPath,
        verdict: 'foreign', expected: null, actual,
      });
    }
  }

  const counts: Record<DriftVerdict, number> = {
    'still-valid': 0, drifted: 0, gone: 0, foreign: 0, unverifiable: 0,
  };
  for (const e of entries) counts[e.verdict]++;

  return { scope, entries, counts };
}
