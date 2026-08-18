/**
 * libs/data/store/store-adapter/src/sidecar-retention.ts — BL-591.
 *
 * Retention/pruning for the `.stale-*` WAL-index sidecar debris that
 * `recoverStaleWalIndex()` / `proactivelyReconcileStaleSidecar()` (integrity.ts)
 * produce. BUG-021 established that a content-dead `-tshm`/`-shm` is RENAMED
 * to `<file>.stale-<stamp>`, never deleted — deliberately, as a recoverable
 * forensic artefact an operator can use to reconstruct what a store's
 * WAL-index looked like at the moment a reconcile fired. Nothing ever
 * collected that artefact: growth is proportional to WRITE VOLUME (each
 * close+reopen cycle that lands on a 0-byte WAL produces one — BL-590), not
 * to elapsed time, so it is unbounded under sustained write pressure.
 *
 * This module does NOT change the rename decision (BUG-021's content-deadness
 * gate is untouched) — it only decides, independently and later, which of the
 * already-renamed artefacts still earn their keep.
 *
 * Leaf module — fs + path only, no imports from integrity.ts, so the rename
 * gate and the retention policy stay independently testable and cannot
 * accidentally couple.
 */

import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// ─── Policy defaults ──────────────────────────────────────────────────────────

/**
 * Hard cap on how many `.stale-*` sidecars survive a sweep, regardless of
 * age. ~86 KB each (measured, BL-591) → ~1.7 MB worst case per store, which
 * is trivial, and wide enough to cover an entire incident-response window:
 * BL-591's own five-minute write-pressure test produced only 5.
 */
export const DEFAULT_STALE_SIDECAR_KEEP_N = 20;

/**
 * Hard cap on how OLD a surviving sidecar may be, regardless of rank. An
 * incident is investigated within days, not weeks — BL-591 states outright
 * that a sidecar renamed three weeks ago "is not going to be forensically
 * useful in September". 3 days covers a normal investigation window (a
 * multi-day on-call handoff, a Monday review of a Friday incident) without
 * accumulating indefinitely on a low-traffic store where the count cap alone
 * would never fire.
 */
export const DEFAULT_STALE_SIDECAR_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Minimum interval between two real directory sweeps for the SAME db path
 * (enforced via a marker file's mtime). The sweep is triggered from the
 * store-adapter's open path (the natural moment a NEW piece of debris was
 * just created) — but that path can fire once per write under BL-590's
 * close/reopen churn, and a full `readdir`+`stat`-per-candidate pass is not
 * something that debounce-sensitive hot path should pay for on every call.
 * Throttling bounds the real cost to "one extra stat() on the common case,
 * one bounded directory scan every 10 minutes at most" — independent of
 * write volume.
 */
export const DEFAULT_STALE_SIDECAR_SWEEP_THROTTLE_MS = 10 * 60 * 1000;

/**
 * Env-tunable read of {@link DEFAULT_STALE_SIDECAR_SWEEP_THROTTLE_MS}, same
 * convention as `staleSidecarThresholdMs()` in integrity.ts
 * (`SOX_WAL_SIDECAR_STALE_THRESHOLD_MS`). Exists so an integration test can
 * drive real `close()`/reopen cycles at real wall-clock speed and still
 * observe more than one real sweep without waiting 10 real minutes between
 * assertions — production never sets this.
 */
export function staleSidecarSweepThrottleMs(): number {
  const raw = process.env['SOX_SIDECAR_SWEEP_THROTTLE_MS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_STALE_SIDECAR_SWEEP_THROTTLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STALE_SIDECAR_SWEEP_THROTTLE_MS;
}

// ─── Injectable fs seam ───────────────────────────────────────────────────────

/**
 * Injectable filesystem seam so specs can exercise the policy without
 * touching the real filesystem (and so real-filesystem specs can use a
 * disposable `mkdtemp` sandbox instead).
 */
export interface StaleSidecarFs {
  existsSync(p: string): boolean;
  readdirSync(dir: string): string[];
  statSync(p: string): { mtimeMs: number };
  unlinkSync(p: string): void;
  writeFileSync(p: string, data: string): void;
}

/** The real filesystem seam — delegates to node:fs. */
export const realStaleSidecarFs: StaleSidecarFs = {
  existsSync: (p) => existsSync(p),
  readdirSync: (dir) => readdirSync(dir) as string[],
  statSync: (p) => statSync(p),
  unlinkSync: (p) => unlinkSync(p),
  writeFileSync: (p, data) => writeFileSync(p, data, 'utf8'),
};

// ─── Result types ─────────────────────────────────────────────────────────────

/** Disposition record for a single `.stale-*` sidecar candidate. */
export interface StaleSidecarEntry {
  file: string;
  action: 'pruned' | 'would-prune' | 'kept';
  reason: string;
  ageMs: number;
}

/** Result returned by {@link pruneStaleTshmSidecars}. */
export interface StaleSidecarPruneResult {
  /** `.stale-*` candidates found beside dbPath. */
  scanned: number;
  /** Files removed (or that WOULD be removed in dry-run). */
  pruned: number;
  /** Files kept (within both the count cap and the age cap). */
  kept: number;
  /** Per-file disposition records. */
  entries: StaleSidecarEntry[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches exactly the artefact shape `recoverStaleWalIndex` /
 * `proactivelyReconcileStaleSidecar` produce: `<basename>-tshm.stale-<stamp>`
 * or `<basename>-shm.stale-<stamp>`, stamp = `YYYY-MM-DD-HHMM`. Deliberately
 * anchored (`^`/`$`) and requiring the literal `.stale-` infix so this can
 * never match the live `-tshm`/`-shm`/`-wal` sidecars or the db file itself —
 * those never contain `.stale-` in their name by construction.
 */
function staleSidecarPattern(basename: string): RegExp {
  return new RegExp(`^${escapeRegExp(basename)}-(tshm|shm)\\.stale-\\d{4}-\\d{2}-\\d{2}-\\d{4}$`);
}

/**
 * Extracts the RENAME time from a `.stale-<stamp>` filename, `stamp` =
 * `YYYY-MM-DD-HHMM` (minute precision, UTC — the exact format
 * `recoverStaleWalIndex`/`proactivelyReconcileStaleSidecar` stamp via
 * `new Date().toISOString().replace(/[:.]/g,'').replace('T','-').slice(0,15)`).
 *
 * This is the age source the retention policy MUST use — not the file's
 * mtime. `renameSync` never touches inode mtime (POSIX rename only rewrites
 * the directory entry), so a `.stale-*` sidecar's mtime is whatever the
 * ORIGINAL `-tshm`/`-shm` last had before it froze — which, by the exact
 * mechanism BUG-021 exists to describe, can be arbitrarily old (a `-tshm`
 * frozen for a week is the textbook trigger). Ranking by mtime would prune a
 * sidecar the instant it is created whenever the frozen file predates
 * `maxAgeMs`, which defeats retention entirely — caught by
 * `wal-sidecar-staleness.bl373.test.ts`'s root-cause-mechanism spec
 * backdating the `-tshm` a full week before triggering the rename.
 *
 * Returns `null` if the stamp cannot be parsed (defensive — should be
 * unreachable given the anchored {@link staleSidecarPattern} already
 * validated the shape); callers fall back to mtime in that case only.
 */
function parseStaleStamp(filename: string): number | null {
  const m = /\.stale-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/.exec(filename);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:00.000Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// ─── Core policy ──────────────────────────────────────────────────────────────

/**
 * Prune `.stale-*` WAL-index sidecar debris beside `dbPath` down to a bounded
 * retention window (BL-591).
 *
 * Policy — INTERSECTION of a count cap and an age cap: a file survives iff
 * `(rank among newest, by RENAME time parsed from the filename, < keepRecentN)
 * AND (age <= maxAgeMs)`. Ranking is by rename time, never by file mtime —
 * see {@link parseStaleStamp} for why mtime is unusable here.
 *
 * Neither bound alone gives the properties this ticket needs:
 *   - An age-only policy is unbounded under sustained write pressure — the
 *     five-minutes-per-file measured rate in BL-591 would keep every sidecar
 *     from the last N days, which is exactly today's unbounded-growth defect
 *     under heavy load.
 *   - A count-only policy (the log-manager BL-579 model) never expires debris
 *     on an idle store below the count cap — a three-week-old sidecar that
 *     the ticket explicitly says has zero debugging value would survive
 *     forever if the store just never produces `keepRecentN` more of them.
 * The intersection bounds worst-case retained bytes to `keepRecentN * ~86KB`
 * regardless of write volume (the count cap always wins under sustained
 * churn), while guaranteeing nothing outlives `maxAgeMs` even when write
 * volume is low enough that the count cap never fills.
 *
 * SAFETY:
 *   - Only ever considers files matching {@link staleSidecarPattern} beside
 *     `dbPath` — the live `-wal`/`-shm`/`-tshm`/db files are never matched,
 *     by construction (none of them contain the literal `.stale-` infix).
 *   - Every filesystem call is individually try/caught; a failure anywhere
 *     (stat race, permission error, concurrent unlink) degrades that single
 *     file to "kept" and is logged — never thrown into the caller. Same
 *     swallow-and-log posture as the flush paths (BL-590): a failed prune
 *     pass must never fail the operation that triggered it.
 *   - `dryRun` never calls `unlinkSync` — candidates beyond the retention
 *     window are reported as `would-prune` and counted in `pruned` (matching
 *     the `sweepProxyBackendLocks` convention in host-runtime/reconcile.ts).
 */
export function pruneStaleTshmSidecars(
  dbPath: string,
  opts: {
    dryRun?: boolean;
    keepRecentN?: number;
    maxAgeMs?: number;
    log?: (msg: string) => void;
    fsSeal?: StaleSidecarFs;
    now?: number;
  } = {},
): StaleSidecarPruneResult {
  const dryRun = opts.dryRun ?? false;
  const keepRecentN = opts.keepRecentN ?? DEFAULT_STALE_SIDECAR_KEEP_N;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_STALE_SIDECAR_MAX_AGE_MS;
  const log = opts.log ?? ((): void => undefined);
  const fsSeal = opts.fsSeal ?? realStaleSidecarFs;
  const now = opts.now ?? Date.now();

  const result: StaleSidecarPruneResult = { scanned: 0, pruned: 0, kept: 0, entries: [] };

  let dir: string;
  let base: string;
  try {
    dir = path.dirname(dbPath);
    base = path.basename(dbPath);
  } catch (err) {
    log(`[sidecar-retention] could not resolve dbPath ${dbPath}: ${String(err)}`);
    return result;
  }

  try {
    if (!fsSeal.existsSync(dir)) return result;
  } catch (err) {
    log(`[sidecar-retention] could not stat dir ${dir}: ${String(err)}`);
    return result;
  }

  let files: string[];
  try {
    files = fsSeal.readdirSync(dir);
  } catch (err) {
    log(`[sidecar-retention] could not list ${dir}: ${String(err)}`);
    return result;
  }

  const pattern = staleSidecarPattern(base);
  const candidates = files.filter((f) => pattern.test(f));

  const withRenameTime: { file: string; path: string; renamedAtMs: number }[] = [];
  for (const f of candidates) {
    result.scanned++;
    const filePath = path.join(dir, f);
    // Rank by the RENAME time embedded in the filename — never by mtime,
    // which POSIX rename leaves untouched (see parseStaleStamp doc comment).
    const stamped = parseStaleStamp(f);
    if (stamped !== null) {
      withRenameTime.push({ file: f, path: filePath, renamedAtMs: stamped });
      continue;
    }
    // Defensive fallback only — unreachable given the anchored pattern
    // already validated the stamp shape, but never let an unparseable
    // filename crash the sweep; fall back to mtime rather than skip it.
    try {
      const st = fsSeal.statSync(filePath);
      withRenameTime.push({ file: f, path: filePath, renamedAtMs: st.mtimeMs });
      log(`[sidecar-retention] could not parse stamp from ${f}, falling back to mtime`);
    } catch (err) {
      // Vanished between readdir and stat — a concurrent sweep, or the file
      // being reconciled again, already handled it. Not an error.
      log(`[sidecar-retention] stat race, skipping ${filePath}: ${String(err)}`);
    }
  }

  withRenameTime.sort((a, b) => b.renamedAtMs - a.renamedAtMs); // newest first

  for (let rank = 0; rank < withRenameTime.length; rank++) {
    const entry = withRenameTime[rank]!;
    const ageMs = now - entry.renamedAtMs;
    const withinCount = rank < keepRecentN;
    const withinAge = ageMs <= maxAgeMs;

    if (withinCount && withinAge) {
      result.kept++;
      result.entries.push({
        file: entry.path,
        action: 'kept',
        reason: `rank ${rank + 1}/${keepRecentN}, age ${Math.round(ageMs / 1000)}s <= ${Math.round(maxAgeMs / 1000)}s`,
        ageMs,
      });
      continue;
    }

    const reason = !withinCount
      ? `exceeds retention count cap (rank ${rank + 1} > keepRecentN=${keepRecentN})`
      : `exceeds retention age cap (age ${(ageMs / 86_400_000).toFixed(2)}d > maxAgeMs=${(maxAgeMs / 86_400_000).toFixed(2)}d)`;

    if (dryRun) {
      result.pruned++;
      result.entries.push({ file: entry.path, action: 'would-prune', reason, ageMs });
      log(`[sidecar-retention] WOULD prune ${entry.path}: ${reason}`);
      continue;
    }

    try {
      fsSeal.unlinkSync(entry.path);
      result.pruned++;
      result.entries.push({ file: entry.path, action: 'pruned', reason, ageMs });
      log(`[sidecar-retention] pruned ${entry.path}: ${reason}`);
    } catch (err) {
      // Never throw into the caller — a failed unlink just leaves the file
      // for the next sweep (BL-590 swallow-and-log posture).
      result.kept++;
      result.entries.push({ file: entry.path, action: 'kept', reason: `unlink failed: ${String(err)}`, ageMs });
      log(`[sidecar-retention] FAILED to prune ${entry.path}: ${String(err)}`);
    }
  }

  return result;
}

// ─── Throttled entry point for the hot open path ─────────────────────────────

/**
 * Throttled wrapper around {@link pruneStaleTshmSidecars}, meant to be called
 * from the store-adapter's own open path right after a rename produces a NEW
 * `.stale-*` artefact — the moment retention actually needs re-evaluating.
 *
 * A sibling marker file (`<dbPath>.sidecar-sweep-marker`, never matching the
 * `.stale-*` glob so it can never be mistaken for a sidecar candidate itself)
 * records the last real sweep time. If a sweep ran within
 * {@link DEFAULT_STALE_SIDECAR_SWEEP_THROTTLE_MS}, this call is a single
 * `existsSync`+`statSync` no-op — that is the ENTIRE added cost on the common
 * case of an open that lands inside the throttle window, which is what makes
 * hooking this into the open path acceptable per BL-590's cost concerns
 * despite that path firing up to once per write under aggressive debounce.
 *
 * Returns `null` when throttled (no sweep ran) so callers can distinguish
 * "nothing to prune" from "didn't even look this time".
 *
 * Every failure mode (marker read/write errors, sweep errors) is swallowed
 * and logged — this must never fail the open it is piggy-backing on.
 */
export function maybePruneStaleTshmSidecars(
  dbPath: string,
  opts: {
    log?: (msg: string) => void;
    fsSeal?: StaleSidecarFs;
    throttleMs?: number;
    dryRun?: boolean;
    keepRecentN?: number;
    maxAgeMs?: number;
    now?: number;
  } = {},
): StaleSidecarPruneResult | null {
  const log = opts.log ?? ((): void => undefined);
  const fsSeal = opts.fsSeal ?? realStaleSidecarFs;
  const throttleMs = opts.throttleMs ?? staleSidecarSweepThrottleMs();
  const now = opts.now ?? Date.now();
  const markerPath = `${dbPath}.sidecar-sweep-marker`;

  try {
    if (fsSeal.existsSync(markerPath)) {
      const st = fsSeal.statSync(markerPath);
      if (now - st.mtimeMs < throttleMs) {
        return null; // swept recently enough — skip the directory scan entirely
      }
    }
  } catch (err) {
    // Marker unreadable for some reason — proceed with a sweep rather than
    // wedge retention off forever; the marker write below will re-heal it.
    log(`[sidecar-retention] marker check failed, proceeding with sweep: ${String(err)}`);
  }

  const pruneOpts: Parameters<typeof pruneStaleTshmSidecars>[1] = { log, fsSeal, now };
  if (opts.dryRun !== undefined) pruneOpts.dryRun = opts.dryRun;
  if (opts.keepRecentN !== undefined) pruneOpts.keepRecentN = opts.keepRecentN;
  if (opts.maxAgeMs !== undefined) pruneOpts.maxAgeMs = opts.maxAgeMs;

  let result: StaleSidecarPruneResult;
  try {
    result = pruneStaleTshmSidecars(dbPath, pruneOpts);
  } catch (err) {
    // pruneStaleTshmSidecars itself never throws by construction, but this
    // belt-and-suspenders catch guarantees the caller's open can never fail
    // because of anything in this module.
    log(`[sidecar-retention] sweep threw unexpectedly (swallowed): ${String(err)}`);
    return null;
  }

  if (opts.dryRun !== true) {
    try {
      fsSeal.writeFileSync(markerPath, String(now));
    } catch (err) {
      log(`[sidecar-retention] could not write sweep marker (next open will re-attempt): ${String(err)}`);
    }
  }

  return result;
}
