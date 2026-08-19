/**
 * path-identity — ONE canonical path per physical store (INV-4, BUG014.T4).
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
 * under a live peer (BUG014.T4).
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
 * The file-symlink gap is therefore NOT an INV-4 violation this fix could
 * have produced or must converge: a `link.db` open puts `-wal`/`-tshm`
 * BESIDE THE LINK (the engines name sidecars from the spelling they are
 * given), so link-vs-target spellings never shared ONE coordination domain
 * even before this module existed — they are engine-level incoherent in WAL
 * mode (the documented SQLite symlink hazard), not a false-quiescence the
 * canonicalization could cause. `canonicalDbPath` reproduces exactly the
 * engine's own identity derivation, so INV-4 holds per spelling-class the
 * engine treats as one store; no reachable INV-4 violation results from
 * preserving the basename.
 *
 * Tolerates a not-yet-created db file: only the PARENT directory must exist
 * (a fresh store's first open creates the file, which realpathSync would
 * otherwise choke on). When the parent is genuinely ABSENT — ENOENT, or a
 * path component that is not a directory (ENOTDIR), i.e. no fs identity can
 * exist for this path — the raw spelling is returned unchanged and the
 * caller's own open will surface the real error.
 *
 * An unresolvable parent is NOT silently swallowed (DEBT-003 discipline, the
 * same errno distinction `isTshmContentDead` applies: EACCES must not prove
 * "absent"). EACCES/EIO/… mean the parent EXISTS but cannot be read — that is
 * uncertainty, not absence, and a silent raw fallback there would let two
 * processes with different permission views compute DIFFERENT coordination
 * keys for one store (the exact false-quiescence failure BUG014.T4 fixes). So
 * non-absence errnos surface the typed {@link EPathIdentityUnresolvable}
 * instead of falling back.
 *
 * Results are memoized per input spelling — but ONLY realpath-normalized
 * results: the same spelling always yields the same canonical string without
 * re-stat'ing, and each adapter entry point canonicalizes ONCE (SPEC §T4
 * single-entry discipline), so repeated calls during a connect are free. The
 * missing-parent FALLBACK is deliberately NOT memoized: absence is a
 * transient fs-state, not a property of the spelling — if the parent is
 * created (or a symlink retargeted) after a fallback, the next call must
 * re-evaluate and pick up the now-resolvable canonical form instead of
 * returning the stale raw spelling forever (BUG014.T4 review finding 2). The
 * cache is bounded — a long-lived server may churn many temp stores.
 *
 * Pure `node:fs` + `node:path` plus same-package `errors.js` and the
 * package's existing `@adhd/sox-telemetry` logger (for the absence
 * fallback's errno line) — no native deps, no NEW package dependencies
 * (bundled inline). Synchronous only, matching store-lease.ts
 * (deterministic, no await interleaving inside the check — minimizes
 * TOCTOU).
 *
 * @module
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { log } from '@adhd/sox-telemetry';
import { EPathIdentityUnresolvable } from './errors.js';

/** Upper bound on memo entries; beyond it the oldest-inserted entry is
 *  evicted. Real deployments hold a handful of stores — this only guards a
 *  pathological churn of distinct temp paths in a long-lived server. */
const CACHE_LIMIT = 256;

const memo = new Map<string, string>();

/**
 * The canonical spelling of `dbPath` — `realpathSync(dirname)` + `basename`,
 * memoized per input spelling for realpath-normalized results only.
 *
 * Never throws on a missing parent (ENOENT/ENOTDIR — the raw spelling is
 * returned, and the fallback is NOT memoized, so a later-created parent is
 * picked up on the next call). Throws {@link EPathIdentityUnresolvable} when
 * the parent exists but cannot be resolved (EACCES/EIO/…) — see the module
 * doc for the DEBT-003 errno discipline.
 */
export function canonicalDbPath(dbPath: string): string {
  const cached = memo.get(dbPath);
  if (cached !== undefined) return cached;
  const result = computeCanonicalDbPath(dbPath);
  if (result.kind === 'canonical') {
    // Only the realpath-NORMALIZED result is memoizable. The fallback must
    // stay re-evaluated per call: caching it would freeze a transient fs
    // state (missing parent) as the spelling's permanent identity.
    if (memo.size >= CACHE_LIMIT) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    memo.set(dbPath, result.path);
  }
  return result.path;
}

type CanonicalResult =
  | { kind: 'canonical'; path: string }
  | { kind: 'fallback'; path: string; errno: string };

function computeCanonicalDbPath(dbPath: string): CanonicalResult {
  // Special SQLite names / URI forms have no filesystem identity to
  // canonicalize: `:memory:` (and `file:` URIs) must pass through UNCHANGED,
  // or an in-memory database would silently become a real file beside the
  // caller's cwd and "memory" semantics (fresh schema per connection) would
  // be destroyed.
  if (dbPath === ':memory:' || dbPath.startsWith('file:')) {
    return { kind: 'canonical', path: dbPath };
  }
  const parent = dirname(dbPath);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch (err) {
    // (DEBT-003 errno discipline) Distinguish PLAIN ABSENCE from uncertainty.
    // ENOENT/ENOTDIR: no fs identity can exist for this path — keep the raw
    // spelling, and let the caller's own open surface the real error.
    // EACCES/EIO/…: the parent EXISTS but cannot be resolved — falling back
    // silently could diverge from the canonical key a peer computes for the
    // same store (false quiescence); surface a typed error instead.
    const errno = (err as { code?: unknown } | null | undefined)?.code;
    if (errno === 'ENOENT' || errno === 'ENOTDIR') {
      log.debug('store_adapter.path_identity.parent_absent', {
        dbPath,
        errno: String(errno),
      });
      return { kind: 'fallback', path: dbPath, errno: String(errno) };
    }
    throw new EPathIdentityUnresolvable(
      dbPath,
      typeof errno === 'string' && errno.length > 0 ? errno : 'UNKNOWN',
      err,
    );
  }
  return { kind: 'canonical', path: join(realParent, basename(dbPath)) };
}
