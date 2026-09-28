/**
 * libs/host-runtime/src/retention.ts — bounded, roots-first retention (D-B /
 * substrate DESIGN §2 D3; invariant B-I6; SR-12; ADR-0014 design input).
 *
 * The rule that makes this safe: **no artifact with a live root is ever
 * reclaimed**, and **a tree with NO roots model is never auto-cleaned**. The
 * planner is READ-ONLY; deletion is a separate, deliberate act (`applyRetention`)
 * and is SOFT — paths move to a trash namespace and only `sweepTrash` (past the
 * grace window) removes bytes. This is the counter-design to the 1.4 GB snapshot
 * accrual: roots are checked first, not age alone.
 *
 * Leaf module: node builtins only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RootsModel {
  /** Live/active generation directory names or paths. */
  liveGenerations: string[];
  /** Lockfile entries referencing a deployed artifact (path or id). */
  lockEntries: string[];
  /** Pids of live processes holding a root (stringified for name matching). */
  runningPids: number[];
}

export interface RetentionPolicy {
  /** Only entries older than this are even eligible (0 disables the age gate). */
  maxAgeMs: number;
  /** Optional cap: stop reclaiming once this many bytes are selected. */
  maxBytes?: number;
  /** Soft-deleted entries survive this long in the trash before physical sweep. */
  graceMs: number;
  /** Where soft-deleted entries are moved. */
  trashDir: string;
}

export type RetentionClass = 'snapshot' | 'deployed-generation' | 'scratch';

export interface RetentionPlan {
  reclaim: Array<{ path: string; class: RetentionClass; bytes: number; reason: string }>;
  /** Entries withheld because a live root references them (B-I6). */
  protected: Array<{ path: string; root: string }>;
  /** A tree with no roots model — NEVER eligible. */
  unmanaged: string[];
  totalBytes: number;
}

interface TrashManifestEntry {
  originalPath: string;
  trashedPath: string;
  class: RetentionClass;
  trashedAt: number;
  /** sweepTrash removes the entry only at/after this instant (grace window). */
  sweepAfter: number;
}

const MANIFEST = 'manifest.json';

/** Recursive byte size of a path (file or directory). */
function sizeOf(p: string): number {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    total += sizeOf(path.join(p, e.name));
  }
  return total;
}

/** Classify an entry by naming convention. */
function classify(name: string): RetentionClass {
  if (/snapshot/i.test(name)) return 'snapshot';
  if (/gen(eration)?\b|gen-/i.test(name)) return 'deployed-generation';
  return 'scratch';
}

/**
 * Is `name`/`fullPath` referenced by any live root? Returns the root string, or
 * undefined.
 *
 * Roots are compared PATH-AWARE, both sides normalized (`path.resolve`, which
 * also strips a trailing separator): an entry is rooted when its resolved path
 * EQUALS a resolved root, when it lies BELOW a resolved root (the root is an
 * ancestor directory), or when its basename equals the root's basename. A root
 * supplied as an absolute path WITH a trailing separator (`join(dir,'gen-1')+sep`
 * — what shell tab-completion produces) resolves to the same path as the entry
 * and is therefore still protected; the previous `name === r || r.endsWith(name)`
 * substring arms matched neither it nor a bare `gen-1/`, so a live-rooted
 * generation was classified reclaimable and hard-deleted after the grace window
 * (counter-design to the module header's "no artifact with a live root is ever
 * reclaimed"). The non-path-aware substring arms are intentionally dropped:
 * `name.startsWith(r)`/`r.endsWith(name)` over-protected on a short root (a root
 * `gen-1` protected an unrelated `gen-1-backup`) and so defeated the GC.
 */
function matchingRoot(name: string, fullPath: string, roots: string[]): string | undefined {
  const full = path.resolve(fullPath);
  return roots.find((r) => {
    const resolved = path.resolve(r);
    return (
      full === resolved ||                 // exact path (trailing separators normalized away)
      full.startsWith(resolved + path.sep) || // entry lives under a rooted directory
      path.basename(resolved) === name     // bare name/id/basename root
    );
  });
}

/**
 * planRetention — READ-ONLY planner. An entry matched by a live root is
 * `protected`; with no roots model at all the whole dir is `unmanaged` (never
 * auto-cleaned); otherwise entries past `maxAgeMs` are `reclaim` candidates.
 */
export function planRetention(dir: string, roots: RootsModel, policy: RetentionPolicy): RetentionPlan {
  const reclaim: RetentionPlan['reclaim'] = [];
  const protectedList: RetentionPlan['protected'] = [];
  const unmanaged: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { reclaim, protected: protectedList, unmanaged, totalBytes: 0 };
  }

  const rootStrings = [
    ...roots.liveGenerations,
    ...roots.lockEntries,
    ...roots.runningPids.map(String),
  ];
  const hasRootsModel = rootStrings.length > 0;

  const now = Date.now();
  let totalBytes = 0;
  const trashResolved = path.resolve(policy.trashDir);

  for (const e of entries) {
    const full = path.join(dir, e.name);
    // The trash namespace is NEVER a reclaim candidate. If it were, a second
    // `gc` run would select `<dir>/.trash` (it matches no live root) and
    // `applyRetention` would rename it into its own descendant → EINVAL,
    // leaving the just-moved trees unrecorded. Exclude it, and equally exclude
    // any entry that CONTAINS the trash dir (moving that would be the same
    // self-nesting move).
    const fullResolved = path.resolve(full);
    if (
      fullResolved === trashResolved ||
      fullResolved.startsWith(trashResolved + path.sep) ||
      trashResolved.startsWith(fullResolved + path.sep)
    ) {
      continue;
    }
    const root = matchingRoot(e.name, full, rootStrings);
    if (root !== undefined) {
      protectedList.push({ path: full, root });
      continue;
    }
    if (!hasRootsModel) {
      // B-I6: no roots model ⇒ the tree is unmanaged and is NEVER eligible.
      unmanaged.push(full);
      continue;
    }
    const st = safeStat(full);
    const ageMs = st === undefined ? Infinity : now - st.mtimeMs;
    if (ageMs < policy.maxAgeMs) {
      protectedList.push({ path: full, root: '(within maxAgeMs)' });
      continue;
    }
    const bytes = sizeOf(full);
    if (policy.maxBytes !== undefined && totalBytes + bytes > policy.maxBytes && reclaim.length > 0) {
      protectedList.push({ path: full, root: '(maxBytes cap reached)' });
      continue;
    }
    totalBytes += bytes;
    reclaim.push({
      path: full,
      class: classify(e.name),
      bytes,
      reason: `unreferenced by any live root; age ${Math.round(ageMs)}ms ≥ maxAgeMs ${policy.maxAgeMs}`,
    });
  }

  return { reclaim, protected: protectedList, unmanaged, totalBytes };
}

function safeStat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

function readManifest(trashDir: string): TrashManifestEntry[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(trashDir, MANIFEST), 'utf8')) as TrashManifestEntry[];
  } catch {
    return [];
  }
}

function writeManifest(trashDir: string, entries: TrashManifestEntry[]): void {
  fs.mkdirSync(trashDir, { recursive: true });
  fs.writeFileSync(path.join(trashDir, MANIFEST), JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

/**
 * applyRetention — the deliberate act. Moves each `reclaim` path into the trash
 * namespace (SOFT delete) and records a manifest with `sweepAfter = now + graceMs`.
 * It never touches a `protected`/`unmanaged` path (they are not in the plan's
 * reclaim list). A path that vanished between planning and applying is skipped.
 *
 * The manifest is persisted INCREMENTALLY (after each moved tree), so a crash
 * mid-loop can never leave an already-moved tree unrecorded — which would make it
 * unsweepable forever (the pre-fix code wrote the manifest once, after the whole
 * loop, outside any try/finally).
 *
 * An item whose path is an ANCESTOR of `policy.trashDir` is refused (a clear
 * error) rather than renamed into its own descendant, which fails `EINVAL`.
 */
export async function applyRetention(plan: RetentionPlan, policy: RetentionPolicy): Promise<void> {
  const manifest = readManifest(policy.trashDir);
  const now = Date.now();
  const trashResolved = path.resolve(policy.trashDir);
  for (const item of plan.reclaim) {
    if (!fs.existsSync(item.path)) continue;
    const itemResolved = path.resolve(item.path);
    // Guard: moving a path into its own descendant is impossible (EINVAL) and
    // would leave it half-recorded. planRetention already excludes these, so
    // reaching here is an invariant violation — refuse loudly, never rename.
    if (itemResolved === trashResolved || trashResolved.startsWith(itemResolved + path.sep)) {
      throw new Error(
        `[retention] refusing to trash ${item.path}: it is an ancestor of (or equal to) ` +
        `policy.trashDir ${policy.trashDir} — a move into its own descendant is impossible (EINVAL)`,
      );
    }
    const destDir = path.join(policy.trashDir, item.class);
    fs.mkdirSync(destDir, { recursive: true });
    const stamped = `${path.basename(item.path)}.${now}`;
    const dest = path.join(destDir, stamped);
    fs.renameSync(item.path, dest);
    manifest.push({
      originalPath: item.path,
      trashedPath: dest,
      class: item.class,
      trashedAt: now,
      sweepAfter: now + policy.graceMs,
    });
    // Persist the moved set INCREMENTALLY: a throw/crash after this point still
    // leaves every already-moved tree recorded and therefore sweepable.
    writeManifest(policy.trashDir, manifest);
  }
}

/**
 * sweepTrash — physically delete trash entries whose grace window has elapsed.
 * `now` defaults to the wall clock. Only paths recorded in the manifest AND still
 * contained within `trashDir` are removed (safe by construction). Returns the
 * original paths swept.
 */
export function sweepTrash(trashDir: string, now: number = Date.now()): string[] {
  const manifest = readManifest(trashDir);
  const kept: TrashManifestEntry[] = [];
  const swept: string[] = [];
  const trashRoot = path.resolve(trashDir);

  for (const entry of manifest) {
    if (entry.sweepAfter > now) {
      kept.push(entry);
      continue;
    }
    const resolved = path.resolve(entry.trashedPath);
    // Guard: only ever remove something inside the trash namespace.
    if (resolved === trashRoot || !resolved.startsWith(trashRoot + path.sep)) {
      kept.push(entry);
      continue;
    }
    fs.rmSync(resolved, { recursive: true, force: true });
    swept.push(entry.originalPath);
  }
  writeManifest(trashDir, kept);
  return swept;
}
