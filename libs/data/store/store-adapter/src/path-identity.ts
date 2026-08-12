/**
 * path-identity — ONE canonical path per physical store (INV-4, BUG-018).
 *
 * Every cross-process coordination key — the lease directory
 * (`<dbPath>.sox-lease.d`), the out-of-band open marker (`<dbPath>-openmark`),
 * the sidecar probes (`-wal`, `-tshm`, `-shm`) — must be DERIVED FROM THE SAME
 * STRING for every process reaching the same physical store, whatever path
 * spelling each caller happened to use. Before this module, two processes
 * reaching one store through different spellings of the same directory (a
 * symlink alias, `/tmp` vs `/private/tmp`, a relative path vs its absolute
 * form, a `~`-expansion difference between a published global CLI and a
 * worktree dist) computed DIFFERENT lease dirs and never saw each other's
 * leases, so `storeQuiescence` could report `quiescent: true` while a live
 * peer held the store — letting every quiescence-gated destructive op
 * (close() WAL TRUNCATE, the proactive `-tshm` reconcile,
 * `recoverStaleWalIndex`, and the BUG-017 classic-engine repair gate) run
 * under a live peer (BUG-018).
 *
 * The canonical form is `realpathSync(dirname(dbPath)) + basename(dbPath)`:
 * the PARENT directory is resolved through every symlink / `.` / `..` /
 * relative spelling to its on-disk identity, while the FILE basename is
 * preserved verbatim. The basename is deliberately NOT resolved (a db file
 * that is itself a symlink keeps its own name): the engines derive sidecar
 * names from the path they were GIVEN, not from the symlink target, so
 * resolving the file would MISALIGN this module's sidecar paths with the
 * engine's — the canonical form must stay a path the engine would have
 * produced from the same spelling.
 *
 * Tolerates a not-yet-created db file: only the PARENT directory must exist
 * (a fresh store's first open creates the file, which realpathSync would
 * otherwise choke on). When even the parent is missing or unreadable, the raw
 * spelling is returned unchanged — never throws — and the caller's own open
 * will surface the real error.
 *
 * Results are memoized per input spelling: the same spelling always yields
 * the same canonical string without re-stat'ing, and each adapter entry point
 * canonicalizes ONCE (SPEC §T4 single-entry discipline), so repeated calls
 * during a connect are free. The cache is bounded — a long-lived server may
 * churn many temp stores.
 *
 * Pure `node:fs` + `node:path` — no native deps, no new package dependencies
 * (bundled inline). Synchronous only, matching store-lease.ts (deterministic,
 * no await interleaving inside the check — minimizes TOCTOU).
 *
 * @module
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Upper bound on memo entries; beyond it the oldest-inserted entry is
 *  evicted. Real deployments hold a handful of stores — this only guards a
 *  pathological churn of distinct temp paths in a long-lived server. */
const CACHE_LIMIT = 256;

const memo = new Map<string, string>();

/**
 * The canonical spelling of `dbPath` — `realpathSync(dirname)` + `basename`,
 * memoized per input spelling. Never throws (see the module doc for the
 * missing-parent fallback).
 */
export function canonicalDbPath(dbPath: string): string {
  const cached = memo.get(dbPath);
  if (cached !== undefined) return cached;
  const canonical = computeCanonicalDbPath(dbPath);
  if (memo.size >= CACHE_LIMIT) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(dbPath, canonical);
  return canonical;
}

function computeCanonicalDbPath(dbPath: string): string {
  // Special SQLite names / URI forms have no filesystem identity to
  // canonicalize: `:memory:` (and `file:` URIs) must pass through UNCHANGED,
  // or an in-memory database would silently become a real file beside the
  // caller's cwd and "memory" semantics (fresh schema per connection) would
  // be destroyed.
  if (dbPath === ':memory:' || dbPath.startsWith('file:')) return dbPath;
  const parent = dirname(dbPath);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch {
    // Parent missing or unreadable — keep the raw spelling. The caller's own
    // open will surface the real error; canonicalizing a path whose parent
    // does not exist could only invent a location nobody asked for.
    return dbPath;
  }
  return join(realParent, basename(dbPath));
}
