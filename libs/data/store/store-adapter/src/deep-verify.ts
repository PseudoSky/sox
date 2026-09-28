/**
 * deep-verify.ts — `deep` integrity verification, off the opener's thread and
 * out of its process (BL-fc5ab895).
 *
 * ── The incident ────────────────────────────────────────────────────────────
 *
 * Production memory-server, 417 MB Turso store: `PRAGMA integrity_check` ran
 * synchronously on the Node main thread for more than 21 minutes
 * (`turso_node::step_sync → op_integrity_check → Pager::read_page_no_cache →
 * pread`). It ran because an unclean shutdown escalated the open-time verify
 * to `deep`. The main-thread liveness watchdog could not fire during the stall
 * (it is a `setInterval` on the stalled thread), so the process sat until an
 * external kill — and that kill was itself an unclean shutdown, so the next
 * open escalated to `deep` again. The loop fed itself.
 *
 * ── The rule this module implements (approved verdict) ──────────────────────
 *
 * 1. Opening a store blocks ONLY on the `fast` tier. `runOpenTimeIntegrity`
 *    never runs `pragma_integrity_check` inline.
 * 2. `deep` runs in a CHILD PROCESS (`deep-verify-child.ts`) — never a
 *    worker_thread, because `Worker.terminate()` cannot interrupt a thread
 *    parked in native `step_sync`, and SIGKILL on a process can. The child is
 *    `detached: false` (same process group as the opener, so the lifecycle
 *    spec's `-pgid` teardown and the host-runtime reaper cover it), opens its
 *    own `query_only` read connection (ADR-0007 D2), and never repairs.
 * 3. The child has a numeric wall-clock bound ({@link DeepVerifyConfig.timeoutMs},
 *    typed config per ADR-0013 D3; a bad value throws at open). On timeout or
 *    failure the child is SIGKILLed, the probe is recorded `unknown` (never
 *    `ok`), a loud telemetry event is emitted, and the durable
 *    {@link DEEP_VERIFY_STATE_KEY} row lets `memory_ping` report the store as
 *    degraded (`[inv:list-never-lies]`).
 * 4. The obligation to run `deep` is DURABLE and SEPARATE from any
 *    clean-shutdown signal ({@link DEEP_VERIFY_OWED_KEY}). It is set when an
 *    unclean shutdown is detected and cleared ONLY when a deep pass completes
 *    `ok`. So `crash → open → deep times out → clean shutdown → reopen` still
 *    runs deep on the reopen: the clean shutdown in the middle says nothing
 *    about whether the store was ever verified.
 * 5. ADR-0020 conformance (peer-spawned, self-reaping, no orphans): the child
 *    runs an off-thread self-reaper (`deep-verify-reaper.ts`); the opener kills
 *    it on its own timeout, on `close()`, and in a process `exit` hook; and at
 *    most ONE verifier runs per store across all processes, via an O_EXCL lock
 *    with pid liveness ({@link DEEP_VERIFY_LOCK_NAME}) — the `ensureBackend`
 *    spawn-lock precedent. ADR-0020 D5 (honest failure, never a silent
 *    fallback): a missing sidecar or a spawn failure is recorded `failed`,
 *    never "run deep inline instead".
 *
 * ── Behaviour change vs. inline deep ────────────────────────────────────────
 *
 * Damage found by `deep` is REPORTED (loud event, `damaged` state, degraded
 * ping, obligation kept) but no longer REINDEXed automatically at open: the
 * child never repairs, and a `REINDEX` of an index the size that made
 * `integrity_check` slow would reintroduce the main-thread stall this module
 * exists to remove.
 *
 * @module
 */

import { fork, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOX_TELEMETRY_INIT, log } from '@adhd/sox-telemetry';
import type { DeepVerifyChildMessage, DeepVerifyChildPayload } from './deep-verify-child.js';
import {
  emitIntegrityReport,
  persistIntegrityResult,
  recordIntegrityResult,
  type IntegrityFinding,
  type VerifyAndRepairResult,
} from './integrity.js';
import { canonicalDbPath } from './path-identity.js';
import { entryLiveness, leaseDirPath } from './store-lease.js';
import type { StoreAdapter } from './types.js';

// ── Typed config (ADR-0013 D3) ───────────────────────────────────────────────

/**
 * Default wall-clock bound for one deep pass. Measured points: 392 ms on a
 * 43 MB copy and ~2 s on a copy of the 417 MB production store with a warm
 * page cache; 21+ minutes on that same store in production under memory
 * pressure (no-cache `pread`s). 30 minutes is well past every healthy
 * measurement and bounds the pathological one. It has NOT been measured as a
 * success bound on the 417 MB store under that memory pressure — tune it via
 * {@link DeepVerifyConfig.timeoutMs} rather than trusting this constant.
 */
export const DEFAULT_DEEP_VERIFY_TIMEOUT_MS = 30 * 60_000;
/** Smallest accepted bound — below this a healthy small store could not finish. */
export const MIN_DEEP_VERIFY_TIMEOUT_MS = 1_000;
/** Largest accepted bound — past this the bound stops meaning anything. */
export const MAX_DEEP_VERIFY_TIMEOUT_MS = 6 * 60 * 60_000;
/** Extra time the child's self-reaper grants past the parent's bound, so the
 *  parent's own SIGKILL (and its `timed_out` record) normally wins the race. */
export const DEEP_VERIFY_REAPER_GRACE_MS = 10_000;

/**
 * Who may START a background deep pass (BL-9f6681ee).
 *
 * - `'owner'` — a long-lived opener (memory-server). It schedules the owed
 *   pass, and when a live peer holds the single-flight lock it waits for the
 *   lock to free and tries again ({@link DeepVerifyPeerRetry}), for as long as
 *   it stays open and the obligation stays owed.
 * - `'never'` — a one-shot opener (CLI, hooks, flush). It still RECORDS the
 *   obligation when it detects an unclean shutdown, but never forks a
 *   verifier: a one-shot that took the lock and then closed or exited would
 *   cancel/kill the pass and starve the owner.
 *
 * Default `'never'`, so an unknown caller can never starve the owner. This
 * chooses WHICH process verifies, never WHETHER verification is owed
 * (ADR-0013): the obligation is written unconditionally.
 */
export type DeepVerifySchedule = 'owner' | 'never';
/** Accepted {@link DeepVerifySchedule} values. */
export const DEEP_VERIFY_SCHEDULES: readonly DeepVerifySchedule[] = ['owner', 'never'];
/** First wait before an owner re-attempts a lock a live peer holds, ms. */
export const DEFAULT_DEEP_VERIFY_PEER_RETRY_INITIAL_MS = 1_000;
/** Backoff ceiling for the peer-lock re-attempt, ms. */
export const DEFAULT_DEEP_VERIFY_PEER_RETRY_MAX_MS = 60_000;
/** Accepted range for either peer-retry bound, ms. */
export const MIN_DEEP_VERIFY_PEER_RETRY_MS = 10;
export const MAX_DEEP_VERIFY_PEER_RETRY_MS = 60 * 60_000;

/** Bounded exponential backoff for an owner blocked by a live peer's lock.
 *  Tuning only — there is no value that makes the owner give up. */
export interface DeepVerifyPeerRetry {
  /** First wait, ms. Default {@link DEFAULT_DEEP_VERIFY_PEER_RETRY_INITIAL_MS}. */
  initialMs?: number;
  /** Ceiling the doubling wait is clamped to, ms. Default {@link DEFAULT_DEEP_VERIFY_PEER_RETRY_MAX_MS}. */
  maxMs?: number;
}

/** Where the verifier entrypoint lives and how to run it. */
export interface DeepVerifyVerifierEntry {
  /** Absolute path of the verifier script. */
  path: string;
  /** `execArgv` for the fork. Default `[]` — never the opener's own
   *  `process.execArgv` (an `--inspect` flag must not follow the child). */
  execArgv?: string[];
}

/**
 * Typed deep-verify config, carried on `AdapterConfig.deepVerify`. Tuning only
 * (ADR-0013 D3): there is no value that turns `deep` off.
 */
export interface DeepVerifyConfig {
  /** Wall-clock bound for one deep pass, ms. Integer in
   *  [{@link MIN_DEEP_VERIFY_TIMEOUT_MS}, {@link MAX_DEEP_VERIFY_TIMEOUT_MS}].
   *  Default {@link DEFAULT_DEEP_VERIFY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Verifier entrypoint override — a path injection for tests and diagnostics
   * (ADR-0013 D5 border: it chooses WHICH script verifies, never WHETHER
   * verification runs). Default {@link resolveDeepVerifierEntry}.
   */
  verifier?: DeepVerifyVerifierEntry;
  /** Whether this opener may start the pass. Default `'never'` — see
   *  {@link DeepVerifySchedule}. */
  schedule?: DeepVerifySchedule;
  /** Owner-only: backoff for re-attempting a lock a live peer holds. */
  peerRetry?: DeepVerifyPeerRetry;
}

/** A deep-verify config value was rejected. Thrown at open — loud, never
 *  silently replaced by a default (ADR-0013 D3: "parse failures must be loud"). */
export class EInvalidDeepVerifyConfig extends Error {
  public readonly code = 'E_INVALID_DEEP_VERIFY_CONFIG';
  constructor(message: string) {
    super(message);
    this.name = 'EInvalidDeepVerifyConfig';
  }
}

/** Validate and resolve the deep-verify bound. Throws {@link EInvalidDeepVerifyConfig}. */
export function resolveDeepVerifyTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_DEEP_VERIFY_TIMEOUT_MS;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_DEEP_VERIFY_TIMEOUT_MS ||
    value > MAX_DEEP_VERIFY_TIMEOUT_MS
  ) {
    throw new EInvalidDeepVerifyConfig(
      `deepVerify.timeoutMs must be an integer number of milliseconds in ` +
        `[${MIN_DEEP_VERIFY_TIMEOUT_MS}, ${MAX_DEEP_VERIFY_TIMEOUT_MS}]; got ${JSON.stringify(value)} ` +
        `(${typeof value}). There is no value that disables deep verification (ADR-0013).`,
    );
  }
  return value;
}

/** The effective {@link DeepVerifySchedule}. Throws {@link EInvalidDeepVerifyConfig}. */
export function resolveDeepVerifySchedule(cfg: DeepVerifyConfig | undefined): DeepVerifySchedule {
  const value: unknown = cfg?.schedule;
  if (value === undefined) return 'never';
  if (typeof value !== 'string' || !(DEEP_VERIFY_SCHEDULES as readonly string[]).includes(value)) {
    throw new EInvalidDeepVerifyConfig(
      `deepVerify.schedule must be one of ${DEEP_VERIFY_SCHEDULES.map((v) => `'${v}'`).join(', ')}; ` +
        `got ${JSON.stringify(value)}.`,
    );
  }
  return value as DeepVerifySchedule;
}

function resolvePeerRetryBound(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_DEEP_VERIFY_PEER_RETRY_MS ||
    value > MAX_DEEP_VERIFY_PEER_RETRY_MS
  ) {
    throw new EInvalidDeepVerifyConfig(
      `deepVerify.peerRetry.${field} must be an integer number of milliseconds in ` +
        `[${MIN_DEEP_VERIFY_PEER_RETRY_MS}, ${MAX_DEEP_VERIFY_PEER_RETRY_MS}]; got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/** The effective peer-retry bounds. Throws {@link EInvalidDeepVerifyConfig}. */
export function resolveDeepVerifyPeerRetry(cfg: DeepVerifyConfig | undefined): { initialMs: number; maxMs: number } {
  const initialMs = resolvePeerRetryBound(cfg?.peerRetry?.initialMs, 'initialMs', DEFAULT_DEEP_VERIFY_PEER_RETRY_INITIAL_MS);
  const maxMs = resolvePeerRetryBound(cfg?.peerRetry?.maxMs, 'maxMs', Math.max(initialMs, DEFAULT_DEEP_VERIFY_PEER_RETRY_MAX_MS));
  if (maxMs < initialMs) {
    throw new EInvalidDeepVerifyConfig(
      `deepVerify.peerRetry.maxMs (${maxMs}) must be >= deepVerify.peerRetry.initialMs (${initialMs}).`,
    );
  }
  return { initialMs, maxMs };
}

/** Validate a whole {@link DeepVerifyConfig}. Throws {@link EInvalidDeepVerifyConfig}. */
export function validateDeepVerifyConfig(cfg: DeepVerifyConfig | undefined): void {
  if (cfg === undefined) return;
  resolveDeepVerifyTimeoutMs(cfg.timeoutMs);
  resolveDeepVerifySchedule(cfg);
  resolveDeepVerifyPeerRetry(cfg);
  if (cfg.verifier !== undefined) {
    if (typeof cfg.verifier.path !== 'string' || cfg.verifier.path === '') {
      throw new EInvalidDeepVerifyConfig('deepVerify.verifier.path must be a non-empty string');
    }
    if (cfg.verifier.execArgv !== undefined && !Array.isArray(cfg.verifier.execArgv)) {
      throw new EInvalidDeepVerifyConfig('deepVerify.verifier.execArgv must be an array of strings');
    }
  }
}

// ── Verifier entry resolution (sidecar) ─────────────────────────────────────

// Named `__dirname` on purpose: the bundler's sidecar reference scan keys on it.
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate `deep-verify-child.js`: the sibling in a tsc `dist/` or an esbuild
 * bundle (declared in this package's `sox.sidecars`, so every consuming bundle
 * emits it — docs/standards/extension-bundling.md §3), else the `.ts` source
 * run through `tsx` (vitest runs this module from `src/`), else `../dist`.
 */
export function resolveDeepVerifierEntry(): DeepVerifyVerifierEntry {
  const sibling = join(__dirname, 'deep-verify-child.js');
  if (existsSync(sibling)) return { path: sibling, execArgv: [] };
  const source = join(__dirname, 'deep-verify-child.ts');
  if (existsSync(source)) return { path: source, execArgv: ['--import', 'tsx'] };
  const distSibling = join(__dirname, '..', 'dist', 'deep-verify-child.js');
  if (existsSync(distSibling)) return { path: distSibling, execArgv: [] };
  // Returned as-is so the recorded failure names the path actually attempted.
  return { path: sibling, execArgv: [] };
}

// ── Durable state in `_adapter_meta` ────────────────────────────────────────

/** `_adapter_meta` key holding the outstanding deep-verify obligation. Present
 *  ⇔ owed. Deliberately NOT the clean-shutdown marker. */
export const DEEP_VERIFY_OWED_KEY = 'deep_verify_owed';
/** `_adapter_meta` key holding the latest deep-verify attempt's outcome. */
export const DEEP_VERIFY_STATE_KEY = 'deep_verify_state';

const UPSERT_META_SQL = `INSERT INTO _adapter_meta(key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

export interface DeepVerifyObligation {
  /** Why deep verification is owed (e.g. `unclean_shutdown`). */
  reason: string;
  /** ISO time the obligation was (last) recorded. */
  since: string;
}

export type DeepVerifyStatus =
  /** A verifier child is running now. */
  | 'running'
  /** `integrity_check` completed and found nothing wrong. Clears the obligation. */
  | 'ok'
  /** `integrity_check` completed and found damage. Obligation kept. */
  | 'damaged'
  /** It completed but could not show health (e.g. output truncated). Obligation kept. */
  | 'inconclusive'
  /** The wall-clock bound fired; the child was SIGKILLed. Obligation kept. */
  | 'timed_out'
  /** The child could not be started, crashed, or reported an error. Obligation kept. */
  | 'failed'
  /** The owning adapter closed first; the child was SIGKILLed. Obligation kept. */
  | 'cancelled';

/** Terminal outcomes that mean "the store is owed a deep pass it could not get". */
export const DEEP_VERIFY_DEGRADED_STATUSES: readonly DeepVerifyStatus[] = [
  'timed_out',
  'failed',
  'damaged',
  'inconclusive',
];

export interface DeepVerifyState {
  v: 1;
  status: DeepVerifyStatus;
  /** Why this pass ran (the obligation's reason). */
  reason: string | null;
  /** Evidence for a non-`ok` outcome; the clean detail for `ok`. */
  detail: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  timeout_ms: number;
  /** The opener that spawned the verifier. */
  owner_pid: number;
  verifier_pid: number | null;
}

/** Record that a deep pass is owed. Idempotent; refreshes `since`/`reason`. */
export async function markDeepVerifyOwed(adapter: StoreAdapter, reason: string): Promise<void> {
  if (adapter.config.readonly === true) return;
  const value: DeepVerifyObligation = { reason, since: new Date().toISOString() };
  await adapter.executeRun(UPSERT_META_SQL, [DEEP_VERIFY_OWED_KEY, JSON.stringify(value)]);
}

/** The outstanding obligation, or `null` when none is owed. Throws on a read
 *  error — the caller decides (the open path treats "cannot read" as owed). */
export async function readDeepVerifyObligation(adapter: StoreAdapter): Promise<DeepVerifyObligation | null> {
  const row = await adapter.executeGet<{ value: string }>(
    `SELECT value FROM _adapter_meta WHERE key = ?`,
    [DEEP_VERIFY_OWED_KEY],
  );
  if (row === null) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<DeepVerifyObligation>;
    return {
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'unknown',
      since: typeof parsed.since === 'string' ? parsed.since : '',
    };
  } catch (err) {
    // A present-but-unparseable row is still an obligation — presence is the
    // signal. Report the corruption rather than dropping it.
    log.warn('store_adapter.deep_verify.obligation_unparseable', {
      db_path: adapter.config.dbPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { reason: 'unparseable obligation row', since: '' };
  }
}

/** Clear the obligation. Called ONLY after a deep pass completed `ok`. */
async function clearDeepVerifyObligation(adapter: StoreAdapter): Promise<void> {
  await adapter.executeRun(`DELETE FROM _adapter_meta WHERE key = ?`, [DEEP_VERIFY_OWED_KEY]);
}

/** The latest recorded deep-verify outcome, or `null` (never attempted, or unreadable). */
export async function readDeepVerifyState(adapter: StoreAdapter): Promise<DeepVerifyState | null> {
  try {
    const row = await adapter.executeGet<{ value: string }>(
      `SELECT value FROM _adapter_meta WHERE key = ?`,
      [DEEP_VERIFY_STATE_KEY],
    );
    if (row === null) return null;
    const parsed = JSON.parse(row.value) as DeepVerifyState;
    if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1) return null;
    return parsed;
  } catch (err) {
    log.warn('store_adapter.deep_verify.state_read_failed', {
      db_path: adapter.config.dbPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * (BL-9f6681ee) Whether the process that recorded a `running` state is still
 * alive: `kill(pid, 0)`, with `EPERM` counted as alive. `null` when the state
 * names no usable pid. A `running` record whose owner is dead is a pass that
 * will never finish — its opener was killed (a one-shot's exit hook SIGKILLs
 * the verifier and cannot write a terminal state).
 */
export function isDeepVerifyOwnerAlive(state: Pick<DeepVerifyState, 'owner_pid'> | null): boolean | null {
  const pid = state?.owner_pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    log.warn('store_adapter.deep_verify.owner_liveness_undeterminable', {
      owner_pid: pid,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function writeDeepVerifyState(adapter: StoreAdapter, state: DeepVerifyState): Promise<void> {
  await adapter.executeRun(UPSERT_META_SQL, [DEEP_VERIFY_STATE_KEY, JSON.stringify(state)]);
}

// ── Cross-process single-flight lock ────────────────────────────────────────

/**
 * Lock file inside the store's lease directory. DOT-prefixed on purpose:
 * `storeQuiescence` counts every non-dot, non-`.openmark` entry as a live
 * lease, and a non-dot name here would defer every quiescent TRUNCATE for the
 * life of the verifier.
 */
export const DEEP_VERIFY_LOCK_NAME = '.deep-verify.lock';

export function deepVerifyLockPath(canonicalDb: string): string {
  return join(leaseDirPath(canonicalDb), DEEP_VERIFY_LOCK_NAME);
}

type LockOutcome = { acquired: true; held: boolean } | { acquired: false; holderPid: number };

function tryAcquireDeepVerifyLock(canonicalDb: string): LockOutcome {
  const p = deepVerifyLockPath(canonicalDb);
  try {
    mkdirSync(leaseDirPath(canonicalDb), { recursive: true });
  } catch (err) {
    log.warn('store_adapter.deep_verify.lock_dir_failed', {
      db_path: canonicalDb,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, 'wx');
      try {
        writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      } finally {
        closeSync(fd);
      }
      return { acquired: true, held: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        // Cannot lock at all (permissions, read-only fs). Verification still
        // runs — an unverified store is worse than a duplicated verifier.
        log.warn('store_adapter.deep_verify.lock_unavailable', {
          db_path: canonicalDb,
          error: err instanceof Error ? err.message : String(err),
        });
        return { acquired: true, held: false };
      }
    }
    let content = '';
    try {
      content = readFileSync(p, 'utf8');
    } catch (err) {
      log.warn('store_adapter.deep_verify.lock_read_failed', {
        db_path: canonicalDb,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const info = entryLiveness(content);
    if (info !== null && info.live && info.pid !== process.pid) {
      return { acquired: false, holderPid: info.pid };
    }
    // Dead holder, unparseable, or our own leaked lock — take it over.
    try {
      unlinkSync(p);
    } catch (err) {
      log.warn('store_adapter.deep_verify.lock_steal_failed', {
        db_path: canonicalDb,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { acquired: true, held: false };
}

function releaseDeepVerifyLock(canonicalDb: string): void {
  const p = deepVerifyLockPath(canonicalDb);
  try {
    const info = entryLiveness(readFileSync(p, 'utf8'));
    if (info !== null && info.pid !== process.pid) return; // not ours
    unlinkSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    log.warn('store_adapter.deep_verify.lock_release_failed', {
      db_path: canonicalDb,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── In-process registry ─────────────────────────────────────────────────────

interface DeepVerifyRun {
  canonicalDb: string;
  /** Open adapters for this store that want this run's outcome recorded.
   *  The run persists through one of them; when the last one closes, the run
   *  is cancelled. */
  members: Set<StoreAdapter>;
  child: ChildProcess | null;
  cancelReason: string | null;
  done: Promise<DeepVerifyState | null>;
}

const runs = new Map<string, DeepVerifyRun>();

/**
 * (BL-9f6681ee) An owner adapter waiting for a live peer's lock to free. One
 * entry per adapter; cleared by `releaseDeepVerify` (close) and moved by
 * `transferDeepVerifyMembership` (Turso reconnect).
 */
interface PeerWait {
  timer: NodeJS.Timeout;
  opts: ScheduleDeepVerifyOptions;
  /** The wait that produced `timer`; the next one doubles it, up to the cap. */
  delayMs: number;
}
const peerWaits = new Map<StoreAdapter, PeerWait>();

/**
 * (BL-80965c9f) Adapters whose final `close()` has begun. Marked as the FIRST
 * synchronous step of {@link releaseDeepVerify} — never inferred from the
 * adapter's own `closed` flag, which both adapters set only AFTER
 * `releaseDeepVerify`'s awaits settle (the exact window the race lives in),
 * and which transient teardowns (idle release, repair) also flip. A tombstone
 * is permanent: a closed adapter never re-opens, so nothing may re-arm a
 * peer-lock wait on it, start a run through it, or join a run with it.
 */
const releasedAdapters = new WeakSet<StoreAdapter>();

/**
 * (BL-026af34c) `from → to` for every {@link transferDeepVerifyMembership}.
 * The Turso reconnect abandons `from` (never closed, so never tombstoned) and
 * keeps `to`. A peer-lock re-attempt that had already FIRED for `from` when
 * the transfer ran has no `peerWaits` entry left to move; it is parked on its
 * obligation read and would otherwise resume against `from`. It FOLLOWS the
 * membership to `to` instead of being dropped: the obligation belongs to the
 * store, not to an instance, and that in-flight re-attempt is the only thing
 * still serving it — dropping it would starve the owed pass for the rest of
 * `to`'s life (the BL-9f6681ee shape).
 */
const transferredTo = new WeakMap<StoreAdapter, StoreAdapter>();

/** The adapter that now owns `adapter`'s deep-verify membership. */
function currentOwner(adapter: StoreAdapter): StoreAdapter {
  let cur = adapter;
  const seen = new Set<StoreAdapter>();
  for (let next = transferredTo.get(cur); next !== undefined && !seen.has(cur); next = transferredTo.get(cur)) {
    seen.add(cur);
    cur = next;
  }
  return cur;
}

/** Test-only: whether `adapter` is waiting to re-attempt a peer-held lock. */
export function _peerWaitPendingForTest(adapter: StoreAdapter): boolean {
  return peerWaits.has(adapter);
}

function cancelPeerWait(adapter: StoreAdapter): void {
  const wait = peerWaits.get(adapter);
  if (wait === undefined) return;
  clearTimeout(wait.timer);
  peerWaits.delete(adapter);
}

function armPeerWait(adapter: StoreAdapter, opts: ScheduleDeepVerifyOptions, delayMs: number, canonicalDb: string): void {
  cancelPeerWait(adapter);
  if (releasedAdapters.has(adapter)) {
    // (BL-80965c9f) Never leave a timer armed against a closed adapter.
    log.info('store_adapter.deep_verify.peer_wait_skipped_closed', {
      db_path: canonicalDb,
      detail: 'the owning adapter closed; not re-attempting the peer-held lock. The obligation stays for the next owner',
    });
    return;
  }
  const timer = setTimeout(() => {
    const current = peerWaits.get(adapter);
    if (current === undefined || current.timer !== timer) return;
    peerWaits.delete(adapter);
    if (releasedAdapters.has(adapter)) return; // (BL-80965c9f) closed since arming
    // (BL-10b71ea6) Never discard the retry's promise untraced: a throw from
    // the re-attempt (e.g. config resolution) would be an unhandled rejection.
    retryAfterPeer(adapter, current.opts, current.delayMs, canonicalDb).catch((err: unknown) => {
      log.error('store_adapter.deep_verify.peer_retry_failed', {
        db_path: canonicalDb,
        error: err instanceof Error ? err.message : String(err),
        detail: 'the re-attempt after a peer-held lock threw; the obligation stays owed',
      });
    });
  }, delayMs);
  // Never keep a process alive just to wait for a peer's verifier.
  timer.unref();
  peerWaits.set(adapter, { timer, opts, delayMs });
}

async function retryAfterPeer(
  adapter: StoreAdapter,
  opts: ScheduleDeepVerifyOptions,
  lastDelayMs: number,
  canonicalDb: string,
): Promise<void> {
  try {
    // The peer's pass may have completed `ok` and cleared the obligation.
    const obligation = await readDeepVerifyObligation(adapter);
    if (obligation === null) {
      log.info('store_adapter.deep_verify.peer_satisfied', {
        db_path: canonicalDb,
        detail: 'the obligation was cleared while waiting for a peer-held lock; nothing left to run',
      });
      return;
    }
  } catch (err) {
    // "Cannot tell" is owed — same rule as the open path.
    log.warn('store_adapter.deep_verify.obligation_read_failed', {
      db_path: canonicalDb,
      error: err instanceof Error ? err.message : String(err),
      detail: 'retrying the deep pass after a peer-held lock as if still owed',
    });
  }
  // (BL-026af34c) A Turso reconnect may have handed this adapter's membership
  // to the instance that stays open while the read was in flight; the
  // re-attempt continues against THAT one and never touches `adapter` again.
  const owner = currentOwner(adapter);
  if (owner !== adapter) {
    log.info('store_adapter.deep_verify.peer_retry_followed_transfer', {
      db_path: canonicalDb,
      detail: 'the adapter was replaced by a reconnect during the peer-lock re-attempt; continuing on its successor',
    });
  }
  // (BL-80965c9f) The adapter may have closed while the obligation read was in
  // flight — its peer wait was already consumed, so `releaseDeepVerify` had
  // nothing to cancel. Touch it no further.
  if (releasedAdapters.has(owner)) {
    log.info('store_adapter.deep_verify.peer_retry_skipped_closed', {
      db_path: canonicalDb,
      detail: 'the owning adapter closed during the peer-lock re-attempt; the obligation stays for the next owner',
    });
    return;
  }
  // `run.done` is already caught inside; a synchronous throw here rejects this
  // function's promise, which the timer callback catches and traces.
  await scheduleDeepVerifyInternal(owner, opts, lastDelayMs);
}
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Synchronous: `exit` listeners cannot await. A signal send is synchronous,
  // which is all this needs — the child's own reaper covers the paths where
  // this hook never runs (the opener SIGKILLed).
  process.on('exit', () => {
    for (const run of runs.values()) {
      const c = run.child;
      if (c !== null && c.exitCode === null && c.signalCode === null) {
        try {
          c.kill('SIGKILL');
        } catch (err) {
          process.stderr.write(
            `[store-adapter] deep-verify: failed to SIGKILL verifier pid ${String(c.pid)} at exit: ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }
  });
}

/** Test-only: the live run for a store, if any. */
export function _activeDeepVerifyForTest(
  dbPath: string,
): { pid: number | null; done: Promise<DeepVerifyState | null> } | null {
  const run = runs.get(canonicalOrRaw(dbPath));
  if (run === undefined) return null;
  return { pid: run.child?.pid ?? null, done: run.done };
}

function canonicalOrRaw(dbPath: string): string {
  try {
    return canonicalDbPath(dbPath);
  } catch (err) {
    log.warn('store_adapter.deep_verify.canonicalize_failed', {
      db_path: dbPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return dbPath;
  }
}

/**
 * Hand an adapter's membership to another instance. The Turso reconnect path
 * opens a throwaway `fresh` instance, adopts its connection onto `this`, and
 * never closes `fresh` — so a run `fresh` joined must be re-owned by `this`, or
 * `this.close()` would leave it running.
 */
export function transferDeepVerifyMembership(from: StoreAdapter, to: StoreAdapter): void {
  // (BL-026af34c) Forward any re-attempt already in flight for `from`.
  if (from !== to) transferredTo.set(from, to);
  for (const run of runs.values()) {
    if (run.members.delete(from)) run.members.add(to);
  }
  // (BL-9f6681ee) A pending peer-lock re-attempt belongs to the adapter that
  // stays open, not to the throwaway instance the reconnect discards.
  const wait = peerWaits.get(from);
  if (wait !== undefined && from !== to) {
    clearTimeout(wait.timer);
    peerWaits.delete(from);
    const canonicalDb = canonicalOrRaw(to.config.dbPath ?? from.config.dbPath ?? '');
    armPeerWait(to, wait.opts, wait.delayMs, canonicalDb);
  }
}

/**
 * Called at the top of an adapter's `close()`. When this adapter is the last
 * one interested in a running verifier, the verifier is SIGKILLed and its
 * `cancelled` outcome is persisted THROUGH this adapter (still open here)
 * before the close ceremony — including the quiescence-gated TRUNCATE, which a
 * live verifier lease would otherwise defer — proceeds.
 */
export async function releaseDeepVerify(adapter: StoreAdapter): Promise<void> {
  // (BL-80965c9f) Tombstone FIRST, synchronously, before any await: an
  // in-flight peer-lock re-attempt checks this after its own await.
  releasedAdapters.add(adapter);
  // (BL-9f6681ee) A closing owner stops waiting for a peer-held lock.
  cancelPeerWait(adapter);
  for (const run of [...runs.values()]) {
    if (!run.members.has(adapter)) continue;
    if (run.members.size > 1) {
      run.members.delete(adapter);
      continue;
    }
    run.cancelReason = 'the owning store adapter closed before the deep pass finished';
    const c = run.child;
    if (c !== null && c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      run.done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5_000);
        timer.unref();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!settled) {
      log.error('store_adapter.deep_verify.cancel_wait_exceeded', {
        db_path: run.canonicalDb,
        verifier_pid: c?.pid ?? null,
        detail: 'the verifier did not report exit within 5s of SIGKILL; closing anyway',
      });
    }
    run.members.delete(adapter);
  }
}

// ── Scheduling ──────────────────────────────────────────────────────────────

export interface ScheduleDeepVerifyOptions {
  /** The fast pass this open just ran — the deep result is merged into it. */
  fastResult: VerifyAndRepairResult;
  /** Why deep is owed (recorded in the state row). */
  reason: string;
  /** Same sink the open-time pass reports through. */
  onReport?: (event: 'damaged' | 'repaired' | 'repair_failed', detail: string) => void;
}

/**
 * Start a background deep pass for the store behind `adapter`, unless one is
 * already running (in this process: join it; in another process: leave it to
 * that process). Never blocks the caller on the pass itself — the returned
 * promise settles when the pass does, for callers (tests) that want to wait.
 * Resolves `null` when no pass was started here.
 */
export function scheduleDeepVerify(
  adapter: StoreAdapter,
  opts: ScheduleDeepVerifyOptions,
): Promise<DeepVerifyState | null> {
  return scheduleDeepVerifyInternal(adapter, opts, null);
}

/**
 * @param lastPeerDelayMs the wait that preceded this attempt when it is a
 *   peer-lock re-attempt (the next wait doubles it); `null` for a first attempt.
 */
function scheduleDeepVerifyInternal(
  adapter: StoreAdapter,
  opts: ScheduleDeepVerifyOptions,
  lastPeerDelayMs: number | null,
): Promise<DeepVerifyState | null> {
  // (BL-80965c9f) A closed adapter never arms, starts, or joins a pass.
  if (releasedAdapters.has(adapter)) return Promise.resolve(null);
  const dbPath = adapter.config.dbPath;
  if (dbPath === undefined || dbPath === '') {
    log.warn('store_adapter.deep_verify.skipped_remote', {
      detail: 'deep verification needs a local store file; this adapter has none',
    });
    return Promise.resolve(null);
  }
  const canonicalDb = canonicalOrRaw(dbPath);

  const existing = runs.get(canonicalDb);
  if (existing !== undefined) {
    existing.members.add(adapter);
    return existing.done;
  }

  const timeoutMs = resolveDeepVerifyTimeoutMs(adapter.config.deepVerify?.timeoutMs);
  const lock = tryAcquireDeepVerifyLock(canonicalDb);
  if (!lock.acquired) {
    // (BL-9f6681ee) Never give up: the peer may be a one-shot that closes or
    // exits mid-pass, leaving the obligation owed. An owner re-attempts on a
    // bounded exponential backoff until the lock frees (then runs) or the
    // obligation is cleared (then stops), for as long as it stays open.
    const bounds = resolveDeepVerifyPeerRetry(adapter.config.deepVerify);
    const nextDelayMs =
      lastPeerDelayMs === null ? bounds.initialMs : Math.min(bounds.maxMs, Math.max(bounds.initialMs, lastPeerDelayMs * 2));
    log.info('store_adapter.deep_verify.peer_running', {
      db_path: canonicalDb,
      holder_pid: lock.holderPid,
      retry_in_ms: nextDelayMs,
      detail:
        'another process holds the deep-pass lock for this store; re-attempting when it frees. ' +
        'The obligation stays until a pass completes ok',
    });
    armPeerWait(adapter, opts, nextDelayMs, canonicalDb);
    return Promise.resolve(null);
  }

  installExitHook();
  const run: DeepVerifyRun = {
    canonicalDb,
    members: new Set([adapter]),
    child: null,
    cancelReason: null,
    done: Promise.resolve(null),
  };
  runs.set(canonicalDb, run);
  run.done = executeRun(run, adapter, opts, timeoutMs, lock.held).catch((err: unknown) => {
    log.error('store_adapter.deep_verify.orchestration_failed', {
      db_path: canonicalDb,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  return run.done;
}

function classifyFindings(findings: IntegrityFinding[]): 'ok' | 'damaged' | 'inconclusive' {
  if (findings.some((f) => f.status === 'damaged')) return 'damaged';
  if (findings.length === 0 || findings.some((f) => f.status !== 'ok' || !f.probeValidated)) {
    return 'inconclusive';
  }
  return 'ok';
}

/** Fold the deep findings into the fast pass this open recorded. */
function mergeDeepIntoResult(
  fast: VerifyAndRepairResult,
  deepFindings: IntegrityFinding[],
  deepDurationMs: number,
): VerifyAndRepairResult {
  const findings = [...fast.verify.findings, ...deepFindings];
  const damaged = findings.filter((f) => f.status === 'damaged');
  const unknown = findings.filter((f) => f.status === 'unknown');
  return {
    verify: {
      ok: fast.verify.ok && damaged.length === 0,
      depth: 'deep',
      durationMs: Math.round((fast.verify.durationMs + deepDurationMs) * 10) / 10,
      findings,
      damaged,
      unknown,
    },
    repair: fast.repair,
  };
}

function loud(event: string, fields: Record<string, unknown>): void {
  log.error(event, fields);
  try {
    process.stderr.write(JSON.stringify({ evt: event, ...fields }) + '\n');
  } catch (err) {
    log.error('store_adapter.deep_verify.stderr_write_failed', {
      event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function executeRun(
  run: DeepVerifyRun,
  starter: StoreAdapter,
  opts: ScheduleDeepVerifyOptions,
  timeoutMs: number,
  lockHeld: boolean,
): Promise<DeepVerifyState | null> {
  const startedAtMs = Date.now();
  const t0 = performance.now();
  const base: DeepVerifyState = {
    v: 1,
    status: 'running',
    reason: opts.reason,
    detail: null,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: null,
    duration_ms: null,
    timeout_ms: timeoutMs,
    owner_pid: process.pid,
    verifier_pid: null,
  };

  const entry = starter.config.deepVerify?.verifier ?? resolveDeepVerifierEntry();
  const adapterType = starter.config.type;

  let outcome: Outcome;
  // (BL-374ec7b9) The `running` state write, kept so the terminal write can
  // wait for it. Fire-and-forget let a slow `running` upsert land AFTER the
  // terminal one and overwrite `ok`/`timed_out` with a stale `running`.
  let runningWrite: Promise<void> = Promise.resolve();

  if (!existsSync(entry.path)) {
    outcome = {
      status: 'failed',
      detail: `the deep verifier sidecar is missing at ${entry.path} — deep verification did not run (ADR-0020 D5: no inline fallback)`,
      findings: [],
    };
  } else {
    outcome = await new Promise<Outcome>((resolve) => {
      let settled = false;
      let timedOut = false;
      let reply: DeepVerifyChildMessage | null = null;
      let stderrTail = '';
      let timer: NodeJS.Timeout | undefined;
      const settle = (o: Outcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(o);
      };

      const payload: DeepVerifyChildPayload = {
        dbPath: run.canonicalDb,
        adapterType,
        parentPid: process.pid,
        hardDeadlineMs: timeoutMs + DEEP_VERIFY_REAPER_GRACE_MS,
      };
      if (starter.config.concurrencyMode !== undefined) payload.concurrencyMode = starter.config.concurrencyMode;
      const args = ['--payload', JSON.stringify(payload)];
      if (typeof process.argv[1] === 'string' && process.argv[1] !== '') {
        args.push('--sox-parent-entry', process.argv[1]);
      }

      let child: ChildProcess;
      try {
        child = fork(entry.path, args, {
          detached: false,
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          execArgv: entry.execArgv ?? [],
          env: {
            ...process.env,
            [SOX_TELEMETRY_INIT]: JSON.stringify({ service: 'store-adapter-deep-verify', role: 'harness', logSink: 'file' }),
          },
        });
      } catch (err) {
        settle({
          status: 'failed',
          detail: `could not fork the deep verifier: ${err instanceof Error ? err.message : String(err)}`,
          findings: [],
        });
        return;
      }
      run.child = child;
      base.verifier_pid = child.pid ?? null;
      // Never keep the opener alive for the verifier: if the owner exits, its
      // `exit` hook SIGKILLs the child, and the obligation stays for next time.
      // (One-shot openers never get here — `schedule: 'never'`, BL-9f6681ee.)
      child.unref();
      child.channel?.unref();
      const errStream = child.stderr as unknown as { unref?: () => void } | null;
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2_000);
      });
      errStream?.unref?.();

      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref();

      child.on('message', (msg: DeepVerifyChildMessage) => {
        reply = msg;
      });
      child.on('error', (err) => {
        settle({
          status: 'failed',
          detail: `deep verifier process error: ${err.message}`,
          findings: [],
        });
      });
      child.on('exit', (code, signal) => {
        const r = reply as DeepVerifyChildMessage | null;
        if (r !== null && r.type === 'result') {
          settle({ status: classifyFindings(r.findings), detail: '', findings: r.findings });
          return;
        }
        if (run.cancelReason !== null) {
          settle({ status: 'cancelled', detail: run.cancelReason, findings: [] });
          return;
        }
        if (timedOut) {
          settle({
            status: 'timed_out',
            detail: `deep verification exceeded its ${timeoutMs}ms wall-clock bound; the verifier (pid ${String(child.pid)}) was SIGKILLed`,
            findings: [],
          });
          return;
        }
        const why = r !== null && r.type === 'error' ? `reported: ${r.message}` : 'exited without a result';
        settle({
          status: 'failed',
          detail:
            `deep verifier ${why} (code ${String(code)}, signal ${String(signal)})` +
            (stderrTail.trim() !== '' ? `; stderr tail: ${stderrTail.trim().slice(-500)}` : ''),
          findings: [],
        });
      });

      // Recorded AFTER the fork so `verifier_pid` is known; a write failure
      // here must not stop the pass.
      runningWrite = writeDeepVerifyState(starter, { ...base }).catch((err: unknown) => {
        log.warn('store_adapter.deep_verify.state_write_failed', {
          db_path: run.canonicalDb,
          status: 'running',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  run.child = null;
  try {
    // (BL-374ec7b9) Never let the `running` record land after the outcome.
    // `runningWrite` carries its own catch, so this await cannot throw.
    await runningWrite;
    return await recordOutcome(run, opts, outcome, base, timeoutMs, performance.now() - t0);
  } finally {
    // Deregister only AFTER the outcome is recorded: recording may reconnect a
    // released adapter, and that reconnect's open-time pass must JOIN this run
    // rather than read the not-yet-cleared obligation and start a second one.
    runs.delete(run.canonicalDb);
    if (lockHeld) releaseDeepVerifyLock(run.canonicalDb);
  }
}

type Outcome = { status: DeepVerifyStatus; detail: string; findings: IntegrityFinding[] };

async function recordOutcome(
  run: DeepVerifyRun,
  opts: ScheduleDeepVerifyOptions,
  outcome: Outcome,
  base: DeepVerifyState,
  timeoutMs: number,
  elapsedMs: number,
): Promise<DeepVerifyState> {
  const durationMs = Math.round(elapsedMs);
  let findings = outcome.findings;
  if (outcome.status === 'timed_out' || outcome.status === 'failed' || outcome.status === 'cancelled') {
    // An aborted deep pass is `unknown`, never `ok` and never omitted.
    findings = [
      {
        probe: 'pragma_integrity_check',
        object: 'main',
        status: 'unknown',
        detail: `Deep verification ${outcome.status}: ${outcome.detail}. The store is NOT verified at depth deep.`,
        repairable: false,
        backlog: 'BL-fc5ab895',
        probeValidated: false,
      },
    ];
  }
  const detail =
    outcome.detail !== ''
      ? outcome.detail
      : findings.map((f) => `${f.object}: ${f.detail}`).join(' | ').slice(0, 1_000);
  const state: DeepVerifyState = {
    ...base,
    status: outcome.status,
    detail,
    finished_at: new Date().toISOString(),
    duration_ms: durationMs,
  };

  const fields = {
    db_path: run.canonicalDb,
    status: state.status,
    reason: state.reason,
    duration_ms: durationMs,
    timeout_ms: timeoutMs,
    verifier_pid: state.verifier_pid,
    detail,
  };
  switch (state.status) {
    case 'ok':
      log.info('store_adapter.deep_verify.ok', fields);
      break;
    case 'damaged':
      for (const f of findings.filter((x) => x.status === 'damaged')) {
        opts.onReport?.('damaged', `[${f.backlog}] ${f.object}: ${f.detail}`);
      }
      loud('store_adapter.deep_verify.damaged', fields);
      break;
    case 'cancelled':
      log.warn('store_adapter.deep_verify.cancelled', fields);
      break;
    default:
      loud(`store_adapter.deep_verify.${state.status}`, fields);
      break;
  }

  // Persist through an adapter that is still open. `releaseDeepVerify` keeps
  // the closing adapter a member until this has run.
  const writer = [...run.members][0];
  if (writer === undefined) {
    log.warn('store_adapter.deep_verify.unpersisted', {
      ...fields,
      detail: 'no open adapter remained to record the outcome; the obligation (if any) is unchanged',
    });
    return state;
  }
  const merged = mergeDeepIntoResult(opts.fastResult, findings, durationMs);
  recordIntegrityResult(writer, merged);
  try {
    await persistIntegrityResult(writer, merged);
    await writeDeepVerifyState(writer, state);
    if (state.status === 'ok') await clearDeepVerifyObligation(writer);
  } catch (err) {
    emitIntegrityReport(
      run.canonicalDb,
      'repair_failed',
      `deep verification finished ${state.status} but its outcome could not be recorded: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return state;
}
